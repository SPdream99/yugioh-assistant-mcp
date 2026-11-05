/**
 * Where custom-card state lives.
 *
 * Every reader and writer of the registry, the custom Lua scripts and the
 * migrated-script cache resolves its location here, so they can never drift
 * apart (the engine reading one folder while the registry writes another).
 *
 * YGO_CUSTOM_DATA_DIR relocates all of it at once. The test suite points it at
 * a throw-away directory so test cards never land in the user's real registry.
 */

import path from 'node:path';

export function customDataRoot(): string {
  const override = process.env.YGO_CUSTOM_DATA_DIR;
  return override && override.trim() ? path.resolve(override) : path.resolve(process.cwd(), 'data');
}

export function customRegistryFile(): string {
  return path.join(customDataRoot(), 'custom_registry.json');
}

export function customCardsDir(): string {
  return path.join(customDataRoot(), 'custom_cards');
}

/** Copies of migrated scripts kept beside the other cached scripts. */
export function customCacheScriptsDir(): string {
  return path.join(customDataRoot(), 'cache', 'scripts');
}

export function renderedCardsDir(): string {
  return path.join(customDataRoot(), 'rendered_cards');
}
