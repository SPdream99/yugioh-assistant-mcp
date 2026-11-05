/**
 * Bridges the custom-card registry into ocgcore.
 *
 * Custom and unreleased cards live in data/custom_registry.json, not in
 * cards.cdb, so the engine's cardReader cannot see them. Without this bridge a
 * custom card dealt into a duel has no type, stats or setcode and its script
 * never runs. This module converts a registry record into OcgCardData and
 * resolves archetype names to setcodes that the generated Lua can test with
 * Card.IsSetCard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../types/card.js';
import { listCustomCards } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SETCODE_FILE = path.join(ROOT, 'data', 'ocgcore-scripts', 'archetype_setcode_constants.lua');

export const TYPE_BITS: Record<string, number> = {
  MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4, NORMAL: 0x10, EFFECT: 0x20, FUSION: 0x40, RITUAL: 0x80,
  SPIRIT: 0x200, UNION: 0x400, GEMINI: 0x800, TUNER: 0x1000, SYNCHRO: 0x2000, TOKEN: 0x4000,
  QUICKPLAY: 0x10000, CONTINUOUS: 0x20000, EQUIP: 0x40000, FIELD: 0x80000, COUNTER: 0x100000,
  FLIP: 0x200000, TOON: 0x400000, XYZ: 0x800000, PENDULUM: 0x1000000, LINK: 0x4000000
};

const ATTRIBUTE_BITS: Record<string, number> = {
  EARTH: 0x1, WATER: 0x2, FIRE: 0x4, WIND: 0x8, LIGHT: 0x10, DARK: 0x20, DIVINE: 0x40
};

const RACE_BITS: Record<string, number> = {
  WARRIOR: 0x1, SPELLCASTER: 0x2, FAIRY: 0x4, FIEND: 0x8, ZOMBIE: 0x10, MACHINE: 0x20, AQUA: 0x40,
  PYRO: 0x80, ROCK: 0x100, WINGEDBEAST: 0x200, PLANT: 0x400, INSECT: 0x800, THUNDER: 0x1000,
  DRAGON: 0x2000, BEAST: 0x4000, BEASTWARRIOR: 0x8000, DINOSAUR: 0x10000, FISH: 0x20000,
  SEASERPENT: 0x40000, REPTILE: 0x80000, PSYCHIC: 0x100000, DIVINEBEAST: 0x200000, CREATORGOD: 0x400000,
  WYRM: 0x800000, CYBERSE: 0x1000000, ILLUSION: 0x2000000
};

const LINK_MARKER_BITS: Record<string, number> = {
  'BOTTOM-LEFT': 0x1, BOTTOM: 0x2, 'BOTTOM-RIGHT': 0x4, LEFT: 0x8, RIGHT: 0x20,
  'TOP-LEFT': 0x40, TOP: 0x80, 'TOP-RIGHT': 0x100
};

function squash(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function attributeBits(attribute?: string): number {
  return attribute ? ATTRIBUTE_BITS[squash(attribute)] ?? 0 : 0;
}

export function raceBits(race?: string): number {
  if (!race) return 0;
  const key = squash(race);
  return RACE_BITS[key] ?? (key === 'DIVINE' ? RACE_BITS.DIVINEBEAST : 0);
}

/** Lua constant name for a race, e.g. "Winged Beast" -> RACE_WINGEDBEAST. */
export function raceConstant(race?: string): string | null {
  if (!race) return null;
  const key = squash(race);
  if (key === 'DIVINE' || key === 'DIVINEBEAST') return 'RACE_DIVINE';
  return RACE_BITS[key] ? `RACE_${key}` : null;
}

export function attributeConstant(attribute?: string): string | null {
  if (!attribute) return null;
  const key = squash(attribute);
  return ATTRIBUTE_BITS[key] ? `ATTRIBUTE_${key}` : null;
}

/** Converts a YGOPRODeck-style type string ("Synchro Tuner Effect Monster") to type bits. */
export function typeBits(card: Partial<Card>): number {
  const text = `${card.type || ''} ${card.frameType || ''}`.toLowerCase();
  if (/\bspell\b/.test(text)) {
    let bits = TYPE_BITS.SPELL;
    if (/quick-?play/.test(text)) bits |= TYPE_BITS.QUICKPLAY;
    if (/continuous/.test(text)) bits |= TYPE_BITS.CONTINUOUS;
    if (/\bequip\b/.test(text)) bits |= TYPE_BITS.EQUIP;
    if (/\bfield\b/.test(text)) bits |= TYPE_BITS.FIELD;
    if (/ritual/.test(text)) bits |= TYPE_BITS.RITUAL;
    return bits;
  }
  if (/\btrap\b/.test(text)) {
    let bits = TYPE_BITS.TRAP;
    if (/continuous/.test(text)) bits |= TYPE_BITS.CONTINUOUS;
    if (/counter/.test(text)) bits |= TYPE_BITS.COUNTER;
    return bits;
  }
  let bits = TYPE_BITS.MONSTER;
  const flags: Array<[RegExp, number]> = [
    [/fusion/, TYPE_BITS.FUSION], [/synchro/, TYPE_BITS.SYNCHRO], [/xyz/, TYPE_BITS.XYZ],
    [/\blink\b/, TYPE_BITS.LINK], [/ritual/, TYPE_BITS.RITUAL], [/tuner/, TYPE_BITS.TUNER],
    [/pendulum/, TYPE_BITS.PENDULUM], [/\bflip\b/, TYPE_BITS.FLIP], [/gemini/, TYPE_BITS.GEMINI],
    [/spirit/, TYPE_BITS.SPIRIT], [/union/, TYPE_BITS.UNION], [/toon/, TYPE_BITS.TOON]
  ];
  for (const [re, bit] of flags) if (re.test(text)) bits |= bit;
  const isVanilla = /\bnormal\b/.test(text) && !/effect/.test(text);
  bits |= isVanilla ? TYPE_BITS.NORMAL : TYPE_BITS.EFFECT;
  return bits;
}

let setcodeTable: Map<string, number> | null = null;

function loadSetcodeTable(): Map<string, number> {
  if (setcodeTable) return setcodeTable;
  setcodeTable = new Map();
  try {
    const text = fs.readFileSync(SETCODE_FILE, 'utf-8');
    for (const match of text.matchAll(/^SET_([A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+)/gm)) {
      setcodeTable.set(match[1].replace(/_/g, ''), parseInt(match[2], 16));
    }
  } catch {
    // Missing scripts folder: every archetype falls back to a custom setcode.
  }
  return setcodeTable;
}

/**
 * Setcode for an archetype name. Official archetypes reuse their real setcode
 * (so custom support cards interact with real ones); unknown archetypes get a
 * stable code in 0xF00-0xFFE, a range no official archetype uses.
 */
export function resolveSetcode(archetype: string): { setcode: number; official: boolean } {
  const key = squash(archetype);
  const official = loadSetcodeTable().get(key);
  if (official !== undefined) return { setcode: official, official: true };
  let hash = 2166136261;
  for (const ch of key) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return { setcode: 0xf00 + (hash % 0xff), official: false };
}

export interface EngineCardData {
  code: number;
  alias: number;
  setcodes: number[];
  type: number;
  level: number;
  attribute: number;
  race: bigint;
  attack: number;
  defense: number;
  lscale: number;
  rscale: number;
  link_marker: number;
}

export function customCardToEngine(card: Partial<Card>, code: number): EngineCardData {
  const type = typeBits(card);
  const isMonster = (type & TYPE_BITS.MONSTER) !== 0;
  const isLink = (type & TYPE_BITS.LINK) !== 0;
  let linkMarker = 0;
  for (const marker of card.linkmarkers || []) {
    linkMarker |= LINK_MARKER_BITS[String(marker).toUpperCase().replace(/\s+/g, '')] ?? 0;
  }
  const archetypes = String(card.archetype || '').split(/[,/]/).map((s) => s.trim()).filter(Boolean);
  return {
    code,
    alias: 0,
    setcodes: archetypes.map((a) => resolveSetcode(a).setcode),
    type,
    level: isMonster ? Number(isLink ? card.linkval ?? card.level : card.level) || 0 : 0,
    attribute: isMonster ? attributeBits(card.attribute) : 0,
    race: BigInt(isMonster ? raceBits(card.race) : 0),
    attack: isMonster ? Number(card.atk) || 0 : 0,
    defense: isMonster && !isLink ? Number(card.def) || 0 : 0,
    lscale: Number(card.scale) || 0,
    rscale: Number(card.scale) || 0,
    link_marker: isLink ? linkMarker : 0
  };
}

/**
 * Engine data for every registered custom card, keyed by temp ID and (after a
 * migration) official ID, so a .ydk using either code resolves.
 */
export function loadCustomEngineCards(): Map<number, EngineCardData> {
  const out = new Map<number, EngineCardData>();
  for (const record of listCustomCards()) {
    const codes = [record.tempId, record.officialId].filter((c): c is number => typeof c === 'number' && c > 0);
    for (const code of codes) out.set(code, customCardToEngine(record.cardData, code));
  }
  return out;
}
