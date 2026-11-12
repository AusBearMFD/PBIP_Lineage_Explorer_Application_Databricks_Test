import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRefs, NothingToCompareError } from '../src/refs.js';
import { createFakeSource } from './fakeSource.js';

const pr = (n, head, base) => ({ number: n, title: `PR ${n}`, head: { ref: head, sha: `sha-${head}` }, base: { ref: base } });

test('an explicit head wins, with the default branch as base', async () => {
  const refs = await pickRefs(createFakeSource({ openPr: pr(9, 'other', 'main') }), { head: 'feature' });
  assert.equal(refs.head.ref, 'feature');
  assert.equal(refs.base.ref, 'main');
  assert.equal(refs.reason, 'head given');
});

test('an explicit PR gives both branches', async () => {
  const refs = await pickRefs(createFakeSource(), { pr: 4 });
  assert.equal(refs.head.ref, 'feature');
  assert.equal(refs.base.ref, 'main');
  assert.equal(refs.pr, 4);
  assert.match(refs.reason, /^PR #4 given/);
});

test('with nothing given, the newest open PR is used and its base wins over the default branch', async () => {
  const refs = await pickRefs(createFakeSource({ openPr: pr(23, 'dev/v2.1-mena', 'release/2.1') }));
  assert.equal(refs.head.ref, 'dev/v2.1-mena');
  assert.equal(refs.head.sha, 'sha-dev/v2.1-mena');
  assert.equal(refs.base.ref, 'release/2.1');
  assert.match(refs.reason, /^newest open PR #23/);
});

test('an explicit base wins over the PR base', async () => {
  const refs = await pickRefs(createFakeSource({ openPr: pr(23, 'x', 'release/2.1') }), { base: 'main' });
  assert.equal(refs.base.ref, 'main');
});

test('with no open PR, the most recently pushed branch is used', async () => {
  const refs = await pickRefs(createFakeSource({ branches: [{ name: 'dev/1.2', when: '2026-10-01T00:00:00Z', how: 'push activity' }] }));
  assert.equal(refs.head.ref, 'dev/1.2');
  assert.equal(refs.base.ref, 'main');
  assert.match(refs.reason, /^most recently pushed branch/);
});

test('with no PR and no other branch, it stops with a clear error', async () => {
  await assert.rejects(pickRefs(createFakeSource()), NothingToCompareError);
});
