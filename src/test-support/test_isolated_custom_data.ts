/**
 * Import this FIRST in any test that registers or migrates custom cards.
 *
 * It points YGO_CUSTOM_DATA_DIR at a fresh temp directory, so the registry,
 * custom scripts, migrated-script cache and rendered SVGs of the test run never
 * touch the user's real data/ folder. The directory is removed on exit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ISOLATED_CUSTOM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-custom-data-'));
process.env.YGO_CUSTOM_DATA_DIR = ISOLATED_CUSTOM_DATA_DIR;

process.on('exit', () => {
  try {
    fs.rmSync(ISOLATED_CUSTOM_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Best effort: the OS cleans its temp folder eventually.
  }
});
