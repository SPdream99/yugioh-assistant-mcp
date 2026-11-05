/**
 * PSCT compiler test harness.
 *
 * 1. Compiles representative card texts and asserts the IR (kinds, count
 *    limits, categories, warnings, unparsed clauses).
 * 2. Loads every generated script into the real ocgcore engine and plays a
 *    short duel, asserting the core reports no Lua errors.
 * 3. Security: Lua injection through names/text/spec fields, bounded work on
 *    pathological input, input validation.
 *
 * Run: npx tsx src/core/custom-cards/test_psct_compiler.ts
 */
// Must load first: keeps test cards out of the real custom-card registry.
import '../../test-support/test_isolated_custom_data.js';
import luaparse from 'luaparse';
import { OcgMessageType, OcgResponseType, SelectIdleCMDAction } from 'ocgcore-wasm';
import type { Card } from '../../types/card.js';
import { compilePsct, luaString, PSCT_MAX_DESC_CHARS, PSCT_MAX_EFFECTS, type PsctCompileReport } from './psct-compiler.js';
import { generateLuaScript } from './lua-generator.js';
import { customCardToEngine } from './engine-data.js';
import { validateCustomCardInput, MAX_CUSTOM_LUA_BYTES } from './registry.js';
import { runOcgCoreDuel } from '../card-scripts/ocgcore-runtime.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

const WARWOLF = 69247929; // vanilla filler
const ENGRAVER = 60764609; // real "Fiendsmith" card (setcode 0x1a8 from cards.cdb)
const TESTARCH_FILLER = 990100900; // custom "Testarch" vanilla for archetype searches
const EMPTY_SCRIPT = 'local s,id=GetID()\nfunction s.initial_effect(c)\nend\n';

// Names resolve from a fixed table so the test does not depend on the registry contents.
const NAMES: Record<string, number> = { 'blue-eyes white dragon': 89631139, 'testarch filler': TESTARCH_FILLER };
const resolveName = (n: string) => NAMES[n.toLowerCase()] ?? null;

interface Case {
  code: number;
  card: Partial<Card>;
  zone: 'hand' | 'extra';
  verify: (r: PsctCompileReport) => void;
  mustChain?: boolean;
  /** The card must activate at least once in the engine (exercises its runtime code). */
  mustActivate?: boolean;
}

const lua = (r: PsctCompileReport) => r.lua;
const kinds = (r: PsctCompileReport) => r.ir.map((e) => e.kind).join(',');

const CASES: Case[] = [
  {
    code: 990100001,
    zone: 'hand',
    mustChain: true,
    card: {
      name: "Fiendsmith's Agony", type: 'Effect Monster', frameType: 'effect', race: 'Fiend', attribute: 'LIGHT', level: 4, atk: 1850, def: 0, archetype: 'Fiendsmith',
      desc: 'If you control no monsters, or control a LIGHT Fiend monster: You can Special Summon this card (from your hand). You can only use this effect of "Fiendsmith\'s Agony" once per turn. If this card is Normal or Special Summoned: You can add 1 "Fiendsmith" card from your Deck to your hand.',
    },
    verify: (r) => {
      check(kinds(r) === 'ignition,trigger', 'Agony: ignition + trigger');
      check(r.ir[0].range === 'LOCATION_HAND', 'Agony: SS effect range is the hand');
      check(r.ir[0].countLimit?.kind === 'hopt' && r.ir[0].countLimit.hoptIndex === 0, 'Agony: effect 1 has HOPT {id,0}');
      check(!r.ir[1].countLimit, 'Agony: effect 2 has NO count limit (text has none)');
      check(lua(r).includes('SetCountLimit(1,{id,0})') && (lua(r).match(/SetCountLimit/g) || []).length === 1, 'Agony: exactly one SetCountLimit');
      check(lua(r).includes('c:IsSetCard(0x1a8'), 'Agony: searches by the real Fiendsmith setcode');
      check(lua(r).includes('CATEGORY_TOHAND+CATEGORY_SEARCH'), 'Agony: search categories combined');
      check(lua(r).includes('EVENT_SPSUMMON_SUCCESS') && lua(r).includes('EFFECT_FLAG_DELAY'), 'Agony: NS/SS trigger with DELAY');
      check(lua(r).includes('IsAttribute(ATTRIBUTE_LIGHT)') && lua(r).includes('IsRace(RACE_FIEND)'), 'Agony: LIGHT Fiend condition');
      check(r.designWarnings.some((w) => w.startsWith('Effect 2') && /once-per-turn/.test(w)), 'Agony: warning for search without OPT');
      check(r.confidence === 'high' && r.unparsed.length === 0, 'Agony: fully understood');
    },
  },
  {
    code: 990100002,
    mustActivate: true,
    zone: 'hand',
    card: {
      name: 'Test Veiler', type: 'Effect Monster', frameType: 'effect', race: 'Fairy', attribute: 'LIGHT', level: 3, atk: 1000, def: 1000,
      desc: 'When your opponent activates a card or effect (Quick Effect): You can Tribute this card; negate the activation, and if you do, destroy that card. You can only use this effect of "Test Veiler" once per turn.',
    },
    verify: (r) => {
      check(kinds(r) === 'quick', 'Veiler: quick effect');
      check(lua(r).includes('EFFECT_TYPE_QUICK_O') && lua(r).includes('EVENT_CHAINING'), 'Veiler: QUICK_O on EVENT_CHAINING');
      check(lua(r).includes('rp==1-tp') && lua(r).includes('Duel.IsChainNegatable(ev)'), 'Veiler: opponent + negatable condition');
      check(lua(r).includes('Duel.Release(c,REASON_COST)'), 'Veiler: Tribute self cost');
      check(lua(r).includes('Duel.NegateActivation(ev)') && lua(r).includes('Duel.Destroy(eg,REASON_EFFECT)'), 'Veiler: negate then destroy');
      check(lua(r).includes('CATEGORY_NEGATE+CATEGORY_DESTROY'), 'Veiler: categories');
      check(r.ir[0].countLimit?.kind === 'hopt', 'Veiler: HOPT');
    },
  },
  {
    code: 990100003,
    mustActivate: true,
    zone: 'hand',
    card: { name: 'Test Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.' },
    verify: (r) => {
      check(kinds(r) === 'activate', 'Greed: activation');
      check(lua(r).includes('EFFECT_TYPE_ACTIVATE') && lua(r).includes('Duel.Draw(tp,2,REASON_EFFECT)'), 'Greed: draws 2');
      check(r.designWarnings.some((w) => /Pot of Greed/.test(w)), 'Greed: Pot of Greed warning');
    },
  },
  {
    code: 990100004,
    mustActivate: true,
    zone: 'hand',
    card: { name: 'Test Judgment', type: 'Counter Trap Card', frameType: 'trap', desc: 'When your opponent activates a card or effect: Negate the activation, and if you do, destroy that card.' },
    verify: (r) => {
      check(kinds(r) === 'activate', 'Counter: activation');
      check(lua(r).includes('EVENT_CHAINING') && lua(r).includes('Duel.IsChainNegatable(ev)'), 'Counter: chain negation');
      check(!/SendtoGrave\(\s*e:GetHandler\(\)/.test(lua(r)) && !lua(r).includes('SetCost'), 'Counter: no self-send cost');
    },
  },
  {
    code: 990100005,
    zone: 'extra',
    card: {
      name: 'Test Synchron Lord', type: 'Synchro Effect Monster', frameType: 'synchro', race: 'Warrior', attribute: 'DARK', level: 7, atk: 2500, def: 2000,
      desc: '1 DARK Tuner + 1+ non-Tuner monsters\nIf this card is Synchro Summoned: You can draw 1 card. You can only use this effect of "Test Synchron Lord" once per turn.',
    },
    verify: (r) => {
      check(r.ir[0].kind === 'material' && r.ir[0].understood, 'Synchro: material line understood');
      check(/Synchro\.AddProcedure\(c,s\.matfilter\d+,1,1,Synchro\.NonTuner\(nil\),1,99\)/.test(lua(r)), 'Synchro: procedure with DARK Tuner filter');
      check(lua(r).includes('IsAttribute(ATTRIBUTE_DARK)'), 'Synchro: DARK filter');
      check(lua(r).includes('IsSummonType(SUMMON_TYPE_SYNCHRO)'), 'Synchro: Synchro Summoned condition');
    },
  },
  {
    code: 990100006,
    zone: 'extra',
    card: {
      name: 'Test Xyz Knight', type: 'XYZ Effect Monster', frameType: 'xyz', race: 'Warrior', attribute: 'LIGHT', level: 4, atk: 2200, def: 1800,
      desc: '2 Level 4 monsters\nOnce per turn: You can detach 1 material from this card, then target 1 card your opponent controls; destroy it.',
    },
    verify: (r) => {
      check(lua(r).includes('Xyz.AddProcedure(c,nil,4,2)'), 'Xyz: 2 Level 4 procedure');
      check(lua(r).includes('c:RemoveOverlayCard(tp,1,1,REASON_COST)'), 'Xyz: detach cost');
      check(lua(r).includes('EFFECT_FLAG_CARD_TARGET') && lua(r).includes('Duel.SelectTarget'), 'Xyz: targets');
      check(lua(r).includes('SetCountLimit(1)\n') || /SetCountLimit\(1\)\s/.test(lua(r)), 'Xyz: soft once per turn');
    },
  },
  {
    code: 990100007,
    zone: 'extra',
    card: {
      name: 'Test Link Weaver', type: 'Link Monster', frameType: 'link', race: 'Cyberse', attribute: 'DARK', linkval: 2, atk: 1600, linkmarkers: ['Bottom-Left', 'Bottom-Right'],
      desc: '2 monsters, including a "Testarch" monster\nIf this card is Link Summoned: You can add 1 Spell from your Deck to your hand. You can only use this effect of "Test Link Weaver" once per turn.',
    },
    verify: (r) => {
      check(/Link\.AddProcedure\(c,nil,2,2,s\.lcheck\d+\)/.test(lua(r)), 'Link: procedure with "including" check');
      check(r.designWarnings.some((w) => /any spell/i.test(w)), 'Link: generic Spell tutor warning');
    },
  },
  {
    code: 990100008,
    zone: 'extra',
    card: {
      name: 'Test Twin Fusion', type: 'Fusion Monster', frameType: 'fusion', race: 'Dragon', attribute: 'LIGHT', level: 8, atk: 3000, def: 2500,
      desc: '"Blue-Eyes White Dragon" + 1 "Testarch" monster\nThis card cannot be destroyed by battle.',
    },
    verify: (r) => {
      check(/Fusion\.AddProcMix\(c,true,true,89631139,s\.ffilter\d+\)/.test(lua(r)), 'Fusion: named + archetype materials');
      check(lua(r).includes('EFFECT_INDESTRUCTABLE_BATTLE'), 'Fusion: battle protection');
    },
  },
  {
    code: 990100009,
    zone: 'hand',
    card: {
      name: 'Test Bulwark', type: 'Effect Monster', frameType: 'effect', race: 'Rock', attribute: 'EARTH', level: 4, atk: 1000, def: 2000,
      desc: 'This card cannot be destroyed by battle or card effects. Your opponent cannot target this card with card effects.',
    },
    verify: (r) => {
      check(kinds(r) === 'continuous,continuous', 'Bulwark: two continuous effects');
      check(lua(r).includes('EFFECT_INDESTRUCTABLE_BATTLE') && lua(r).includes('EFFECT_INDESTRUCTABLE_EFFECT') && lua(r).includes('aux.tgoval'), 'Bulwark: protection codes');
      check(!lua(r).includes('SetCountLimit'), 'Bulwark: no count limit');
    },
  },
  {
    code: 990100010,
    zone: 'hand',
    card: {
      name: 'Test Grave Caller', type: 'Effect Monster', frameType: 'effect', race: 'Zombie', attribute: 'DARK', level: 4, atk: 1500, def: 1000, archetype: 'Testarch',
      desc: 'If this card is sent to the GY: You can Special Summon 1 Level 4 or lower "Testarch" monster from your Deck in Defense Position, except "Test Grave Caller". You can only use this effect of "Test Grave Caller" once per turn.',
    },
    verify: (r) => {
      check(lua(r).includes('EVENT_TO_GRAVE'), 'GY: EVENT_TO_GRAVE trigger');
      check(lua(r).includes('IsLevelBelow(4)') && lua(r).includes('not c:IsCode(id)'), 'GY: Level + except filter');
      check(lua(r).includes('POS_FACEUP_DEFENSE'), 'GY: Defense Position');
    },
  },
  {
    code: 990100011,
    mustActivate: true,
    zone: 'hand',
    card: { name: 'Test Trap Hole', type: 'Trap Card', frameType: 'trap', desc: 'Target 1 card your opponent controls; destroy it.' },
    verify: (r) => {
      check(kinds(r) === 'activate', 'Trap: activation');
      check(lua(r).includes('Duel.SelectTarget(tp,s.tfilter1,tp,0,LOCATION_ONFIELD,1,1'), 'Trap: targets opponent field');
      check(lua(r).includes('TIMINGS_CHECK_MONSTER_E'), 'Trap: hint timing');
    },
  },
  {
    code: 990100012,
    mustActivate: true,
    zone: 'hand',
    card: {
      name: 'Test Bomber', type: 'Effect Monster', frameType: 'effect', race: 'Pyro', attribute: 'FIRE', level: 3, atk: 1200, def: 600,
      desc: 'You can Tribute this card; inflict 800 damage to your opponent.',
    },
    verify: (r) => {
      check(kinds(r) === 'ignition', 'Burn: ignition');
      check(lua(r).includes('Duel.Damage(1-tp,800,REASON_EFFECT)') && lua(r).includes('CATEGORY_DAMAGE'), 'Burn: 800 damage');
    },
  },
  {
    code: 990100013,
    zone: 'hand',
    card: { name: 'Test Gibberish', type: 'Effect Monster', frameType: 'effect', race: 'Fiend', attribute: 'DARK', level: 4, atk: 1000, def: 1000, desc: 'Blorp the zibbles when the moon is purple, then wibble 3 zorks.' },
    verify: (r) => {
      check(r.confidence === 'low' && r.unparsed.length > 0, 'Gibberish: low confidence, unparsed listed');
      check(lua(r).includes('-- TODO (not understood)') && !lua(r).includes('Effect.CreateEffect'), 'Gibberish: TODO only, no invented effect');
    },
  },
  {
    code: 990100014,
    mustActivate: true,
    zone: 'hand',
    card: {
      name: 'Test Each', type: 'Effect Monster', frameType: 'effect', race: 'Machine', attribute: 'EARTH', level: 4, atk: 1600, def: 1200, archetype: 'Testarch',
      desc: 'You can discard this card; add 1 "Testarch" monster from your Deck to your hand. If this card is sent to the GY: You can draw 1 card. You can only use each effect of "Test Each" once per turn.',
    },
    verify: (r) => {
      check(lua(r).includes('SetCountLimit(1,{id,0})') && lua(r).includes('SetCountLimit(1,{id,1})'), 'Each: distinct HOPT codes {id,0} and {id,1}');
      check(r.ir[0].range === 'LOCATION_HAND' && lua(r).includes('REASON_COST+REASON_DISCARD'), 'Each: discard-self cost from hand');
    },
  },
  {
    code: 990100015,
    zone: 'hand',
    card: {
      name: 'Test Shared', type: 'Effect Monster', frameType: 'effect', race: 'Machine', attribute: 'EARTH', level: 4, atk: 1600, def: 1200,
      desc: 'If this card is Normal Summoned: You can draw 1 card. If this card is sent to the GY: You can gain 500 LP. You can only use 1 "Test Shared" effect per turn, and only once that turn.',
    },
    verify: (r) => {
      check((lua(r).match(/SetCountLimit\(1,\{id,0\}\)/g) || []).length === 2 && !lua(r).includes('{id,1}'), 'Shared: both effects share {id,0}');
    },
  },
  {
    code: 990100016,
    mustActivate: true,
    zone: 'hand',
    card: {
      name: 'Test Bastion', type: 'Continuous Spell Card', frameType: 'spell', archetype: 'Testarch',
      desc: 'All "Testarch" monsters you control gain 300 ATK. Once per turn: You can add 1 "Testarch" monster from your GY to your hand. You can only activate 1 "Test Bastion" per turn.',
    },
    verify: (r) => {
      check(lua(r).includes('EFFECT_UPDATE_ATTACK') && lua(r).includes('SetRange(LOCATION_SZONE)'), 'Continuous Spell: field ATK boost from SZONE');
      check(lua(r).includes('aux.NecroValleyFilter'), 'Continuous Spell: GY add uses NecroValleyFilter');
      check(r.ir.some((e) => e.text === 'Activate this card'), 'Continuous Spell: bare activation');
    },
  },
  {
    code: 990100017,
    zone: 'hand',
    card: {
      name: 'Void Charmer', type: 'Effect Monster', frameType: 'effect', race: 'Spellcaster', attribute: 'DARK', level: 4, atk: 1850, def: 1500,
      desc: 'You can Special Summon this card (from your hand) by sending 1 Spellcaster monster from your hand or field to the GY. You can only Special Summon "Void Charmer" once per turn this way.',
    },
    verify: (r) => {
      check(r.ir[0].kind === 'summon-procedure' && lua(r).includes('EFFECT_SPSUMMON_PROC'), 'Charmer: inherent summon procedure');
      check(lua(r).includes('EFFECT_COUNT_CODE_OATH'), 'Charmer: "once per turn this way" is an OATH count');
    },
  },
  {
    code: 990100018,
    zone: 'hand',
    card: { name: 'Test Breaker', type: 'Quick-Play Spell Card', frameType: 'spell', desc: 'Target 1 face-up monster your opponent controls; negate its effects until the end of this turn.' },
    verify: (r) => {
      check(lua(r).includes('EFFECT_DISABLE_EFFECT') && lua(r).includes('RESETS_STANDARD_PHASE_END'), 'Quick-Play: negate until end of turn');
      check(lua(r).includes('c:IsNegatable()'), 'Quick-Play: negatable target filter');
    },
  },
];

// ---------------------------------------------------------------------------
// Engine harness
// ---------------------------------------------------------------------------

function activateResponder(code: number) {
  return (msg: any): any => {
    switch (msg.type) {
      case OcgMessageType.SELECT_IDLECMD: {
        if (msg.player !== 0) return null;
        const pick = (list: any[] | undefined, action: SelectIdleCMDAction) => {
          const i = (list || []).findIndex((x: any) => x.code === code);
          return i >= 0 ? { type: OcgResponseType.SELECT_IDLECMD, action, index: i } : null;
        };
        return pick(msg.activates, SelectIdleCMDAction.SELECT_ACTIVATE)
          ?? pick(msg.special_summons, SelectIdleCMDAction.SELECT_SPECIAL_SUMMON)
          ?? pick(msg.summons, SelectIdleCMDAction.SELECT_SUMMON)
          ?? pick(msg.spell_sets, SelectIdleCMDAction.SELECT_SPELL_SET);
      }
      case OcgMessageType.SELECT_CHAIN: {
        const i = (msg.selects || []).findIndex((x: any) => x.code === code);
        return i >= 0 ? { type: OcgResponseType.SELECT_CHAIN, index: i } : null;
      }
      case OcgMessageType.SELECT_EFFECTYN:
        return msg.code === code ? { type: OcgResponseType.SELECT_EFFECTYN, yes: true } : null;
      default:
        return null;
    }
  };
}

const testarchFiller: Partial<Card> = { name: 'Testarch Filler', type: 'Normal Monster', frameType: 'normal', race: 'Warrior', attribute: 'EARTH', level: 4, atk: 1000, def: 1000, archetype: 'Testarch' };

async function runInEngine(code: number, card: Partial<Card>, scriptLua: string, zone: 'hand' | 'extra') {
  const deckA = [...Array(28).fill(WARWOLF), ...Array(8).fill(TESTARCH_FILLER), ...Array(4).fill(ENGRAVER)];
  return runOcgCoreDuel({
    deckA,
    deckB: Array(40).fill(WARWOLF),
    handA: zone === 'hand' ? [code] : [],
    // Player B opens with Pot of Greed so chain-response effects (negations) actually resolve.
    handB: [55144522],
    extraA: zone === 'extra' ? [code] : [],
    maxSteps: 400,
    scriptOverrides: {
      [`c${code}.lua`]: scriptLua,
      [`c${WARWOLF}.lua`]: EMPTY_SCRIPT,
      [`c${ENGRAVER}.lua`]: EMPTY_SCRIPT,
      [`c${TESTARCH_FILLER}.lua`]: EMPTY_SCRIPT,
    },
    cardOverrides: {
      [code]: customCardToEngine(card, code) as any,
      [TESTARCH_FILLER]: customCardToEngine(testarchFiller, TESTARCH_FILLER) as any,
    },
    responder: activateResponder(code),
  });
}

const coreErrors = (errors: string[]) => errors.filter((e) => e.startsWith('[core:'));

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/** Every call expression in a Lua chunk, as "Base.Member" / "name" strings. */
function callNames(src: string): string[] {
  const ast: any = luaparse.parse(src, { luaVersion: '5.3', comments: false });
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'CallExpression' || node.type === 'StringCallExpression' || node.type === 'TableCallExpression') {
      const b = node.base;
      if (b?.type === 'Identifier') out.push(b.name);
      else if (b?.type === 'MemberExpression' && b.base?.type === 'Identifier') out.push(`${b.base.name}.${b.identifier.name}`);
    }
    for (const key of Object.keys(node)) if (key !== 'type') walk(node[key]);
  };
  walk(ast);
  return out;
}

function identifiers(src: string): Set<string> {
  const ast: any = luaparse.parse(src, { luaVersion: '5.3', comments: false });
  const out = new Set<string>();
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'Identifier') out.add(node.name);
    for (const key of Object.keys(node)) if (key !== 'type') walk(node[key]);
  };
  walk(ast);
  return out;
}

function securityTests() {
  console.log('\n[Security] Lua injection');
  const nameInjection = compilePsct({ name: 'X\nDuel.Win(0,0x1)--', type: 'Effect Monster', frameType: 'effect', level: 4, desc: 'You can Tribute this card; inflict 500 damage to your opponent.' }, 990100101, { resolveName });
  check(!callNames(nameInjection.lua).includes('Duel.Win'), 'name with newline does not inject Duel.Win');
  check(nameInjection.lua.split('\n').every((l) => !l.includes('Duel.Win') || l.trim().startsWith('--')), 'name payload only inside a comment');

  const payloads = [
    'If you control a "]]os.exit()--" monster: You can add 1 "]]os.exit()--" card from your Deck to your hand.',
    'You can add 1 "X\nos.exit()" card from your Deck to your hand.',
    'You can Tribute this card; destroy all monsters your opponent controls. ]] os.exit() --[[ os.exit()',
    'Draw 1 card.\r\nos.execute("rm -rf /")\n--]]',
  ];
  for (const [i, desc] of payloads.entries()) {
    const r = compilePsct({ name: 'Inject', type: i === 3 ? 'Spell Card' : 'Effect Monster', frameType: i === 3 ? 'spell' : 'effect', level: 4, desc }, 990100102 + i, { resolveName });
    let ids = new Set<string>();
    let parsed = true;
    try {
      ids = identifiers(r.lua);
    } catch {
      parsed = false;
    }
    check(parsed, `desc payload ${i + 1}: generated Lua still parses`);
    check(!ids.has('os'), `desc payload ${i + 1}: no "os" identifier reaches code`);
  }

  const archetypeInjection = generateLuaScript(
    { name: 'Spec\nos.exit()', type: 'Effect Monster', frameType: 'effect', level: 4, archetype: 'Evil"]]\nos.exit()--' },
    990100110,
    [{ type: 'ignition', category: 'CATEGORY_SEARCH) os.exit() --', code: 'EVENT_FREE_CHAIN) os.exit(', range: 'LOCATION_HAND\nos.exit()', description: 'desc\nos.exit()', isHOPT: true }]
  );
  check(!identifiers(archetypeInjection).has('os'), 'effectsSpec fields (category/code/range/description/archetype) cannot inject');

  const lit = luaString('a"b\\c\n]]os.exit()\u0000\'');
  const litAst: any = luaparse.parse(`local x=${lit}`, { luaVersion: '5.3' });
  check(litAst.body.length === 1 && litAst.body[0].init[0].type === 'StringLiteral', 'luaString produces a single string literal');

  console.log('[Security] Bounded work');
  const patho = [
    '"'.repeat(PSCT_MAX_DESC_CHARS),
    'a'.repeat(PSCT_MAX_DESC_CHARS),
    '('.repeat(PSCT_MAX_DESC_CHARS / 2) + ')'.repeat(PSCT_MAX_DESC_CHARS / 2),
    'If you control a '.repeat(250).slice(0, PSCT_MAX_DESC_CHARS),
    '1 "a" or "a" or '.repeat(250).slice(0, PSCT_MAX_DESC_CHARS),
    ('You can add 1 "x" monster, except "' + 'y'.repeat(50) + '" from your Deck to your hand ').repeat(40).slice(0, PSCT_MAX_DESC_CHARS),
    ' , then'.repeat(600).slice(0, PSCT_MAX_DESC_CHARS),
    'Target 1 ' + 'face-up '.repeat(500),
  ];
  for (const [i, desc] of patho.entries()) {
    for (const type of ['Effect Monster', 'Link Monster', 'Fusion Monster']) {
      const t0 = performance.now();
      const r = compilePsct({ name: 'Patho', type, frameType: type.split(' ')[0].toLowerCase(), level: 4, linkval: 2, desc }, 990100120, { resolveName: () => null });
      const ms = performance.now() - t0;
      check(ms < 500, `pathological desc ${i + 1} (${type}) compiles in <500ms (took ${ms.toFixed(1)}ms)`);
      check(typeof r.lua === 'string', `pathological desc ${i + 1} (${type}) returns a report`);
    }
  }
  const long = compilePsct({ name: 'Long', type: 'Spell Card', frameType: 'spell', desc: 'Draw 1 card. '.repeat(500) }, 990100121, { resolveName });
  check(long.limitNotes.some((n) => /only the first 4000/.test(n)), 'text longer than 4000 chars is reported, not silently truncated');
  check(long.limitNotes.some((n) => new RegExp(`first ${PSCT_MAX_EFFECTS} effects`).test(n)) && long.ir.length <= PSCT_MAX_EFFECTS, 'effect count is capped and reported');
  check(long.confidence !== 'high', 'hitting a limit lowers confidence');
  const huge = compilePsct({ name: 'Huge', type: 'Spell Card', frameType: 'spell', desc: 'Inflict 99999999999 damage to your opponent.' }, 990100122, { resolveName });
  check(!/Infinity|99999999999/.test(huge.lua.replace(/^\s*--.*$/gm, '')) && huge.unparsed.length > 0, 'oversized numbers are not spliced into Lua');

  console.log('[Security] Input validation');
  check(validateCustomCardInput('A', { atk: 1.5 }).length === 1, 'non-integer ATK rejected');
  check(validateCustomCardInput('A', { atk: -2 }).length === 1, 'negative ATK rejected');
  check(validateCustomCardInput('A', { level: 99 }).length === 1, 'Level 99 rejected');
  check(validateCustomCardInput('A', { linkval: 9 }).length === 1, 'Link 9 rejected');
  check(validateCustomCardInput('A', { scale: 14 }).length === 1, 'Scale 14 rejected');
  check(validateCustomCardInput('A', {}, 'x'.repeat(MAX_CUSTOM_LUA_BYTES + 1)).length === 1, 'Lua override over 200 KB rejected');
  check(validateCustomCardInput('A', { atk: 3000, def: 2500, level: 8, scale: 4 }).length === 0, 'valid stats accepted');
  let threw = false;
  try {
    compilePsct({ name: 'Bad id', desc: '' }, 1.5);
  } catch {
    threw = true;
  }
  check(threw, 'non-integer card id rejected');
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('=== PSCT compiler tests ===');
  const compiled = new Map<number, PsctCompileReport>();
  for (const c of CASES) {
    const r = compilePsct({ ...c.card, id: c.code }, c.code, { resolveName });
    compiled.set(c.code, r);
    console.log(`\n[IR] ${c.card.name}: ${r.effects.map((e) => `${e.kind}${e.understood ? '' : '(?)'}`).join(', ')} | confidence=${r.confidence} | warnings=${r.designWarnings.length}`);
    c.verify(r);
  }

  securityTests();

  console.log('\n[Engine] Loading every generated script into ocgcore');
  // Negative control: proves a broken script IS reported, so "no errors" below means something.
  const broken = await runInEngine(990100099, { name: 'Broken', type: 'Effect Monster', frameType: 'effect', level: 4 }, 'local s,id=GetID()\nfunction s.initial_effect(c)\n\tc:ThisMethodDoesNotExist()\nend\n', 'hand');
  check(coreErrors(broken.errors).length > 0, 'negative control: a broken script produces a [core: error');

  let engineRuns = 0;
  for (const c of CASES) {
    const r = compiled.get(c.code)!;
    const result = await runInEngine(c.code, { ...c.card, id: c.code }, r.lua, c.zone);
    engineRuns += 1;
    const errs = coreErrors(result.errors);
    if (errs.length) console.log(`  ${c.card.name} core errors:\n    ${errs.slice(0, 5).join('\n    ')}`);
    check(errs.length === 0, `${c.card.name}: no [core: Lua errors (steps=${result.steps})`);
    const chained = result.messages.filter((m) => m.typeName === 'CHAINING' && Number(m.raw.code) === c.code).length;
    console.log(`  ${c.card.name}: steps=${result.steps}, activations=${chained}`);
    if (c.mustActivate) check(chained >= 1, `${c.card.name}: activated in the engine (CHAINING x${chained})`);
    if (c.mustChain) {
      check(chained >= 2, `${c.card.name}: both effects activated in the engine (CHAINING x${chained})`);
      const searched = result.messages.some((m) => m.typeName === 'MOVE' && Number(m.raw.card) === ENGRAVER && Number(m.raw.to?.location) === 2);
      check(searched, `${c.card.name}: a real "Fiendsmith" card was added from Deck to hand`);
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed (${CASES.length} cards compiled, ${engineRuns} engine runs) ===`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
