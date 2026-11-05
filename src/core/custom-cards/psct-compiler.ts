/**
 * PSCT (Problem-Solving Card Text) compiler: card text -> effect IR -> EDOPro Lua.
 *
 * Custom cards used to get a canned script ("SS itself + search any card")
 * regardless of what the text said. This compiler reads the text the way a
 * scripter does: `condition: cost/target; resolution`, binds once-per-turn
 * clauses to the effect they belong to, maps each clause to the engine idiom
 * used by official ProjectIgnis scripts, and refuses to guess: anything it does
 * not understand becomes a `-- TODO (not understood)` comment and is reported
 * in `unparsed`, so the caller can see exactly what the simulation ignores.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../types/card.js';
import { resolveSetcode, raceConstant, attributeConstant, typeBits } from './engine-data.js';
import { listCustomCards } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CDB_PATH = path.join(ROOT, 'data', 'ocgcore', 'cards.cdb');
const requireCjs = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EffectKind =
  | 'ignition' | 'trigger' | 'quick' | 'activate' | 'continuous'
  | 'summon-procedure' | 'material' | 'restriction' | 'unknown';

export interface PsctEffectReport {
  index: number;
  text: string;
  kind: EffectKind;
  understood: boolean;
  notes: string[];
}

export interface PsctCompileReport {
  lua: string;
  effects: PsctEffectReport[];
  unparsed: string[];
  confidence: 'high' | 'medium' | 'low';
  designWarnings: string[];
  /** Work limits that were hit (text length / effect count); listed in `unparsed` too. */
  limitNotes: string[];
  /** Full intermediate representation, for tests and debugging. */
  ir: EffectIR[];
}

export interface PsctCompileOptions {
  /** Resolve a quoted card name to a passcode. Defaults to registry + cards.cdb. */
  resolveName?: (name: string) => number | null;
}

export interface FilterIR {
  /** Lua predicates over `c` (and `e`), ANDed. */
  lua: string[];
  kind: 'monster' | 'spell' | 'trap' | 'spelltrap' | 'card';
  desc: string;
  /** True when the text names no qualifier at all ("1 card", "1 monster"). */
  generic: boolean;
  excludeSelf: boolean;
  leftovers: string;
}

export interface CostIR {
  kind: 'self_discard' | 'discard' | 'pay_lp' | 'pay_half_lp' | 'self_tribute' | 'tribute'
    | 'self_banish' | 'self_to_grave' | 'detach' | 'self_reveal' | 'banish' | 'send_to_gy';
  count: number;
  amount?: number;
  filter?: FilterIR;
  loc?: string;
  raw: string;
}

export interface TargetIR {
  count: number;
  upTo: boolean;
  filter: FilterIR;
  self: string;
  opp: string;
  raw: string;
}

export type ActionVerb =
  | 'draw' | 'search' | 'add_from_gy' | 'ss_self' | 'ss' | 'destroy' | 'banish' | 'to_hand'
  | 'to_deck' | 'to_grave' | 'foolish' | 'mill' | 'damage' | 'recover' | 'stat'
  | 'negate_effects' | 'negate_activation' | 'negate_effect' | 'negate_summon' | 'set_st' | 'discard';

export interface ActionIR {
  verb: ActionVerb;
  raw: string;
  link: 'first' | 'then' | 'ifyoudo' | 'and' | 'also';
  optional: boolean;
  subject?: 'target' | 'self' | 'chain' | 'all' | 'select';
  count?: number;
  upTo?: boolean;
  filter?: FilterIR;
  locs?: string;
  self?: string;
  opp?: string;
  amount?: number;
  player?: 'tp' | '1-tp';
  stat?: 'ATK' | 'DEF' | 'ATKDEF';
  untilEot?: boolean;
  defense?: boolean;
  negateOnSummon?: boolean;
}

export interface ContinuousIR {
  code: string;
  value: string;
  scope: 'self' | 'field' | 'equip';
  targetSelf?: string;
  targetOpp?: string;
  filter?: FilterIR;
  raw: string;
}

export interface CountLimit {
  kind: 'hopt' | 'soft' | 'oath' | 'duel';
  hoptIndex?: number;
}

export interface EffectIR {
  index: number;
  section: 'monster' | 'pendulum' | 'spell' | 'trap';
  text: string;
  kind: EffectKind;
  luaType: string;
  codes: string[];
  range?: string;
  optional: boolean;
  delay: boolean;
  hintTiming?: string;
  conditions: string[];
  costs: CostIR[];
  target?: TargetIR;
  actions: ActionIR[];
  continuous: ContinuousIR[];
  countLimit?: CountLimit;
  /** Raw Lua lines placed in initial_effect (material procedures, restrictions). */
  initLines: string[];
  helpers: string[];
  understood: boolean;
  notes: string[];
  unparsed: string[];
  /** Internal: this effect responds to a chain link (EVENT_CHAINING). */
  chainResponse?: boolean;
  /** Internal: the cost is a Cost.* helper reference instead of an inline function. */
}

// ---------------------------------------------------------------------------
// Card name -> passcode lookup
// ---------------------------------------------------------------------------

let cdb: any | null | undefined;
const nameCache = new Map<string, number | null>();

function defaultResolveName(name: string): number | null {
  const key = name.toLowerCase();
  if (nameCache.has(key)) return nameCache.get(key)!;
  let found: number | null = null;
  try {
    const custom = listCustomCards().find((r) => r.name.toLowerCase() === key);
    if (custom) found = custom.officialId ?? custom.tempId;
  } catch {
    // Registry unreadable: fall through to cards.cdb.
  }
  if (found === null) {
    try {
      if (cdb === undefined) {
        // createRequire keeps this lookup synchronous so generateLuaScript stays sync.
        const { Database } = requireCjs('node-sqlite3-wasm');
        cdb = fs.existsSync(CDB_PATH) ? new Database(CDB_PATH, { readOnly: true }) : null;
      }
      if (cdb) {
        // Alt-art prints share a name; prefer the original (alias 0, lowest id).
        const row = cdb.get(
          'SELECT t.id AS id FROM texts t JOIN datas d ON d.id = t.id WHERE t.name = ? COLLATE NOCASE ORDER BY (d.alias <> 0), t.id LIMIT 1',
          [name]
        );
        if (row && row.id) found = Number(row.id);
      }
    } catch {
      cdb = null;
    }
  }
  nameCache.set(key, found);
  return found;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/●/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Masks quoted names and parentheticals so punctuation inside them never splits clauses. */
function mask(text: string): { masked: string; unmask: (s: string) => string } {
  const saved: string[] = [];
  const store = (m: string) => {
    saved.push(m);
    return `\u0001${saved.length - 1}\u0001`;
  };
  let masked = text.replace(/"[^"]*"/g, store);
  masked = masked.replace(/\([^()]*\)/g, store);
  const unmask = (s: string): string => {
    let out = s;
    // Parentheticals may contain masked quotes, so unmask until stable.
    for (let i = 0; i < 3 && /\u0001\d{1,7}\u0001/.test(out); i++) {
      out = out.replace(/\u0001(\d{1,7})\u0001/g, (_m, i2) => saved[Number(i2)]);
    }
    return out;
  };
  return { masked, unmask };
}

function splitSentences(text: string): string[] {
  const { masked, unmask } = mask(text);
  return masked
    .split(/(?<=\.)\s+|\n+/)
    .map((s) => unmask(s).trim().replace(/\.$/, '').trim())
    .filter(Boolean);
}

/** Splits at the first top-level occurrence of `sep` (outside quotes/parentheses). */
function splitFirst(text: string, sep: string): [string, string] | null {
  const { masked, unmask } = mask(text);
  const at = masked.indexOf(sep);
  if (at < 0) return null;
  return [unmask(masked.slice(0, at)).trim(), unmask(masked.slice(at + sep.length)).trim()];
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

function parseCount(word: string): number | null {
  const w = word.toLowerCase();
  if (/^\d{1,7}$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

const COUNT_RE = '(up to )?(\\d{1,7}|a|an|one|two|three|four|five)';

/**
 * Text that is safe inside a `-- line comment`: no line breaks or control
 * characters (a newline would end the comment and turn the rest into code),
 * and no long-bracket openers/closers.
 */
export function luaComment(text: string, max = 160): string {
  return String(text)
    // Control characters, U+2028/U+2029 and DEL become spaces (a line break would end the comment).
    .split('').map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : ch;
    }).join('')
    .replace(/\[=*\[|\]=*\]/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** The single escaping helper for Lua string literals (double-quoted). */
export function luaString(text: string): string {
  let out = '"';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\${String(code).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Hard limits: compile work must stay bounded whatever text a caller sends. */
export const PSCT_MAX_DESC_CHARS = 4000;
export const PSCT_MAX_EFFECTS = 12;

// ---------------------------------------------------------------------------
// Card context
// ---------------------------------------------------------------------------

interface Ctx {
  card: Partial<Card>;
  id: number;
  name: string;
  isSpell: boolean;
  isTrap: boolean;
  isMonster: boolean;
  spellKind: 'normal' | 'quickplay' | 'continuous' | 'field' | 'equip' | 'ritual';
  trapKind: 'normal' | 'continuous' | 'counter';
  extra: 'fusion' | 'synchro' | 'xyz' | 'link' | null;
  isRitual: boolean;
  isPendulum: boolean;
  level: number;
  linkval: number;
  resolveName: (name: string) => number | null;
  helperSeq: number;
}

function buildCtx(card: Partial<Card>, id: number, opts: PsctCompileOptions): Ctx {
  const bits = typeBits(card);
  const isSpell = (bits & 0x2) !== 0;
  const isTrap = (bits & 0x4) !== 0;
  const t = `${card.type || ''} ${card.frameType || ''}`.toLowerCase();
  return {
    card,
    id,
    name: card.name || 'Custom Card',
    isSpell,
    isTrap,
    isMonster: !isSpell && !isTrap,
    spellKind: /quick-?play/.test(t) ? 'quickplay' : /continuous/.test(t) ? 'continuous' : /\bfield\b/.test(t)
      ? 'field' : /\bequip\b/.test(t) ? 'equip' : /ritual/.test(t) ? 'ritual' : 'normal',
    trapKind: /counter/.test(t) ? 'counter' : /continuous/.test(t) ? 'continuous' : 'normal',
    extra: (bits & 0x40) ? 'fusion' : (bits & 0x2000) ? 'synchro' : (bits & 0x800000) ? 'xyz' : (bits & 0x4000000) ? 'link' : null,
    isRitual: (bits & 0x80) !== 0 && !isSpell,
    isPendulum: (bits & 0x1000000) !== 0,
    level: Number(card.level) || 0,
    linkval: Number(card.linkval ?? card.level) || 0,
    // Only positive safe integers may ever be spliced into Lua as passcodes.
    resolveName: (name: string) => {
      const code = (opts.resolveName ?? defaultResolveName)(name);
      return typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? code : null;
    },
    helperSeq: 0,
  };
}

function helperName(ctx: Ctx, prefix: string): string {
  ctx.helperSeq += 1;
  return `s.${prefix}${ctx.helperSeq}`;
}

// ---------------------------------------------------------------------------
// Filters ("1 Level 4 or lower "Fiendsmith" monster, except "X"")
// ---------------------------------------------------------------------------

const RACE_WORDS = [
  'Winged Beast', 'Beast-Warrior', 'Sea Serpent', 'Divine-Beast', 'Creator God', 'Spellcaster', 'Warrior',
  'Fairy', 'Fiend', 'Zombie', 'Machine', 'Aqua', 'Pyro', 'Rock', 'Plant', 'Insect', 'Thunder', 'Dragon',
  'Beast', 'Dinosaur', 'Fish', 'Reptile', 'Psychic', 'Wyrm', 'Cyberse', 'Illusion',
];
const RACE_RE = new RegExp(`\\b(${RACE_WORDS.map((r) => r.replace(/-/g, '\\-')).join('|')})(?:-Type)?\\b`, 'g');
const ATTR_RE = /\b(LIGHT|DARK|EARTH|WATER|FIRE|WIND|DIVINE)\b/g;

const MONSTER_TYPE_WORDS: Record<string, string> = {
  effect: 'TYPE_EFFECT', normal: 'TYPE_NORMAL', fusion: 'TYPE_FUSION', synchro: 'TYPE_SYNCHRO', xyz: 'TYPE_XYZ',
  link: 'TYPE_LINK', ritual: 'TYPE_RITUAL', pendulum: 'TYPE_PENDULUM', tuner: 'TYPE_TUNER', flip: 'TYPE_FLIP',
  gemini: 'TYPE_GEMINI', spirit: 'TYPE_SPIRIT', union: 'TYPE_UNION', toon: 'TYPE_TOON',
};

function setcodeExpr(name: string): string {
  const { setcode } = resolveSetcode(name);
  // The archetype name is user text: keep only a harmless character set inside the block comment.
  const label = name.replace(/[^A-Za-z0-9 '&.-]/g, '').replace(/--/g, '-').slice(0, 40);
  return `c:IsSetCard(0x${setcode.toString(16)} --[[${label}]])`;
}

function parseFilter(phrase: string, ctx: Ctx, notes: string[]): FilterIR {
  let p = phrase.trim().replace(/^(?:the|a|an)\s+/i, '');
  const lua: string[] = [];
  let excludeSelf = false;

  // except "X" / except "A" or "B"
  const except = p.match(/,?\s*except\s+((?:"[^"]+"(?:\s*(?:,|or|and)\s*)?)+)\s*$/i);
  if (except) {
    p = p.slice(0, except.index).trim();
    const codes: string[] = [];
    for (const m of except[1].matchAll(/"([^"]+)"/g)) {
      if (m[1].toLowerCase() === ctx.name.toLowerCase()) codes.push('id');
      else {
        const code = ctx.resolveName(m[1]);
        if (code) codes.push(String(code));
        else notes.push(`except "${m[1]}": card name not found, exclusion not enforced`);
      }
    }
    if (codes.length) lua.push(`not c:IsCode(${codes.join(',')})`);
  }

  const stat = p.match(/\s*with (\d{1,7}) or (less|lower|more|higher) (ATK|DEF)\b/i);
  if (stat) {
    p = p.replace(stat[0], ' ').trim();
    const below = /less|lower/i.test(stat[2]);
    const fn = stat[3].toUpperCase() === 'ATK' ? (below ? 'IsAttackBelow' : 'IsAttackAbove') : (below ? 'IsDefenseBelow' : 'IsDefenseAbove');
    lua.push(`c:${fn}(${stat[1]})`);
  }

  if (/\bother\b/i.test(p)) {
    excludeSelf = true;
    p = p.replace(/\bother\b/i, ' ').trim();
  }

  // Card kind from the trailing noun.
  let kind: FilterIR['kind'] = 'card';
  let kindFound = false;
  const tail: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [/\b(?:spell\/trap|spell or trap|spells? and traps?|spell and trap)(?: cards?)?$/i, () => { kind = 'spelltrap'; lua.push('c:IsSpellTrap()'); }],
    [/\b(quick-play|continuous|field|equip|ritual|normal)?\s*spells?(?: cards?)?$/i, (m) => {
      kind = 'spell'; lua.push('c:IsSpell()');
      const sub = (m[1] || '').toLowerCase();
      const map: Record<string, string> = { 'quick-play': 'TYPE_QUICKPLAY', continuous: 'TYPE_CONTINUOUS', field: 'TYPE_FIELD', equip: 'TYPE_EQUIP', ritual: 'TYPE_RITUAL' };
      if (map[sub]) lua.push(`c:IsType(${map[sub]})`);
      if (sub === 'normal') lua.push('c:GetType()==TYPE_SPELL');
    }],
    [/\b(continuous|counter|normal)?\s*traps?(?: cards?)?$/i, (m) => {
      kind = 'trap'; lua.push('c:IsTrap()');
      const sub = (m[1] || '').toLowerCase();
      if (sub === 'continuous') lua.push('c:IsType(TYPE_CONTINUOUS)');
      if (sub === 'counter') lua.push('c:IsType(TYPE_COUNTER)');
      if (sub === 'normal') lua.push('c:GetType()==TYPE_TRAP');
    }],
    [/\b(non-tuner\s+)?(effect|normal|fusion|synchro|xyz|link|ritual|pendulum|tuner|flip|gemini|spirit|union|toon)\s+monsters?$/i, (m) => {
      kind = 'monster'; lua.push('c:IsMonster()');
      if (m[1]) lua.push('not c:IsType(TYPE_TUNER)');
      lua.push(`c:IsType(${MONSTER_TYPE_WORDS[m[2].toLowerCase()]})`);
    }],
    [/\bnon-tuner(?: monsters?)?$/i, () => { kind = 'monster'; lua.push('c:IsMonster()', 'not c:IsType(TYPE_TUNER)'); }],
    [/\btuners?$/i, () => { kind = 'monster'; lua.push('c:IsMonster()', 'c:IsType(TYPE_TUNER)'); }],
    [/\bmonsters?$/i, () => { kind = 'monster'; lua.push('c:IsMonster()'); }],
    [/\bcards?$/i, () => { kind = 'card'; }],
  ];
  for (const [re, apply] of tail) {
    const m = p.match(re);
    if (m) {
      apply(m);
      p = p.slice(0, m.index).trim();
      kindFound = true;
      break;
    }
  }

  // Quoted names: archetype when followed by a kind noun, exact card name otherwise.
  const quoted = [...p.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  p = p.replace(/"[^"]+"/g, ' ').trim();
  if (quoted.length) {
    if (kindFound) {
      const parts = quoted.map((q) => setcodeExpr(q));
      lua.push(parts.length > 1 ? `(${parts.join(' or ')})` : parts[0]);
    } else {
      const codes: string[] = [];
      const unresolved: string[] = [];
      for (const q of quoted) {
        if (q.toLowerCase() === ctx.name.toLowerCase()) codes.push('id');
        else {
          const code = ctx.resolveName(q);
          if (code) codes.push(String(code));
          else unresolved.push(q);
        }
      }
      const parts: string[] = [];
      if (codes.length) parts.push(`c:IsCode(${codes.join(',')})`);
      for (const q of unresolved) {
        // Unknown name: the closest honest reading is "a card of that archetype".
        notes.push(`"${q}" is not a known card name; treated as an archetype`);
        parts.push(setcodeExpr(q));
      }
      lua.push(parts.length > 1 ? `(${parts.join(' or ')})` : parts[0]);
    }
  }

  // Qualifiers.
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = p.match(re);
    if (m) {
      fn(m);
      p = p.replace(m[0], ' ').trim();
    }
  };
  take(/\bface-up\b/i, () => lua.push('c:IsFaceup()'));
  take(/\bface-down\b/i, () => lua.push('c:IsFacedown()'));
  take(/\bnon-tuner\b/i, () => lua.push('not c:IsType(TYPE_TUNER)'));
  take(/\bLevel (\d{1,7}) or (lower|higher|less|more)\b/i, (m) => lua.push(`c:${/lower|less/i.test(m[2]) ? 'IsLevelBelow' : 'IsLevelAbove'}(${m[1]})`));
  take(/\bLevel (\d{1,7})\b/i, (m) => lua.push(`c:IsLevel(${m[1]})`));
  take(/\bRank (\d{1,7}) or (lower|higher|less|more)\b/i, (m) => lua.push(`c:${/lower|less/i.test(m[2]) ? 'IsRankBelow' : 'IsRankAbove'}(${m[1]})`));
  take(/\bRank (\d{1,7})\b/i, (m) => lua.push(`c:IsRank(${m[1]})`));
  take(/\bLink-(\d{1,7}) or (lower|higher)\b/i, (m) => lua.push(`c:${/lower/i.test(m[2]) ? 'IsLinkBelow' : 'IsLinkAbove'}(${m[1]})`));
  take(/\bLink-(\d{1,7})\b/i, (m) => lua.push(`c:IsLink(${m[1]})`));

  const attrs = [...p.matchAll(ATTR_RE)].map((m) => attributeConstant(m[1])).filter(Boolean) as string[];
  if (attrs.length) {
    lua.push(`c:IsAttribute(${attrs.join('|')})`);
    p = p.replace(ATTR_RE, ' ');
  }
  const races = [...p.matchAll(RACE_RE)].map((m) => raceConstant(m[1])).filter(Boolean) as string[];
  if (races.length) {
    lua.push(`c:IsRace(${races.join('|')})`);
    p = p.replace(RACE_RE, ' ');
  }
  // Monster-only qualifiers imply a monster even when the noun was "card".
  if (kind === 'card' && (attrs.length || races.length || /IsLevel|IsRank|IsLink/.test(lua.join(' ')))) {
    kind = 'monster';
    lua.unshift('c:IsMonster()');
  }

  const leftovers = p.replace(/\b(or|and|of|that|is|are|with|the|1|a|an|card|cards)\b|[,/]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (leftovers) notes.push(`filter words not understood: "${leftovers}"`);
  const qualifierCount = lua.filter((l) => !/^c:Is(Monster|SpellTrap|Spell|Trap)\(\)$/.test(l)).length;
  return {
    lua,
    kind,
    desc: phrase.trim(),
    generic: qualifierCount === 0 && !leftovers,
    excludeSelf,
    leftovers,
  };
}

function filterBody(f: FilterIR | undefined, extra: string[] = []): string {
  const parts = [...(f?.lua ?? []), ...(f?.excludeSelf ? ['c~=e:GetHandler()'] : []), ...extra];
  return parts.length ? parts.join(' and ') : 'true';
}

// ---------------------------------------------------------------------------
// Zones ("your opponent controls", "in your GY", "from your hand or GY")
// ---------------------------------------------------------------------------

function parseLocations(text: string): string | null {
  const t = text.toLowerCase();
  const locs: string[] = [];
  if (/extra deck/.test(t)) locs.push('LOCATION_EXTRA');
  if (/\bdeck\b/.test(t.replace(/extra deck/g, ''))) locs.push('LOCATION_DECK');
  if (/\bhand\b/.test(t)) locs.push('LOCATION_HAND');
  if (/\bgy\b|graveyard/.test(t)) locs.push('LOCATION_GRAVE');
  if (/banish/.test(t)) locs.push('LOCATION_REMOVED');
  if (/\bfield\b/.test(t)) locs.push('LOCATION_ONFIELD');
  return locs.length ? locs.join('|') : null;
}

function fieldLoc(kind: FilterIR['kind']): string {
  if (kind === 'monster') return 'LOCATION_MZONE';
  if (kind === 'spell' || kind === 'trap' || kind === 'spelltrap') return 'LOCATION_SZONE';
  return 'LOCATION_ONFIELD';
}

interface Zone {
  phrase: string;
  self: string;
  opp: string;
}

/** Splits "<filter> <zone>" for things on the field / in GYs. */
function parseZone(text: string, ctx: Ctx, notes: string[]): { zone: Zone; filter: FilterIR } | null {
  const forms: Array<[RegExp, (f: FilterIR) => [string, string]]> = [
    [/^(.+?) (?:that )?your opponent controls$/i, (f) => ['0', fieldLoc(f.kind)]],
    [/^(.+?) on your opponent's field$/i, (f) => ['0', fieldLoc(f.kind)]],
    [/^(.+?) (?:that )?you control$/i, (f) => [fieldLoc(f.kind), '0']],
    [/^(.+?) on the field$/i, (f) => [fieldLoc(f.kind), fieldLoc(f.kind)]],
    [/^(.+?) in your opponent's (?:GY|Graveyard)$/i, () => ['0', 'LOCATION_GRAVE']],
    [/^(.+?) in (?:either|each) (?:player's )?(?:GY|Graveyard)$/i, () => ['LOCATION_GRAVE', 'LOCATION_GRAVE']],
    [/^(.+?) in your (?:GY|Graveyard)$/i, () => ['LOCATION_GRAVE', '0']],
    [/^(.+?) in your hand$/i, () => ['LOCATION_HAND', '0']],
    [/^(.+?) (?:that (?:is|are) )?banished$/i, () => ['LOCATION_REMOVED', 'LOCATION_REMOVED']],
    [/^(?:\d{1,7} )?of your banished (.+)$/i, () => ['LOCATION_REMOVED', '0']],
  ];
  for (const [re, locs] of forms) {
    const m = text.trim().match(re);
    if (!m) continue;
    const filter = parseFilter(m[1], ctx, notes);
    const [self, opp] = locs(filter);
    return { zone: { phrase: m[0], self, opp }, filter };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conditions ("If you control no monsters, or control a LIGHT Fiend monster")
// ---------------------------------------------------------------------------

interface ConditionResult {
  exprs: string[];
  range?: string;
  understood: boolean;
  unparsed: string[];
}

function parseConditionClause(clause: string, ctx: Ctx, eff: EffectIR, subject: 'you' | 'opp'): string | 'range-hand' | 'range-grave' | 'range-field' | null {
  let t = clause.trim().replace(/^(?:if|while|when)\s+/i, '').replace(/,$/, '').trim();
  const lower = t.toLowerCase();
  if (/^this card is in your (?:gy|graveyard)$/.test(lower)) return 'range-grave';
  if (/^this card is in your hand$/.test(lower)) return 'range-hand';
  if (/^this card is (?:face-up )?(?:on the field|in your monster zone)$/.test(lower)) return 'range-field';
  if (/^during your main phase$/.test(lower)) return 'true';
  if (/^during the main phase$/.test(lower)) return 'Duel.IsMainPhase()';
  if (/^during your opponent's main phase$/.test(lower)) return 'Duel.IsMainPhase() and Duel.GetTurnPlayer()==1-tp';
  if (/^during your opponent's turn$/.test(lower)) return 'Duel.GetTurnPlayer()==1-tp';
  if (/^during your turn$/.test(lower)) return 'Duel.GetTurnPlayer()==tp';
  if (/^during the battle phase$/.test(lower)) return 'Duel.IsBattlePhase()';
  if (/^it is your opponent's turn$/.test(lower)) return 'Duel.GetTurnPlayer()==1-tp';

  // Subject: "you control" / "your opponent controls" / bare "control" inherits.
  let who = subject;
  if (/^your opponent\b/i.test(t)) {
    who = 'opp';
    t = t.replace(/^your opponent\s+/i, '');
  } else if (/^you\s+/i.test(t)) {
    who = 'you';
    t = t.replace(/^you\s+/i, '');
  }
  const l = t.toLowerCase();
  const [selfLoc, oppLoc] = who === 'you' ? ['LOCATION_MZONE', '0'] : ['0', 'LOCATION_MZONE'];
  if (/^controls? no monsters$/.test(l)) return `Duel.GetFieldGroupCount(tp,${selfLoc},${oppLoc})==0`;
  if (/^controls? no cards$/.test(l)) return `Duel.GetFieldGroupCount(tp,${who === 'you' ? 'LOCATION_ONFIELD,0' : '0,LOCATION_ONFIELD'})==0`;
  if (/^controls? more monsters than you(?: do)?$/.test(l)) return 'Duel.GetFieldGroupCount(tp,0,LOCATION_MZONE)>Duel.GetFieldGroupCount(tp,LOCATION_MZONE,0)';
  if (/^controls? (?:a|an) monster$/.test(l)) return `Duel.GetFieldGroupCount(tp,${selfLoc},${oppLoc})>0`;
  if (/^(?:have|has) no cards in (?:your|their) hand$/.test(l)) return `Duel.GetFieldGroupCount(tp,${who === 'you' ? 'LOCATION_HAND,0' : '0,LOCATION_HAND'})==0`;
  const lp = l.match(/^(?:have|has) (\d{1,7}) or less lp$/) || l.match(/^lp (?:is|are) (\d{1,7}) or less$/);
  if (lp) return `Duel.GetLP(${who === 'you' ? 'tp' : '1-tp'})<=${lp[1]}`;
  if (/^(?:r )?lp (?:is|are) lower than your opponent's$/.test(l) || /^(?:have|has) less lp than your opponent$/.test(l)) return 'Duel.GetLP(tp)<Duel.GetLP(1-tp)';
  const ctl = t.match(/^controls? (?:a|an|another|1|at least 1) (.+)$/i);
  if (ctl) {
    const notes: string[] = [];
    const f = parseFilter(ctl[1], ctx, notes);
    if (notes.length) {
      eff.notes.push(...notes);
      return null;
    }
    const loc = fieldLoc(f.kind);
    const name = helperName(ctx, 'cfilter');
    eff.helpers.push(`function ${name}(c,e,tp)\n\treturn c:IsFaceup() and ${filterBody(f)}\nend`);
    const [s, o] = who === 'you' ? [loc, '0'] : ['0', loc];
    return `Duel.IsExistingMatchingCard(${name},tp,${s},${o},1,${f.excludeSelf ? 'e:GetHandler()' : 'nil'},e,tp)`;
  }
  const gy = clause.match(/^(?:if |while )?(?:there is |there are )?(?:a|an|1|at least 1) (.+?) (?:is )?in your (?:GY|Graveyard)$/i);
  if (gy) {
    const notes: string[] = [];
    const f = parseFilter(gy[1], ctx, notes);
    if (notes.length) return null;
    const name = helperName(ctx, 'cfilter');
    eff.helpers.push(`function ${name}(c,e,tp)\n\treturn ${filterBody(f)}\nend`);
    return `Duel.IsExistingMatchingCard(${name},tp,LOCATION_GRAVE,0,1,nil,e,tp)`;
  }
  return null;
}

function parseCondition(text: string, ctx: Ctx, eff: EffectIR): ConditionResult {
  const result: ConditionResult = { exprs: [], understood: true, unparsed: [] };
  if (!text.trim()) return result;
  const { masked, unmask } = mask(text);
  // OR-groups first ("..., or control a LIGHT Fiend monster"), then AND inside each.
  const orParts = masked.split(/,\s*or\s+|\s+or\s+(?=(?:if\s+)?(?:you|your opponent|control|controls|have|has)\b)/i).map(unmask);
  const orExprs: string[] = [];
  for (const part of orParts) {
    const andParts = mask(part).masked.split(/,?\s+and\s+(?=(?:if\s+)?(?:you|your opponent|control|controls|have|has|this card|it is)\b)/i);
    const um = mask(part).unmask;
    const andExprs: string[] = [];
    for (const raw of andParts) {
      const clause = um(raw);
      const r = parseConditionClause(clause, ctx, eff, 'you');
      if (r === null) {
        result.understood = false;
        result.unparsed.push(clause.trim());
      } else if (r === 'range-hand') result.range = 'LOCATION_HAND';
      else if (r === 'range-grave') result.range = 'LOCATION_GRAVE';
      else if (r === 'range-field') result.range = 'LOCATION_MZONE';
      else if (r !== 'true') andExprs.push(r);
    }
    if (andExprs.length) orExprs.push(andExprs.length > 1 ? `(${andExprs.join(' and ')})` : andExprs[0]);
  }
  if (orExprs.length === 1) result.exprs.push(orExprs[0]);
  else if (orExprs.length > 1) result.exprs.push(`(${orExprs.join(' or ')})`);
  return result;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

interface TriggerMatch {
  codes: string[];
  scope: 'single' | 'field' | 'chain' | 'flip';
  conditions: string[];
  /** Spell/Trap negation of a Summon. */
  summonNegation?: boolean;
}

const SUMMON_TYPE: Record<string, string> = {
  fusion: 'SUMMON_TYPE_FUSION', synchro: 'SUMMON_TYPE_SYNCHRO', xyz: 'SUMMON_TYPE_XYZ', link: 'SUMMON_TYPE_LINK',
  ritual: 'SUMMON_TYPE_RITUAL', pendulum: 'SUMMON_TYPE_PENDULUM',
};
const REASON_TYPE: Record<string, string> = {
  fusion: 'REASON_FUSION', synchro: 'REASON_SYNCHRO', xyz: 'REASON_XYZ', link: 'REASON_LINK', ritual: 'REASON_RITUAL',
};

function parseTrigger(text: string): TriggerMatch | null {
  const t = text.trim().replace(/^(?:if|when)\s+/i, '').replace(/,$/, '').toLowerCase();
  const single = (codes: string[], conditions: string[] = []): TriggerMatch => ({ codes, scope: 'single', conditions });
  let m: RegExpMatchArray | null;
  if (/^this card is normal or special summoned$/.test(t)) return single(['EVENT_SUMMON_SUCCESS', 'EVENT_SPSUMMON_SUCCESS']);
  if (/^this card is normal or flip summoned$/.test(t)) return single(['EVENT_SUMMON_SUCCESS', 'EVENT_FLIP_SUMMON_SUCCESS']);
  if (/^this card is summoned$/.test(t)) return single(['EVENT_SUMMON_SUCCESS', 'EVENT_FLIP_SUMMON_SUCCESS', 'EVENT_SPSUMMON_SUCCESS']);
  if (/^this card is normal summoned$/.test(t)) return single(['EVENT_SUMMON_SUCCESS']);
  if (/^this card is flip summoned$/.test(t)) return single(['EVENT_FLIP_SUMMON_SUCCESS']);
  if ((m = t.match(/^this card is special summoned(?: from (?:the|your) (hand|gy|graveyard|deck|extra deck))?$/))) {
    const loc = m[1] ? parseLocations(m[1]) : null;
    return single(['EVENT_SPSUMMON_SUCCESS'], loc ? [`e:GetHandler():IsSummonLocation(${loc})`] : []);
  }
  if ((m = t.match(/^this card is (fusion|synchro|xyz|link|ritual|pendulum) summoned$/))) {
    return single(['EVENT_SPSUMMON_SUCCESS'], [`e:GetHandler():IsSummonType(${SUMMON_TYPE[m[1]]})`]);
  }
  if (/^this card is sent to the (?:gy|graveyard)$/.test(t)) return single(['EVENT_TO_GRAVE']);
  if (/^this card is sent from the field to the (?:gy|graveyard)$/.test(t)) return single(['EVENT_TO_GRAVE'], ['e:GetHandler():IsPreviousLocation(LOCATION_ONFIELD)']);
  if (/^this card is sent from the hand to the (?:gy|graveyard)$/.test(t)) return single(['EVENT_TO_GRAVE'], ['e:GetHandler():IsPreviousLocation(LOCATION_HAND)']);
  if (/^this card is sent to the (?:gy|graveyard) by (?:a )?card effect$/.test(t)) return single(['EVENT_TO_GRAVE'], ['r&REASON_EFFECT~=0']);
  if (/^this card is destroyed by battle$/.test(t)) return single(['EVENT_BATTLE_DESTROYED']);
  if (/^this card is destroyed by battle or (?:a )?card effect$/.test(t)) return single(['EVENT_DESTROYED'], ['r&(REASON_BATTLE|REASON_EFFECT)~=0']);
  if (/^this card is destroyed by (?:a )?card effect$/.test(t)) return single(['EVENT_DESTROYED'], ['r&REASON_EFFECT~=0']);
  if (/^this card (?:in your possession )?is destroyed by (?:an |your )?opponent's card(?: effect)?$/.test(t)) {
    return single(['EVENT_DESTROYED'], ['rp==1-tp', 'e:GetHandler():IsPreviousControler(tp)']);
  }
  if (/^this card is destroyed$/.test(t)) return single(['EVENT_DESTROYED']);
  if ((m = t.match(/^this card destroys (an opponent's|your opponent's|a|an) monster by battle(?: and sends it to the (?:gy|graveyard))?$/))) {
    return single(['EVENT_BATTLE_DESTROYING'], [/opponent/.test(m[1]) ? 'aux.bdocon(e,tp,eg,ep,ev,re,r,rp)' : 'aux.bdcon(e,tp,eg,ep,ev,re,r,rp)']);
  }
  if (/^this card inflicts battle damage to your opponent$/.test(t)) return single(['EVENT_BATTLE_DAMAGE'], ['ep==1-tp']);
  if (/^this card declares an attack$/.test(t)) return single(['EVENT_ATTACK_ANNOUNCE']);
  if (/^this card is banished$/.test(t)) return single(['EVENT_REMOVE']);
  if (/^this card is tributed$/.test(t)) return single(['EVENT_RELEASE']);
  if (/^this card is flipped face-up$/.test(t)) return single(['EVENT_FLIP']);
  if ((m = t.match(/^this card is (sent to the (?:gy|graveyard)|used) as (?:a )?material for an? (fusion|synchro|xyz|link|ritual) summon$/))) {
    const conds = [`r==${REASON_TYPE[m[2]]}`];
    if (m[1].startsWith('sent')) conds.unshift('e:GetHandler():IsLocation(LOCATION_GRAVE)');
    return single(['EVENT_BE_MATERIAL'], conds);
  }

  // Chain responses.
  m = t.match(/^(?:your opponent activates (?:a|an) (.+?)|(?:a|an) (.+?) is activated)(?: that targets? (this card|a card you control|a monster you control))?$/);
  if (m) {
    const what = (m[1] || m[2] || '').trim();
    const conds: string[] = [];
    if (m[1]) conds.push('rp==1-tp');
    const typeCond: Record<string, string> = {
      'card or effect': '',
      'monster effect': 're:IsMonsterEffect()',
      'spell card': 're:IsHasType(EFFECT_TYPE_ACTIVATE) and re:IsActiveType(TYPE_SPELL)',
      'trap card': 're:IsHasType(EFFECT_TYPE_ACTIVATE) and re:IsActiveType(TYPE_TRAP)',
      'spell/trap card': 're:IsHasType(EFFECT_TYPE_ACTIVATE) and re:IsActiveType(TYPE_SPELL|TYPE_TRAP)',
      'spell card or effect': 're:IsActiveType(TYPE_SPELL)',
      'trap card or effect': 're:IsActiveType(TYPE_TRAP)',
      'spell/trap card or effect': 're:IsActiveType(TYPE_SPELL|TYPE_TRAP)',
      'spell/trap card, or monster effect': '',
    };
    if (!(what in typeCond)) return null;
    if (typeCond[what]) conds.push(typeCond[what]);
    if (m[3]) {
      const tgt = m[3] === 'this card'
        ? 'Duel.GetChainInfo(ev,CHAININFO_TARGET_CARDS):IsContains(e:GetHandler())'
        : `Duel.GetChainInfo(ev,CHAININFO_TARGET_CARDS):IsExists(function(tc) return tc:IsControler(tp) and tc:IsOnField()${m[3].includes('monster') ? ' and tc:IsLocation(LOCATION_MZONE)' : ''} end,1,nil)`;
      conds.push('re:IsHasProperty(EFFECT_FLAG_CARD_TARGET)', tgt);
    }
    return { codes: ['EVENT_CHAINING'], scope: 'chain', conditions: conds };
  }
  if (/^(?:an opponent's|your opponent's) monster declares an attack$/.test(t)) {
    return { codes: ['EVENT_ATTACK_ANNOUNCE'], scope: 'field', conditions: ['Duel.GetAttacker():IsControler(1-tp)'] };
  }
  if (/^(?:an opponent's|your opponent's) monster declares a direct attack$/.test(t)) {
    return { codes: ['EVENT_ATTACK_ANNOUNCE'], scope: 'field', conditions: ['Duel.GetAttacker():IsControler(1-tp)', 'Duel.GetAttackTarget()==nil'] };
  }
  if ((m = t.match(/^your opponent (normal or special|normal|special) summons? (?:a monster|monsters?|a monster\(s\))$/))) {
    const codes = m[1] === 'normal' ? ['EVENT_SUMMON_SUCCESS'] : m[1] === 'special' ? ['EVENT_SPSUMMON_SUCCESS'] : ['EVENT_SUMMON_SUCCESS', 'EVENT_SPSUMMON_SUCCESS'];
    return { codes, scope: 'field', conditions: ['eg:IsExists(Card.IsSummonPlayer,1,nil,1-tp)'] };
  }
  if ((m = t.match(/^(?:a monster|your opponent) would (?:be )?(normal or special |special |normal )?summon(?:ed| a monster)?$/))) {
    const kind = (m[1] || '').trim();
    const codes = kind === 'normal' ? ['EVENT_SUMMON'] : kind === 'special' ? ['EVENT_SPSUMMON'] : ['EVENT_SUMMON', 'EVENT_FLIP_SUMMON', 'EVENT_SPSUMMON'];
    const conds = ['Duel.GetCurrentChain(true)==0'];
    if (/opponent/.test(t)) conds.push('ep==1-tp');
    return { codes, scope: 'field', conditions: conds, summonNegation: true };
  }
  if ((m = t.match(/^during (?:the|each|your|your opponent's) (end|standby) phase$/))) {
    const conds: string[] = [];
    if (/during your opponent's/.test(t)) conds.push('Duel.GetTurnPlayer()==1-tp');
    else if (/during your /.test(t)) conds.push('Duel.GetTurnPlayer()==tp');
    return { codes: [`EVENT_PHASE+PHASE_${m[1].toUpperCase()}`], scope: 'field', conditions: conds };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

function parseCost(raw: string, ctx: Ctx, eff: EffectIR): CostIR | null {
  const t = raw.trim().replace(/^you can\s+/i, '').replace(/,$/, '');
  const l = t.toLowerCase();
  let m: RegExpMatchArray | null;
  if (/^discard this card$/.test(l)) return { kind: 'self_discard', count: 1, raw };
  if (/^reveal this card(?: in your hand)?$/.test(l)) return { kind: 'self_reveal', count: 1, raw };
  if (/^tribute this card$/.test(l)) return { kind: 'self_tribute', count: 1, raw };
  if (/^banish this card from (?:your|the) (?:gy|graveyard)$/.test(l)) return { kind: 'self_banish', count: 1, loc: 'LOCATION_GRAVE', raw };
  if (/^banish this card(?: from your hand)?$/.test(l)) return { kind: 'self_banish', count: 1, raw };
  if (/^send this card(?: from (?:the field|your hand))? to the (?:gy|graveyard)$/.test(l)) return { kind: 'self_to_grave', count: 1, raw };
  if ((m = l.match(/^pay (\d{1,7}) lp$/))) return { kind: 'pay_lp', count: 1, amount: Number(m[1]), raw };
  if (/^pay half your lp$/.test(l)) return { kind: 'pay_half_lp', count: 1, raw };
  if ((m = l.match(/^detach (\d{1,7}|a|an|one|two|three) (?:xyz )?materials? from this card$/))) {
    return { kind: 'detach', count: parseCount(m[1]) || 1, raw };
  }
  const notes: string[] = [];
  if ((m = t.match(/^discard (\d{1,7}|a|an|one|two|three) (.+)$/i))) {
    const f = parseFilter(m[2], ctx, notes);
    eff.notes.push(...notes);
    return { kind: 'discard', count: parseCount(m[1]) || 1, filter: f, raw };
  }
  if ((m = t.match(/^tribute (\d{1,7}|a|an|one|two|three) (.+)$/i))) {
    const f = parseFilter(m[2].replace(/\s+you control$/i, ''), ctx, notes);
    eff.notes.push(...notes);
    return { kind: 'tribute', count: parseCount(m[1]) || 1, filter: f, raw };
  }
  if ((m = t.match(/^banish (\d{1,7}|a|an|one|two|three) (.+?) from your (.+)$/i))) {
    const f = parseFilter(m[2], ctx, notes);
    eff.notes.push(...notes);
    return { kind: 'banish', count: parseCount(m[1]) || 1, filter: f, loc: parseLocations(m[3]) || 'LOCATION_GRAVE', raw };
  }
  if ((m = t.match(/^send (\d{1,7}|a|an|one|two|three) (.+?) from your (.+?) to the (?:GY|Graveyard)$/i))) {
    const f = parseFilter(m[2], ctx, notes);
    eff.notes.push(...notes);
    const loc = (parseLocations(m[3]) || 'LOCATION_HAND').replace('LOCATION_ONFIELD', f.kind === 'monster' ? 'LOCATION_MZONE' : 'LOCATION_ONFIELD');
    return { kind: 'send_to_gy', count: parseCount(m[1]) || 1, filter: f, loc, raw };
  }
  return null;
}

function parseTargetClause(raw: string, ctx: Ctx, eff: EffectIR): TargetIR | null {
  const m = raw.trim().replace(/^you can\s+/i, '').match(new RegExp(`^target ${COUNT_RE} (.+)$`, 'i'));
  if (!m) return null;
  const notes: string[] = [];
  const z = parseZone(m[3], ctx, notes);
  if (!z) return null;
  eff.notes.push(...notes);
  return { count: parseCount(m[2]) || 1, upTo: !!m[1], filter: z.filter, self: z.zone.self, opp: z.zone.opp, raw };
}

// ---------------------------------------------------------------------------
// Actions (resolution)
// ---------------------------------------------------------------------------

const PRONOUN_RE = /^(?:it|them|that target|those targets|that card|that monster|those cards|those monsters|the targeted (?:card|monster)|that face-up (?:card|monster))$/i;

function subjectOf(text: string, ctx: Ctx, eff: EffectIR, notes: string[]): Partial<ActionIR> | null {
  const t = text.trim();
  if (/^this card$/i.test(t)) return { subject: 'self' };
  if (PRONOUN_RE.test(t)) {
    if (eff.target) return { subject: 'target' };
    if (eff.chainResponse) return { subject: 'chain' };
    return null;
  }
  let m = t.match(/^all (.+)$/i);
  if (m) {
    const z = parseZone(m[1], ctx, notes);
    if (!z) return null;
    return { subject: 'all', filter: z.filter, self: z.zone.self, opp: z.zone.opp };
  }
  m = t.match(new RegExp(`^${COUNT_RE} (.+)$`, 'i'));
  if (m) {
    const z = parseZone(m[3], ctx, notes);
    if (!z) return null;
    return { subject: 'select', count: parseCount(m[2]) || 1, upTo: !!m[1], filter: z.filter, self: z.zone.self, opp: z.zone.opp };
  }
  return null;
}

function parseAction(rawIn: string, link: ActionIR['link'], ctx: Ctx, eff: EffectIR): ActionIR | null {
  let raw = rawIn.trim().replace(/[.,]$/, '').trim();
  let optional = false;
  if (/^you can\s+/i.test(raw)) {
    optional = link !== 'first';
    raw = raw.replace(/^you can\s+/i, '');
  }
  const base: Pick<ActionIR, 'raw' | 'link' | 'optional'> = { raw: rawIn.trim(), link, optional };
  const notes: string[] = [];
  const done = (a: Omit<ActionIR, 'raw' | 'link' | 'optional'>): ActionIR => {
    eff.notes.push(...notes);
    return { ...base, ...a } as ActionIR;
  };
  let m: RegExpMatchArray | null;

  // Pull ", except "X"" off the end so it reaches the filter.
  let exceptTail = '';
  const ex = raw.match(/,?\s*except\s+("[^"]+"(?:\s*(?:,|or|and)\s*"[^"]+")*)\s*$/i);
  if (ex) {
    exceptTail = `, except ${ex[1]}`;
    raw = raw.slice(0, ex.index).trim();
  }
  let defense = false;
  if (/\s+in (?:face-up )?defense position/i.test(raw)) {
    defense = true;
    raw = raw.replace(/\s+in (?:face-up )?defense position/i, '');
  }
  let negateOnSummon = false;
  if (/,?\s*but (?:its effects are negated|negate its effects)$/i.test(raw)) {
    negateOnSummon = true;
    raw = raw.replace(/,?\s*but (?:its effects are negated|negate its effects)$/i, '');
  }
  const untilEot = /\s+until the end of (?:this|the|your opponent's|your) turn$/i.test(raw);
  raw = raw.replace(/\s+until the end of (?:this|the|your opponent's|your) turn$/i, '');
  const l = raw.toLowerCase();

  if ((m = l.match(/^draw (\d{1,7}|a|an|one|two|three) cards?$/))) return done({ verb: 'draw', count: parseCount(m[1]) || 1, player: 'tp' });
  if ((m = l.match(/^(?:your opponent|each player) draws (\d{1,7}|a|an|one|two) cards?$/))) return null;
  if ((m = l.match(/^inflict (\d{1,7}) damage to your opponent$/))) return done({ verb: 'damage', amount: Number(m[1]), player: '1-tp' });
  if ((m = l.match(/^(?:you )?take (\d{1,7}) damage$/))) return done({ verb: 'damage', amount: Number(m[1]), player: 'tp' });
  if ((m = l.match(/^(?:you )?gain (\d{1,7}) (?:lp|life points)$/))) return done({ verb: 'recover', amount: Number(m[1]), player: 'tp' });
  if ((m = l.match(/^send the top (\d{1,7}|a|one|two|three) cards? of (your|your opponent's) deck to the (?:gy|graveyard)$/))) {
    return done({ verb: 'mill', count: parseCount(m[1]) || 1, player: m[2] === 'your' ? 'tp' : '1-tp' });
  }
  if ((m = l.match(/^discard (\d{1,7}|a|an|one|two) cards?$/))) return done({ verb: 'discard', count: parseCount(m[1]) || 1 });
  if (/^negate the activation$/.test(l)) return eff.chainResponse ? done({ verb: 'negate_activation', subject: 'chain' }) : null;
  if (/^negate (?:that|the|its) effect$|^negate that card's effect$|^negate the effect$/.test(l)) return eff.chainResponse ? done({ verb: 'negate_effect', subject: 'chain' }) : null;
  if (/^negate the summon$/.test(l)) return done({ verb: 'negate_summon', subject: 'chain' });
  if (/^negate (?:its effects|the effects of (?:that|the) (?:target|targeted card|card|monster|face-up card|face-up monster)|that target's effects|their effects)$/.test(l)) {
    return eff.target ? done({ verb: 'negate_effects', subject: 'target', untilEot }) : null;
  }

  // add ... to your hand
  if ((m = raw.match(/^add (.+?) to (?:your|the|its owner's|their owner's) hand$/i))) {
    const what = m[1].trim();
    const loc = what.match(new RegExp(`^${COUNT_RE} (.+?) from your (.+)$`, 'i'));
    if (loc) {
      const f = parseFilter(loc[3] + exceptTail, ctx, notes);
      const locs = parseLocations(loc[4]);
      if (!locs) return null;
      return done({ verb: locs.includes('LOCATION_DECK') ? 'search' : 'add_from_gy', count: parseCount(loc[2]) || 1, upTo: !!loc[1], filter: f, locs });
    }
    const banished = what.match(new RegExp(`^${COUNT_RE} of your banished (.+)$`, 'i'));
    if (banished) {
      return done({ verb: 'add_from_gy', count: parseCount(banished[2]) || 1, upTo: !!banished[1], filter: parseFilter(banished[3] + exceptTail, ctx, notes), locs: 'LOCATION_REMOVED' });
    }
    const subj = subjectOf(what, ctx, eff, notes);
    if (subj) return done({ verb: 'to_hand', ...subj });
    return null;
  }

  // Special Summon
  if ((m = raw.match(/^special summon this card(?:\s*\(from your (hand|gy|graveyard)\)|\s+from your (hand|gy|graveyard))?$/i))) {
    return done({ verb: 'ss_self', subject: 'self', defense });
  }
  if ((m = raw.match(new RegExp(`^special summon ${COUNT_RE} (.+?) from your (.+)$`, 'i')))) {
    const locs = parseLocations(m[4]);
    if (!locs || locs.includes('LOCATION_EXTRA')) return null;
    return done({ verb: 'ss', subject: 'select', count: parseCount(m[2]) || 1, upTo: !!m[1], filter: parseFilter(m[3] + exceptTail, ctx, notes), locs, defense, negateOnSummon });
  }
  if ((m = raw.match(/^special summon (.+)$/i))) {
    const subj = subjectOf(m[1], ctx, eff, notes);
    if (subj && subj.subject === 'target') return done({ verb: 'ss', ...subj, defense, negateOnSummon });
    return null;
  }

  // Set a Spell/Trap
  if ((m = raw.match(new RegExp(`^set ${COUNT_RE} (.+?) (?:directly )?from your (deck|gy|graveyard|hand|deck or gy)(?: to your field)?$`, 'i')))) {
    const f = parseFilter(m[3] + exceptTail, ctx, notes);
    if (f.kind === 'monster') return null;
    return done({ verb: 'set_st', count: parseCount(m[2]) || 1, filter: f, locs: parseLocations(m[4]) || 'LOCATION_DECK' });
  }

  // send ... from your Deck to the GY  (foolish)  /  send it to the GY
  if ((m = raw.match(new RegExp(`^send ${COUNT_RE} (.+?) from your (deck|hand|extra deck|deck or extra deck|hand or deck) to the (?:gy|graveyard)$`, 'i')))) {
    return done({ verb: 'foolish', subject: 'select', count: parseCount(m[2]) || 1, upTo: !!m[1], filter: parseFilter(m[3] + exceptTail, ctx, notes), locs: parseLocations(m[4]) || 'LOCATION_DECK' });
  }

  // Generic movers: destroy / banish / return / shuffle / send
  const movers: Array<[RegExp, ActionVerb]> = [
    [/^destroy (.+)$/i, 'destroy'],
    [/^banish (.+?)(?:,? face-up)?$/i, 'banish'],
    [/^return (.+?) to (?:the|its owner's|their owners'?|your|the owner's) hands?$/i, 'to_hand'],
    [/^(?:shuffle|return) (.+?) into (?:the|its owner's|their owners'?|your) decks?$/i, 'to_deck'],
    [/^return (.+?) to the deck$/i, 'to_deck'],
    [/^send (.+?) to the (?:gy|graveyard)$/i, 'to_grave'],
  ];
  for (const [re, verb] of movers) {
    const mm = raw.match(re);
    if (!mm) continue;
    if (verb === 'banish' && /face-down/i.test(mm[1])) return null;
    const subj = subjectOf(mm[1] + exceptTail, ctx, eff, notes);
    if (!subj) return null;
    return done({ verb, ...subj });
  }

  // ATK/DEF changes
  m = raw.match(/^(this card|it|that target|that monster|the targeted monster|all (.+?)) (gains?|loses?) (\d{1,7}) (ATK\/DEF|ATK and DEF|ATK|DEF)$/i);
  if (m) {
    const amount = Number(m[4]) * (/^lose/i.test(m[3]) ? -1 : 1);
    const stat = /\/|and/.test(m[5]) ? 'ATKDEF' : (m[5].toUpperCase() as 'ATK' | 'DEF');
    if (/^this card$/i.test(m[1])) return done({ verb: 'stat', subject: 'self', amount, stat, untilEot });
    if (m[2]) {
      const z = parseZone(m[2], ctx, notes);
      if (!z) return null;
      return done({ verb: 'stat', subject: 'all', filter: z.filter, self: z.zone.self, opp: z.zone.opp, amount, stat, untilEot });
    }
    if (eff.target) return done({ verb: 'stat', subject: 'target', amount, stat, untilEot });
    return null;
  }
  return null;
}

/** Splits a resolution into linked actions ("A, then B", "A, and if you do, B", "A. Also, B"). */
function splitActions(text: string): Array<{ text: string; link: ActionIR['link'] }> {
  const { masked, unmask } = mask(text);
  const SEP = /(\s*,?\s*and if you do,?\s*|\.\s*if you do,?\s*|\.\s*then,?\s*|,?\s*then,?\s+|\.\s*also,?\s*|,\s*also,?\s*|\s*,?\s*and\s+(?=(?:draw|destroy|banish|add|special summon|inflict|gain|send|shuffle|return|negate|set|discard|you gain|take|this card gains|it gains)\b)|\.\s+)/i;
  const parts = masked.split(SEP);
  const out: Array<{ text: string; link: ActionIR['link'] }> = [];
  let link: ActionIR['link'] = 'first';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const sep = parts[i].toLowerCase();
      link = sep.includes('if you do') ? 'ifyoudo' : sep.includes('then') ? 'then' : sep.includes('also') ? 'also' : /\band\b/.test(sep) ? 'and' : 'also';
      continue;
    }
    const piece = unmask(parts[i]).trim();
    if (piece) out.push({ text: piece, link: out.length === 0 ? 'first' : link });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Continuous effects
// ---------------------------------------------------------------------------

function parseContinuous(text: string, ctx: Ctx, eff: EffectIR): ContinuousIR[] | null {
  const raw = text.trim();
  const l = raw.toLowerCase().replace(/^(?:this card )?(?:also )?/, (s) => s);
  const notes: string[] = [];
  const self = (code: string, value = '1'): ContinuousIR => ({ code, value, scope: 'self', raw });
  let m: RegExpMatchArray | null;

  if ((m = l.match(/^(?:this card )?cannot be (targeted or destroyed|destroyed or targeted|targeted|destroyed) by (battle or card effects|battle or your opponent's card effects|battle|card effects|your opponent's card effects)$/))) {
    const out: ContinuousIR[] = [];
    const targeted = /targeted/.test(m[1]);
    const destroyed = /destroyed/.test(m[1]);
    const opp = /opponent/.test(m[2]);
    if (destroyed && /battle/.test(m[2])) out.push(self('EFFECT_INDESTRUCTABLE_BATTLE'));
    if (destroyed && /effects/.test(m[2])) out.push(self('EFFECT_INDESTRUCTABLE_EFFECT', opp ? 'aux.indoval' : '1'));
    if (targeted) out.push(self('EFFECT_CANNOT_BE_EFFECT_TARGET', opp ? 'aux.tgoval' : '1'));
    return out.length ? out : null;
  }
  if ((m = raw.match(/^the equipped monster (gains?|loses?) (\d{1,7}) (ATK\/DEF|ATK and DEF|ATK|DEF)$/i))) {
    const amount = Number(m[2]) * (/^lose/i.test(m[1]) ? -1 : 1);
    const codes = /\/|and/.test(m[3]) ? ['EFFECT_UPDATE_ATTACK', 'EFFECT_UPDATE_DEFENSE'] : [m[3].toUpperCase() === 'ATK' ? 'EFFECT_UPDATE_ATTACK' : 'EFFECT_UPDATE_DEFENSE'];
    return codes.map((code) => ({ code, value: String(amount), scope: 'equip' as const, raw }));
  }
  if (/^your opponent cannot target this card with card effects$/.test(l)) return [self('EFFECT_CANNOT_BE_EFFECT_TARGET', 'aux.tgoval')];
  if (/^(?:this card )?cannot attack directly$/.test(l)) return [self('EFFECT_CANNOT_DIRECT_ATTACK')];
  if (/^(?:this card )?can attack directly$/.test(l)) return [self('EFFECT_DIRECT_ATTACK')];
  if (/^(?:this card )?can (?:make a second attack|attack twice) during each battle phase$/.test(l)) return [self('EFFECT_EXTRA_ATTACK')];
  if (/^if this card attacks a defense position monster, inflict piercing battle damage(?: to your opponent)?$/.test(l)) return [self('EFFECT_PIERCE')];

  m = raw.match(/^(this card|all (.+?)|(.+? monsters (?:you control|your opponent controls|on the field))) (gains?|loses?) (\d{1,7}) (ATK\/DEF|ATK and DEF|ATK|DEF)$/i);
  if (m) {
    const amount = Number(m[5]) * (/^lose/i.test(m[4]) ? -1 : 1);
    const codes = /\/|and/.test(m[6]) ? ['EFFECT_UPDATE_ATTACK', 'EFFECT_UPDATE_DEFENSE'] : [m[6].toUpperCase() === 'ATK' ? 'EFFECT_UPDATE_ATTACK' : 'EFFECT_UPDATE_DEFENSE'];
    if (/^this card$/i.test(m[1])) return codes.map((c) => self(c, String(amount)));
    const zoneText = m[2] || m[3];
    const z = parseZone(zoneText, ctx, notes);
    if (!z) return null;
    eff.notes.push(...notes);
    return codes.map((code) => ({ code, value: String(amount), scope: 'field' as const, targetSelf: z.zone.self === '0' ? '0' : 'LOCATION_MZONE', targetOpp: z.zone.opp === '0' ? '0' : 'LOCATION_MZONE', filter: z.filter, raw }));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Material lines and summon restrictions
// ---------------------------------------------------------------------------

function materialFilterFn(ctx: Ctx, eff: EffectIR, qualifier: string, args = 'c'): { fn: string; ok: boolean } {
  const q = qualifier.trim();
  if (!q) return { fn: 'nil', ok: true };
  const notes: string[] = [];
  const f = parseFilter(`${q} monster`, ctx, notes);
  if (notes.length) {
    eff.notes.push(...notes);
    return { fn: 'nil', ok: false };
  }
  const name = helperName(ctx, 'matfilter');
  eff.helpers.push(`function ${name}(${args},...)\n\treturn ${filterBody(f)}\nend`);
  return { fn: name, ok: true };
}

function parseMaterials(line: string, ctx: Ctx, eff: EffectIR): boolean {
  const t = line.trim().replace(/\.$/, '');
  let m: RegExpMatchArray | null;
  eff.initLines.push('\tc:EnableReviveLimit()');
  if (ctx.extra === 'synchro') {
    m = t.match(/^(\d{1,7})\s+(.*?)\btuners?(?:\s+monsters?)?\s*\+\s*(\d{1,7})(\+| or more)?\s+(.*?)non-tuners?\s*(.*?)\s*monsters?$/i);
    if (!m) return false;
    const f1 = materialFilterFn(ctx, eff, m[2]);
    const f2 = materialFilterFn(ctx, eff, `${m[5]} ${m[6]}`);
    if (!f1.ok || !f2.ok) return false;
    const min2 = Number(m[3]);
    const max2 = m[4] ? 99 : min2;
    eff.initLines.push(`\tSynchro.AddProcedure(c,${f1.fn},${Number(m[1])},${Number(m[1])},Synchro.NonTuner(${f2.fn}),${min2},${max2})`);
    return true;
  }
  if (ctx.extra === 'xyz') {
    m = t.match(/^(\d{1,7})(\+| or more)?\s+level\s+(\d{1,7})\s*(.*?)\s*monsters$/i);
    if (!m) return false;
    const f = materialFilterFn(ctx, eff, m[4]);
    if (!f.ok) return false;
    const extra = m[2] ? ',nil,nil,Xyz.InfiniteMats' : '';
    eff.initLines.push(`\tXyz.AddProcedure(c,${f.fn},${Number(m[3])},${Number(m[1])}${extra})`);
    return true;
  }
  if (ctx.extra === 'link') {
    m = t.match(/^(\d{1,7})(\+| or more)?\s+(.*?)\s*monsters?(?:,\s*including (?:at least )?(?:a|an|1) (.+?))?$/i);
    if (!m) return false;
    const min = Number(m[1]);
    const max = m[2] ? Math.max(min, ctx.linkval || min) : min;
    let qual = m[3].trim();
    let fn = 'nil';
    if (/^effect$/i.test(qual)) {
      fn = 'aux.FilterBoolFunctionEx(Card.IsType,TYPE_EFFECT)';
      qual = '';
    }
    if (qual) {
      const f = materialFilterFn(ctx, eff, qual);
      if (!f.ok) return false;
      fn = f.fn;
    }
    let check = '';
    if (m[4]) {
      const notes: string[] = [];
      const inc = parseFilter(m[4], ctx, notes);
      if (notes.length) {
        eff.notes.push(...notes);
        return false;
      }
      const incName = helperName(ctx, 'lfilter');
      const chkName = helperName(ctx, 'lcheck');
      eff.helpers.push(`function ${incName}(c,lc,sumtype,tp)\n\treturn ${filterBody(inc)}\nend`);
      eff.helpers.push(`function ${chkName}(g,lc,sumtype,tp)\n\treturn g:IsExists(${incName},1,nil,lc,sumtype,tp)\nend`);
      check = `,${chkName}`;
    }
    eff.initLines.push(`\tLink.AddProcedure(c,${fn},${min},${max}${check})`);
    return true;
  }
  if (ctx.extra === 'fusion') {
    const parts = mask(t).masked.split(/\s*\+\s*/).map(mask(t).unmask);
    const items: Array<{ fn: string; min: number; rep: boolean }> = [];
    for (const part of parts) {
      const p = part.trim();
      const named = p.match(/^"([^"]+)"$/);
      if (named) {
        const code = named[1].toLowerCase() === ctx.name.toLowerCase() ? null : ctx.resolveName(named[1]);
        if (!code) {
          eff.notes.push(`Fusion material "${named[1]}" is not a known card name`);
          return false;
        }
        items.push({ fn: String(code), min: 1, rep: false });
        continue;
      }
      const counted = p.match(/^(\d{1,7})(\+| or more)?\s+(.+?)$/i);
      if (!counted) return false;
      const notes: string[] = [];
      const f = parseFilter(counted[3], ctx, notes);
      if (notes.length) {
        eff.notes.push(...notes);
        return false;
      }
      const name = helperName(ctx, 'ffilter');
      eff.helpers.push(`function ${name}(c,fc,sumtype,tp)\n\treturn ${filterBody(f)}\nend`);
      items.push({ fn: name, min: Number(counted[1]), rep: !!counted[2] });
    }
    if (!items.length) return false;
    const reps = items.filter((i) => i.rep);
    if (reps.length > 1) return false;
    if (reps.length === 1) {
      const others = items.filter((i) => !i.rep).flatMap((i) => Array(i.min).fill(i.fn));
      eff.initLines.push(`\tFusion.AddProcMixRep(c,true,true,${reps[0].fn},${reps[0].min},99${others.length ? ',' + others.join(',') : ''})`);
    } else if (items.every((i) => i.min === 1)) {
      eff.initLines.push(`\tFusion.AddProcMix(c,true,true,${items.map((i) => i.fn).join(',')})`);
    } else {
      eff.initLines.push(`\tFusion.AddProcMixN(c,true,true,${items.map((i) => `${i.fn},${i.min}`).join(',')})`);
    }
    return true;
  }
  return false;
}

const SUMMON_LIMIT: Record<string, string> = {
  fusion: 'aux.fuslimit', synchro: 'aux.synlimit', xyz: 'aux.xyzlimit', link: 'aux.lnklimit', ritual: 'aux.ritlimit',
};

function parseRestriction(sentence: string, ctx: Ctx, eff: EffectIR): boolean {
  const l = sentence.toLowerCase().trim();
  let m: RegExpMatchArray | null;
  if (/^cannot be normal summoned\/set$/.test(l)) {
    eff.initLines.push('\tc:EnableUnsummonable()');
    return true;
  }
  if (/^cannot be special summoned$/.test(l)) {
    eff.initLines.push(
      '\tlocal e0=Effect.CreateEffect(c)', '\te0:SetType(EFFECT_TYPE_SINGLE)',
      '\te0:SetProperty(EFFECT_FLAG_CANNOT_DISABLE+EFFECT_FLAG_UNCOPYABLE)', '\te0:SetCode(EFFECT_SPSUMMON_CONDITION)',
      '\te0:SetValue(aux.FALSE)', '\tc:RegisterEffect(e0)'
    );
    return true;
  }
  if ((m = l.match(/^must first be (fusion|synchro|xyz|link|ritual|special) summoned/))) {
    // Revive limit already models "must first be X Summoned".
    if (!eff.initLines.some((x) => x.includes('EnableReviveLimit'))) eff.initLines.push('\tc:EnableReviveLimit()');
    if (m[1] === 'special') eff.notes.push('the specific Special Summon method is not scripted');
    return m[1] !== 'special';
  }
  if ((m = l.match(/^must be (fusion|synchro|xyz|link|ritual) summoned$/))) {
    eff.initLines.push(
      '\tlocal e0=Effect.CreateEffect(c)', '\te0:SetType(EFFECT_TYPE_SINGLE)',
      '\te0:SetProperty(EFFECT_FLAG_CANNOT_DISABLE+EFFECT_FLAG_UNCOPYABLE)', '\te0:SetCode(EFFECT_SPSUMMON_CONDITION)',
      `\te0:SetValue(${SUMMON_LIMIT[m[1]]})`, '\tc:RegisterEffect(e0)'
    );
    return true;
  }
  if (/^must be special summoned/.test(l)) {
    eff.initLines.push('\tc:EnableUnsummonable()');
    eff.notes.push('the specific Special Summon method is not scripted; only "cannot be Normal Summoned/Set" is enforced');
    return false;
  }
  if (/^you can ritual summon this card with /.test(l)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Inherent Special Summon ("You can Special Summon this card (from your hand) by Tributing 1 monster")
// ---------------------------------------------------------------------------

function parseInherentSummon(text: string, ctx: Ctx, eff: EffectIR): boolean {
  const m = text.match(/^you can special summon this card \(from your (hand|gy|graveyard)\) by (tributing|sending|banishing|discarding) (\d{1,7}|a|an|one|two) (.+?)(?: from your (.+?))?(?: to the (?:gy|graveyard))?$/i);
  if (!m) return false;
  const notes: string[] = [];
  const f = parseFilter(m[4].replace(/\s+you control$/i, ''), ctx, notes);
  if (notes.length) {
    eff.notes.push(...notes);
    return false;
  }
  const count = parseCount(m[3]) || 1;
  const verb = m[2].toLowerCase();
  const range = /hand/i.test(m[1]) ? 'LOCATION_HAND' : 'LOCATION_GRAVE';
  let loc = m[5] ? parseLocations(m[5]) : verb === 'tributing' ? 'LOCATION_MZONE' : verb === 'banishing' ? 'LOCATION_GRAVE' : 'LOCATION_HAND';
  if (!loc) return false;
  loc = loc.replace('LOCATION_ONFIELD', f.kind === 'monster' ? 'LOCATION_MZONE' : 'LOCATION_ONFIELD');
  const able: Record<string, string> = {
    tributing: 'c:IsReleasable()', sending: 'c:IsAbleToGraveAsCost()', banishing: 'c:IsAbleToRemoveAsCost()', discarding: 'c:IsDiscardable()',
  };
  const doIt: Record<string, string> = {
    tributing: 'Duel.Release(g,REASON_COST)', sending: 'Duel.SendtoGrave(g,REASON_COST)',
    banishing: 'Duel.Remove(g,POS_FACEUP,REASON_COST)', discarding: 'Duel.SendtoGrave(g,REASON_COST+REASON_DISCARD)',
  };
  const hint: Record<string, string> = { tributing: 'HINTMSG_RELEASE', sending: 'HINTMSG_TOGRAVE', banishing: 'HINTMSG_REMOVE', discarding: 'HINTMSG_DISCARD' };
  const n = eff.index;
  eff.kind = 'summon-procedure';
  eff.luaType = 'EFFECT_TYPE_FIELD';
  eff.codes = ['EFFECT_SPSUMMON_PROC'];
  eff.range = range;
  eff.helpers.push(
    `function s.spfilter${n}(c,tp)\n\treturn ${filterBody(f, [able[verb]])} and Duel.GetMZoneCount(tp,c)>0\nend`,
    `function s.spcon${n}(e,c)\n\tif c==nil then return true end\n\tlocal tp=c:GetControler()\n\treturn Duel.IsExistingMatchingCard(s.spfilter${n},tp,${loc},0,${count},c,tp)\nend`,
    `function s.sptg${n}(e,tp,eg,ep,ev,re,r,rp,chk,c)\n\tlocal g=Duel.GetMatchingGroup(s.spfilter${n},tp,${loc},0,c,tp)\n\tlocal sg=aux.SelectUnselectGroup(g,e,tp,${count},${count},nil,1,tp,${hint[verb]},nil,nil,true)\n\tif #sg>0 then\n\t\tsg:KeepAlive()\n\t\te:SetLabelObject(sg)\n\t\treturn true\n\tend\n\treturn false\nend`,
    `function s.spop${n}(e,tp,eg,ep,ev,re,r,rp,c)\n\tlocal g=e:GetLabelObject()\n\tif not g then return end\n\t${doIt[verb]}\n\tg:DeleteGroup()\nend`
  );
  return true;
}

// ---------------------------------------------------------------------------
// Effect parsing
// ---------------------------------------------------------------------------

function newEffect(index: number, section: EffectIR['section'], text: string): EffectIR {
  return {
    index, section, text, kind: 'unknown', luaType: '', codes: [], optional: false, delay: false,
    conditions: [], costs: [], actions: [], continuous: [], initLines: [], helpers: [],
    understood: true, notes: [], unparsed: [],
  };
}

function markUnparsed(eff: EffectIR, clause: string) {
  eff.understood = false;
  eff.unparsed.push(clause.trim());
}

function defaultRange(ctx: Ctx, eff: EffectIR): string {
  if (eff.section === 'pendulum') return 'LOCATION_PZONE';
  if (ctx.isSpell) return ctx.spellKind === 'field' ? 'LOCATION_FZONE' : 'LOCATION_SZONE';
  if (ctx.isTrap) return 'LOCATION_SZONE';
  return 'LOCATION_MZONE';
}

function parseEffectText(eff: EffectIR, ctx: Ctx): void {
  let text = eff.text.trim().replace(/\.$/, '');
  let soft = false;
  let quick = false;
  let flip = false;

  if (/^FLIP:\s*/i.test(text)) {
    flip = true;
    text = text.replace(/^FLIP:\s*/i, '');
  }
  if (/\(Quick Effect\)/i.test(text)) {
    quick = true;
    text = text.replace(/\s*\(Quick Effect\)\s*/i, ' ').replace(/\s+:/, ':').trim();
  }
  for (let i = 0; i < 2; i++) {
    if (/^Once per turn(?:\s*[:,])\s*/i.test(text)) {
      soft = true;
      text = text.replace(/^Once per turn(?:\s*[:,])\s*/i, '');
    }
  }
  if (/,? once per turn$/i.test(text)) {
    soft = true;
    text = text.replace(/,? once per turn$/i, '');
  }
  if (soft) eff.countLimit = { kind: 'soft' };

  // Inherent Special Summon procedure (no colon/semicolon, "by <cost>").
  if (ctx.isMonster && !flip && parseInherentSummon(text, ctx, eff)) return;

  const colon = splitFirst(text, ':');
  let pre = colon ? colon[0] : '';
  let body = colon ? colon[1] : text;

  // Continuous effects: no colon, no semicolon, no "You can".
  if (!colon && !splitFirst(body, ';') && !/^you can\b/i.test(body) && !flip) {
    const whileM = body.match(/^while (.+?), (.+)$/i);
    const contText = whileM ? whileM[2] : body;
    const cont = parseContinuous(contText, ctx, eff);
    const isActivationText = (ctx.isSpell || ctx.isTrap) && !['continuous', 'field', 'equip'].includes(ctx.isSpell ? ctx.spellKind : ctx.trapKind);
    if (cont && !isActivationText) {
      eff.kind = 'continuous';
      eff.continuous = cont;
      eff.range = defaultRange(ctx, eff);
      if (whileM) {
        const cond = parseCondition(whileM[1], ctx, eff);
        eff.conditions.push(...cond.exprs);
        if (!cond.understood) cond.unparsed.forEach((u) => markUnparsed(eff, u));
      }
      return;
    }
  }

  // Optional ("You can") is decided by the body; strip it for clause parsing.
  if (/^you can\b/i.test(body)) {
    eff.optional = true;
    body = body.replace(/^you can\s+/i, '');
  }
  if (/\bfrom your hand\)/i.test(body) || /\(from your hand\)/i.test(body)) eff.range = 'LOCATION_HAND';
  if (/\(from your (?:gy|graveyard)\)/i.test(body)) eff.range = 'LOCATION_GRAVE';

  // Trigger / condition (text before the colon).
  let trig: TriggerMatch | null = null;
  const isWhen = /^when\b/i.test(pre);
  if (pre) {
    trig = parseTrigger(pre);
    if (!trig) {
      // Phase / ownership conditions combined with a trigger are rare; treat pre as condition.
      const cond = parseCondition(pre, ctx, eff);
      eff.conditions.push(...cond.exprs);
      if (cond.range) eff.range = cond.range;
      if (!cond.understood) cond.unparsed.forEach((u) => {
        markUnparsed(eff, u);
        eff.notes.push(`condition not enforced: "${u}"`);
      });
    } else {
      eff.conditions.push(...trig.conditions);
    }
  }
  if (flip) trig = { codes: ['EVENT_FLIP'], scope: 'flip', conditions: [] };
  eff.chainResponse = trig?.scope === 'chain' || trig?.summonNegation;

  // Cost / target (before the semicolon).
  const semi = splitFirst(body, ';');
  const resolution = semi ? semi[1] : body;
  if (semi) {
    const { masked, unmask } = mask(semi[0]);
    const pieces = masked.split(/,?\s+then\s+|,?\s+and\s+(?=(?:discard|pay|tribute|banish|send|detach|reveal|target)\b)|,\s+(?=target\b)/i).map(unmask);
    for (const piece of pieces) {
      const p = piece.trim().replace(/^you can\s+/i, '');
      if (!p) continue;
      if (/^target\b/i.test(p)) {
        const tgt = parseTargetClause(p, ctx, eff);
        if (tgt) eff.target = tgt;
        else markUnparsed(eff, p);
        continue;
      }
      const cost = parseCost(p, ctx, eff);
      if (cost) eff.costs.push(cost);
      else markUnparsed(eff, p);
    }
  }
  for (const cost of eff.costs) {
    if (cost.kind === 'self_discard' || cost.kind === 'self_reveal') eff.range = 'LOCATION_HAND';
    if (cost.kind === 'self_banish' && cost.loc === 'LOCATION_GRAVE') eff.range = 'LOCATION_GRAVE';
  }

  // Resolution.
  for (const piece of splitActions(resolution)) {
    const action = parseAction(piece.text, piece.link, ctx, eff);
    if (action) eff.actions.push(action);
    else markUnparsed(eff, piece.text);
  }
  if (!eff.actions.length && !eff.unparsed.length) markUnparsed(eff, resolution || text);

  // Effect kind / type / codes.
  const isST = ctx.isSpell || ctx.isTrap;
  const stActivation = isST && eff.section !== 'pendulum'
    && !(ctx.isSpell && ['continuous', 'field', 'equip'].includes(ctx.spellKind))
    && !(ctx.isTrap && ctx.trapKind === 'continuous')
    && eff.range !== 'LOCATION_GRAVE' && trig?.scope !== 'single';

  if (stActivation) {
    eff.kind = 'activate';
    eff.luaType = 'EFFECT_TYPE_ACTIVATE';
    eff.optional = true;
    eff.range = undefined;
    if (trig && (trig.scope === 'chain' || trig.scope === 'field')) {
      eff.codes = trig.codes;
    } else {
      eff.codes = ['EVENT_FREE_CHAIN'];
      if (ctx.isTrap || ctx.spellKind === 'quickplay') eff.hintTiming = 'TIMINGS_CHECK_MONSTER_E';
    }
    if (ctx.isTrap && ctx.trapKind === 'counter' && !eff.chainResponse) eff.notes.push('Counter Trap without a chain/summon trigger');
    return;
  }
  if (flip) {
    eff.kind = 'trigger';
    eff.luaType = `EFFECT_TYPE_SINGLE+EFFECT_TYPE_FLIP${eff.optional ? '+EFFECT_TYPE_TRIGGER_O' : ''}`;
    eff.codes = [];
    eff.delay = eff.optional;
    eff.range = undefined;
    return;
  }
  if (trig?.scope === 'single') {
    eff.kind = 'trigger';
    eff.luaType = `EFFECT_TYPE_SINGLE+${eff.optional ? 'EFFECT_TYPE_TRIGGER_O' : 'EFFECT_TYPE_TRIGGER_F'}`;
    eff.codes = trig.codes;
    eff.delay = !isWhen;
    eff.range = undefined;
    return;
  }
  const trapSpeed = ctx.isTrap; // Every Trap Card effect is Spell Speed 2.
  if (trig?.scope === 'chain' || ((quick || trapSpeed) && !trig)) {
    eff.kind = 'quick';
    eff.luaType = eff.optional ? 'EFFECT_TYPE_QUICK_O' : 'EFFECT_TYPE_QUICK_F';
    eff.codes = trig?.scope === 'chain' ? trig.codes : ['EVENT_FREE_CHAIN'];
    if (eff.codes[0] === 'EVENT_FREE_CHAIN') eff.hintTiming = 'TIMINGS_CHECK_MONSTER_E';
    eff.range = eff.range || defaultRange(ctx, eff);
    return;
  }
  if (trig?.scope === 'field') {
    eff.kind = 'trigger';
    eff.luaType = `EFFECT_TYPE_FIELD+${eff.optional ? 'EFFECT_TYPE_TRIGGER_O' : 'EFFECT_TYPE_TRIGGER_F'}`;
    eff.codes = trig.codes;
    eff.delay = !isWhen && !trig.codes.some((c) => c.startsWith('EVENT_PHASE'));
    eff.range = eff.range || defaultRange(ctx, eff);
    return;
  }
  eff.kind = 'ignition';
  eff.luaType = 'EFFECT_TYPE_IGNITION';
  eff.range = eff.range || defaultRange(ctx, eff);
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

const MOVER: Record<string, { call: (g: string) => string; cat: string; able: string; hint: string }> = {
  destroy: { call: (g) => `Duel.Destroy(${g},REASON_EFFECT)`, cat: 'CATEGORY_DESTROY', able: '', hint: 'HINTMSG_DESTROY' },
  banish: { call: (g) => `Duel.Remove(${g},POS_FACEUP,REASON_EFFECT)`, cat: 'CATEGORY_REMOVE', able: 'c:IsAbleToRemove()', hint: 'HINTMSG_REMOVE' },
  to_hand: { call: (g) => `Duel.SendtoHand(${g},nil,REASON_EFFECT)`, cat: 'CATEGORY_TOHAND', able: 'c:IsAbleToHand()', hint: 'HINTMSG_RTOHAND' },
  to_deck: { call: (g) => `Duel.SendtoDeck(${g},nil,SEQ_DECKSHUFFLE,REASON_EFFECT)`, cat: 'CATEGORY_TODECK', able: 'c:IsAbleToDeck()', hint: 'HINTMSG_TODECK' },
  to_grave: { call: (g) => `Duel.SendtoGrave(${g},REASON_EFFECT)`, cat: 'CATEGORY_TOGRAVE', able: 'c:IsAbleToGrave()', hint: 'HINTMSG_TOGRAVE' },
  foolish: { call: (g) => `Duel.SendtoGrave(${g},REASON_EFFECT)`, cat: 'CATEGORY_TOGRAVE', able: 'c:IsAbleToGrave()', hint: 'HINTMSG_TOGRAVE' },
};

interface ActionCode {
  check: string | null;
  info: string[];
  op: string[];
  cats: string[];
}

/** Ability check a target must satisfy so the effect can actually do something to it. */
function targetAbility(eff: EffectIR): string[] {
  const first = eff.actions.find((a) => a.subject === 'target');
  if (!first) return [];
  if (MOVER[first.verb]?.able) return [MOVER[first.verb].able];
  if (first.verb === 'ss') return ['c:IsCanBeSpecialSummoned(e,0,tp,false,false)'];
  if (first.verb === 'negate_effects') return ['c:IsNegatable()'];
  if (first.verb === 'stat') return ['c:IsFaceup()'];
  return [];
}

function statLines(target: string, a: ActionIR, indent: string): string[] {
  const reset = a.untilEot ? 'RESETS_STANDARD_PHASE_END' : 'RESET_EVENT+RESETS_STANDARD';
  const codes = a.stat === 'ATKDEF' ? ['EFFECT_UPDATE_ATTACK', 'EFFECT_UPDATE_DEFENSE'] : [a.stat === 'DEF' ? 'EFFECT_UPDATE_DEFENSE' : 'EFFECT_UPDATE_ATTACK'];
  const out: string[] = [];
  codes.forEach((code, i) => {
    out.push(
      `${indent}local se${i}=Effect.CreateEffect(c)`, `${indent}se${i}:SetType(EFFECT_TYPE_SINGLE)`, `${indent}se${i}:SetCode(${code})`,
      `${indent}se${i}:SetValue(${a.amount})`, `${indent}se${i}:SetReset(${reset})`, `${indent}${target}:RegisterEffect(se${i})`
    );
  });
  return out;
}

function genAction(a: ActionIR, eff: EffectIR, ctx: Ctx, k: number): ActionCode {
  const n = eff.index;
  const fname = `s.f${n}_${k}`;
  const pos = a.defense ? 'POS_FACEUP_DEFENSE' : 'POS_FACEUP';
  const min = a.upTo ? 1 : a.count ?? 1;
  const max = a.count ?? 1;
  const T = '\t\t';
  const defFilter = (extra: string[]) => eff.helpers.push(`function ${fname}(c,e,tp)\n\treturn ${filterBody(a.filter, extra)}\nend`);

  switch (a.verb) {
    case 'draw':
      return {
        check: `Duel.IsPlayerCanDraw(tp,${a.count})`,
        info: [`Duel.SetOperationInfo(0,CATEGORY_DRAW,nil,0,tp,${a.count})`],
        op: [`${T}res=Duel.Draw(tp,${a.count},REASON_EFFECT)>0`],
        cats: ['CATEGORY_DRAW'],
      };
    case 'damage':
      return {
        check: null,
        info: [`Duel.SetOperationInfo(0,CATEGORY_DAMAGE,nil,0,${a.player},${a.amount})`],
        op: [`${T}res=Duel.Damage(${a.player},${a.amount},REASON_EFFECT)>0`],
        cats: ['CATEGORY_DAMAGE'],
      };
    case 'recover':
      return {
        check: null,
        info: [`Duel.SetOperationInfo(0,CATEGORY_RECOVER,nil,0,tp,${a.amount})`],
        op: [`${T}res=Duel.Recover(tp,${a.amount},REASON_EFFECT)>0`],
        cats: ['CATEGORY_RECOVER'],
      };
    case 'mill':
      return {
        check: `Duel.IsPlayerCanDiscardDeck(${a.player},${a.count})`,
        info: [`Duel.SetOperationInfo(0,CATEGORY_DECKDES,nil,0,${a.player},${a.count})`],
        op: [`${T}res=Duel.DiscardDeck(${a.player},${a.count},REASON_EFFECT)>0`],
        cats: ['CATEGORY_DECKDES'],
      };
    case 'discard':
      return {
        check: `Duel.IsExistingMatchingCard(Card.IsDiscardable,tp,LOCATION_HAND,0,${a.count},nil,REASON_EFFECT)`,
        info: [`Duel.SetOperationInfo(0,CATEGORY_HANDES,nil,0,tp,${a.count})`],
        op: [`${T}res=Duel.DiscardHand(tp,nil,${a.count},${a.count},REASON_EFFECT+REASON_DISCARD)>0`],
        cats: ['CATEGORY_HANDES'],
      };
    case 'search':
    case 'add_from_gy': {
      defFilter(['c:IsAbleToHand()']);
      const nv = a.locs!.includes('LOCATION_GRAVE') ? `aux.NecroValleyFilter(${fname})` : fname;
      return {
        check: `Duel.IsExistingMatchingCard(${fname},tp,${a.locs},0,${min},nil,e,tp)`,
        info: [`Duel.SetOperationInfo(0,CATEGORY_TOHAND,nil,${min},tp,${a.locs})`],
        op: [
          `${T}Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_ATOHAND)`,
          `${T}local g=Duel.SelectMatchingCard(tp,${nv},tp,${a.locs},0,${min},${max},nil,e,tp)`,
          `${T}res=#g>0 and Duel.SendtoHand(g,nil,REASON_EFFECT)>0`,
          `${T}if res then Duel.ConfirmCards(1-tp,g) end`,
        ],
        cats: a.locs!.includes('LOCATION_DECK') ? ['CATEGORY_TOHAND', 'CATEGORY_SEARCH'] : ['CATEGORY_TOHAND'],
      };
    }
    case 'ss_self':
      return {
        check: `Duel.GetLocationCount(tp,LOCATION_MZONE)>0 and c:IsCanBeSpecialSummoned(e,0,tp,false,false,${pos})`,
        info: [`Duel.SetOperationInfo(0,CATEGORY_SPECIAL_SUMMON,c,1,0,0)`],
        op: [`${T}res=c:IsRelateToEffect(e) and Duel.SpecialSummon(c,0,tp,tp,false,false,${pos})>0`],
        cats: ['CATEGORY_SPECIAL_SUMMON'],
      };
    case 'ss': {
      if (a.subject === 'target') {
        return {
          check: 'Duel.GetLocationCount(tp,LOCATION_MZONE)>0',
          info: [`Duel.SetOperationInfo(0,CATEGORY_SPECIAL_SUMMON,g,#g,0,0)`],
          op: [`${T}res=#tg>0 and Duel.GetLocationCount(tp,LOCATION_MZONE)>=#tg and Duel.SpecialSummon(tg,0,tp,tp,false,false,${pos})>0`],
          cats: ['CATEGORY_SPECIAL_SUMMON'],
        };
      }
      defFilter([`c:IsCanBeSpecialSummoned(e,0,tp,false,false,${pos})`]);
      const nv = a.locs!.includes('LOCATION_GRAVE') ? `aux.NecroValleyFilter(${fname})` : fname;
      const summon = a.negateOnSummon
        ? [
          `${T}for sc in g:Iter() do`,
          `${T}\tif Duel.SpecialSummonStep(sc,0,tp,tp,false,false,${pos}) then`,
          `${T}\t\tlocal de=Effect.CreateEffect(c)`, `${T}\t\tde:SetType(EFFECT_TYPE_SINGLE)`, `${T}\t\tde:SetCode(EFFECT_DISABLE)`,
          `${T}\t\tde:SetReset(RESET_EVENT+RESETS_STANDARD)`, `${T}\t\tsc:RegisterEffect(de)`,
          `${T}\t\tlocal de2=de:Clone()`, `${T}\t\tde2:SetCode(EFFECT_DISABLE_EFFECT)`, `${T}\t\tsc:RegisterEffect(de2)`,
          `${T}\t\tres=true`, `${T}\tend`, `${T}end`, `${T}Duel.SpecialSummonComplete()`,
        ]
        : [`${T}res=#g>0 and Duel.SpecialSummon(g,0,tp,tp,false,false,${pos})>0`];
      return {
        check: `Duel.GetLocationCount(tp,LOCATION_MZONE)>=${min} and Duel.IsExistingMatchingCard(${fname},tp,${a.locs},0,${min},nil,e,tp)`,
        info: [`Duel.SetOperationInfo(0,CATEGORY_SPECIAL_SUMMON,nil,${min},tp,${a.locs})`],
        op: [
          `${T}local ft=math.min(Duel.GetLocationCount(tp,LOCATION_MZONE),${max})`,
          `${T}if ft>=${min} then`,
          `${T}\tDuel.Hint(HINT_SELECTMSG,tp,HINTMSG_SPSUMMON)`,
          `${T}\tlocal g=Duel.SelectMatchingCard(tp,${nv},tp,${a.locs},0,${min},ft,nil,e,tp)`,
          ...summon.map((l) => `\t${l}`),
          `${T}end`,
        ],
        cats: ['CATEGORY_SPECIAL_SUMMON'],
      };
    }
    case 'set_st':
      defFilter(['c:IsSSetable()']);
      return {
        check: `Duel.GetLocationCount(tp,LOCATION_SZONE)>0 and Duel.IsExistingMatchingCard(${fname},tp,${a.locs},0,1,nil,e,tp)`,
        info: [],
        op: [
          `${T}Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_SET)`,
          `${T}local g=Duel.SelectMatchingCard(tp,${fname},tp,${a.locs},0,1,1,nil,e,tp)`,
          `${T}res=#g>0 and Duel.SSet(tp,g)>0`,
        ],
        cats: [],
      };
    case 'negate_activation':
      return {
        check: null,
        info: ['Duel.SetOperationInfo(0,CATEGORY_NEGATE,eg,1,0,0)'],
        op: [`${T}res=Duel.NegateActivation(ev)`],
        cats: ['CATEGORY_NEGATE'],
      };
    case 'negate_effect':
      return {
        check: null,
        info: ['Duel.SetOperationInfo(0,CATEGORY_DISABLE,eg,1,0,0)'],
        op: [`${T}res=Duel.NegateEffect(ev)`],
        cats: ['CATEGORY_DISABLE'],
      };
    case 'negate_summon':
      return {
        check: null,
        info: ['Duel.SetOperationInfo(0,CATEGORY_DISABLE_SUMMON,eg,#eg,0,0)'],
        op: [`${T}Duel.NegateSummon(eg)`, `${T}res=true`],
        cats: ['CATEGORY_DISABLE_SUMMON'],
      };
    case 'negate_effects': {
      const reset = a.untilEot ? 'RESETS_STANDARD_PHASE_END' : 'RESET_EVENT+RESETS_STANDARD';
      return {
        check: null,
        info: ['Duel.SetOperationInfo(0,CATEGORY_DISABLE,g,#g,0,0)'],
        op: [
          `${T}for tc in tg:Iter() do`,
          `${T}\tif tc:IsFaceup() and not tc:IsDisabled() then`,
          `${T}\t\tDuel.NegateRelatedChain(tc,RESET_TURN_SET)`,
          `${T}\t\tlocal ne1=Effect.CreateEffect(c)`, `${T}\t\tne1:SetType(EFFECT_TYPE_SINGLE)`, `${T}\t\tne1:SetCode(EFFECT_DISABLE)`,
          `${T}\t\tne1:SetReset(${reset})`, `${T}\t\ttc:RegisterEffect(ne1)`,
          `${T}\t\tlocal ne2=ne1:Clone()`, `${T}\t\tne2:SetCode(EFFECT_DISABLE_EFFECT)`, `${T}\t\tne2:SetValue(RESET_TURN_SET)`, `${T}\t\ttc:RegisterEffect(ne2)`,
          `${T}\t\tif tc:IsType(TYPE_TRAPMONSTER) then`,
          `${T}\t\t\tlocal ne3=ne1:Clone()`, `${T}\t\t\tne3:SetCode(EFFECT_DISABLE_TRAPMONSTER)`, `${T}\t\t\ttc:RegisterEffect(ne3)`,
          `${T}\t\tend`,
          `${T}\t\tres=true`,
          `${T}\tend`,
          `${T}end`,
        ],
        cats: ['CATEGORY_DISABLE'],
      };
    }
    case 'stat': {
      const cats = a.stat === 'ATKDEF' ? ['CATEGORY_ATKCHANGE', 'CATEGORY_DEFCHANGE'] : [a.stat === 'DEF' ? 'CATEGORY_DEFCHANGE' : 'CATEGORY_ATKCHANGE'];
      if (a.subject === 'self') {
        return {
          check: null, info: [], cats,
          op: [`${T}if c:IsRelateToEffect(e) and c:IsFaceup() then`, ...statLines('c', a, `${T}\t`), `${T}\tres=true`, `${T}end`],
        };
      }
      if (a.subject === 'target') {
        return {
          check: null, info: [], cats,
          op: [`${T}for tc in tg:Iter() do`, `${T}\tif tc:IsFaceup() then`, ...statLines('tc', a, `${T}\t\t`), `${T}\t\tres=true`, `${T}\tend`, `${T}end`],
        };
      }
      defFilter(['c:IsFaceup()']);
      return {
        check: `Duel.IsExistingMatchingCard(${fname},tp,${a.self},${a.opp},1,nil,e,tp)`, info: [], cats,
        op: [`${T}local g=Duel.GetMatchingGroup(${fname},tp,${a.self},${a.opp},nil,e,tp)`, `${T}for tc in g:Iter() do`, ...statLines('tc', a, `${T}\t`), `${T}\tres=true`, `${T}end`],
      };
    }
    default: {
      const mv = MOVER[a.verb];
      if (!mv) return { check: null, info: [], op: [`${T}-- TODO (not understood): ${luaComment(a.raw)}`], cats: [] };
      if (a.subject === 'self') {
        return {
          check: null,
          info: [`Duel.SetOperationInfo(0,${mv.cat},c,1,0,0)`],
          op: [`${T}res=c:IsRelateToEffect(e) and ${mv.call('c')}>0`],
          cats: [mv.cat],
        };
      }
      if (a.subject === 'target') {
        return { check: null, info: [`Duel.SetOperationInfo(0,${mv.cat},g,#g,0,0)`], op: [`${T}res=#tg>0 and ${mv.call('tg')}>0`], cats: [mv.cat] };
      }
      if (a.subject === 'chain' && eff.codes[0] !== 'EVENT_CHAINING') {
        // Summon negation: eg is the monster(s) being Summoned, there is no `re`.
        return { check: null, info: [`Duel.SetOperationInfo(0,${mv.cat},eg,#eg,0,0)`], op: [`${T}res=${mv.call('eg')}>0`], cats: [mv.cat] };
      }
      if (a.subject === 'chain') {
        return {
          check: null,
          info: [`if re:GetHandler():IsRelateToEffect(re) then Duel.SetOperationInfo(0,${mv.cat},eg,1,0,0) end`],
          op: [`${T}res=re:GetHandler():IsRelateToEffect(re) and ${mv.call('eg')}>0`],
          cats: [mv.cat],
        };
      }
      const self = a.verb === 'foolish' ? a.locs! : a.self!;
      const opp = a.verb === 'foolish' ? '0' : a.opp!;
      defFilter(mv.able ? [mv.able] : []);
      const ex = a.filter?.excludeSelf ? 'c' : 'nil';
      if (a.subject === 'all') {
        return {
          check: `Duel.IsExistingMatchingCard(${fname},tp,${self},${opp},1,${ex},e,tp)`,
          info: [`local ag=Duel.GetMatchingGroup(${fname},tp,${self},${opp},${ex},e,tp)`, `Duel.SetOperationInfo(0,${mv.cat},ag,#ag,0,0)`],
          op: [`${T}local g=Duel.GetMatchingGroup(${fname},tp,${self},${opp},${ex},e,tp)`, `${T}res=#g>0 and ${mv.call('g')}>0`],
          cats: [mv.cat],
        };
      }
      return {
        check: `Duel.IsExistingMatchingCard(${fname},tp,${self},${opp},${min},${ex},e,tp)`,
        info: [`Duel.SetOperationInfo(0,${mv.cat},nil,${min},${opp === '0' ? 'tp' : self === '0' ? '1-tp' : 'PLAYER_ALL'},${self === '0' ? opp : self})`],
        op: [
          `${T}Duel.Hint(HINT_SELECTMSG,tp,${mv.hint})`,
          `${T}local g=Duel.SelectMatchingCard(tp,${fname},tp,${self},${opp},${min},${max},${ex},e,tp)`,
          `${T}if #g>0 then Duel.HintSelection(g) end`,
          `${T}res=#g>0 and ${mv.call('g')}>0`,
        ],
        cats: [mv.cat, ...(a.verb === 'foolish' && self.includes('LOCATION_DECK') ? [] : [])],
      };
    }
  }
}

function genCost(cost: CostIR, eff: EffectIR, ctx: Ctx, k: number): { check: string; op: string[] } {
  const n = eff.index;
  const fname = `s.cost${n}_f${k}`;
  const def = (extra: string[]) => eff.helpers.push(`function ${fname}(c,e,tp)\n\treturn ${filterBody(cost.filter, extra)}\nend`);
  switch (cost.kind) {
    case 'self_discard': return { check: 'c:IsDiscardable()', op: ['Duel.SendtoGrave(c,REASON_COST+REASON_DISCARD)'] };
    case 'self_reveal': return { check: 'not c:IsPublic()', op: ['Duel.ConfirmCards(1-tp,c)'] };
    case 'self_tribute': return { check: 'c:IsReleasable()', op: ['Duel.Release(c,REASON_COST)'] };
    case 'self_banish': return { check: 'c:IsAbleToRemoveAsCost()', op: ['Duel.Remove(c,POS_FACEUP,REASON_COST)'] };
    case 'self_to_grave': return { check: 'c:IsAbleToGraveAsCost()', op: ['Duel.SendtoGrave(c,REASON_COST)'] };
    case 'pay_lp': return { check: `Duel.CheckLPCost(tp,${cost.amount})`, op: [`Duel.PayLPCost(tp,${cost.amount})`] };
    case 'pay_half_lp': return { check: 'true', op: ['Duel.PayLPCost(tp,math.floor(Duel.GetLP(tp)/2))'] };
    case 'detach': return { check: `c:CheckRemoveOverlayCard(tp,${cost.count},REASON_COST)`, op: [`c:RemoveOverlayCard(tp,${cost.count},${cost.count},REASON_COST)`] };
    case 'discard':
      def(['c:IsDiscardable()']);
      return {
        check: `Duel.IsExistingMatchingCard(${fname},tp,LOCATION_HAND,0,${cost.count},c,e,tp)`,
        op: [`Duel.DiscardHand(tp,${fname},${cost.count},${cost.count},REASON_COST+REASON_DISCARD,c,e,tp)`],
      };
    case 'tribute':
      def([]);
      return {
        check: `Duel.CheckReleaseGroupCost(tp,${fname},${cost.count},false,nil,c,e,tp)`,
        op: [`local g=Duel.SelectReleaseGroupCost(tp,${fname},${cost.count},${cost.count},false,nil,c,e,tp)`, 'Duel.Release(g,REASON_COST)'],
      };
    case 'banish':
      def(['c:IsAbleToRemoveAsCost()']);
      return {
        check: `Duel.IsExistingMatchingCard(${fname},tp,${cost.loc},0,${cost.count},c,e,tp)`,
        op: ['Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_REMOVE)', `local g=Duel.SelectMatchingCard(tp,${fname},tp,${cost.loc},0,${cost.count},${cost.count},c,e,tp)`, 'Duel.Remove(g,POS_FACEUP,REASON_COST)'],
      };
    case 'send_to_gy':
      def(['c:IsAbleToGraveAsCost()']);
      return {
        check: `Duel.IsExistingMatchingCard(${fname},tp,${cost.loc},0,${cost.count},c,e,tp)`,
        op: ['Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_TOGRAVE)', `local g=Duel.SelectMatchingCard(tp,${fname},tp,${cost.loc},0,${cost.count},${cost.count},c,e,tp)`, 'Duel.SendtoGrave(g,REASON_COST)'],
      };
  }
}

function countLimitLua(limit?: CountLimit): string | null {
  if (!limit) return null;
  if (limit.kind === 'soft') return 'SetCountLimit(1)';
  if (limit.kind === 'oath') return 'SetCountLimit(1,id,EFFECT_COUNT_CODE_OATH)';
  if (limit.kind === 'duel') return `SetCountLimit(1,{id,${limit.hoptIndex ?? 0}},EFFECT_COUNT_CODE_DUEL)`;
  return `SetCountLimit(1,{id,${limit.hoptIndex ?? 0}})`;
}

function emitContinuous(eff: EffectIR, ctx: Ctx, init: string[]) {
  const n = eff.index;
  const conName = eff.conditions.length ? `s.con${n}` : null;
  if (conName) eff.helpers.push(`function ${conName}(e)\n\tlocal tp=e:GetHandlerPlayer()\n\treturn ${eff.conditions.join(' and ')}\nend`);
  eff.continuous.forEach((ce, i) => {
    const v = `e${n}${String.fromCharCode(97 + i)}`;
    init.push(`\tlocal ${v}=Effect.CreateEffect(c)`);
    if (ce.scope === 'equip') {
      init.push(`\t${v}:SetType(EFFECT_TYPE_EQUIP)`);
    } else if (ce.scope === 'self') {
      init.push(`\t${v}:SetType(EFFECT_TYPE_SINGLE)`);
      if (eff.range === 'LOCATION_MZONE') init.push(`\t${v}:SetProperty(EFFECT_FLAG_SINGLE_RANGE)`, `\t${v}:SetRange(LOCATION_MZONE)`);
    } else {
      const tname = `s.eftg${n}_${i}`;
      eff.helpers.push(`function ${tname}(e,c)\n\tlocal tp=e:GetHandlerPlayer()\n\treturn c:IsFaceup() and ${filterBody(ce.filter)}\nend`);
      init.push(`\t${v}:SetType(EFFECT_TYPE_FIELD)`, `\t${v}:SetRange(${eff.range})`, `\t${v}:SetTargetRange(${ce.targetSelf},${ce.targetOpp})`, `\t${v}:SetTarget(${tname})`);
    }
    init.push(`\t${v}:SetCode(${ce.code})`, `\t${v}:SetValue(${ce.value})`);
    if (conName) init.push(`\t${v}:SetCondition(${conName})`);
    init.push(`\tc:RegisterEffect(${v})`);
  });
}

function emitEffect(eff: EffectIR, ctx: Ctx, init: string[], descIndex: number) {
  const n = eff.index;
  init.push(`\t-- ${luaComment(eff.text)}`);
  for (const u of eff.unparsed) init.push(`\t-- TODO (not understood): ${luaComment(u)}`);

  if (eff.kind === 'continuous') {
    emitContinuous(eff, ctx, init);
    return;
  }
  if (eff.kind === 'summon-procedure') {
    const v = `e${n}`;
    init.push(
      `\tlocal ${v}=Effect.CreateEffect(c)`, `\t${v}:SetDescription(aux.Stringid(id,${descIndex}))`, `\t${v}:SetType(EFFECT_TYPE_FIELD)`,
      `\t${v}:SetCode(EFFECT_SPSUMMON_PROC)`, `\t${v}:SetProperty(EFFECT_FLAG_UNCOPYABLE)`, `\t${v}:SetRange(${eff.range})`
    );
    // Inherent summons are not activations, so a hard limit must be an OATH count.
    if (eff.countLimit?.kind === 'soft') init.push(`\t${v}:SetCountLimit(1)`);
    else if (eff.countLimit) init.push(`\t${v}:SetCountLimit(1,{id,${eff.countLimit.hoptIndex ?? 0}},EFFECT_COUNT_CODE_OATH)`);
    init.push(`\t${v}:SetCondition(s.spcon${n})`, `\t${v}:SetTarget(s.sptg${n})`, `\t${v}:SetOperation(s.spop${n})`, `\tc:RegisterEffect(${v})`);
    return;
  }
  if (!eff.luaType) return;

  // Chain-response conditions depend on what the resolution does.
  const conds = [...eff.conditions];
  if (eff.chainResponse && eff.codes[0] === 'EVENT_CHAINING') {
    if (eff.actions.some((a) => a.verb === 'negate_activation')) conds.push('Duel.IsChainNegatable(ev)');
    else if (eff.actions.some((a) => a.verb === 'negate_effect')) conds.push('Duel.IsChainDisablable(ev)');
    conds.push('not e:GetHandler():IsStatus(STATUS_BATTLE_DESTROYED)');
  }

  const codes = eff.actions.map((a, k) => genAction(a, eff, ctx, k + 1));
  const costs = eff.costs.map((c, k) => genCost(c, eff, ctx, k + 1));
  const cats = [...new Set(codes.flatMap((c) => c.cats))];
  const props: string[] = [];
  if (eff.delay) props.push('EFFECT_FLAG_DELAY');
  if (eff.target) props.push('EFFECT_FLAG_CARD_TARGET');
  if (eff.actions.some((a) => a.verb === 'stat' || a.verb === 'negate_effects') && eff.kind !== 'activate') props.push('EFFECT_FLAG_DAMAGE_STEP');

  const v = `e${n}`;
  init.push(`\tlocal ${v}=Effect.CreateEffect(c)`, `\t${v}:SetDescription(aux.Stringid(id,${descIndex}))`);
  if (cats.length) init.push(`\t${v}:SetCategory(${cats.join('+')})`);
  init.push(`\t${v}:SetType(${eff.luaType})`);
  if (props.length) init.push(`\t${v}:SetProperty(${props.join('+')})`);
  if (eff.codes.length) init.push(`\t${v}:SetCode(${eff.codes[0]})`);
  if (eff.range) init.push(`\t${v}:SetRange(${eff.range})`);
  if (eff.hintTiming) init.push(`\t${v}:SetHintTiming(0,${eff.hintTiming})`);
  const cl = countLimitLua(eff.countLimit);
  if (cl) init.push(`\t${v}:${cl}`);
  if (conds.length) {
    init.push(`\t${v}:SetCondition(s.con${n})`);
    eff.helpers.push(`function s.con${n}(e,tp,eg,ep,ev,re,r,rp)\n\treturn ${conds.join(' and ')}\nend`);
  }
  if (costs.length) {
    init.push(`\t${v}:SetCost(s.cost${n})`);
    eff.helpers.push([
      `function s.cost${n}(e,tp,eg,ep,ev,re,r,rp,chk)`,
      '\tlocal c=e:GetHandler()',
      `\tif chk==0 then return ${costs.map((c) => c.check).join(' and ')} end`,
      ...costs.flatMap((c) => ['\tdo', ...c.op.map((l) => `\t\t${l}`), '\tend']),
      'end',
    ].join('\n'));
  }

  // Target function.
  const tg: string[] = [`function s.tg${n}(e,tp,eg,ep,ev,re,r,rp,chk,chkc)`, '\tlocal c=e:GetHandler()'];
  const checks: string[] = [];
  // Only the first action (and anything joined with plain "and") must be possible to activate.
  codes.forEach((code, k) => {
    const link = eff.actions[k].link;
    if (code.check && (link === 'first' || link === 'and' || link === 'also')) checks.push(code.check);
  });
  if (eff.target) {
    const t = eff.target;
    const tf = `s.tfilter${n}`;
    eff.helpers.push(`function ${tf}(c,e,tp)\n\treturn ${filterBody(t.filter, targetAbility(eff))}\nend`);
    const ex = t.filter.excludeSelf ? 'c' : 'nil';
    let chkc = 'false';
    if (t.count === 1 || t.upTo) {
      const loc = t.self !== '0' && t.opp !== '0' ? (t.self === t.opp ? t.self : `${t.self}|${t.opp}`) : t.self !== '0' ? t.self : t.opp;
      const ctl = t.self !== '0' && t.opp !== '0' ? '' : t.self !== '0' ? ' and chkc:IsControler(tp)' : ' and chkc:IsControler(1-tp)';
      chkc = t.count === 1 ? `chkc:IsLocation(${loc})${ctl} and ${tf}(chkc,e,tp)` : 'false';
    }
    tg.push(`\tif chkc then return ${chkc} end`);
    checks.unshift(`Duel.IsExistingTarget(${tf},tp,${t.self},${t.opp},${t.upTo ? 1 : t.count},${ex},e,tp)`);
    tg.push(`\tif chk==0 then return ${checks.join(' and ')} end`);
    const firstVerb = eff.actions.find((a) => a.subject === 'target')?.verb;
    const hint = firstVerb && MOVER[firstVerb] ? MOVER[firstVerb].hint : firstVerb === 'ss' ? 'HINTMSG_SPSUMMON' : firstVerb === 'negate_effects' ? 'HINTMSG_NEGATE' : 'HINTMSG_TARGET';
    tg.push(`\tDuel.Hint(HINT_SELECTMSG,tp,${hint})`);
    tg.push(`\tlocal g=Duel.SelectTarget(tp,${tf},tp,${t.self},${t.opp},${t.upTo ? 1 : t.count},${t.count},${ex},e,tp)`);
  } else {
    tg.push(`\tif chk==0 then return ${checks.length ? checks.join(' and ') : 'true'} end`);
  }
  for (const code of codes) for (const info of code.info) tg.push(`\t${info}`);
  tg.push('end');
  eff.helpers.push(tg.join('\n'));
  init.push(`\t${v}:SetTarget(s.tg${n})`);

  // Operation: actions linked by then / if you do / also.
  const op: string[] = [`function s.op${n}(e,tp,eg,ep,ev,re,r,rp)`, '\tlocal c=e:GetHandler()'];
  if (eff.target) op.push('\tlocal tg=Duel.GetTargetCards(e)');
  op.push('\tlocal res=false');
  let depth = 0;
  codes.forEach((code, k) => {
    const a = eff.actions[k];
    let ind = '\t'.repeat(depth + 1);
    if (k > 0 && (a.link === 'then' || a.link === 'ifyoudo')) {
      op.push(`${ind}if res${a.optional ? ` and Duel.SelectYesNo(tp,aux.Stringid(id,${Math.min(15, descIndex + 1)}))` : ''} then`);
      depth += 1;
      ind = '\t'.repeat(depth + 1);
      if (a.link === 'then') op.push(`${ind}Duel.BreakEffect()`);
    } else if (k > 0 && a.optional) {
      op.push(`${ind}if Duel.SelectYesNo(tp,aux.Stringid(id,${Math.min(15, descIndex + 1)})) then`);
      depth += 1;
      ind = '\t'.repeat(depth + 1);
    }
    op.push(`${ind}do`, `${ind}\tres=false`);
    for (const line of code.op) op.push(ind + line.replace(/^\t\t/, '\t'));
    op.push(`${ind}end`);
  });
  for (let d = depth; d > 0; d--) op.push(`${'\t'.repeat(d)}end`);
  op.push('end');
  eff.helpers.push(op.join('\n'));
  init.push(`\t${v}:SetOperation(s.op${n})`, `\tc:RegisterEffect(${v})`);

  for (const extra of eff.codes.slice(1)) {
    const clone = `${v}${extra.replace(/^EVENT_/, '').toLowerCase().replace(/[^a-z]/g, '')}`;
    init.push(`\tlocal ${clone}=${v}:Clone()`, `\t${clone}:SetCode(${extra})`, `\tc:RegisterEffect(${clone})`);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const HOPT_THIS = /^You can only use this effect of "(.+)" once per (turn|Duel)$/i;
const HOPT_EACH = /^You can only use each effect of "(.+)" once per (turn|Duel)$/i;
const HOPT_SHARED = /^You can only use 1 (?:of the following effects of )?"?(.+?)"?(?: effect)? per turn, and only once that turn$/i;
const HOPT_ORDINAL = /^You can only use the (1st|2nd|3rd|first|second|third) effect of "(.+)" once per turn$/i;
const OATH_ACTIVATE = /^You can only activate 1 "(.+)" per turn$/i;
const SS_ONCE_WAY = /^You can only Special Summon "(.+)" once per turn this way$/i;
const SS_ONCE = /^You can only Special Summon "(.+)" once per turn$/i;
const UNIQUE = /^You can only control (?:1|one) "(.+)"$/i;
const CONTINUATION = /^(?:Then|Also|If you do|Otherwise|It |That |Those |They )/;

function splitDesc(desc: string, ctx: Ctx): { pendulum: string; monster: string; materials: string } {
  let text = normalizeText(desc);
  let pendulum = '';
  const pm = text.match(/\[\s*Pendulum Effect\s*\]([\s\S]*?)(?:-{3,}\s*)?\[\s*(?:Monster Effect|Flavor Text)\s*\]([\s\S]*)/i);
  if (pm) {
    pendulum = pm[1].replace(/-{3,}/g, '').trim();
    text = pm[2].trim();
  }
  let materials = '';
  if (ctx.extra) {
    const lines = text.split('\n');
    const first = lines[0].trim();
    if (lines.length > 1 && (/\+/.test(first) || /^\d{1,7}\+?\s/.test(first) || /^"/.test(first))) {
      materials = first;
      text = lines.slice(1).join('\n').trim();
    } else {
      // No newline: materials run until the first sentence that starts an effect.
      const m = text.match(/^(.*?(?:monsters?|"))\s*(?=(?:If|When|You can|Once per|During|FLIP|While|This card|Each|All|Must|Cannot|Unaffected|\(Quick Effect\)|Gains|[A-Z][a-z]+ [a-z]))/);
      if (m && (/\+/.test(m[1]) || /^\d{1,7}\+?\s/.test(m[1]))) {
        materials = m[1].trim();
        text = text.slice(m[0].length).trim();
      } else if (/^[^.]*(?:\+|^\d{1,7}\+?\s)[^.]*$/.test(text)) {
        materials = text;
        text = '';
      }
    }
  }
  return { pendulum, monster: text, materials };
}

export function compilePsct(card: Partial<Card>, id: number, opts: PsctCompileOptions = {}): PsctCompileReport {
  // The id is spliced into Lua (header comment); only a positive safe integer is acceptable.
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid card id ${String(id)}: expected a positive integer passcode`);
  const ctx = buildCtx(card, id, opts);
  const limitNotes: string[] = [];
  let desc = String(card.desc || '');
  if (desc.length > PSCT_MAX_DESC_CHARS) {
    limitNotes.push(`Card text is ${desc.length} characters; only the first ${PSCT_MAX_DESC_CHARS} were compiled, the rest is NOT simulated.`);
    desc = desc.slice(0, PSCT_MAX_DESC_CHARS);
  }
  const { pendulum, monster, materials } = splitDesc(desc, ctx);
  const effects: EffectIR[] = [];
  let hoptNext = 0;
  let droppedSentences = 0;

  if (ctx.extra) {
    const eff = newEffect(effects.length + 1, 'monster', materials || '(no material line)');
    eff.kind = 'material';
    if (!materials || !parseMaterials(materials, ctx, eff)) {
      markUnparsed(eff, materials || 'material line missing');
      eff.notes.push('summon procedure not generated: the card cannot be Summoned from the Extra Deck in simulations');
    }
    effects.push(eff);
  } else if (ctx.isRitual) {
    const eff = newEffect(effects.length + 1, 'monster', 'Ritual Monster');
    eff.kind = 'material';
    eff.initLines.push('\tc:EnableReviveLimit()');
    effects.push(eff);
  }
  if (ctx.isPendulum) {
    const eff = newEffect(effects.length + 1, 'pendulum', 'Pendulum procedure');
    eff.kind = 'material';
    eff.initLines.push('\tPendulum.AddProcedure(c)');
    effects.push(eff);
  }

  const section = (text: string, sec: EffectIR['section']) => {
    const start = effects.length;
    const activatable = () => effects.slice(start).filter((e) => !['continuous', 'material', 'restriction', 'unknown'].includes(e.kind) || (e.kind === 'unknown' && e.actions.length));
    const isNormalMonster = ctx.isMonster && (typeBits(card) & 0x10) !== 0;
    if (isNormalMonster && sec === 'monster') return; // flavor text
    for (const sentence of splitSentences(text)) {
      let m: RegExpMatchArray | null;
      if (effects.length >= PSCT_MAX_EFFECTS) {
        droppedSentences += 1;
        continue;
      }
      const last = effects.length > start ? effects[effects.length - 1] : null;
      const lastActivatable = [...activatable()].pop();
      if ((m = sentence.match(HOPT_THIS))) {
        if (lastActivatable && (!lastActivatable.countLimit || lastActivatable.countLimit.kind === 'soft')) {
          lastActivatable.countLimit = { kind: /duel/i.test(m[2]) ? 'duel' : 'hopt', hoptIndex: hoptNext++ };
        } else if (last) last.notes.push(`"${sentence}" had no effect to bind to`);
        continue;
      }
      if ((m = sentence.match(HOPT_EACH))) {
        for (const e of activatable()) if (!e.countLimit || e.countLimit.kind === 'soft') e.countLimit = { kind: /duel/i.test(m[2]) ? 'duel' : 'hopt', hoptIndex: hoptNext++ };
        continue;
      }
      if (HOPT_SHARED.test(sentence)) {
        const idx = hoptNext++;
        for (const e of activatable()) e.countLimit = { kind: 'hopt', hoptIndex: idx };
        continue;
      }
      if ((m = sentence.match(HOPT_ORDINAL))) {
        const ord = { '1st': 0, first: 0, '2nd': 1, second: 1, '3rd': 2, third: 2 }[m[1].toLowerCase() as '1st'] ?? 0;
        const target = activatable()[ord];
        if (target) target.countLimit = { kind: 'hopt', hoptIndex: hoptNext++ };
        continue;
      }
      if (OATH_ACTIVATE.test(sentence)) {
        const act = effects.slice(start).find((e) => e.kind === 'activate') || activatable()[0];
        if (act) act.countLimit = { kind: 'oath' };
        continue;
      }
      if (SS_ONCE_WAY.test(sentence)) {
        const proc = effects.slice(start).filter((e) => e.kind === 'summon-procedure').pop();
        if (proc) proc.countLimit = { kind: 'hopt', hoptIndex: hoptNext++ };
        else if (last) markUnparsed(last, sentence);
        continue;
      }
      if ((m = sentence.match(/^Equip only to (?:an? |1 )?(.+)$/i))) {
        const equip = effects.find((e) => e.text.startsWith('Equip procedure'));
        const notes: string[] = [];
        const f = parseFilter(m[1].replace(/\s+you control$/i, ''), ctx, notes);
        if (equip && !notes.length) {
          const name = helperName(ctx, 'eqfilter');
          equip.helpers.push(`function ${name}(c)\n\treturn ${filterBody(f)}\nend`);
          equip.initLines = [`\taux.AddEquipProcedure(c,${/you control/i.test(m[1]) ? '0' : 'nil'},${name})`];
          equip.text = `Equip procedure (${sentence})`;
        } else if (equip) {
          markUnparsed(equip, sentence);
          equip.notes.push(...notes);
        }
        continue;
      }
      if (SS_ONCE.test(sentence)) {
        const eff = newEffect(effects.length + 1, sec, sentence);
        eff.kind = 'restriction';
        eff.initLines.push('\tc:SetSPSummonOnce(id)');
        effects.push(eff);
        continue;
      }
      if (UNIQUE.test(sentence)) {
        const eff = newEffect(effects.length + 1, sec, sentence);
        eff.kind = 'restriction';
        eff.initLines.push('\tc:SetUniqueOnField(1,0,id)');
        effects.push(eff);
        continue;
      }
      if (/^(?:Cannot be|Must (?:first )?be|You can Ritual Summon this card)/i.test(sentence)) {
        const eff = newEffect(effects.length + 1, sec, sentence);
        eff.kind = 'restriction';
        if (!parseRestriction(sentence, ctx, eff)) markUnparsed(eff, sentence);
        effects.push(eff);
        continue;
      }
      if (last && CONTINUATION.test(sentence) && last.kind !== 'restriction' && last.kind !== 'material') {
        // A follow-up sentence of the previous effect: re-parse the whole effect.
        const merged = newEffect(last.index, last.section, `${last.text}. ${sentence}`);
        merged.countLimit = last.countLimit;
        parseEffectText(merged, ctx);
        effects[effects.length - 1] = merged;
        continue;
      }
      if (/^(?:You cannot|For the rest of this turn|During the rest of this turn)/i.test(sentence) && last) {
        // Lingering restrictions ("You cannot Special Summon ... the turn you activate this effect").
        markUnparsed(last, sentence);
        last.notes.push('lingering restriction not enforced');
        continue;
      }
      const eff = newEffect(effects.length + 1, sec, sentence);
      parseEffectText(eff, ctx);
      effects.push(eff);
    }
  };

  // Continuous/Field Spells and Continuous Traps need a bare activation to be placed.
  const needsBareActivation = (ctx.isSpell && ['continuous', 'field'].includes(ctx.spellKind)) || (ctx.isTrap && ctx.trapKind === 'continuous');
  if (needsBareActivation) {
    const eff = newEffect(effects.length + 1, ctx.isSpell ? 'spell' : 'trap', 'Activate this card');
    eff.kind = 'activate';
    eff.initLines.push(
      '\tlocal e0=Effect.CreateEffect(c)', '\te0:SetType(EFFECT_TYPE_ACTIVATE)', '\te0:SetCode(EVENT_FREE_CHAIN)',
      ...(ctx.isTrap ? ['\te0:SetHintTiming(0,TIMINGS_CHECK_MONSTER_E)'] : []), '\tc:RegisterEffect(e0)'
    );
    effects.push(eff);
  }
  if (ctx.isSpell && ctx.spellKind === 'equip') {
    const eff = newEffect(effects.length + 1, 'spell', 'Equip procedure');
    eff.kind = 'material';
    eff.initLines.push('\taux.AddEquipProcedure(c)');
    effects.push(eff);
  }
  if (pendulum) section(pendulum, 'pendulum');
  section(monster, ctx.isSpell ? 'spell' : ctx.isTrap ? 'trap' : 'monster');

  // Equip Spells: "Equip only to ..." / "The equipped monster gains N ATK" are not modelled beyond the procedure.
  // Lua assembly.
  const init: string[] = [];
  let descIndex = 0;
  for (const eff of effects) {
    if (eff.initLines.length) {
      init.push(`\t-- ${luaComment(eff.text)}`);
      for (const u of eff.unparsed) init.push(`\t-- TODO (not understood): ${luaComment(u)}`);
      init.push(...eff.initLines);
      if (eff.kind === 'material' || eff.kind === 'restriction' || (eff.kind === 'activate' && !eff.luaType)) continue;
    }
    if (eff.kind === 'restriction' || eff.kind === 'material') continue;
    const emptyActivation = eff.luaType && !eff.actions.length && eff.kind !== 'continuous' && eff.kind !== 'summon-procedure';
    if ((!eff.luaType && eff.kind !== 'continuous' && eff.kind !== 'summon-procedure') || emptyActivation) {
      // An effect whose resolution was not understood is not registered at all:
      // an activatable "does nothing" effect would still be invented behaviour.
      // Nothing usable was understood: keep the text as a TODO, invent nothing.
      init.push(`\t-- ${luaComment(eff.text)}`);
      for (const u of eff.unparsed.length ? eff.unparsed : [eff.text]) init.push(`\t-- TODO (not understood): ${luaComment(u)}`);
      if (!eff.unparsed.length) markUnparsed(eff, eff.text);
      continue;
    }
    emitEffect(eff, ctx, init, Math.min(15, descIndex));
    descIndex += eff.kind === 'continuous' ? 0 : 1;
  }

  const lua = [
    `-- Custom Card: ${luaComment(ctx.name, 120)} (ID: ${id})`,
    '-- Generated by Yu-Gi-Oh! Assistant PSCT compiler from the card text.',
    'local s,id=GetID()',
    'function s.initial_effect(c)',
    ...(init.length ? init : ['\t-- No effects (Normal Monster or empty text)']),
    'end',
    ...effects.flatMap((e) => e.helpers),
    '',
  ].join('\n');

  const reports: PsctEffectReport[] = effects.map((e) => ({
    index: e.index,
    text: e.text,
    kind: e.kind,
    understood: e.understood && e.unparsed.length === 0,
    notes: [...new Set(e.notes)],
  }));
  if (droppedSentences) {
    limitNotes.push(`Only the first ${PSCT_MAX_EFFECTS} effects/clauses were compiled; ${droppedSentences} further sentence(s) are NOT simulated.`);
  }
  const unparsed = [...effects.flatMap((e) => e.unparsed), ...limitNotes];
  const scored = reports.filter((r) => r.kind !== 'material' || ctx.extra);
  const ok = scored.filter((r) => r.understood).length;
  const confidence: PsctCompileReport['confidence'] = !scored.length
    ? ((card.desc || '').trim() && !(ctx.isMonster && (typeBits(card) & 0x10)) ? 'low' : 'high')
    : ok === scored.length ? 'high' : ok / scored.length >= 0.5 ? 'medium' : 'low';
  const finalConfidence = limitNotes.length && confidence === 'high' ? 'medium' : confidence;

  return { lua, effects: reports, unparsed, confidence: finalConfidence, designWarnings: designReview(effects, ctx), limitNotes, ir: effects };
}

// ---------------------------------------------------------------------------
// Card-designer review
// ---------------------------------------------------------------------------

function designReview(effects: EffectIR[], ctx: Ctx): string[] {
  const out: string[] = [];
  const card = ctx.card;
  const activatable = effects.filter((e) => ['ignition', 'trigger', 'quick'].includes(e.kind));
  for (const e of activatable) {
    const plus = e.actions.filter((a) => ['search', 'ss', 'ss_self', 'add_from_gy', 'draw'].includes(a.verb));
    if (plus.length && !e.countLimit) {
      out.push(`Effect ${e.index} (${plus.map((a) => a.verb).join('+')}) has no once-per-turn clause: it can be reused every time its condition is met (loop/abuse risk). Official design would add "You can only use this effect of "${ctx.name}" once per turn".`);
    }
    const negates = e.actions.some((a) => a.verb.startsWith('negate'));
    if (negates && e.kind === 'quick' && !e.countLimit) {
      out.push(`Effect ${e.index} is a repeatable quick negation with no once-per-turn: it can negate every card the opponent plays.`);
    }
  }
  for (const e of effects) {
    for (const a of e.actions) {
      if ((a.verb === 'search' || a.verb === 'add_from_gy') && a.filter?.generic) {
        out.push(`Effect ${e.index} adds ${a.filter.kind === 'card' ? 'ANY card' : `any ${a.filter.kind}`} (no archetype/type filter): a generic tutor is far above normal power level.`);
      }
      if (a.verb === 'ss' && a.subject === 'select' && a.filter?.generic && a.locs?.includes('LOCATION_DECK')) {
        out.push(`Effect ${e.index} Special Summons any monster from the Deck: unrestricted Deck summoning is a degenerate combo enabler.`);
      }
      if ((a.verb === 'damage' || a.verb === 'recover') && a.amount !== undefined && (a.amount > 4000 || a.amount % 50 !== 0)) {
        out.push(`Effect ${e.index}: ${a.amount} ${a.verb === 'damage' ? 'damage' : 'LP'} is outside the usual range (multiples of 50/100, at most a few thousand).`);
      }
      if (a.verb === 'stat' && a.amount !== undefined && (Math.abs(a.amount) > 3000 || a.amount % 50 !== 0)) {
        out.push(`Effect ${e.index}: ATK/DEF change of ${a.amount} is outside the usual range.`);
      }
    }
    if (ctx.isSpell && ctx.spellKind === 'normal' && e.kind === 'activate' && !e.costs.length) {
      const draw = e.actions.find((a) => a.verb === 'draw' && (a.count || 0) >= 2);
      if (draw && e.actions.length === 1) out.push(`Normal Spell that draws ${draw.count} with no cost or drawback is Pot of Greed-tier (Forbidden card) power.`);
    }
  }
  const atk = Number(card.atk);
  if (ctx.isMonster && Number.isFinite(atk) && card.atk !== undefined && (atk > 5000 || atk % 50 !== 0)) out.push(`ATK ${atk} is outside normal ranges (multiples of 50, at most 5000).`);
  const def = Number(card.def);
  if (ctx.isMonster && Number.isFinite(def) && card.def !== undefined && (def > 5000 || def % 50 !== 0)) out.push(`DEF ${def} is outside normal ranges.`);
  if (ctx.isMonster && !ctx.extra && !ctx.isRitual && ctx.level >= 5) {
    const restricted = effects.some((e) => e.kind === 'restriction' || e.kind === 'summon-procedure');
    const freeSelfSS = effects.some((e) => e.kind !== 'trigger' && e.range === 'LOCATION_HAND' && e.actions.some((a) => a.verb === 'ss_self') && !e.costs.length && !e.conditions.length);
    if (freeSelfSS && !restricted) out.push(`Level ${ctx.level} monster can Special Summon itself from the hand with no cost or condition: it skips the Tribute requirement entirely.`);
  }
  if (ctx.isMonster && ctx.level > 0 && ctx.level <= 4 && atk > 2000 && effects.some((e) => e.actions.some((a) => a.verb === 'ss_self'))) {
    out.push(`Level ${ctx.level} monster with ${atk} ATK that also Special Summons itself: above the usual stat line for an extender.`);
  }
  return [...new Set(out)];
}

/**
 * Summon-procedure Lua only (material line, Ritual/Pendulum/Equip procedures,
 * "Cannot be Normal Summoned/Set"). Used by the legacy effectsSpec generator so
 * Extra Deck cards built from a spec still honour their material line.
 */
export function compileSummonProcedure(card: Partial<Card>, id: number, opts: PsctCompileOptions = {}): { init: string[]; helpers: string[]; unparsed: string[] } {
  const report = compilePsct(card, id, opts);
  const procs = report.ir.filter((e) => e.kind === 'material' || e.kind === 'restriction');
  return {
    init: procs.flatMap((e) => e.initLines),
    helpers: procs.flatMap((e) => e.helpers),
    unparsed: procs.flatMap((e) => e.unparsed),
  };
}
