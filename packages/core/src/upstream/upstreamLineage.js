/**
 * Upstream lineage — where a model table's source data comes from, beyond the
 * source connection the PBIP files themselves describe.
 *
 * The app can't reach Databricks, Power BI or SQL Server (it runs in the browser
 * with no credentials), so this lineage is gathered by an AI agent or a
 * collector script and written to `.lineage/upstream.json` next to the PBIP
 * project. This module reads that file, checks it, and answers questions the
 * views ask: "what feeds this table?", "where does its trail end?".
 *
 * File format (version 1):
 * {
 *   "version": 1,
 *   "generatedAt": "2026-11-06T15:20:00Z",
 *   "generatedBy": "upstream-lineage skill",
 *   "pbipCommit": "fe6ccf6",                       // optional: model commit described
 *   "anchors": { "Model/Table" | "Table": "<node id>" },
 *   "nodes": [{ "id", "system", "kind", "name"?, "terminal"?, "lastUpdated"?, "freshness"?, "note"?,
 *               "owner"?, "details"? }],
 *   "edges": [{ "from", "to", "via"?, "evidence"?, "confidence": "recorded"|"inferred" }],
 *   "stops": [{ "node", "terminal": "origin"|"best_known", "reason" }]
 * }
 * Edges point downstream: `from` feeds `to`.
 * Node ids are prefixed by system: dbx:, pbi-df:, fabric:, sql:, ext:.
 *
 * `details` (optional, shown in the app's table details panel when a node is
 * clicked) may hold:
 *   sql, sqlSource          view definition or custom SQL, and where it came from
 *   mQuery, transform       a dataflow table's Power Query and its analysis
 *                           (analyzeMQuery: shape direct|shaped|transformed, changes)
 *   dataflow                { name, id, workspace, workspaceId, modified }
 *   writer                  { jobId, jobName, runAs, operation, visible, note }
 *   schedule                { summary, source, cron?, timezone?, paused? }
 *   runs, runsSource        recent runs or refreshes: [{ time, status, operation?, rows?, runId?, trigger?, url? }]
 *   columns                 column names
 *   links                   [{ label, url }]
 * Unknown keys are kept, so newer collectors don't break older apps.
 */

export const UPSTREAM_FILE_PATH = '.lineage/upstream.json';
export const TERMINAL = { ORIGIN: 'origin', BEST_KNOWN: 'best_known' };
export const CONFIDENCE = { RECORDED: 'recorded', INFERRED: 'inferred' };

const SYSTEM_LABELS = {
  databricks: 'Databricks',
  sqlserver: 'SQL Server',
  fabric: 'Fabric',
  dataflow: 'Power BI dataflow',
  powerbi: 'Power BI',
  dbt: 'dbt',
  file: 'File',
  api: 'API',
  external: 'External system',
};

export function systemLabel(system) {
  return SYSTEM_LABELS[(system || '').toLowerCase()] || system || 'Unknown';
}

const norm = (id) => String(id || '').trim().toLowerCase();

/**
 * Parse and check an upstream lineage file.
 * Never throws for content problems: they come back in `errors` (file unusable)
 * or `warnings` (file usable, something skipped).
 * @param {string|object} input - File text or an already-parsed object.
 * @returns {{ upstream: object|null, errors: string[], warnings: string[] }}
 */
export function parseUpstreamLineage(input) {
  const errors = [];
  const warnings = [];
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (err) {
      return { upstream: null, errors: [`Not valid JSON: ${err.message}`], warnings };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { upstream: null, errors: ['The file must contain a JSON object.'], warnings };
  }
  if (raw.version !== 1) errors.push(`Unsupported version ${JSON.stringify(raw.version)}; this app reads version 1.`);
  if (!Array.isArray(raw.nodes)) errors.push('"nodes" must be a list.');
  if (!Array.isArray(raw.edges)) errors.push('"edges" must be a list.');
  if (errors.length) return { upstream: null, errors, warnings };

  const nodes = new Map();
  for (const n of raw.nodes) {
    if (!n || !n.id) { warnings.push('Skipped a node with no id.'); continue; }
    const key = norm(n.id);
    if (nodes.has(key)) { warnings.push(`Duplicate node ${n.id}; kept the first.`); continue; }
    nodes.set(key, {
      id: n.id,
      key,
      system: n.system || systemFromId(n.id),
      kind: n.kind || 'table',
      name: n.name || nameFromId(n.id),
      terminal: n.terminal || null,
      lastUpdated: n.lastUpdated || null,
      freshness: n.freshness || null,
      note: n.note || '',
      owner: n.owner || '',
      details: n.details && typeof n.details === 'object' && !Array.isArray(n.details) ? n.details : null,
    });
  }

  const edges = [];
  for (const e of raw.edges) {
    if (!e || !e.from || !e.to) { warnings.push('Skipped an edge without "from" and "to".'); continue; }
    const from = norm(e.from);
    const to = norm(e.to);
    // An edge may name a node the file doesn't list; add a bare one so the
    // chain still draws, and say so.
    for (const [key, id] of [[from, e.from], [to, e.to]]) {
      if (!nodes.has(key)) {
        warnings.push(`Edge names ${id}, which isn't in "nodes"; added it.`);
        nodes.set(key, { id, key, system: systemFromId(id), kind: 'table', name: nameFromId(id), terminal: null, lastUpdated: null, freshness: null, note: '' });
      }
    }
    if (from === to) { warnings.push(`Skipped an edge from ${e.from} to itself.`); continue; }
    edges.push({
      from, to,
      via: e.via || '',
      evidence: e.evidence || '',
      confidence: e.confidence === CONFIDENCE.INFERRED ? CONFIDENCE.INFERRED : CONFIDENCE.RECORDED,
    });
  }

  for (const s of (Array.isArray(raw.stops) ? raw.stops : [])) {
    const key = norm(s?.node);
    const node = nodes.get(key);
    if (!node) { warnings.push(`A stop names ${s?.node}, which isn't in "nodes"; skipped.`); continue; }
    node.terminal = s.terminal === TERMINAL.ORIGIN ? TERMINAL.ORIGIN : TERMINAL.BEST_KNOWN;
    node.stopReason = s.reason || '';
  }

  const anchors = new Map();
  for (const [k, v] of Object.entries(raw.anchors || {})) anchors.set(String(k), norm(v));

  // Upstream adjacency: for each node, the edges that feed it.
  const feeders = new Map();
  for (const e of edges) {
    if (!feeders.has(e.to)) feeders.set(e.to, []);
    feeders.get(e.to).push(e);
  }

  return {
    upstream: {
      version: 1,
      generatedAt: raw.generatedAt || null,
      generatedBy: raw.generatedBy || '',
      pbipCommit: raw.pbipCommit || null,
      anchors, nodes, edges, feeders,
    },
    errors,
    warnings,
  };
}

/** Node id for a model table's own source, when its connection names one. */
export function sourceNodeIdForTable(dataSource) {
  if (!dataSource) return null;
  if (dataSource.sourceType === 'Databricks' || dataSource.type === 'Databricks') {
    const fqn = dataSource.fqn || [dataSource.database, dataSource.schema, dataSource.sourceTable].filter(Boolean).join('.');
    return fqn && fqn.split('.').length === 3 ? `dbx:${fqn}` : null;
  }
  if ((dataSource.sourceType === 'SQL' || dataSource.type === 'SQL') && dataSource.database && dataSource.sourceTable) {
    return `sql:${dataSource.database}.${dataSource.schema || 'dbo'}.${dataSource.sourceTable}`;
  }
  // Power BI dataflow table: pbi-df:<dataflowId>/<table> (the M names ids, not names).
  if ((dataSource.sourceType === 'Dataflow' || dataSource.type === 'Dataflow') && dataSource.database && dataSource.sourceTable) {
    return `pbi-df:${dataSource.database}/${dataSource.sourceTable}`;
  }
  return null;
}

/**
 * A node with the nodes on either side of it, for a details panel.
 * @returns {null|{ node: object, feeds: {node, edge}[], fedBy: {node, edge}[], terminal: string|null }}
 */
export function upstreamNeighbors(upstream, key) {
  const node = upstream?.nodes.get(norm(key));
  if (!node) return null;
  const fedBy = (upstream.feeders.get(node.key) || []).map(e => ({ node: upstream.nodes.get(e.from), edge: e }));
  const feeds = upstream.edges.filter(e => e.from === node.key).map(e => ({ node: upstream.nodes.get(e.to), edge: e }));
  return { node, feeds, fedBy, terminal: terminalOf(upstream, node) };
}

/**
 * Find the first upstream node for a model table: an explicit anchor in the
 * file ("Model/Table" or "Table"), else the node matching the table's own
 * source connection (e.g. dbx:catalog.schema.table).
 * @returns {string|null} normalized node key
 */
export function anchorForTable(upstream, tableName, dataSource, modelName = '') {
  if (!upstream || !tableName) return null;
  const candidates = [modelName && `${modelName}/${tableName}`, tableName];
  for (const c of candidates) {
    if (c && upstream.anchors.has(c)) return upstream.anchors.get(c);
  }
  // Anchors written as "AnyModel/Table" still match by table name.
  for (const [k, v] of upstream.anchors) {
    if (k.split('/').pop() === tableName) return v;
  }
  const own = norm(sourceNodeIdForTable(dataSource));
  if (own && upstream.nodes.has(own)) return own;
  return null;
}

/**
 * Walk upstream from a node, returning a tree. Cycle-safe; stops at maxDepth.
 * Each tree node: { node, edge (the edge into its child-of relation), depth, children }.
 * @param {object} upstream
 * @param {string} startKey - normalized node key
 * @param {{ maxDepth?: number, hideInferred?: boolean, systems?: Set<string>|null }} [opts]
 */
export function upstreamTree(upstream, startKey, opts = {}) {
  const maxDepth = opts.maxDepth ?? 12;
  const start = upstream?.nodes.get(startKey);
  if (!start) return null;

  const walk = (key, depth, path, edge) => {
    const node = upstream.nodes.get(key);
    const out = { node, edge: edge || null, depth, children: [], truncated: false };
    if (depth >= maxDepth) { out.truncated = (upstream.feeders.get(key) || []).length > 0; return out; }
    for (const e of (upstream.feeders.get(key) || [])) {
      if (opts.hideInferred && e.confidence === CONFIDENCE.INFERRED) continue;
      if (path.has(e.from)) continue; // cycle
      const fromNode = upstream.nodes.get(e.from);
      if (opts.systems && fromNode && !opts.systems.has((fromNode.system || '').toLowerCase())) continue;
      out.children.push(walk(e.from, depth + 1, new Set([...path, e.from]), e));
    }
    return out;
  };
  return walk(startKey, 0, new Set([startKey]), null);
}

/**
 * Where a node's trail ends: a node with nothing feeding it. Marked origin when
 * the file says so, otherwise best known (with the file's reason, if any).
 */
export function terminalOf(upstream, node) {
  if (node.terminal === TERMINAL.ORIGIN) return TERMINAL.ORIGIN;
  if (node.terminal === TERMINAL.BEST_KNOWN) return TERMINAL.BEST_KNOWN;
  return (upstream.feeders.get(node.key) || []).length === 0 ? TERMINAL.BEST_KNOWN : null;
}

/**
 * One-line facts about a table's upstream trail, for tables and badges.
 * @returns {null|{ firstHop: string, depth: number, origins: object[], bestKnown: object[],
 *   systems: string[], inferredEdges: number, stale: object[] }}
 */
export function summarizeUpstream(upstream, startKey, opts = {}) {
  const tree = upstreamTree(upstream, startKey, opts);
  if (!tree) return null;
  const origins = [];
  const bestKnown = [];
  const systems = new Set();
  const stale = [];
  let inferredEdges = 0;
  let depth = 0;
  const seen = new Set();
  const visit = (t) => {
    if (seen.has(t.node.key + '@' + t.depth)) return;
    seen.add(t.node.key + '@' + t.depth);
    depth = Math.max(depth, t.depth);
    systems.add(t.node.system);
    if (t.edge?.confidence === CONFIDENCE.INFERRED) inferredEdges++;
    if (t.node.freshness?.status && t.node.freshness.status !== 'ok') stale.push(t.node);
    if (t.children.length === 0) {
      const term = terminalOf(upstream, t.node);
      if (term === TERMINAL.ORIGIN) { if (!origins.includes(t.node)) origins.push(t.node); }
      else if (!bestKnown.includes(t.node)) bestKnown.push(t.node);
    }
    t.children.forEach(visit);
  };
  visit(tree);
  return {
    firstHop: tree.children[0]?.node.name || '',
    depth,
    origins,
    bestKnown,
    systems: [...systems].map(systemLabel),
    inferredEdges,
    stale,
  };
}

/** Every system named in the file, for filter chips. */
export function systemsInUpstream(upstream) {
  return [...new Set([...upstream.nodes.values()].map(n => (n.system || '').toLowerCase()))].filter(Boolean).sort();
}

/**
 * Is the file older than the model it describes? Compares the file's
 * pbipCommit with the commit the app has open, when both are known.
 */
export function isUpstreamStale(upstream, currentCommit) {
  if (!upstream?.pbipCommit || !currentCommit) return false;
  const a = upstream.pbipCommit.toLowerCase();
  const b = currentCommit.toLowerCase();
  return !(a.startsWith(b) || b.startsWith(a));
}

function systemFromId(id) {
  const prefix = String(id).split(':')[0].toLowerCase();
  return { dbx: 'databricks', sql: 'sqlserver', fabric: 'fabric', 'pbi-df': 'dataflow', dbt: 'dbt', file: 'file', api: 'api', ext: 'external' }[prefix] || 'external';
}

function nameFromId(id) {
  const s = String(id);
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}
