/**
 * Heuristic duel policy.
 *
 * Not a learned model and not optimal play: a scoring policy over the legal
 * options ocgcore offers, written the way a competent player reasons —
 * develop the board before battling, only attack into monsters it can beat,
 * keep weak monsters in defence, hold disruption for the opponent's plays,
 * pick removal targets by threat and costs/materials by lowest value.
 *
 * It reads the live board through the runtime's `view()` and card text through
 * preloaded knowledge. Face-down opponent cards are treated as unknown: the
 * policy never reads hidden information.
 */

import { OcgMessageType, OcgResponseType, OcgPosition, OcgLocation, SelectBattleCMDAction, SelectIdleCMDAction } from "ocgcore-wasm";
import { placeFromMask, utilityResponse, type DuelView, type FieldCard, type OcgDuelContext } from "../card-scripts/ocgcore-runtime.js";
import { T_EXTRA, T_MONSTER, T_QUICKPLAY, T_TRAP, type CardKnowledge, type KnowledgeLookup } from "./card-knowledge.js";

export interface PolicyStats {
  decisions: number;
  activations: number;
  summons: number;
  chains: number;
  attacks: number;
  passes: number;
}

export interface PolicyOptions {
  seed?: number;
  /** 0 = always the top-scored option, 1 = fully random among legal options. */
  exploration?: number;
  /** Chain at most this many own links in one chain before passing. */
  maxChainDepth?: number;
  /** Card knowledge preloaded with loadCardKnowledge(); without it the policy falls back to board stats only. */
  knowledge?: KnowledgeLookup;
}

/** Hand traps / disruption that should be chained against the opponent when offered. */
const DISRUPTION_CODES = new Set([
  14558127, // Ash Blossom
  23434538, // Maxx "C"
  94145021, // Droll & Lock Bird
  97268402, // Effect Veiler
  10045474, // Infinite Impermanence
  24224830, // Called by the Grave
  73642296, // Nibiru
  65681983, // Ghost Belle
  59438930, // Ghost Ogre
  62015408, // Dimension Shifter
  52038441 // Mulcharmy Fuwalos
]);

// HINTMSG_* ids (constant.lua): what the engine says the selection is for.
const HINT = {
  RELEASE: 500, DISCARD: 501, DESTROY: 502, REMOVE: 503, TOGRAVE: 504, RTOHAND: 505, ATOHAND: 506,
  TODECK: 507, SUMMON: 508, SPSUMMON: 509, SET: 510, FMATERIAL: 511, SMATERIAL: 512, XMATERIAL: 513,
  FACEUP: 514, EQUIP: 518, REMOVEXYZ: 519, CONTROL: 520, TOFIELD: 527, TRIBUTE: 531, DEATTACHFROM: 532,
  LMATERIAL: 533, ATTACKTARGET: 549, TARGET: 551, NEGATE: 575
} as const;

/** Selections that hurt whoever owns the chosen card. */
const HARMFUL_HINTS = new Set<number>([HINT.DESTROY, HINT.REMOVE, HINT.TOGRAVE, HINT.RTOHAND, HINT.TODECK, HINT.CONTROL, HINT.NEGATE, HINT.DISCARD, HINT.RELEASE]);
/** Selections that spend own resources (pick the cheapest). */
const COST_HINTS = new Set<number>([HINT.RELEASE, HINT.DISCARD, HINT.FMATERIAL, HINT.SMATERIAL, HINT.XMATERIAL, HINT.LMATERIAL, HINT.TRIBUTE, HINT.REMOVEXYZ, HINT.DEATTACHFROM]);
/** Selections that give the selector something (pick the best). */
const GAIN_HINTS = new Set<number>([HINT.ATOHAND, HINT.SPSUMMON, HINT.SUMMON, HINT.SET, HINT.FACEUP, HINT.EQUIP, HINT.TOFIELD]);

const PHASE_END = 0x200;
const FACEDOWN_DEF_GUESS = 1500;

function isRequestType(type: number): boolean {
  return (type >= OcgMessageType.SELECT_BATTLECMD && type <= OcgMessageType.SELECT_UNSELECT_CARD) || type === OcgMessageType.SELECT_CHAIN;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  index: number;
  score: number;
}

const EMPTY_VIEW: DuelView = {
  turn: 0, turnPlayer: 0, lp: [8000, 8000], monsters: [[], []], spells: [[], []],
  handCount: [0, 0], graveCount: [0, 0], deckCount: [0, 0]
};

export function createPolicy(options: PolicyOptions = {}) {
  const random = mulberry32(options.seed ?? 1);
  const exploration = Math.max(0, Math.min(options.exploration ?? 0.1, 1));
  const maxChainDepth = options.maxChainDepth ?? 3;
  const know: KnowledgeLookup = options.knowledge ?? (() => undefined);
  const stats: PolicyStats = { decisions: 0, activations: 0, summons: 0, chains: 0, attacks: 0, passes: 0 };

  // Per-turn memory: stops a repeatable effect from being spammed until the step budget runs out.
  let memoTurn = -1;
  let activationCount = new Map<string, number>();
  let plannedTarget: { controller: number; location: number; sequence: number } | null = null;

  const pickBest = (candidates: Candidate[]): number | null => {
    if (candidates.length === 0) return null;
    if (exploration > 0 && random() < exploration) return candidates[Math.floor(random() * candidates.length)].index;
    return [...candidates].sort((a, b) => b.score - a.score)[0].index;
  };

  const opponentView = (view: DuelView, player: number) => {
    // Face-down opponent cards are unknown: strip their stats.
    return view.monsters[1 - player].map((m) => (m.faceUp ? m : { ...m, code: 0, attack: 0, defense: FACEDOWN_DEF_GUESS }));
  };

  const strongestAttacker = (monsters: FieldCard[]) =>
    monsters.filter((m) => m.faceUp && m.attackPosition).reduce((max, m) => Math.max(max, m.attack), 0);

  /** Rough worth of a card to its controller, for targeting and for picking costs. */
  const cardValue = (code: number, onField?: FieldCard): number => {
    const k = know(code);
    if (onField && onField.location === OcgLocation.MZONE) {
      if (!onField.faceUp) return FACEDOWN_DEF_GUESS;
      return Math.max(onField.attack, onField.defense * 0.6) + ((onField.type & T_EXTRA) ? 800 : 0);
    }
    if (!k) return 1000;
    let value = (k.type & T_MONSTER) ? Math.max(k.atk, k.def * 0.6) : 1200;
    if ((k.type & T_EXTRA) && (k.type & T_MONSTER)) value += 800;
    if (k.roles.search || k.roles.draw) value += 700;
    if (k.roles.negate) value += 600;
    if (k.roles.removal) value += 500;
    if (DISRUPTION_CODES.has(code)) value += 900;
    return value;
  };

  /** Card values for a cost: cards that want to be in the GY are cheap to send there. */
  const costValue = (code: number, onField?: FieldCard, hint?: number): number => {
    const k = know(code);
    let value = cardValue(code, onField);
    if (k?.roles.gyEffect && (hint === HINT.TOGRAVE || hint === HINT.DISCARD || hint === HINT.RELEASE)) value -= 900;
    return value;
  };

  const findOnField = (view: DuelView, entry: any): FieldCard | undefined => {
    const controller = Number(entry.controller) & 1;
    const location = Number(entry.location);
    const zone = location & OcgLocation.MZONE ? view.monsters[controller] : location & OcgLocation.SZONE ? view.spells[controller] : null;
    return zone?.find((c) => c.sequence === Number(entry.sequence));
  };

  /** Most recent SELECTMSG hint addressed to this player since the last request. */
  const lastSelectHint = (ctx: OcgDuelContext | undefined, player: number): number => {
    const messages = ctx?.messages ?? [];
    // The current request is the newest message; a hint belongs to it only if no
    // earlier request sits in between (otherwise it is a stale hint from that one).
    for (let i = messages.length - 2, seen = 0; i >= 0 && seen < 40; i--, seen++) {
      if (isRequestType(messages[i].type)) break;
      const raw = messages[i].raw;
      if (messages[i].type === OcgMessageType.HINT && Number(raw?.hint_type) === 3 && Number(raw?.player) === player) {
        return Number(raw.hint) || 0;
      }
    }
    return 0;
  };

  /** State of the current chain, phase and battle, read from the message log. */
  const chainState = (ctx: OcgDuelContext | undefined) => {
    const messages = ctx?.messages ?? [];
    // Open chain: CHAINING links newer than the last CHAIN_END.
    const links: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === OcgMessageType.CHAIN_END || m.type === OcgMessageType.NEW_TURN) break;
      if (m.type === OcgMessageType.CHAINING) links.unshift(Number(m.raw?.controller) & 1);
    }
    // Current phase: newest NEW_PHASE of this turn.
    let phase = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === OcgMessageType.NEW_PHASE) { phase = Number(m.raw?.phase) || 0; break; }
      if (m.type === OcgMessageType.NEW_TURN) break;
    }
    // An attack is pending when the newest ATTACK has not reached damage calculation yet.
    let attackPending = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i].type;
      if (t === OcgMessageType.ATTACK) { attackPending = true; break; }
      if (t === OcgMessageType.BATTLE || t === OcgMessageType.DAMAGE_STEP_END || t === OcgMessageType.ATTACK_DISABLED || t === OcgMessageType.NEW_PHASE || t === OcgMessageType.NEW_TURN) break;
    }
    return { links, phase, attackPending };
  };

  const resetTurnMemo = (view: DuelView) => {
    if (view.turn !== memoTurn) {
      memoTurn = view.turn;
      activationCount = new Map();
    }
  };

  // -------------------------------------------------------------------------
  // Main Phase
  // -------------------------------------------------------------------------
  const idle = (message: any, view: DuelView, player: number) => {
    resetTurnMemo(view);
    const mine = view.monsters[player];
    const theirs = opponentView(view, player);
    const oppAtk = strongestAttacker(theirs);
    const oppHasCards = theirs.length + view.spells[1 - player].length > 0;
    const freeZones = 5 - mine.filter((m) => m.sequence < 5).length;

    type Option = { action: SelectIdleCMDAction; index: number | null; score: number };
    const options: Option[] = [];

    (message.activates || []).forEach((entry: any, index: number) => {
      const k = know(Number(entry.code));
      const key = `${entry.code}:${entry.description}`;
      const used = activationCount.get(key) ?? 0;
      let score = 70;
      if (k) {
        if (k.roles.search || k.roles.draw) score += 30;
        if (k.roles.summon) score += 20;
        if (k.roles.removal) score += oppHasCards ? 35 : -40;
        if (k.roles.burn) score += 10;
        // Reactive cards (negation, set traps/quick-plays) are worth more held for the opponent's turn.
        if (k.roles.negate && !(k.roles.search || k.roles.draw || k.roles.summon)) score -= 45;
        if ((k.type & (T_TRAP | T_QUICKPLAY)) && Number(entry.location) === OcgLocation.SZONE && !k.roles.removal) score -= 30;
      }
      score -= used * 45;
      options.push({ action: SelectIdleCMDAction.SELECT_ACTIVATE, index, score });
    });

    (message.special_summons || []).forEach((entry: any, index: number) => {
      const k = know(Number(entry.code));
      const fromExtra = Number(entry.location) === OcgLocation.EXTRA;
      let score = 72 + (k ? k.atk / 150 : 0);
      if (fromExtra) score += 6;
      if (k?.roles.summonTrigger) score += 10;
      options.push({ action: SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, index, score });
    });

    (message.summons || []).forEach((entry: any, index: number) => {
      const k = know(Number(entry.code));
      const atk = k?.atk ?? 0;
      const def = k?.def ?? 0;
      let score = 55 + atk / 150;
      if (k?.roles.summonTrigger) score += 20;
      // A monster that would just die to the opponent's board is better Set.
      if (oppAtk > atk && def > atk && !k?.roles.summonTrigger) score -= 20;
      if (k?.roles.flip) score -= 25;
      if (freeZones <= 0) score -= 100;
      options.push({ action: SelectIdleCMDAction.SELECT_SUMMON, index, score });
    });

    (message.monster_sets || []).forEach((entry: any, index: number) => {
      const k = know(Number(entry.code));
      const atk = k?.atk ?? 0;
      const def = k?.def ?? 0;
      let score = 35 + def / 200;
      if (oppAtk > atk && def >= atk) score += 20;
      if (k?.roles.flip) score += 30;
      options.push({ action: SelectIdleCMDAction.SELECT_MONSTER_SET, index, score });
    });

    (message.spell_sets || []).forEach((entry: any, index: number) => {
      const k = know(Number(entry.code));
      // Set traps and quick-plays (they need a turn / are better at instant speed); a normal spell Set does nothing.
      let score = 8;
      if (k && (k.type & T_TRAP)) score = 50;
      else if (k && (k.type & T_QUICKPLAY)) score = 42;
      else if (!k) score = 30;
      const setCount = view.spells[player].filter((s) => s.sequence < 5).length;
      if (setCount >= 4) score -= 30;
      options.push({ action: SelectIdleCMDAction.SELECT_SPELL_SET, index, score });
    });

    (message.pos_changes || []).forEach((entry: any, index: number) => {
      const card = mine.find((m) => m.sequence === Number(entry.sequence));
      if (!card) return;
      const shouldAttack = card.attack > oppAtk || theirs.length === 0;
      if (!card.attackPosition && card.faceUp && shouldAttack && card.attack >= card.defense * 0.8) {
        options.push({ action: SelectIdleCMDAction.SELECT_POS_CHANGE, index, score: 25 });
      } else if (card.attackPosition && !shouldAttack && card.defense > card.attack) {
        options.push({ action: SelectIdleCMDAction.SELECT_POS_CHANGE, index, score: 15 });
      }
    });

    // Battle only when at least one attack is profitable.
    if (message.to_bp) {
      const profitable = mine.some((m) => m.faceUp && m.attackPosition && bestAttack(m.attack, theirs) > 0);
      options.push({ action: SelectIdleCMDAction.TO_BP, index: null, score: profitable ? 20 : -5 });
    }
    if (message.to_ep) options.push({ action: SelectIdleCMDAction.TO_EP, index: null, score: 10 });

    const legal = options.filter((o) => o.score > 10 || o.action === SelectIdleCMDAction.TO_EP || o.action === SelectIdleCMDAction.TO_BP);
    const chosenIdx = pickBest(legal.map((o, i) => ({ index: i, score: o.score })));
    const chosen = chosenIdx === null ? null : legal[chosenIdx];
    if (!chosen) return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null };

    if (chosen.action === SelectIdleCMDAction.SELECT_ACTIVATE) {
      const entry = message.activates[chosen.index!];
      const key = `${entry.code}:${entry.description}`;
      activationCount.set(key, (activationCount.get(key) ?? 0) + 1);
      stats.activations += 1;
    } else if (chosen.action === SelectIdleCMDAction.SELECT_SUMMON || chosen.action === SelectIdleCMDAction.SELECT_SPECIAL_SUMMON) {
      stats.summons += 1;
    } else if (chosen.action === SelectIdleCMDAction.TO_EP || chosen.action === SelectIdleCMDAction.TO_BP) {
      stats.passes += 1;
    }
    return { type: OcgResponseType.SELECT_IDLECMD, action: chosen.action, index: chosen.index };
  };

  /** Value of the best attack for an attacker with `atk` against the visible board (<= 0 = do not attack). */
  function bestAttack(atk: number, theirs: FieldCard[], canDirect = true): number {
    if (theirs.length === 0) return canDirect ? 1000 + atk : 0;
    let best = -Infinity;
    for (const target of theirs) best = Math.max(best, attackValue(atk, target));
    return best;
  }

  function attackValue(atk: number, target: FieldCard): number {
    if (!target.faceUp) return atk > FACEDOWN_DEF_GUESS + 300 ? 400 : -300;
    if (target.attackPosition) {
      if (atk > target.attack) return 600 + target.attack / 2 + (atk - target.attack) / 4;
      if (atk === target.attack) return target.attack >= 2000 ? 50 : -100; // trade only into something worth it
      return -1000;
    }
    if (atk > target.defense) return 400 + target.defense / 4;
    return -500 - (target.defense - atk);
  }

  // -------------------------------------------------------------------------
  // Battle Phase
  // -------------------------------------------------------------------------
  const battle = (message: any, view: DuelView, player: number) => {
    const theirs = opponentView(view, player);
    const attacks: any[] = message.attacks || [];
    let best: { index: number; score: number; target: FieldCard | null } | null = null;
    attacks.forEach((entry: any, index: number) => {
      const attacker = findOnField(view, entry);
      const atk = attacker?.attack ?? know(Number(entry.code))?.atk ?? 0;
      if (theirs.length === 0 || (entry.can_direct && theirs.length === 0)) {
        const score = 1000 + atk;
        if (!best || score > best.score) best = { index, score, target: null };
        return;
      }
      for (const target of theirs) {
        const score = attackValue(atk, target);
        if (!best || score > best.score) best = { index, score, target };
      }
      if (entry.can_direct) {
        const score = 1000 + atk;
        if (!best || score > best.score) best = { index, score, target: null };
      }
    });

    const chosen = best as { index: number; score: number; target: FieldCard | null } | null;
    if (chosen && chosen.score > 0) {
      stats.attacks += 1;
      plannedTarget = chosen.target ? { controller: chosen.target.controller, location: chosen.target.location, sequence: chosen.target.sequence } : null;
      return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.SELECT_BATTLE, index: chosen.index };
    }
    plannedTarget = null;
    if (message.to_m2) return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_M2, index: null };
    return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_EP, index: null };
  };

  // -------------------------------------------------------------------------
  // Chains
  // -------------------------------------------------------------------------
  const chain = (message: any, view: DuelView, player: number, ctx?: OcgDuelContext) => {
    const selects: any[] = message.selects || [];
    if (selects.length === 0) return { type: OcgResponseType.SELECT_CHAIN, index: null };
    const { links, phase, attackPending } = chainState(ctx);
    const opponentLinkOnTop = links.length > 0 && links[links.length - 1] !== player;
    const ownLinks = links.filter((l) => l === player).length;
    const myTurn = view.turnPlayer === player;
    const oppHasCards = view.monsters[1 - player].length + view.spells[1 - player].length > 0;

    const scored: Candidate[] = selects.map((entry: any, index: number) => {
      const code = Number(entry.code);
      const k = know(code);
      let score = -10;
      if (DISRUPTION_CODES.has(code)) score = opponentLinkOnTop || (!myTurn && links.length === 0 && view.turnPlayer !== player) ? 90 : -50;
      else if (k) {
        const fromField = Number(entry.location) & (OcgLocation.MZONE | OcgLocation.GRAVE | OcgLocation.HAND | OcgLocation.REMOVED);
        if (k.roles.negate) score = opponentLinkOnTop ? 85 : -40;
        else if (k.roles.search || k.roles.draw || k.roles.summon) score = (k.type & T_MONSTER) && fromField ? 60 : 25;
        else if (k.roles.removal) {
          // Removal: answer an attack, or use it on the opponent's turn / End Phase rather than idle.
          if (!oppHasCards) score = -30;
          else if (attackPending && !myTurn) score = 80;
          else if (opponentLinkOnTop) score = 55;
          else if (!myTurn && phase === PHASE_END) score = 50;
          else if ((k.type & T_MONSTER) && fromField) score = 40;
          else score = -5;
        } else if (k.roles.burn) score = 30;
        else if ((k.type & T_MONSTER) && fromField) score = 20; // an offered monster trigger is usually upside
      }
      if (ownLinks >= maxChainDepth) score -= 100;
      return { index, score };
    });

    if (message.forced) {
      stats.chains += 1;
      return { type: OcgResponseType.SELECT_CHAIN, index: pickBest(scored) ?? 0 };
    }
    const viable = scored.filter((c) => c.score > 0);
    if (viable.length === 0) return { type: OcgResponseType.SELECT_CHAIN, index: null };
    stats.chains += 1;
    return { type: OcgResponseType.SELECT_CHAIN, index: pickBest(viable) };
  };

  // -------------------------------------------------------------------------
  // Card selection
  // -------------------------------------------------------------------------
  const rankForSelection = (entries: any[], view: DuelView, player: number, hint: number) => {
    return entries.map((entry: any, index: number) => {
      const code = Number(entry.code);
      const owner = Number(entry.controller) & 1;
      const onField = findOnField(view, entry);
      const hiddenOpp = owner !== player && onField && !onField.faceUp;
      const value = hiddenOpp ? FACEDOWN_DEF_GUESS : cardValue(code, onField);
      let score: number;
      if (hint === HINT.ATTACKTARGET && plannedTarget) {
        const match = owner === plannedTarget.controller && Number(entry.location) === plannedTarget.location && Number(entry.sequence) === plannedTarget.sequence;
        score = match ? 1e6 : -value;
      } else if (COST_HINTS.has(hint) && owner === player) {
        score = -costValue(code, onField, hint);
      } else if (HARMFUL_HINTS.has(hint)) {
        score = owner === player ? -costValue(code, onField, hint) - 5000 : value + 5000;
      } else if (GAIN_HINTS.has(hint)) {
        score = owner === player ? value + diversityBonus(code, view, player) : -value;
      } else {
        // Generic target/effect selection: hit the opponent's best card, else take our best.
        score = owner === player ? value : value + 3000;
      }
      return { index, score };
    });
  };

  // Searching: prefer cards that add something new to the hand mix (a monster when we have none on board, etc.).
  const diversityBonus = (code: number, view: DuelView, player: number) => {
    const k = know(code);
    if (!k) return 0;
    let bonus = 0;
    if ((k.type & T_MONSTER) && view.monsters[player].length === 0) bonus += 300;
    if (k.roles.search || k.roles.summon) bonus += 200;
    return bonus;
  };

  const selectCards = (message: any, view: DuelView, player: number, ctx?: OcgDuelContext) => {
    const selects: any[] = message.selects || [];
    const min = Number(message.min) || 0;
    const max = Math.max(Number(message.max) || min, min);
    const hint = lastSelectHint(ctx, player);
    const hitsOpponent = selects.some((entry: any) => (Number(entry.controller) & 1) !== player);
    const worthTaking = GAIN_HINTS.has(hint) || hint === HINT.TARGET || (HARMFUL_HINTS.has(hint) && hitsOpponent);
    if (min === 0 && message.can_cancel && !worthTaking) {
      return { type: OcgResponseType.SELECT_CARD, indicies: null };
    }
    const ranked = rankForSelection(selects, view, player, hint).sort((a, b) => b.score - a.score);
    // Take extra picks only when they hurt the opponent ("destroy up to 2").
    let count = Math.max(min, 1);
    if (HARMFUL_HINTS.has(hint)) {
      const opponentPicks = ranked.filter((r) => (Number(selects[r.index].controller) & 1) !== player).length;
      count = Math.max(count, Math.min(max, opponentPicks));
    }
    count = Math.min(count, selects.length);
    return { type: OcgResponseType.SELECT_CARD, indicies: ranked.slice(0, count).map((r) => r.index) };
  };

  const selectUnselect = (message: any, view: DuelView, player: number, ctx?: OcgDuelContext) => {
    if (message.can_finish) return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null };
    const cards: any[] = message.select_cards || [];
    if (cards.length === 0) return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null };
    const hint = lastSelectHint(ctx, player);
    const ranked = rankForSelection(cards, view, player, hint).sort((a, b) => b.score - a.score);
    return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: ranked[0].index };
  };

  const selectTribute = (message: any, view: DuelView, player: number) => {
    const selects: any[] = message.selects || [];
    const min = Number(message.min) || 0;
    if (message.can_cancel && min === 0) return { type: OcgResponseType.SELECT_TRIBUTE, indicies: null };
    const indices = selects
      .map((entry: any, index: number) => ({ index, score: costValue(Number(entry.code), findOnField(view, entry)) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, Math.max(min, 1))
      .map((c) => c.index);
    return { type: OcgResponseType.SELECT_TRIBUTE, indicies: indices };
  };

  const selectPosition = (message: any, view: DuelView, player: number) => {
    const positions = Number(message.positions) || 0;
    const k: CardKnowledge | undefined = know(Number(message.code));
    const oppAtk = strongestAttacker(opponentView(view, player));
    const atk = k?.atk ?? 0;
    const def = k?.def ?? 0;
    const wantDefense = k ? atk < oppAtk && def > atk : false;
    if (wantDefense && positions & OcgPosition.FACEUP_DEFENSE) return { type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEUP_DEFENSE };
    if (positions & OcgPosition.FACEUP_ATTACK) return { type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEUP_ATTACK };
    if (positions & OcgPosition.FACEUP_DEFENSE) return { type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEUP_DEFENSE };
    return { type: OcgResponseType.SELECT_POSITION, position: OcgPosition.FACEDOWN_DEFENSE };
  };

  const respond = (message: any, ctx?: OcgDuelContext): any => {
    stats.decisions += 1;
    const player = typeof message.player === "number" ? message.player : 0;
    const view = ctx?.view ? ctx.view() : EMPTY_VIEW;

    switch (message.type) {
      case OcgMessageType.SELECT_IDLECMD:
        return idle(message, view, player);
      case OcgMessageType.SELECT_BATTLECMD:
        return battle(message, view, player);
      case OcgMessageType.SELECT_CHAIN:
        return chain(message, view, player, ctx);
      case OcgMessageType.SELECT_CARD:
        return selectCards(message, view, player, ctx);
      case OcgMessageType.SELECT_UNSELECT_CARD:
        return selectUnselect(message, view, player, ctx);
      case OcgMessageType.SELECT_TRIBUTE:
        return selectTribute(message, view, player);
      case OcgMessageType.SELECT_POSITION:
        return selectPosition(message, view, player);
      case OcgMessageType.SELECT_PLACE: {
        const place = placeFromMask(message, "MZONE");
        return place ? { type: OcgResponseType.SELECT_PLACE, places: [place] } : null;
      }
      case OcgMessageType.SELECT_EFFECTYN:
      case OcgMessageType.SELECT_YESNO: {
        // Optional effects are upside by design; refuse only an opponent-benefiting prompt we cannot judge.
        const type = message.type === OcgMessageType.SELECT_EFFECTYN ? OcgResponseType.SELECT_EFFECTYN : OcgResponseType.SELECT_YESNO;
        return { type, yes: true };
      }
      case OcgMessageType.SELECT_OPTION:
        return { type: OcgResponseType.SELECT_OPTION, index: 0 };
      case OcgMessageType.SORT_CARD:
        return { type: OcgResponseType.SORT_CARD, order: null };
      default:
        return utilityResponse(message);
    }
  };

  return { respond, stats };
}

