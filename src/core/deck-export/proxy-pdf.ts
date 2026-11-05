/**
 * Proxy sheet export: cards at real size (59 x 86 mm), 9 per A4 page.
 *
 * Node resolves the card list (deck input, passcodes, names, custom cards) and
 * writes a small JSON spec; generate_proxy_pdf.py does the layout with
 * reportlab. Only integer passcodes and display text cross that boundary, and
 * the Python side builds image URLs from the passcode alone.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Card } from "../../types/card.js";
import { detectPythonCommand, resolvePythonScript } from "../../utils/paths.js";
import { guardOutputPath } from "../../utils/safe-path.js";
import { CardDatabase } from "../card-database/ygoprodeck.js";
import { getCustomCard } from "../custom-cards/registry.js";
import { loadDeckUniversal } from "../deck-parser/universal-deck-loader.js";

/** 20 pages: enough for a deck plus side, small enough to bound image downloads. */
export const MAX_PROXY_CARDS = 180;

export interface ProxyCardRequest {
  /** Passcode (official or custom temp ID) or exact card name. */
  card: number | string;
  copies?: number;
}

export interface ProxyPdfOptions {
  /** Deck as ydke://, .ydk content/path or text list. */
  input?: string;
  cards?: ProxyCardRequest[];
  sections?: Array<"main" | "extra" | "side">;
  /** "image" uses official card art when available; "text" always prints a text proxy. */
  style?: "image" | "text";
  /** Space between cards in mm (0 = shared cut lines). */
  gapMm?: number;
  cropMarks?: boolean;
  offline?: boolean;
  title?: string;
  outputPath?: string;
}

interface ProxySpecCard {
  id: number;
  name: string;
  custom: boolean;
  typeLine: string;
  statLine: string;
  desc: string;
  footer: string;
}

function toSpecCard(card: Card, custom: boolean): ProxySpecCard {
  const type = card.type || "";
  const isMonster = !/spell|trap/i.test(type);
  const isLink = /link/i.test(type);
  const stat: string[] = [];
  if (isMonster) {
    if (card.attribute) stat.push(card.attribute);
    if (isLink && card.linkval) stat.push(`LINK-${card.linkval}`);
    else if (card.level) stat.push(`${/xyz/i.test(type) ? "Rank" : "Level"} ${card.level}`);
    if (card.scale !== undefined && /pendulum/i.test(type)) stat.push(`Scale ${card.scale}`);
  }
  const typeLine = isMonster ? `[${[card.race, type.replace(/ Monster$/i, "")].filter(Boolean).join(" / ")}]` : `[${type}${card.race && card.race !== "Normal" ? ` - ${card.race}` : ""}]`;
  const footer = isMonster
    ? isLink
      ? `ATK/${card.atk ?? "?"}  LINK-${card.linkval ?? "?"}`
      : `ATK/${card.atk ?? "?"}  DEF/${card.def ?? "?"}`
    : "";
  return {
    id: card.id,
    name: card.name,
    custom,
    typeLine,
    statLine: stat.join("  "),
    desc: card.desc || "",
    footer
  };
}

async function lookupCard(ref: number | string, db: CardDatabase): Promise<{ card: Card; custom: boolean } | null> {
  const numeric = typeof ref === "number" ? ref : /^\d{1,10}$/.test(String(ref).trim()) ? Number(ref) : NaN;
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    const custom = getCustomCard(numeric);
    if (custom && (numeric >= 990000000 || !db.getCardById(numeric))) return { card: custom.cardData, custom: true };
    const official = db.getCardById(numeric);
    return official ? { card: official, custom: false } : null;
  }
  const name = String(ref).trim().slice(0, 200);
  if (!name) return null;
  const official = await db.getCardByName(name);
  return official ? { card: official, custom: false } : null;
}

export async function generateProxyPdf(options: ProxyPdfOptions) {
  const db = CardDatabase.getInstance();
  await db.loadCache();

  const requests: ProxyCardRequest[] = [];
  let title = options.title || "Proxy sheet";
  if (options.input) {
    const { deck } = await loadDeckUniversal({ input: options.input });
    title = options.title || deck.name || title;
    const sections = options.sections?.length ? options.sections : ["main", "extra"];
    for (const section of sections) {
      for (const entry of (deck as any)[section] || []) {
        const ref = typeof entry === "object" && entry !== null ? (entry as Card).id : entry;
        requests.push({ card: ref as number | string, copies: 1 });
      }
    }
  }
  for (const request of options.cards || []) requests.push(request);

  if (requests.length === 0) {
    return { available: false, reason: "Provide a deck ('input') or a 'cards' list." };
  }

  const cards: ProxySpecCard[] = [];
  const unresolved: string[] = [];
  for (const request of requests) {
    const copies = Math.max(1, Math.min(Math.trunc(Number(request.copies ?? 1)) || 1, 3));
    const found = await lookupCard(request.card, db);
    if (!found) {
      unresolved.push(String(request.card).slice(0, 80));
      continue;
    }
    for (let i = 0; i < copies; i++) cards.push(toSpecCard(found.card, found.custom));
  }

  if (cards.length === 0) {
    return { available: false, reason: "None of the requested cards could be resolved.", unresolved };
  }
  if (cards.length > MAX_PROXY_CARDS) {
    return {
      available: false,
      reason: `That is ${cards.length} cards; one sheet is limited to ${MAX_PROXY_CARDS} (20 pages). Split the request.`
    };
  }

  const exportsDir = path.resolve(process.cwd(), "data", "deck_exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  const timestamp = Date.now();
  const safeName = title.replace(/[^a-zA-Z0-9_\-À-ɏẠ-ỹ]/g, "_").slice(0, 60) || "proxies";
  const requested = options.outputPath || path.join(exportsDir, `${safeName}_proxies_${timestamp}.pdf`);
  const guard = guardOutputPath(requested);
  if (!guard.ok) return { available: false, reason: guard.reason };
  if (!/\.pdf$/i.test(guard.resolved)) return { available: false, reason: "outputPath must end in .pdf." };

  const specPath = path.join(exportsDir, `temp_proxy_${timestamp}.json`);
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      title,
      style: options.style === "text" ? "text" : "image",
      gapMm: Math.max(0, Math.min(Number(options.gapMm ?? 0) || 0, 5)),
      cropMarks: options.cropMarks !== false,
      offline: Boolean(options.offline) || process.env.YGO_OFFLINE === "1",
      cards
    }),
    "utf-8"
  );

  try {
    // execFile, never a shell: titles and paths are caller-controlled.
    const stdout = execFileSync(
      detectPythonCommand(),
      [resolvePythonScript("core/deck-export/generate_proxy_pdf.py"), "--spec", specPath, "--output", guard.resolved],
      { encoding: "utf-8", timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }
    );
    const result = JSON.parse(stdout.trim().split(/\r?\n/).pop() || "{}");
    return {
      available: Boolean(result.success),
      ...result,
      unresolved,
      printing: [
        "Print at 'Actual size' / 100% (no 'Fit to page'); measure the 50 mm bar to confirm.",
        "Cards are 59 x 86 mm, the official OCG/TCG size, so they fit standard Yu-Gi-Oh! sleeves.",
        "Proxies are for personal playtesting only; they are not legal in sanctioned events."
      ]
    };
  } catch (error: any) {
    const stdout = String(error?.stdout || "").trim();
    let reason = (error as Error).message;
    try {
      reason = JSON.parse(stdout.split(/\r?\n/).pop() || "{}").error || reason;
    } catch {
      // keep the process error
    }
    return { available: false, reason: `Proxy PDF generation failed: ${reason}` };
  } finally {
    fs.rmSync(specPath, { force: true });
  }
}
