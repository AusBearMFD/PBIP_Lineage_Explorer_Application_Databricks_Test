import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'pbip-compare.mjs');
const skip = existsSync(cli) ? false : 'run npm run build first';
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GITHUB_TOKEN: '', ...env },
});

test('--version prints the contract number utils checks', { skip }, () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  const info = JSON.parse(r.stdout);
  assert.equal(info.contract, 1);
  assert.ok(info.version);
});

test('bad arguments exit with 2', { skip }, () => {
  assert.equal(run(['--repo', 'not-a-full-name']).status, 2);
  assert.equal(run(['--repo', 'a/b', '--pr', 'x']).status, 2);
  assert.equal(run(['--repo', 'a/b', '--unknown']).status, 2);
});

test('a missing token exits with 3', { skip }, () => {
  assert.equal(run(['--repo', 'a/b']).status, 3);
});
