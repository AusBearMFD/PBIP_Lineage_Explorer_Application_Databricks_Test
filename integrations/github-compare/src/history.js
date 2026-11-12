/**
 * History — builds the comparison pairs for a head-vs-base review.
 *
 * pairs[0] is the overall comparison: the base tip against the head tip
 * ("tip to tip"). The rest are the branch's own commits, newest first, each
 * compared with its first parent — the same rule snapshotScanner.js uses.
 * Pairs have the shape the existing Version Compare and Model Diagram views
 * expect, so those views are reused unchanged.
 */

import { buildSnapshot, compareSnapshots } from '../../../packages/core/src/index.js';

/** Above this many uncached files, a version is fetched as one archive. */
const ARCHIVE_THRESHOLD = 100;

/**
 * @param {object} source - a source from sources/ (GitHub or local).
 * @param {{ base: {ref, sha?}, head: {ref, sha?} }} refs - from pickRefs().
 * @param {{ maxCommits?: number, onProgress?: function(string) }} [options]
 */
export async function buildRangeHistory(source, refs, { maxCommits = 30, onProgress = () => {} } = {}) {
  const baseTip = await source.getCommit(refs.base.sha || refs.base.ref);
  const headTip = await source.getCommit(refs.head.sha || refs.head.ref);
  const range = await source.compare(baseTip.oid, headTip.oid);
  const branchCommits = maxCommits > 0 ? range.commits.slice(-maxCommits).reverse() : [];
  const warnings = [];
  if (range.behindBy > 0) {
    warnings.push(`${refs.base.ref} has ${range.behindBy} commit${range.behindBy === 1 ? '' : 's'} not in ${refs.head.ref}. ` +
      'Some differences in "All changes" come from the base branch, not this branch.');
  }
  if (range.commits.length > branchCommits.length && maxCommits > 0) {
    warnings.push(`Only the newest ${branchCommits.length} of ${range.commits.length} branch commits are listed individually.`);
  }

  const snapshots = new Map();
  let archiveFailed = false;
  async function snapshotOf(oid) {
    if (!oid) return buildSnapshot(new Map());
    if (snapshots.has(oid)) return snapshots.get(oid);
    const listing = await source.listPbipFiles(oid);
    // When most of a version's files aren't cached yet, one archive download
    // is far cheaper than one request per file.
    const missing = source.countMissing ? source.countMissing(listing.map(f => f.blobOid)) : 0;
    if (missing > ARCHIVE_THRESHOLD && source.seedFromTarball && !archiveFailed) {
      onProgress(`Downloading ${oid.slice(0, 7)} as one archive (${missing} files not cached)…`);
      try {
        await source.seedFromTarball(oid);
      } catch (err) {
        archiveFailed = true;
        warnings.push(`Archive download failed, so files were read one at a time (${err.message}).`);
      }
    }
    const blobs = await source.readBlobs(listing.map(f => f.blobOid));
    const files = new Map(listing.map(f => [f.path, blobs.get(f.blobOid)]));
    const snap = buildSnapshot(files);
    snapshots.set(oid, snap);
    return snap;
  }

  const pairs = [];
  onProgress(`Comparing ${refs.base.ref} with ${refs.head.ref}…`);
  pairs.push(await comparePair(
    {
      hash: 'Overall',
      message: `All changes: ${refs.base.ref} → ${refs.head.ref}`,
      body: `Tip of ${refs.base.ref} (${baseTip.oid.slice(0, 7)}) compared with tip of ${refs.head.ref} (${headTip.oid.slice(0, 7)}).`,
      author: '',
      date: headTip.date,
    },
    describe(baseTip),
    () => snapshotOf(baseTip.oid),
    () => snapshotOf(headTip.oid),
    { isRoot: false, isMerge: false, overall: true },
  ));

  for (let i = 0; i < branchCommits.length; i++) {
    const c = branchCommits[i];
    onProgress(`Comparing branch commit ${i + 1} of ${branchCommits.length}…`);
    const parentOid = c.parents[0] || null;
    const parent = parentOid ? await source.getCommit(parentOid) : null;
    pairs.push(await comparePair(
      describe(c),
      parent ? describe(parent) : null,
      () => snapshotOf(parentOid),
      () => snapshotOf(c.oid),
      { isRoot: !parentOid, isMerge: c.parents.length > 1 },
    ));
  }

  return {
    pairs,
    base: { ref: refs.base.ref, oid: baseTip.oid },
    head: { ref: refs.head.ref, oid: headTip.oid },
    branchCommitCount: range.commits.length,
    baseAheadBy: range.behindBy,
    warnings,
  };
}

async function comparePair(commit, parent, before, after, extra) {
  try {
    const [b, a] = [await before(), await after()];
    const { records, summary } = compareSnapshots(b, a);
    return { commit, parent, ...extra, records, summary, models: { before: b.models, after: a.models } };
  } catch (err) {
    return { commit, parent, ...extra, records: [], summary: null, error: err.message };
  }
}

function describe(c) {
  return { hash: c.oid, message: c.message, body: c.body, author: c.author, date: c.date };
}
