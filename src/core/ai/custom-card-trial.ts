/**
 * Custom card trial: does the card work, does the AI use it, and does it move
 * the matchup?
 *
 * Three questions a card designer asks, each answered on the real engine:
 *   1. Script health — the generated Lua loads and resolves without core errors.
 *   2. Usage — across seeded games, how often the card is summoned / activated.
 *   3. Impact — deck A's win rate against the same opponent with the card
 *      swapped in versus the untouched deck, both piloted by the same policy.
 *
 * The impact number inherits the policy's limits and a small-sample error bar;
 * it is reported with the sample size and an approximate 95% interval so a 2-game
 * swing is never read as "this card is broken".
 */

import { getCustomCard } from "../custom-cards/registry.js";
import { runAiBenchmark } from "./agent.js";

export interface CustomCardTrialOptions {
  code: number;
  /** Deck the card is tested in. Defaults to a vanilla beatdown shell, which only checks the card works. */
  deck?: number[];
  extra?: number[];
  opponent?: number[];
  opponentExtra?: number[];
  copies?: number;
  games?: number;
  seed?: number;
  maxTurns?: number;
}

/** Vanilla Level 4 beaters: a neutral shell that tests the card, not the deck. */
const NEUTRAL_SHELL = [69247929, 14898066, 15025844];

function neutralDeck(): number[] {
  return Array.from({ length: 40 }, (_, i) => NEUTRAL_SHELL[i % NEUTRAL_SHELL.length]);
}

/** Swap `copies` cards into the deck, replacing the most common non-trial cards. */
function withCard(deck: number[], code: number, copies: number): number[] {
  const out = [...deck];
  const counts = new Map<number, number>();
  for (const c of out) if (c !== code) counts.set(c, (counts.get(c) || 0) + 1);
  for (let n = 0; n < copies; n++) {
    const victim = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!victim) {
      out.push(code);
      continue;
    }
    out[out.lastIndexOf(victim[0])] = code;
    counts.set(victim[0], victim[1] - 1);
  }
  return out;
}

function interval95(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const half = 1.96 * Math.sqrt((p * (1 - p)) / n);
  return [Math.max(0, Math.round((p - half) * 1000) / 10), Math.min(100, Math.round((p + half) * 1000) / 10)];
}

export async function runCustomCardTrial(options: CustomCardTrialOptions) {
  const record = getCustomCard(options.code);
  const copies = Math.max(1, Math.min(options.copies ?? 3, 3));
  const games = Math.max(2, Math.min(options.games ?? 10, 50));
  const baseDeck = (options.deck?.length ? options.deck : neutralDeck()).filter((c) => c !== options.code);
  const opponent = options.opponent?.length ? options.opponent : neutralDeck();
  const isExtra = /fusion|synchro|xyz|link/i.test(record?.cardData.type || "");

  const testDeck = isExtra ? baseDeck : withCard(baseDeck, options.code, copies);
  const testExtra = isExtra ? [...(options.extra || []), ...Array(copies).fill(options.code)] : options.extra;

  const common = {
    deckB: opponent,
    extraB: options.opponentExtra,
    games,
    seed: options.seed ?? 1,
    maxTurns: options.maxTurns ?? 30,
    aiSide: "both" as const,
    policy: { exploration: 0.05 }
  };

  const withRun = await runAiBenchmark({ ...common, deckA: testDeck, extraA: testExtra, trackCodes: [options.code] });
  const withoutRun = await runAiBenchmark({ ...common, deckA: baseDeck, extraA: options.extra });

  const usage = withRun.tracked?.[0];
  const decidedWith = (withRun.matchup?.deckAWins ?? 0) + (withRun.matchup?.deckBWins ?? 0);
  const decidedWithout = (withoutRun.matchup?.deckAWins ?? 0) + (withoutRun.matchup?.deckBWins ?? 0);
  const rateWith = withRun.matchup?.deckAWinRate ?? 0;
  const rateWithout = withoutRun.matchup?.deckAWinRate ?? 0;

  const verdict: string[] = [];
  if (!record) verdict.push(`Card ${options.code} is not in the custom registry; it was tested from cards.cdb/scripts as-is.`);
  if (usage && usage.scriptErrors.length) verdict.push("Script errors were raised while the card was in play: fix the Lua before reading the win rates.");
  if (usage && usage.gamesUsed === 0) {
    verdict.push("The card was never summoned or activated: its conditions may be unreachable in this deck, or the script registers no usable effect.");
  }
  const delta = Math.round((rateWith - rateWithout) * 10) / 10;
  const [lo, hi] = interval95(withRun.matchup?.deckAWins ?? 0, decidedWith);
  verdict.push(
    `Win rate with the card ${rateWith}% (95% CI ${lo}-${hi}%, ${decidedWith} decided games) vs ${rateWithout}% without (${decidedWithout} decided); delta ${delta >= 0 ? "+" : ""}${delta} points.`
  );
  if (Math.abs(delta) < (hi - lo) / 2) verdict.push("The delta is inside the noise band: play more games (up to 50) before concluding anything about power level.");

  return {
    code: options.code,
    name: record?.name,
    copies,
    games,
    testedIn: options.deck?.length ? "provided deck" : "neutral vanilla shell (checks function, not real-deck power)",
    scriptHealth: { errors: usage?.scriptErrors ?? [], ok: (usage?.scriptErrors.length ?? 0) === 0 },
    usage: usage ? { gamesUsed: usage.gamesUsed, activations: usage.activations, summons: usage.summons } : null,
    compileReport: (record as any)?.compileReport,
    withCard: { winRate: rateWith, matchup: withRun.matchup, avgTurns: withRun.avgTurns },
    withoutCard: { winRate: rateWithout, matchup: withoutRun.matchup, avgTurns: withoutRun.avgTurns },
    delta,
    verdict,
    notes: [
      "Both runs use the same seeds, opponent and policy, and alternate who goes first.",
      "The policy is heuristic: a card whose value depends on precise sequencing may be under-rated."
    ]
  };
}
