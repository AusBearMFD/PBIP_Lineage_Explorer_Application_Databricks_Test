/**
 * GitHub source — reads commits, trees and file contents of one repository
 * through the GitHub REST API. Works in Node 18+ (and browsers) via fetch.
 *
 * File contents are cached by git blob id, so a file that is the same in
 * several commits is downloaded once. seedFromTarball() fills that cache from
 * one archive download, which saves one request per file for the first commit.
 */

import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const API = 'https://api.github.com';
const RELEVANT_EXTENSIONS = ['.json', '.tmdl', '.pbir'];
const SKIPPED_FOLDERS = new Set(['node_modules', '.pbi']);

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ repo: string, token: string, concurrency?: number }} options - repo is "owner/name".
 */
export function createGitHubSource({ repo, token, concurrency = 8 }) {
  const repoPath = `/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pbip-compare',
  };
  let requests = 0;

  const commitCache = new Map(); // commit sha -> normalized commit
  const treeCache = new Map();   // tree sha -> [{ path, blobOid }]
  const blobCache = new Map();   // blob sha -> text
  const decoder = new TextDecoder();

  async function request(path, { accept = 'application/vnd.github+json', raw = false } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    for (let attempt = 0; ; attempt++) {
      requests++;
      const res = await fetch(url, { headers: { ...headers, Accept: accept } });
      if (res.ok) return raw ? res : res.json();
      if ([500, 502, 503, 504].includes(res.status) && attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new GitHubError(`GitHub returned ${res.status} for ${url.replace(API, '')}: ${body.slice(0, 200)}`, res.status);
    }
  }

  function normalizeCommit(c) {
    const commit = {
      oid: c.sha,
      tree: c.commit.tree.sha,
      parents: (c.parents || []).map(p => p.sha),
      message: (c.commit.message || '').split('\n')[0],
      body: (c.commit.message || '').split('\n').slice(1).join('\n').trim(),
      author: c.commit.author?.name || '',
      date: c.commit.committer?.date || c.commit.author?.date || '',
    };
    commitCache.set(commit.oid, commit);
    return commit;
  }

  async function getCommit(ref) {
    if (commitCache.has(ref)) return commitCache.get(ref);
    return normalizeCommit(await request(`${repoPath}/commits/${encodeURIComponent(ref)}`));
  }

  async function readTree(treeSha) {
    const data = await request(`${repoPath}/git/trees/${treeSha}?recursive=1`);
    if (!data.truncated) return data.tree;
    // Very large trees come back truncated; walk them one level at a time instead.
    const out = [];
    async function walk(sha, prefix) {
      const level = await request(`${repoPath}/git/trees/${sha}`);
      for (const e of level.tree) {
        const path = prefix + e.path;
        out.push({ ...e, path });
        if (e.type === 'tree') await walk(e.sha, `${path}/`);
      }
    }
    await walk(treeSha, '');
    return out;
  }

  async function listPbipFiles(commitOid) {
    const commit = await getCommit(commitOid);
    if (treeCache.has(commit.tree)) return treeCache.get(commit.tree);
    const files = (await readTree(commit.tree))
      .filter(e => e.type === 'blob' && isPbipPath(e.path))
      .map(e => ({ path: e.path, blobOid: e.sha }));
    treeCache.set(commit.tree, files);
    return files;
  }

  async function readBlobs(oids) {
    const missing = [...new Set(oids)].filter(o => !blobCache.has(o));
    await pool(missing, concurrency, async (oid) => {
      const res = await request(`${repoPath}/git/blobs/${oid}`, { accept: 'application/vnd.github.raw', raw: true });
      blobCache.set(oid, decoder.decode(new Uint8Array(await res.arrayBuffer())));
    });
    return new Map(oids.map(o => [o, blobCache.get(o)]));
  }

  return {
    repo,
    requestCount: () => requests,
    blobCount: () => blobCache.size,

    repoInfo: () => request(repoPath),

    async pullRequest(number) {
      return request(`${repoPath}/pulls/${number}`);
    },

    async newestOpenPullRequest() {
      const prs = await request(`${repoPath}/pulls?state=open&sort=updated&direction=desc&per_page=1`);
      return prs[0] || null;
    },

    /** Most recently pushed branch other than `exclude`, from repository activity; falls back to tip commit dates. */
    async newestPushedBranch(exclude) {
      try {
        const events = await request(`${repoPath}/activity?activity_type=push&direction=desc&per_page=50`);
        for (const e of events) {
          const name = (e.ref || '').replace(/^refs\/heads\//, '');
          if (!name || name === exclude || !e.ref.startsWith('refs/heads/')) continue;
          try {
            await getCommit(name); // skip branches that were deleted since
            return { name, when: e.timestamp, how: 'push activity' };
          } catch (err) {
            if (err.status !== 404 && err.status !== 422) throw err;
          }
        }
      } catch (err) {
        if (err.status !== 404 && err.status !== 403) throw err;
      }
      const branches = await request(`${repoPath}/branches?per_page=100`);
      let best = null;
      for (const b of branches) {
        if (b.name === exclude) continue;
        const c = await getCommit(b.commit.sha);
        if (!best || c.date > best.when) best = { name: b.name, when: c.date, how: 'latest commit date' };
      }
      return best;
    },

    getCommit,

    /** Commits reachable from head but not base (oldest first), plus how far base is ahead. */
    async compare(baseOid, headOid) {
      const commits = [];
      let aheadBy = 0, behindBy = 0;
      for (let page = 1; ; page++) {
        const data = await request(`${repoPath}/compare/${baseOid}...${headOid}?per_page=100&page=${page}`);
        aheadBy = data.ahead_by;
        behindBy = data.behind_by;
        commits.push(...data.commits.map(normalizeCommit));
        if (!data.commits.length || commits.length >= data.total_commits) break;
      }
      return { commits, aheadBy, behindBy };
    },

    listPbipFiles,
    readBlobs,
    countMissing: (oids) => new Set(oids.filter(o => !blobCache.has(o))).size,

    /** Fill the blob cache from one tarball of a commit. Returns the number of PBIP files cached. */
    async seedFromTarball(commitOid) {
      const res = await request(`${repoPath}/tarball/${commitOid}`, { accept: '*/*', raw: true });
      const archive = gunzipSync(Buffer.from(await res.arrayBuffer()));
      let n = 0;
      for (const { path, data } of tarEntries(archive)) {
        const repoRelative = path.slice(path.indexOf('/') + 1); // drop "owner-repo-sha/"
        if (!isPbipPath(repoRelative)) continue;
        const oid = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
        if (!blobCache.has(oid)) {
          blobCache.set(oid, decoder.decode(data));
          n++;
        }
      }
      return n;
    },
  };
}

function isPbipPath(path) {
  const lower = path.toLowerCase();
  if (!RELEVANT_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;
  return !lower.split('/').slice(0, -1).some(seg => SKIPPED_FOLDERS.has(seg));
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Regular files in an uncompressed tar archive (ustar, pax and GNU long names). */
function* tarEntries(buf) {
  let offset = 0;
  let paxPath = null;
  let longName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const field = (start, len) => {
      const bytes = header.subarray(start, start + len);
      const end = bytes.indexOf(0);
      return bytes.subarray(0, end < 0 ? len : end).toString('utf8');
    };
    const name = field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const prefix = field(345, 155);
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') { paxPath = parsePax(data).path ?? null; continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    longName = null;
    if (type === '0' || type === '\0') yield { path, data };
  }
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(32, i);
    if (space < 0) break;
    const len = parseInt(data.toString('utf8', i, space), 10);
    if (!len) break;
    const record = data.toString('utf8', space + 1, i + len - 1);
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}
