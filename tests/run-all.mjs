#!/usr/bin/env node
/*
 * Runs every suite in order, stopping at the first failure.
 *
 *   npm test
 *
 * No install, no network, no credentials. The one test that talks to a real
 * server lives in scripts/live-check.mjs and is never run from here.
 */

import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  'core-test.mjs',
  'render-test.mjs',
  'bundle-test.mjs',
];

for (const suite of suites) {
  console.log(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${suite} failed\n`);
    process.exit(r.status || 1);
  }
}

console.log('\n✓ all suites passed\n');
