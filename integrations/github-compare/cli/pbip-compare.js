/**
 * pbip-compare — compare two versions of a PBIP repository and write a
 * single-file HTML report plus flat records as JSON.
 *
 *   node pbip-compare.mjs --repo MFD-Eng/<repo> [--head <branch> | --pr <n>] [--base <branch>]
 *                         [--max-commits 30] [--out report.html] [--json records.json]
 *   node pbip-compare.mjs --version
 *
 * The token comes from the GITHUB_TOKEN environment variable only. The last
 * line on stdout is a JSON summary; progress goes to stderr.
 * Exit codes: 0 ok · 2 bad arguments · 3 auth · 4 not found / nothing to compare · 5 partial.
 */

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import template from 'virtual:report-template';
import { createGitHubSource, GitHubError } from '../src/sources/githubSource.js';
import { pickRefs, NothingToCompareError } from '../src/refs.js';
import { buildRangeHistory } from '../src/history.js';
import { buildPayload, stringify, PAYLOAD_VERSION } from '../src/payload.js';
import { flatRecords } from '../src/records.js';

/* global __TOOL_VERSION__, __TOOL_COMMIT__ */
// Set by build/build.mjs from package.json and the git commit being built.
const TOOL = {
  version: typeof __TOOL_VERSION__ === 'string' ? __TOOL_VERSION__ : 'dev',
  commit: typeof __TOOL_COMMIT__ === 'string' ? __TOOL_COMMIT__ : 'local',
  contract: 1,
};

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { source: 'github', maxCommits: 30, out: 'report.html', json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--repo': opts.repo = value(); break;
      case '--head': opts.head = value(); break;
      case '--base': opts.base = value(); break;
      case '--pr': opts.pr = Number(value()); break;
      case '--max-commits': opts.maxCommits = Number(value()); break;
      case '--source': opts.source = value(); break;
      case '--out': opts.out = value(); break;
      case '--json': opts.json = value(); break;
      case '--version': opts.version = true; break;
      default: throw new UsageError(`Unknown option ${arg}`);
    }
  }
  if (opts.version) return opts;
  if (!opts.repo || !/^[^/]+\/[^/]+$/.test(opts.repo)) throw new UsageError('--repo must look like owner/name');
  if (opts.source !== 'github') throw new UsageError('Only --source github is supported so far');
  if (opts.pr !== undefined && !Number.isInteger(opts.pr)) throw new UsageError('--pr must be a number');
  if (!Number.isInteger(opts.maxCommits) || opts.maxCommits < 0) throw new UsageError('--max-commits must be 0 or more');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) {
    console.log(JSON.stringify(TOOL));
    return 0;
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new GitHubError('GITHUB_TOKEN is not set', 401);

  const progress = (m) => process.stderr.write(`${m}\n`);
  const source = createGitHubSource({ repo: opts.repo, token });
  progress('Choosing branches…');
  const refs = await pickRefs(source, { head: opts.head, base: opts.base, pr: opts.pr });
  progress(`Base: ${refs.base.ref} · Head: ${refs.head.ref} (${refs.reason})`);
  const started = Date.now();
  const history = await buildRangeHistory(source, refs, { maxCommits: opts.maxCommits, onProgress: progress });

  const payload = buildPayload(history, {
    tool: TOOL,
    repo: opts.repo,
    source: 'GitHub',
    mode: 'range',
    reason: refs.reason,
    pr: refs.pr ?? null,
    generatedAt: new Date().toISOString(),
  });
  // Gzipped and base64-encoded: the JSON is very repetitive, so this is far smaller.
  const packed = gzipSync(Buffer.from(stringify(payload)), { level: 9 }).toString('base64');
  const html = template.replace('__PAYLOAD__', () => packed);
  const outPath = resolve(opts.out);
  writeFileSync(outPath, html);

  const records = flatRecords(history.pairs);
  let jsonPath = null;
  if (opts.json) {
    jsonPath = resolve(opts.json);
    writeFileSync(jsonPath, stringify(records, 1));
  }

  const failed = history.pairs.filter(p => p.error).length;
  const summary = {
    html: outPath,
    json: jsonPath,
    repo: opts.repo,
    base: history.base,
    head: history.head,
    headReason: refs.reason,
    baseAheadBy: history.baseAheadBy,
    branchCommits: history.branchCommitCount,
    pairs: history.pairs.length,
    failedPairs: failed,
    records: records.length,
    overall: history.pairs[0]?.summary ?? null,
    warnings: history.warnings,
    githubRequests: source.requestCount(),
    seconds: Math.round((Date.now() - started) / 1000),
    htmlBytes: Buffer.byteLength(html),
    payloadVersion: PAYLOAD_VERSION,
    tool: TOOL,
  };
  console.log(JSON.stringify(summary));
  return failed ? 5 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err.message}\n`);
    if (err instanceof UsageError) process.exit(2);
    if (err instanceof NothingToCompareError) process.exit(4);
    // GitHub answers 422 for a branch or sha that doesn't exist.
    if (err instanceof GitHubError) process.exit(err.status === 401 || err.status === 403 ? 3 : err.status === 404 || err.status === 422 ? 4 : 1);
    process.exit(1);
  },
);
