/**
 * AI harness: benchmarking and self-play data export.
 *
 * The engine is deterministic given a seed and a decision sequence, so a match
 * between two policies is reproducible. The benchmark alternates the starting
 * player to remove the first-turn bias from the sample.
 */

import fs from "node:fs";
import path from "node:path";
import { runOcgCoreDuel, defaultResponder } from "../card-scripts/ocgcore-runtime.js";
import { createPolicy, type PolicyOptions } from "./policy.js";
import { loadCardKnowledge } from "./card-knowledge.js";
import { guardOutputPath } from "../../utils/safe-path.js";
import type { OcgMessage } from "ocgcore-wasm";

export interface AiBenchmarkOptions {
  deckA: number[];
  deckB: number[];
  extraA?: number[];
  extraB?: number[];
  games?: number;
  seed?: number;
  maxSteps?: number;
  /** Starting LP (default 8000; lower values make benchmarks finish faster). */
  startingLP?: number;
  /** Which side plays the policy: "A", "B", "alternate" (default, vs the passive baseline) or "both" (deck A vs deck B matchup, policy on both sides). */
  aiSide?: "A" | "B" | "alternate" | "both";
  /** Stop a game after this many turns (default 30) and report it as unfinished. */
  maxTurns?: number;
  /** Count how often these cards are activated / summoned (by either player) and collect their script errors. */
  trackCodes?: number[];
  policy?: PolicyOptions;
}

export interface AiBenchmarkResult {
  available: boolean;
  games: number;
  aiWins: number;
  baselineWins: number;
  draws: number;
  aiWinRate: number;
  avgSteps: number;
  avgLpRemaining: number;
  sample: Array<{ game: number; aiSide: "A" | "B" | "both"; firstPlayer: "A" | "B"; winner?: number; endReason?: string; turns: number; steps: number; lp: [number, number] }>;
  /** Matchup view (aiSide "both"): deck A's results, with unfinished games adjudicated by LP lead separately. */
  matchup?: { deckAWins: number; deckBWins: number; unfinished: number; deckAWinRate: number; deckAWinRateWithLpAdjudication: number; firstPlayerWinRate: number };
  avgTurns: number;
  tracked?: Array<{ code: number; gamesUsed: number; activations: number; summons: number; scriptErrors: string[] }>;
  reason?: string;
  notes: string[];
}

function otherSide(side: "A" | "B"): "A" | "B" {
  return side === "A" ? "B" : "A";
}

export async function runAiBenchmark(options: AiBenchmarkOptions): Promise<AiBenchmarkResult> {
  const matchupMode = options.aiSide === "both";
  const notes = [
    matchupMode
      ? "Matchup mode: the heuristic policy plays both decks; the result measures deck A vs deck B under identical (imperfect) play."
      : "The baseline is the engine's default responder (first legal action, pass chains).",
    "The AI is a heuristic policy, not a trained model; use the win rate as a sanity check, not a strength claim.",
    "The first player alternates every game (decks swap engine seats), so going-first advantage is split evenly.",
    "Games that hit maxTurns/maxSteps are reported as unfinished, never as wins; the LP-adjudicated rate is shown separately."
  ];

  const games = Math.max(1, Math.min(options.games ?? 10, 50));
  const deckA = (options.deckA || []).filter((c) => c > 0);
  const deckB = (options.deckB || []).filter((c) => c > 0);
  if (deckA.length === 0 || deckB.length === 0) {
    return {
      available: false,
      games: 0,
      aiWins: 0,
      baselineWins: 0,
      draws: 0,
      aiWinRate: 0,
      avgSteps: 0,
      avgTurns: 0,
      avgLpRemaining: 0,
      sample: [],
      reason: "Both decks are required.",
      notes
    };
  }

  const knowledge = await loadCardKnowledge([...deckA, ...deckB, ...(options.extraA || []), ...(options.extraB || [])]);
  const startingLP = options.startingLP ?? 8000;

  const sample: AiBenchmarkResult["sample"] = [];
  let aiWins = 0;
  let baselineWins = 0;
  let draws = 0;
  let totalSteps = 0;
  let totalTurns = 0;
  let totalLp = 0;
  let deckAWins = 0;
  let deckBWins = 0;
  let lpLeadA = 0;
  let firstPlayerWins = 0;
  const tracked = new Map<number, { code: number; gamesUsed: number; activations: number; summons: number; scriptErrors: Set<string> }>();
  for (const code of options.trackCodes || []) tracked.set(code, { code, gamesUsed: 0, activations: 0, summons: 0, scriptErrors: new Set() });

  for (let game = 0; game < games; game++) {
    // Deck A sits in engine seat 0 (goes first) on even games, seat 1 on odd games.
    const aGoesFirst = game % 2 === 0;
    const seatOfA = aGoesFirst ? 0 : 1;
    const aiSide: "A" | "B" | "both" = matchupMode
      ? "both"
      : options.aiSide === "A" || options.aiSide === "B"
        ? options.aiSide
        : (Math.floor(game / 2) % 2 === 0 ? "A" : "B");
    const aiSeats = new Set<number>(
      aiSide === "both" ? [0, 1] : [aiSide === "A" ? seatOfA : 1 - seatOfA]
    );

    const policies = [0, 1].map((seat) =>
      createPolicy({ ...options.policy, knowledge, seed: (options.seed ?? 1) + game * 37 + seat * 101 })
    );

    const result = await runOcgCoreDuel({
      deckA: aGoesFirst ? deckA : deckB,
      deckB: aGoesFirst ? deckB : deckA,
      extraA: aGoesFirst ? options.extraA : options.extraB,
      extraB: aGoesFirst ? options.extraB : options.extraA,
      startingDrawCount: 5,
      drawCountPerTurn: 1,
      startingLP,
      maxSteps: options.maxSteps ?? 5000,
      maxTurns: options.maxTurns ?? 30,
      seed: [BigInt((options.seed ?? 1) + game), BigInt((options.seed ?? 1) * 7919 + game * 104729), 3n, 5n],
      responder: (message: OcgMessage, ctx) => {
        const seat = (message as any).player === 1 ? 1 : 0;
        if (aiSeats.has(seat)) return policies[seat].respond(message, ctx);
        return defaultResponder(message);
      }
    });

    if (tracked.size) {
      const usedThisGame = new Set<number>();
      for (const message of result.messages) {
        const code = Number((message.raw as any)?.code);
        const entry = tracked.get(code);
        if (!entry) continue;
        if (message.typeName === "CHAINING") entry.activations += 1;
        else if (message.typeName === "SUMMONING" || message.typeName === "SPSUMMONING") entry.summons += 1;
        else continue;
        usedThisGame.add(code);
      }
      for (const code of usedThisGame) tracked.get(code)!.gamesUsed += 1;
      for (const error of result.errors) {
        for (const entry of tracked.values()) {
          if (error.includes(`c${entry.code}.lua`) || error.includes(String(entry.code))) entry.scriptErrors.add(error.slice(0, 300));
        }
      }
    }

    const lpBySeat = result.lp ?? [startingLP, startingLP];
    const lp: [number, number] = [lpBySeat[seatOfA], lpBySeat[1 - seatOfA]]; // [deck A, deck B]
    const winnerDeck = result.winner === undefined || result.winner > 1
      ? undefined
      : result.winner === seatOfA ? 0 : 1; // 0 = deck A, 1 = deck B

    if (winnerDeck === undefined) {
      draws += 1;
      if (lp[0] > lp[1]) lpLeadA += 1;
      else if (lp[0] === lp[1]) lpLeadA += 0.5;
    } else {
      if (winnerDeck === 0) deckAWins += 1;
      else deckBWins += 1;
      if ((winnerDeck === 0) === aGoesFirst) firstPlayerWins += 1;
    }

    if (!matchupMode) {
      const aiDeck = aiSide === "A" ? 0 : 1;
      if (winnerDeck !== undefined) {
        if (winnerDeck === aiDeck) aiWins += 1;
        else baselineWins += 1;
      }
      totalLp += lp[aiDeck];
    } else {
      totalLp += lp[0];
    }

    totalSteps += result.steps;
    totalTurns += result.turns ?? 0;
    sample.push({
      game: game + 1,
      aiSide,
      firstPlayer: aGoesFirst ? "A" : "B",
      winner: winnerDeck,
      endReason: result.endReason,
      turns: result.turns ?? 0,
      steps: result.steps,
      lp
    });
  }

  const decided = matchupMode ? deckAWins + deckBWins : aiWins + baselineWins;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  if (draws > 0) notes.push(`${draws}/${games} game(s) did not finish within the turn/step budget; raise maxTurns or maxSteps for a full sample.`);
  return {
    available: true,
    games,
    aiWins: matchupMode ? deckAWins : aiWins,
    baselineWins: matchupMode ? deckBWins : baselineWins,
    draws,
    aiWinRate: pct(matchupMode ? deckAWins : aiWins, decided),
    avgSteps: Math.round(totalSteps / games),
    avgTurns: Math.round((totalTurns / games) * 10) / 10,
    avgLpRemaining: Math.round(totalLp / games),
    sample,
    ...(tracked.size
      ? { tracked: [...tracked.values()].map((t) => ({ ...t, scriptErrors: [...t.scriptErrors].slice(0, 10) })) }
      : {}),
    ...(matchupMode
      ? {
          matchup: {
            deckAWins,
            deckBWins,
            unfinished: draws,
            deckAWinRate: pct(deckAWins, deckAWins + deckBWins),
            deckAWinRateWithLpAdjudication: pct(deckAWins + lpLeadA, games),
            firstPlayerWinRate: pct(firstPlayerWins, deckAWins + deckBWins)
          }
        }
      : {}),
    notes
  };
}

// ---------------------------------------------------------------------------
// Self-play export
// ---------------------------------------------------------------------------

export interface SelfPlayOptions {
  deckA: number[];
  deckB: number[];
  extraA?: number[];
  extraB?: number[];
  games?: number;
  seed?: number;
  maxSteps?: number;
  startingLP?: number;
  policy?: PolicyOptions;
  outPath?: string;
}

export interface SelfPlayResult {
  available: boolean;
  games: number;
  decisions: number;
  outputPath?: string;
  bytes?: number;
  reason?: string;
  notes: string[];
}

/**
 * Plays policy-vs-policy games and writes one JSONL record per decision.
 * The record is the minimum needed for imitation learning: the request type,
 * the legal options, and the action the policy took.
 */
export async function exportSelfPlay(options: SelfPlayOptions): Promise<SelfPlayResult> {
  const games = Math.max(1, Math.min(options.games ?? 5, 50));
  const deckA = (options.deckA || []).filter((c) => c > 0);
  const deckB = (options.deckB || []).filter((c) => c > 0);
  const notes = [
    "Each line is one decision: request type, legal option codes, chosen index.",
    "Use it for behavioural cloning first, then reinforcement learning with the engine as the environment."
  ];

  if (deckA.length === 0 || deckB.length === 0) {
    return { available: false, games: 0, decisions: 0, reason: "Both decks are required.", notes };
  }

  // The path comes from a tool argument: confine it to the project (no game roots
  // either: this is training data, not a simulator asset) and force a .jsonl file.
  const requested = options.outPath || path.join(process.cwd(), "data", "ai", `selfplay_${Date.now()}.jsonl`);
  const guard = guardOutputPath(requested, { allowGameRoots: false });
  if (!guard.ok) return { available: false, games: 0, decisions: 0, reason: guard.reason, notes };
  if (!/\.jsonl$/i.test(guard.resolved)) {
    return { available: false, games: 0, decisions: 0, reason: "outPath must end in .jsonl.", notes };
  }
  const outPath = guard.resolved;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let decisions = 0;
  const lines: string[] = [];
  const knowledge = await loadCardKnowledge([...deckA, ...deckB, ...(options.extraA || []), ...(options.extraB || [])]);

  for (let game = 0; game < games; game++) {
    const policyA = createPolicy({ ...options.policy, knowledge, seed: (options.seed ?? 1) + game * 11 });
    const policyB = createPolicy({ ...options.policy, knowledge, seed: (options.seed ?? 1000) + game * 13 });

    const result = await runOcgCoreDuel({
      deckA,
      deckB,
      extraA: options.extraA,
      extraB: options.extraB,
      startingDrawCount: 5,
      drawCountPerTurn: 1,
      startingLP: options.startingLP ?? 8000,
      maxSteps: options.maxSteps ?? 5000,
      seed: [BigInt((options.seed ?? 1) + game), BigInt((options.seed ?? 1) * 7919 + game * 104729), 11n, 13n],
      maxTurns: 40,
      responder: (message: OcgMessage, ctx) => {
        const player = (message as any).player === 1 ? 1 : 0;
        const policy = player === 0 ? policyA : policyB;
        const response = policy.respond(message, ctx);
        const options = (message as any).selects || (message as any).activates || (message as any).summons || (message as any).special_summons || [];
        lines.push(JSON.stringify({
          game: game + 1,
          player,
          type: (message as any).type,
          optionCount: Array.isArray(options) ? options.length : 0,
          options: Array.isArray(options) ? options.map((o: any) => Number(o?.code) || 0).slice(0, 20) : [],
          chosen: response?.index ?? response?.indicies ?? null,
          response: response?.type ?? null
        }));
        decisions += 1;
        return response;
      }
    });

    lines.push(JSON.stringify({
      game: game + 1,
      result: { winner: result.winner ?? null, endReason: result.endReason, turns: result.turns, steps: result.steps }
    }));
  }

  const payload = `${lines.join("\n")}\n`;
  fs.writeFileSync(outPath, payload, "utf-8");

  return {
    available: true,
    games,
    decisions,
    outputPath: outPath,
    bytes: Buffer.byteLength(payload),
    notes
  };
}

export { otherSide };
