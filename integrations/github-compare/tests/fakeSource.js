/**
 * An in-memory source with the same interface as githubSource.js, built from
 * the repo's own sample PBIP project (public/sample-pbip), so tests run offline.
 *
 * Commits: A (root, the sample) → B (edits the 'Total Sales' measure)
 *          → C (adds the 'Discount' measure). main = A, feature = C.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'sample-pbip');

function readTree(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readTree(full));
    else out.push(full);
  }
  return out;
}

/** Sample files with X.SemanticModel / X.Report folder names, as in a real repo. */
export function sampleFiles() {
  const files = new Map();
  for (const full of readTree(sampleDir)) {
    const rel = relative(sampleDir, full).split('\\').join('/');
    const path = rel.startsWith('report/') ? `Sample.Report/${rel.slice('report/'.length)}` : `Sample.SemanticModel/${rel}`;
    files.set(path, readFileSync(full, 'utf8'));
  }
  return files;
}

export function createFakeSource({ openPr = null, branches = [] } = {}) {
  const salesPath = 'Sample.SemanticModel/definition/tables/Sales.tmdl';
  const a = sampleFiles();
  const b = new Map(a);
  b.set(salesPath, a.get(salesPath).replace("measure 'Total Sales' = SUM(Sales[Amount])", "measure 'Total Sales' = SUMX(Sales, Sales[Amount] * Sales[Quantity])"));
  const c = new Map(b);
  c.set(salesPath, b.get(salesPath).replace("\tpartition Sales = m", "\tmeasure 'Discount' = SUM(Sales[Amount]) * 0.1\n\t\tformatString: #,##0\n\tpartition Sales = m"));

  const commits = {
    A: { oid: 'a'.repeat(40), parents: [], message: 'Initial sample', body: '', author: 'Test', date: '2026-01-01T00:00:00Z', files: a },
    B: { oid: 'b'.repeat(40), parents: ['a'.repeat(40)], message: 'Change Total Sales', body: '', author: 'Test', date: '2026-01-02T00:00:00Z', files: b },
    C: { oid: 'c'.repeat(40), parents: ['b'.repeat(40)], message: 'Add Discount', body: '', author: 'Test', date: '2026-01-03T00:00:00Z', files: c },
  };
  const byOid = new Map(Object.values(commits).map(x => [x.oid, x]));
  const refs = { main: commits.A, feature: commits.C };
  const blobs = new Map();
  const listing = (commit) => [...commit.files].map(([path, text]) => {
    const oid = `${path}@${text.length}:${hash(text)}`;
    blobs.set(oid, text);
    return { path, blobOid: oid };
  });

  return {
    repoInfo: async () => ({ default_branch: 'main' }),
    pullRequest: async (n) => ({ number: n, title: 'Given PR', head: { ref: 'feature', sha: commits.C.oid }, base: { ref: 'main' } }),
    newestOpenPullRequest: async () => openPr,
    newestPushedBranch: async (exclude) => branches.find(b => b.name !== exclude) || null,
    getCommit: async (ref) => {
      const c = refs[ref] || byOid.get(ref);
      if (!c) throw Object.assign(new Error(`no commit ${ref}`), { status: 422 });
      return c;
    },
    compare: async () => ({ commits: [commits.B, commits.C], aheadBy: 2, behindBy: 0 }),
    listPbipFiles: async (oid) => listing(byOid.get(oid)),
    readBlobs: async (oids) => new Map(oids.map(o => [o, blobs.get(o)])),
    countMissing: () => 0,
  };
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
