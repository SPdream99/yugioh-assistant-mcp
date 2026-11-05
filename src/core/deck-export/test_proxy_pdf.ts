// Must load first: keeps test cards out of the real custom-card registry.
import '../../test-support/test_isolated_custom_data.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateProxyPdf } from './proxy-pdf.js';
import { registerCustomCard } from '../custom-cards/registry.js';
import { detectPythonCommand } from '../../utils/paths.js';

let failures = 0;
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failures += 1;
}

/** Card rectangles (mm) measured from the PDF itself, not from our own numbers. */
function measure(pdfPath: string): { pages: number; pageMm: number[]; cardsMm: number[][] } {
  const script = [
    'import json, sys, pymupdf',
    'd = pymupdf.open(sys.argv[1]); mm = 72 / 25.4; cards = []',
    'for p in d:',
    '    for g in p.get_drawings():',
    '        r = g["rect"]',
    '        if g.get("fill") and abs(r.width / mm - 59) < 1 and abs(r.height / mm - 86) < 1: cards.append([round(r.width / mm, 2), round(r.height / mm, 2), round(r.x0 / mm, 2), round(r.y0 / mm, 2)])',
    'print(json.dumps({"pages": len(d), "pageMm": [round(d[0].rect.width / mm, 2), round(d[0].rect.height / mm, 2)], "cardsMm": cards}))'
  ].join('\n');
  return JSON.parse(execFileSync(detectPythonCommand(), ['-c', script, pdfPath], { encoding: 'utf-8' }).trim());
}

async function run() {
  console.log('=== Proxy PDF ===');
  const custom = registerCustomCard({
    name: 'Proxy Test Đồng Hồ',
    origin: 'custom_fanmade',
    cardData: { type: 'Effect Monster', race: 'Machine', attribute: 'EARTH', level: 4, atk: 1800, def: 1200, desc: 'If this card is Normal Summoned: You can draw 1 card.' }
  });

  const out = path.join(process.cwd(), 'data', 'deck_exports', `test_proxy_${Date.now()}.pdf`);
  const result: any = await generateProxyPdf({
    cards: [{ card: custom.tempId, copies: 3 }, { card: 89631139, copies: 3 }, { card: 'Dark Magician', copies: 3 }, { card: 55144522 }],
    style: 'text',
    outputPath: out
  });
  check('generates a PDF', result.available === true && fs.existsSync(out), JSON.stringify(result));
  check('10 cards over 2 pages (9 per page)', result.cards === 10 && result.pages === 2, JSON.stringify(result));
  const measured = measure(out);
  check('page is A4 (210 x 297 mm)', measured.pageMm[0] === 210 && measured.pageMm[1] === 297, JSON.stringify(measured.pageMm));
  check('every card is exactly 59 x 86 mm', measured.cardsMm.length === 10 && measured.cardsMm.every((c) => c[0] === 59 && c[1] === 86), JSON.stringify(measured.cardsMm));
  const xs = [...new Set(measured.cardsMm.map((c) => c[2]))].sort((a, b) => a - b);
  check('grid is centred horizontally', xs[0] === 16.5 && Math.abs(210 - (xs[xs.length - 1] + 59) - 16.5) < 0.01, JSON.stringify(xs));
  fs.rmSync(out, { force: true });

  const gapped: any = await generateProxyPdf({ cards: [{ card: 89631139, copies: 3 }], style: 'text', gapMm: 3, outputPath: out });
  const gapX = [...new Set(measure(out).cardsMm.map((c) => c[2]))].sort((a, b) => a - b);
  check('gapMm spaces cards apart', gapped.gapMm === 3 && Math.abs(gapX[1] - gapX[0] - 62) < 0.01, JSON.stringify(gapX));
  fs.rmSync(out, { force: true });

  console.log('\n--- Safety ---');
  const outside = path.join(os.tmpdir(), `proxy-${Date.now()}.pdf`);
  const escaped: any = await generateProxyPdf({ cards: [{ card: 89631139 }], style: 'text', outputPath: outside });
  check('refuses to write outside the project', escaped.available === false && !fs.existsSync(outside), JSON.stringify(escaped));
  const notPdf: any = await generateProxyPdf({ cards: [{ card: 89631139 }], style: 'text', outputPath: path.join(process.cwd(), 'data', 'deck_exports', 'x.lua') });
  check('only writes .pdf files', notPdf.available === false);
  const huge: any = await generateProxyPdf({ cards: Array.from({ length: 61 }, () => ({ card: 89631139, copies: 3 })), style: 'text' });
  check('refuses more than 180 cards', huge.available === false && /180/.test(huge.reason || ''), JSON.stringify(huge));
  const missing: any = await generateProxyPdf({ cards: [{ card: 'Definitely Not A Card Name 123' }], style: 'text' });
  check('reports unresolved cards instead of inventing them', missing.available === false && missing.unresolved?.length === 1, JSON.stringify(missing));

  console.log(failures === 0 ? '\nALL PROXY PDF TESTS PASSED' : `\n${failures} PROXY PDF TEST(S) FAILED`);
  if (failures) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
