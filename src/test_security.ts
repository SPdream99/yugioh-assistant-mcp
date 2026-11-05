import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeHttpUrl } from './utils/net-guard.js';
import { guardOutputPath, readTextFileSafe } from './utils/safe-path.js';
import { extractCardFromArticle } from './core/news-rulings/news-card-extractor.js';
import { renderDeckGridPng } from './core/deck-export/deck-image.js';
import { exportSelfPlay } from './core/ai/agent.js';
import { runOcgCoreDuel, RUNTIME_LIMITS } from './core/card-scripts/ocgcore-runtime.js';
import { TOOLS } from './tools/index.js';
import { loadGoldenCases } from './core/card-scripts/golden-regression.js';
import { readAndValidateDocx } from './core/archetype-studio/studio_manager.js';

/**
 * Security regression tests: the guards that stop a tool call from becoming a
 * shell command, an arbitrary file write/read, or an SSRF probe.
 */

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`ok - ${message}`);
}

async function rejects(url: string, label: string): Promise<void> {
  let blocked = false;
  try {
    await assertSafeHttpUrl(url);
  } catch {
    blocked = true;
  }
  assert(blocked, label);
}

async function run() {
  console.log('=== SSRF GUARD ===');
  await rejects('http://127.0.0.1/', 'loopback is refused');
  await rejects('http://localhost:8080/', 'localhost is refused');
  await rejects('http://169.254.169.254/latest/meta-data/', 'cloud metadata is refused');
  await rejects('http://10.0.0.5/', 'private IPv4 is refused');
  await rejects('http://[::1]/', 'IPv6 loopback is refused');
  await rejects('file:///etc/passwd', 'non-http scheme is refused');

  const safe = await assertSafeHttpUrl('https://ygoprodeck.com/api-guide/');
  assert(safe.hostname === 'ygoprodeck.com', 'a public https URL is accepted');

  const ssrf = await extractCardFromArticle('http://127.0.0.1:9/secret');
  assert(ssrf.available === false, 'the article extractor refuses a loopback URL');

  console.log('\n=== OUTPUT PATH GUARD ===');
  const outside = guardOutputPath(process.platform === 'win32' ? 'C:\\Windows\\evil.png' : '/etc/evil.png');
  assert(!outside.ok, 'a write outside the project is refused');
  const inside = guardOutputPath(path.join(process.cwd(), 'data', 'deck_exports', 'ok.png'));
  assert(inside.ok, 'a write inside the project is allowed');
  assert(!guardOutputPath('/tmp/not-a-game/YGO Omega-file').ok, 'a lookalike game-root name is refused');

  console.log('\n=== FILE READ GUARD ===');
  const big = path.join(os.tmpdir(), `ygo-big-${Date.now()}.ydk`);
  fs.writeFileSync(big, 'x'.repeat(2_000_001));
  const bigRead = readTextFileSafe(big);
  fs.rmSync(big, { force: true });
  assert(!bigRead.ok, 'a text read above the size cap is refused');

  const binary = path.join(os.tmpdir(), `ygo-bin-${Date.now()}.ydk`);
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const binaryRead = readTextFileSafe(binary);
  fs.rmSync(binary, { force: true });
  assert(!binaryRead.ok, 'a binary file is refused as a deck list');

  console.log('\n=== COMMAND INJECTION (deck title) ===');
  const marker = path.join(os.tmpdir(), `ygo-pwned-${Date.now()}`);
  const title = `x"; require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'pwned'); echo "`;
  try {
    await renderDeckGridPng({
      input: { main: [14558127, 14558127, 14558127], extra: [], side: [] },
      title,
      lang: 'en',
      outputPath: path.join(process.cwd(), 'data', 'deck_exports', `security-${Date.now()}.png`)
    });
  } catch {
    // Rendering may fail without the image assets; the marker is what matters.
  }
  assert(!fs.existsSync(marker), 'a title containing shell metacharacters executes nothing');

  console.log('\n=== OUTPUT PATHS & ENGINE LIMITS ===');
  // Self-play export takes its output path from a tool argument.
  const selfplayOutside = path.join(os.tmpdir(), `ygo-selfplay-${Date.now()}.jsonl`);
  const escaped = await exportSelfPlay({ deckA: [69247929], deckB: [69247929], games: 1, maxSteps: 5, outPath: selfplayOutside });
  assert(escaped.available === false && !fs.existsSync(selfplayOutside), 'self-play export refuses to write outside the project');
  const wrongExt = await exportSelfPlay({ deckA: [69247929], deckB: [69247929], games: 1, maxSteps: 5, outPath: path.join(process.cwd(), 'data', 'ai', 'x.lua') });
  assert(wrongExt.available === false, 'self-play export only writes .jsonl files');

  // The duel runtime receives tool arguments unfiltered: oversized or malformed input is refused, not executed.
  const huge = await runOcgCoreDuel({ deckA: Array(RUNTIME_LIMITS.maxCardsPerZone + 1).fill(69247929), deckB: [69247929] });
  assert(huge.success === false && /limit/.test(huge.errors.join(' ')), 'oversized decks are refused');
  const badCode = await runOcgCoreDuel({ deckA: [-1, 1.5], deckB: [69247929] });
  assert(badCode.success === false && /invalid passcode/.test(badCode.errors.join(' ')), 'invalid passcodes are refused');

  console.log('\n=== ARBITRARY FILE READ / WRITE THROUGH TOOL ARGUMENTS ===');
  const tool = (name: string) => TOOLS.find((t: any) => t.name === name) as any;
  const secret = path.join(os.tmpdir(), `ygo-secret-${Date.now()}.txt`);
  fs.writeFileSync(secret, 'local s,id=GetID() -- SECRET_MARKER', 'utf-8');
  const luaRead = await tool('ygo_analyze_lua').handler({ luaPath: secret });
  assert(luaRead.parsed === false && !JSON.stringify(luaRead).includes('SECRET_MARKER'), 'ygo_analyze_lua refuses non-.lua paths');
  const outsideJson = path.join(os.tmpdir(), `ygo-golden-${Date.now()}.json`);
  fs.writeFileSync(outsideJson, JSON.stringify({ cases: [{ id: 'SECRET_MARKER' }] }), 'utf-8');
  assert(loadGoldenCases(outsideJson).length === 0, 'golden suite refuses JSON outside the project');
  assert(loadGoldenCases().length > 0, 'golden suite still loads the shipped cases');
  let docxRefused = false;
  try {
    await readAndValidateDocx(secret);
  } catch (error) {
    docxRefused = /\.docx/.test((error as Error).message);
  }
  assert(docxRefused, 'docx reader refuses non-.docx paths');
  fs.rmSync(secret, { force: true });
  fs.rmSync(outsideJson, { force: true });

  console.log('\nAll security checks passed.');
}

run().catch(err => {
  console.error('Security test failed:', err);
  process.exit(1);
});
