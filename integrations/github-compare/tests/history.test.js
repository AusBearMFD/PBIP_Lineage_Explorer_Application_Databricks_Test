import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRangeHistory } from '../src/history.js';
import { buildPayload, expandPayload, stringify, parse } from '../src/payload.js';
import { flatRecords } from '../src/records.js';
import { createFakeSource } from './fakeSource.js';

const refs = { base: { ref: 'main' }, head: { ref: 'feature' } };

test('overall pair first, then each branch commit newest first', async () => {
  const h = await buildRangeHistory(createFakeSource(), refs);
  assert.equal(h.pairs.length, 3);
  assert.equal(h.pairs[0].commit.hash, 'Overall');
  assert.equal(h.pairs[0].commit.message, 'All changes: main → feature');
  assert.equal(h.pairs[1].commit.message, 'Add Discount');
  assert.equal(h.pairs[2].commit.message, 'Change Total Sales');
  assert.equal(h.base.oid, 'a'.repeat(40));
  assert.equal(h.head.oid, 'c'.repeat(40));
  assert.deepEqual(h.warnings, []);
});

test('the overall pair holds both commits\' changes; each commit holds only its own', async () => {
  const h = await buildRangeHistory(createFakeSource(), refs);
  const names = (pair) => pair.records.filter(r => r.group === 'measure').map(r => `${r.change}:${r.name}`).sort();
  assert.deepEqual(names(h.pairs[0]), ['added:Discount', 'changed:Total Sales']);
  assert.deepEqual(names(h.pairs[1]), ['added:Discount']);
  assert.deepEqual(names(h.pairs[2]), ['changed:Total Sales']);
});

test('max commits 0 gives the overall comparison only', async () => {
  const h = await buildRangeHistory(createFakeSource(), refs, { maxCommits: 0 });
  assert.equal(h.pairs.length, 1);
});

test('payload round trip restores Maps and shared model snapshots', async () => {
  const h = await buildRangeHistory(createFakeSource(), refs);
  const payload = buildPayload(h, { repo: 'test/sample' });
  // Base, A→B, B→C and head share snapshots, so far fewer model sets than 2 per pair.
  assert.ok(payload.modelSets.length < h.pairs.length * 2);
  const back = expandPayload(parse(stringify(payload)));
  assert.equal(back.base.ref, 'main');
  assert.ok(back.pairs[0].models.after instanceof Map);
  assert.ok(back.pairs[0].models.after.get(back.pairs[0].models.after.keys().next().value).tables instanceof Map);
});

test('flat records name the pair each change came from', async () => {
  const h = await buildRangeHistory(createFakeSource(), refs);
  const rows = flatRecords(h.pairs);
  const overall = rows.filter(r => r.pair === 'Overall' && r.group === 'measure');
  assert.equal(overall.length, 2);
  assert.ok(rows.some(r => r.pair === 'ccccccc' && r.name === 'Discount' && r.change === 'added'));
});
