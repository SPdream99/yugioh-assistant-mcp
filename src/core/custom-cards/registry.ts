import fs from 'node:fs';
import path from 'node:path';
import type { Card } from '../../types/card.js';
import { generateLuaScript, compileCustomCard, type EffectSpec } from './lua-generator.js';
import { renderCardSvg } from './card-renderer.js';
import { guardOutputPath, readTextFileSafe } from '../../utils/safe-path.js';
import { customRegistryFile, customCardsDir as customCardsDirPath, customCacheScriptsDir } from './paths.js';

/** What the script generator understood of the card text (stored with the record). */
export interface CustomCardCompileReport {
  /** Where the stored Lua came from. */
  source: 'psct' | 'effectsSpec' | 'luaOverride';
  /** True when the stored script is the caller's raw Lua: it was NOT generated or checked against the text. */
  userSuppliedLua: boolean;
  effects: Array<{ index: number; text: string; kind: string; understood: boolean; notes: string[] }>;
  unparsed: string[];
  confidence: 'high' | 'medium' | 'low';
  designWarnings: string[];
}

/** Raw Lua overrides run inside the ocgcore WASM sandbox, but are still bounded. */
export const MAX_CUSTOM_LUA_BYTES = 200 * 1024;

const NUMERIC_RULES: Array<{ key: 'atk' | 'def' | 'level' | 'linkval' | 'scale'; min: number; max: number; label: string }> = [
  { key: 'atk', min: 0, max: 1_000_000, label: 'ATK' },
  { key: 'def', min: 0, max: 1_000_000, label: 'DEF' },
  { key: 'level', min: 0, max: 13, label: 'Level/Rank' },
  { key: 'linkval', min: 1, max: 8, label: 'Link Rating' },
  { key: 'scale', min: 0, max: 13, label: 'Pendulum Scale' },
];

/**
 * Validates user-supplied card fields before anything is generated or written.
 * Returns human-readable problems; an empty array means the input is acceptable.
 * ("?" ATK/DEF is not modelled, so negative values are rejected.)
 */
export function validateCustomCardInput(name: string, cardData: Partial<Card>, luaCode?: string): string[] {
  const errors: string[] = [];
  if (!name || !String(name).trim()) errors.push('Card name is required.');
  if (String(name || '').length > 120) errors.push('Card name must be at most 120 characters.');
  for (const rule of NUMERIC_RULES) {
    const value = cardData[rule.key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${rule.label} must be an integer (got ${JSON.stringify(value)}).`);
    } else if (value < rule.min || value > rule.max) {
      errors.push(`${rule.label} must be between ${rule.min} and ${rule.max} (got ${value}).`);
    }
  }
  if (cardData.archetype !== undefined && String(cardData.archetype).length > 64) errors.push('Archetype name must be at most 64 characters.');
  if (luaCode !== undefined && Buffer.byteLength(luaCode, 'utf-8') > MAX_CUSTOM_LUA_BYTES) {
    errors.push(`Lua override is ${Buffer.byteLength(luaCode, 'utf-8')} bytes; the limit is ${MAX_CUSTOM_LUA_BYTES}.`);
  }
  return errors;
}

export interface CustomCardRecord {
  tempId: number;
  officialId?: number;
  name: string;
  origin: 'unreleased_official' | 'custom_fanmade';
  sourceUrl?: string;
  cardData: Card;
  luaPath: string;
  status: 'active' | 'migrated';
  compileReport?: CustomCardCompileReport;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterCustomCardInput {
  name: string;
  cardData: Partial<Card>;
  origin?: 'unreleased_official' | 'custom_fanmade';
  sourceUrl?: string;
  luaCode?: string;
  effectsSpec?: EffectSpec[];
}

export interface MigrationResult {
  success: boolean;
  oldId: number;
  newId: number;
  updatedFiles: string[];
  message: string;
}

function getPaths() {
  const registryFile = customRegistryFile();
  const customCardsDir = customCardsDirPath();
  const cacheScriptsDir = customCacheScriptsDir();

  // Ensure directories exist
  if (!fs.existsSync(customCardsDir)) {
    fs.mkdirSync(customCardsDir, { recursive: true });
  }
  if (!fs.existsSync(cacheScriptsDir)) {
    fs.mkdirSync(cacheScriptsDir, { recursive: true });
  }

  const registryDir = path.dirname(registryFile);
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }

  return { registryFile, customCardsDir, cacheScriptsDir };
}

/**
 * Reads all custom card records from storage.
 */
export function listCustomCards(): CustomCardRecord[] {
  const { registryFile } = getPaths();
  if (!fs.existsSync(registryFile)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(registryFile, 'utf-8');
    if (!raw.trim()) return [];
    return JSON.parse(raw) as CustomCardRecord[];
  } catch (err) {
    console.warn(`Warning: Failed to parse ${registryFile}, returning empty array:`, err);
    return [];
  }
}

/**
 * Writes custom card records to storage file.
 */
function saveRegistry(records: CustomCardRecord[]): void {
  const { registryFile } = getPaths();
  fs.writeFileSync(registryFile, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Finds next available temp ID (>= 990000001).
 */
function getNextTempId(records: CustomCardRecord[], requestedId?: number): number {
  const STARTING_TEMP_ID = 990000001;
  const existingIds = new Set<number>();

  for (const r of records) {
    existingIds.add(r.tempId);
    if (r.officialId) existingIds.add(r.officialId);
  }

  if (requestedId && requestedId >= STARTING_TEMP_ID && !existingIds.has(requestedId)) {
    return requestedId;
  }

  let candidate = STARTING_TEMP_ID;
  for (const r of records) {
    if (r.tempId >= candidate) {
      candidate = r.tempId + 1;
    }
  }

  while (existingIds.has(candidate)) {
    candidate++;
  }

  return candidate;
}

/**
 * Registers a new custom / unreleased card.
 * Auto-assigns unique tempId >= 990000001.
 * Generates Lua script and saves to data/custom_cards/c${tempId}.lua.
 */
export function registerCustomCard(input: RegisterCustomCardInput): CustomCardRecord {
  const problems = validateCustomCardInput(input.name, input.cardData || {}, input.luaCode);
  if (problems.length) throw new Error(`Invalid custom card: ${problems.join(' ')}`);
  const records = listCustomCards();
  const { customCardsDir } = getPaths();

  const tempId = getNextTempId(records, input.cardData?.id);
  const now = new Date().toISOString();

  // Create full Card object adhering to Card interface
  const fullCardData: Card = {
    type: input.cardData.type || 'Effect Monster',
    frameType: input.cardData.frameType || 'effect',
    desc: input.cardData.desc || '',
    atk: input.cardData.atk,
    def: input.cardData.def,
    level: input.cardData.level,
    race: input.cardData.race,
    attribute: input.cardData.attribute,
    scale: input.cardData.scale,
    linkval: input.cardData.linkval,
    linkmarkers: input.cardData.linkmarkers,
    archetype: input.cardData.archetype,
    card_sets: input.cardData.card_sets || [],
    card_images: input.cardData.card_images || [],
    card_prices: input.cardData.card_prices || [],
    banlist_info: input.cardData.banlist_info,
    ...input.cardData,
    // Guarantee id and name consistency
    id: tempId,
    name: input.name,
  };

  // Compile the card text even when Lua is supplied: the report and design
  // review describe the card, whichever script ends up being stored.
  const report = compileCustomCard(fullCardData, tempId);
  const source: CustomCardCompileReport['source'] = input.luaCode ? 'luaOverride' : input.effectsSpec?.length ? 'effectsSpec' : 'psct';
  const luaCode = input.luaCode || (source === 'psct' ? report.lua : generateLuaScript(fullCardData, tempId, input.effectsSpec));
  const compileReport: CustomCardCompileReport = {
    source,
    userSuppliedLua: source === 'luaOverride',
    effects: report.effects,
    unparsed: report.unparsed,
    confidence: report.confidence,
    designWarnings: report.designWarnings,
  };
  const luaFileName = `c${tempId}.lua`;
  const luaFilePath = path.resolve(customCardsDir, luaFileName);
  fs.writeFileSync(luaFilePath, luaCode, 'utf-8');

  // Relative path for registry portability
  const relativeLuaPath = path.relative(process.cwd(), luaFilePath).replace(/\\/g, '/');

  // Render SVG card artwork
  try {
    renderCardSvg(fullCardData, tempId);
  } catch (err) {
    console.warn(`Warning: Failed to render SVG for card ${tempId}:`, err);
  }

  const newRecord: CustomCardRecord = {
    tempId,
    name: input.name,
    origin: input.origin || 'unreleased_official',
    sourceUrl: input.sourceUrl,
    cardData: fullCardData,
    luaPath: relativeLuaPath,
    status: 'active',
    compileReport,
    createdAt: now,
    updatedAt: now,
  };

  records.push(newRecord);
  saveRegistry(records);

  return newRecord;
}

/**
 * Retrieves a custom card record by either tempId or officialId.
 */
export function getCustomCard(id: number): CustomCardRecord | undefined {
  const records = listCustomCards();
  return records.find((r) => r.tempId === id || r.officialId === id);
}

/**
 * Migrates a custom card from tempId to officialId.
 * - Migrates script file from data/custom_cards/c${tempId}.lua to official script files
 * - Updates ID in Lua source
 * - Updates custom_registry.json setting status to 'migrated' and officialId
 * - Updates YDK files by replacing tempId with officialId
 */
export function migrateTempId(
  tempId: number,
  officialId: number,
  ydkFilesToUpdate?: string[]
): MigrationResult {
  const records = listCustomCards();
  const recordIndex = records.findIndex((r) => r.tempId === tempId);

  if (recordIndex === -1) {
    return {
      success: false,
      oldId: tempId,
      newId: officialId,
      updatedFiles: [],
      message: `Card with tempId ${tempId} was not found in registry`,
    };
  }

  const record = records[recordIndex];
  const { customCardsDir, cacheScriptsDir } = getPaths();
  const oldLuaPath = path.isAbsolute(record.luaPath)
    ? record.luaPath
    : path.resolve(process.cwd(), record.luaPath);

  let luaContent = '';
  if (fs.existsSync(oldLuaPath)) {
    luaContent = fs.readFileSync(oldLuaPath, 'utf-8');
  } else {
    // Regenerate from card data if old file was missing
    luaContent = generateLuaScript({ ...record.cardData, id: officialId }, officialId);
  }

  // Update ID occurrences in Lua code
  const updatedLua = luaContent
    .replace(new RegExp(`\\(ID: ${tempId}\\)`, 'g'), `(ID: ${officialId})`)
    .replace(new RegExp(`\\bc${tempId}\\b`, 'g'), `c${officialId}`)
    .replace(new RegExp(`\\b${tempId}\\b`, 'g'), `${officialId}`);

  // Write to both data/custom_cards/c${officialId}.lua and data/cache/scripts/c${officialId}.lua
  const newCustomLuaPath = path.resolve(customCardsDir, `c${officialId}.lua`);
  const newCacheLuaPath = path.resolve(cacheScriptsDir, `c${officialId}.lua`);

  fs.writeFileSync(newCustomLuaPath, updatedLua, 'utf-8');
  try {
    fs.writeFileSync(newCacheLuaPath, updatedLua, 'utf-8');
  } catch (err) {
    console.warn(`Warning: Could not write to cache path ${newCacheLuaPath}:`, err);
  }

  // Render SVG card artwork for official ID
  try {
    renderCardSvg({ ...record.cardData, id: officialId }, officialId);
  } catch (err) {
    console.warn(`Warning: Could not render SVG for migrated card ${officialId}:`, err);
  }

  // Update YDK deck files
  const updatedFiles: string[] = [];
  if (ydkFilesToUpdate && ydkFilesToUpdate.length > 0) {
    for (const ydkPath of ydkFilesToUpdate) {
      const resolvedYdk = path.isAbsolute(ydkPath) ? ydkPath : path.resolve(process.cwd(), ydkPath);
      if (!resolvedYdk.toLowerCase().endsWith(".ydk")) {
        console.warn(`Skipping ${resolvedYdk}: only .ydk files are rewritten.`);
        continue;
      }
      const guard = guardOutputPath(resolvedYdk, { allowGameRoots: true });
      if (!guard.ok) {
        console.warn(`Skipping ${resolvedYdk}: ${guard.reason}`);
        continue;
      }
      if (fs.existsSync(guard.resolved)) {
        try {
          const read = readTextFileSafe(guard.resolved);
          if (!read.ok) throw new Error(read.reason);
          const lines = (read.text || "").split(/\r?\n/);
          let modified = false;
          const updatedLines = lines.map((line) => {
            if (line.trim() === String(tempId)) {
              modified = true;
              return String(officialId);
            }
            return line;
          });
          if (modified) {
            fs.writeFileSync(guard.resolved, updatedLines.join('\n'), 'utf-8');
            updatedFiles.push(guard.resolved);
          }
        } catch (err) {
          console.warn(`Warning: Could not update YDK file ${guard.resolved}:`, err);
        }
      }
    }
  }

  // Update registry record
  const now = new Date().toISOString();
  record.status = 'migrated';
  record.officialId = officialId;
  record.cardData.id = officialId;
  record.luaPath = path.relative(process.cwd(), newCustomLuaPath).replace(/\\/g, '/');
  record.updatedAt = now;

  records[recordIndex] = record;
  saveRegistry(records);

  return {
    success: true,
    oldId: tempId,
    newId: officialId,
    updatedFiles,
    message: `Successfully migrated card "${record.name}" from temp ID ${tempId} to official ID ${officialId}`,
  };
}

/**
 * Object-oriented CustomCardRegistry class wrapper.
 */
export class CustomCardRegistry {
  static register(input: RegisterCustomCardInput): CustomCardRecord {
    return registerCustomCard(input);
  }

  static get(id: number): CustomCardRecord | undefined {
    return getCustomCard(id);
  }

  static list(): CustomCardRecord[] {
    return listCustomCards();
  }

  static migrate(tempId: number, officialId: number, ydkFiles?: string[]): MigrationResult {
    return migrateTempId(tempId, officialId, ydkFiles);
  }
}
