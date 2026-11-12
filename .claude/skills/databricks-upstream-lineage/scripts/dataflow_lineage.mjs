#!/usr/bin/env node
/**
 * dataflow_lineage.mjs - read-only Power BI dataflow lookups for upstream lineage.
 *
 *   node dataflow_lineage.mjs list    [--workspace <name or id>]        # dataflows you can see
 *   node dataflow_lineage.mjs show    <workspaceId> <dataflowId> [--m]  # each query: what it reads, and
 *                                                                      #   direct | shaped | transformed
 *   node dataflow_lineage.mjs collect "<pbip folder>"                   # upstream nodes/edges for the
 *                                                                      #   dataflows a model reads (JSON)
 *   node dataflow_lineage.mjs add     "<pbip folder>" [--out <file>]    # merge those into .lineage/upstream.json
 *
 * Options: --stale-hours <n> (default 30): a dataflow whose last good refresh is older is "stale".
 *
 * Sign-in: uses `az account get-access-token` for the Power BI API (run `az login` first).
 * The token stays in memory; nothing is written but the lineage file (`add`).
 * Read-only: only GET requests (dataflow definition, refresh history, workspace lists).
 *
 * Each dataflow query is analysed with the Lineage Explorer engine's analyzeMQuery:
 *   direct       reads the source and only sets types
 *   shaped       filters, renames, keeps/removes columns; no new values
 *   transformed  joins/appends tables, adds columns, groups, replaces values, custom SQL
 *                that joins or computes, typed-in data: flagged for review
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../../pbip-lineage-analyst/scripts/lib/load-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINEAGE_MJS = join(HERE, '..', '..', 'pbip-lineage-analyst', 'scripts', 'lineage.mjs');
const API = 'https://api.powerbi.com/v1.0/myorg';
const { core } = await loadCore();
const { parseMashupDocument, analyzeMQuery, extractDataflowSource } = core;

class Fail extends Error { constructor(msg, code = 1) { super(msg); this.code = code; } }

let token = null;
function getToken() {
  if (token) return token;
  // A fixed command (no user input), run through the shell so Windows finds az.cmd.
  const p = spawnSync('az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv',
    { encoding: 'utf8', shell: true });
  token = (p.stdout || '').trim();
  if (p.status !== 0 || !token) throw new Fail('Not signed in to Azure for Power BI. Run `az login`, then try again.', 3);
  return token;
}

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 401 || res.status === 403) throw new Fail(`No access to ${path} (${res.status}).`, 4);
  if (res.status === 404) throw new Fail(`Not found: ${path}`, 4);
  if (!res.ok) throw new Fail(`${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const text = (await res.text()).replace(/^﻿/, '');
  return text ? JSON.parse(text) : {};
}

const workspaceNames = new Map();
async function workspaceName(id) {
  if (!workspaceNames.size) {
    for (const w of (await get('/groups?$top=5000')).value || []) workspaceNames.set(w.id.toLowerCase(), w.name);
  }
  return workspaceNames.get(String(id).toLowerCase()) || null;
}

/** Refresh history -> runs, schedule (observed) and freshness. */
function refreshFacts(tx, staleHours) {
  const items = (tx.value || []).map(t => ({
    time: t.startTime, end: t.endTime || null, status: t.status, trigger: t.refreshType,
  })).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const runs = items.slice(0, 12);
  const ok = items.filter(t => /^(success|completed)$/i.test(t.status));
  const scheduled = items.filter(t => /scheduled/i.test(t.trigger || '')).map(t => new Date(t.time)).filter(d => !isNaN(d));
  let schedule = null;
  if (scheduled.length >= 3) {
    const gaps = scheduled.slice(0, 30).slice(1).map((d, i) => (scheduled[i] - d) / 36e5).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    const every = med < 1.5 ? `about every ${Math.max(1, Math.round(med * 60))} minutes` : med < 20 ? `about every ${Math.round(med)} hours`
      : med < 30 ? 'about once a day' : med > 150 && med < 190 ? 'about once a week' : `about every ${Math.round(med / 24)} days`;
    const mins = scheduled.slice(0, 15).map(d => d.getUTCHours() * 60 + d.getUTCMinutes()).sort((a, b) => a - b);
    const m = mins[Math.floor(mins.length / 2)];
    schedule = {
      summary: `Scheduled refresh ${every}${med >= 20 ? `, usually around ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} UTC` : ''}`,
      intervalHours: Math.round(med * 100) / 100,
      source: 'observed from the dataflow\'s refresh history (the schedule setting itself isn\'t available from the API)',
    };
  } else if (items.length) {
    schedule = { summary: scheduled.length ? 'Refreshed on a schedule a few times in the history read' : 'No scheduled refreshes in the history read: refreshed by hand or by another process', source: 'the dataflow\'s refresh history' };
  }
  let freshness = null;
  const last = items[0];
  if (last) {
    const lastOk = ok[0];
    const age = lastOk ? (Date.now() - new Date(lastOk.end || lastOk.time)) / 36e5 : null;
    if (!/^(success|completed|inprogress|notstarted)$/i.test(last.status)) {
      let fails = 0;
      for (const t of items) { if (/^(success|completed)$/i.test(t.status)) break; fails++; }
      freshness = { status: 'failed', lastRun: last.time, job: 'dataflow refresh',
        message: `last ${fails} refresh(es) ended ${last.status}${lastOk ? `; last success ${lastOk.end || lastOk.time}` : '; no successful refresh in the history read'}` };
    } else if (age != null && age > staleHours) {
      freshness = { status: 'stale', lastRun: lastOk.end || lastOk.time, job: 'dataflow refresh', message: `no successful refresh for ${Math.round(age)} hours (threshold ${staleHours})` };
    } else {
      freshness = { status: 'ok', lastRun: lastOk ? (lastOk.end || lastOk.time) : last.time, job: 'dataflow refresh' };
    }
  }
  return { runs, schedule, freshness, lastGood: ok[0] ? (ok[0].end || ok[0].time) : null };
}

async function loadDataflow(workspaceId, dataflowId) {
  const def = await get(`/groups/${workspaceId}/dataflows/${dataflowId}`);
  let tx = { value: [] };
  try { tx = await get(`/groups/${workspaceId}/dataflows/${dataflowId}/transactions`); } catch { /* no refresh history access */ }
  const queries = parseMashupDocument(def['pbi:mashup']?.document || '');
  const names = queries.map(q => q.name);
  const loaded = new Set((def.entities || []).map(e => e.name));
  const meta = def['pbi:mashup']?.queriesMetadata || {};
  return { def, tx, queries, names, loaded, meta, workspace: await workspaceName(workspaceId) };
}

function analyzeQuery(df, q) {
  const a = analyzeMQuery(q.expression, { queryNames: df.names, name: q.name });
  // Linked tables from other dataflows carry that dataflow's workspace id.
  const linked = extractDataflowSource(q.expression);
  return { ...a, linked };
}

// --- Commands ----------------------------------------------------------------------

async function cmdList(opts) {
  const ws = (await get('/groups?$top=5000')).value || [];
  const filter = opts.workspace?.toLowerCase();
  const out = [];
  for (const w of ws) {
    if (filter && !w.name.toLowerCase().includes(filter) && w.id.toLowerCase() !== filter) continue;
    let dfs = [];
    try { dfs = (await get(`/groups/${w.id}/dataflows`)).value || []; } catch { continue; }
    for (const d of dfs) out.push({ workspace: w.name, workspaceId: w.id, dataflow: d.name, dataflowId: d.objectId, generation: d.generation, modified: d.modifiedDateTime || null });
  }
  return { count: out.length, dataflows: out };
}

async function cmdShow(opts) {
  const [ws, id] = opts.args;
  if (!ws || !id) throw new Fail('show needs <workspaceId> <dataflowId> (from `list`)', 2);
  const df = await loadDataflow(ws, id);
  const facts = refreshFacts(df.tx, opts.staleHours);
  const queries = df.queries.map(q => {
    const a = analyzeQuery(df, q);
    return {
      name: q.name, loaded: df.loaded.has(q.name), shape: a.shape, summary: a.summary, flags: a.flags,
      reads: [...a.sources.map(s => s.label), ...a.references.map(r => `query: ${r}`)],
      changes: a.changes.map(c => `${c.label}${c.detail ? `: ${c.detail}` : ''} [${c.step}]`),
      ...(opts.m ? { m: q.expression } : {}),
    };
  });
  const count = (s) => queries.filter(q => q.shape === s).length;
  return {
    dataflow: df.def.name, workspace: df.workspace, modified: df.def.modifiedTime,
    url: `https://app.powerbi.com/groups/${ws}/dataflows/${id}`,
    refresh: { schedule: facts.schedule, freshness: facts.freshness, recent: facts.runs.slice(0, 5) },
    shapes: { direct: count('direct'), shaped: count('shaped'), transformed: count('transformed') },
    queries,
  };
}

function modelDataflowTables(pbip) {
  const p = spawnSync(process.execPath, [LINEAGE_MJS, 'sources', pbip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = p.stdout || '';
  if (!text.includes('{')) throw new Fail(`lineage.mjs sources failed:\n${p.stderr || text}`);
  return JSON.parse(text.slice(text.indexOf('{'))).dataflowTables || [];
}

/**
 * Upstream nodes, edges and stops for every dataflow table the model reads, the
 * queries they're built from, and linked tables in other dataflows.
 */
async function collect(pbip, opts) {
  const wanted = modelDataflowTables(pbip).filter(t => t.dataflowId && t.entity);
  const nodes = new Map();
  const edges = [];
  const stops = [];
  const databricksSeeds = new Set();
  const errors = [];
  const cache = new Map();
  const queue = wanted.map(t => ({ ws: t.workspaceId, df: t.dataflowId, query: t.entity }));
  const seen = new Set();
  const nodeId = (df, q) => `pbi-df:${df}/${q}`;

  while (queue.length) {
    const item = queue.shift();
    const key = nodeId(item.df, item.query).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let df = cache.get(item.df);
    if (!df) {
      try { df = await loadDataflow(item.ws, item.df); } catch (e) {
        errors.push(`${item.df}: ${e.message}`);
        nodes.set(key, { id: nodeId(item.df, item.query), system: 'dataflow', kind: 'dataflow table', name: item.query });
        stops.push({ node: nodeId(item.df, item.query), terminal: 'best_known', reason: `the dataflow couldn't be read (${e.message.slice(0, 160)})` });
        continue;
      }
      df.facts = refreshFacts(df.tx, opts.staleHours);
      cache.set(item.df, df);
    }
    const q = df.queries.find(x => x.name.toLowerCase() === item.query.toLowerCase());
    if (!q) {
      nodes.set(key, { id: nodeId(item.df, item.query), system: 'dataflow', kind: 'dataflow table', name: `${df.def.name} / ${item.query}` });
      stops.push({ node: nodeId(item.df, item.query), terminal: 'best_known', reason: `no query named "${item.query}" in dataflow ${df.def.name}` });
      continue;
    }
    const a = analyzeQuery(df, q);
    const isTable = df.loaded.has(q.name);
    const node = {
      id: nodeId(item.df, q.name), system: 'dataflow', kind: isTable ? 'dataflow table' : 'dataflow query',
      name: `${df.def.name} / ${q.name}`,
      details: {
        mQuery: q.expression,
        transform: { shape: a.shape, summary: a.summary, flags: a.flags, changes: a.changes, sources: a.sources, references: a.references, nativeSql: a.nativeSql || undefined },
        dataflow: { name: df.def.name, id: item.df, workspace: df.workspace, workspaceId: item.ws, modified: df.def.modifiedTime },
        links: [{ label: 'Open the dataflow in Power BI', url: `https://app.powerbi.com/groups/${item.ws}/dataflows/${item.df}` }],
      },
    };
    if (isTable) {
      // Refreshes belong to loaded tables; a helper query isn't stored on its own.
      if (df.facts.runs.length) {
        node.details.runs = df.facts.runs;
        node.details.runsSource = 'the dataflow\'s refresh history (the whole dataflow refreshes together)';
      }
      if (df.facts.schedule) node.details.schedule = df.facts.schedule;
      if (df.facts.freshness) node.freshness = df.facts.freshness;
      if (df.facts.lastGood) node.lastUpdated = df.facts.lastGood;
    } else {
      node.details.schedule = { summary: 'A helper query: not stored, it runs as part of the tables that use it', source: 'dataflow definition' };
    }
    nodes.set(key, node);

    const evidence = 'dataflow definition (Power Query)';
    for (const r of a.references) {
      edges.push({ from: nodeId(item.df, r), to: node.id, via: 'query reference', evidence, confidence: 'recorded' });
      queue.push({ ws: item.ws, df: item.df, query: r });
    }
    if (a.linked?.dataflowId && a.linked.entity) {
      edges.push({ from: nodeId(a.linked.dataflowId, a.linked.entity), to: node.id, via: 'linked table', evidence, confidence: 'recorded' });
      queue.push({ ws: a.linked.workspaceId, df: a.linked.dataflowId, query: a.linked.entity });
    }
    const readable = a.sources.filter(s => s.type !== 'dataflow' && s.type !== 'manual');
    if (!readable.length && !a.references.length && !a.linked?.entity) {
      stops.push({ node: node.id, terminal: a.sources.some(s => s.type === 'manual') ? 'origin' : 'best_known',
        reason: a.sources.some(s => s.type === 'manual') ? 'data typed into the dataflow (Enter data)'
          : "the query reads a source this tool doesn't recognise; open its Power Query to see it" });
    }
    for (const s of readable) {
      const id = s.id || `ext:${s.label}`;
      if (s.type === 'databricks' && s.id) databricksSeeds.add(s.id.slice(4));
      if (!nodes.has(id.toLowerCase())) {
        const system = { databricks: 'databricks', sqlserver: 'sqlserver', fabric: 'fabric', sharepoint: 'file', file: 'file', web: 'api' }[s.type] || 'external';
        nodes.set(id.toLowerCase(), { id, system, kind: s.type === 'sharepoint' || s.type === 'file' ? 'file' : s.type === 'web' ? 'endpoint' : 'table', name: s.label.replace(/^https?:\/\//, '') });
        if (s.type !== 'databricks') {
          stops.push({ node: id, terminal: 'best_known', reason: s.type === 'sqlserver'
            ? 'SQL Server table read by a dataflow; not traced further'
            : s.type === 'sharepoint' || s.type === 'file' ? 'a file maintained by people; nothing upstream to trace'
            : 'external source read by a dataflow; not traced further' });
        }
      }
      edges.push({ from: id, to: node.id, via: 'dataflow (Power Query)', evidence, confidence: 'recorded' });
    }
  }
  return { modelTables: wanted, nodes: [...nodes.values()], edges, stops, databricksSeeds: [...databricksSeeds].sort(), errors };
}

async function cmdCollect(opts) {
  if (!opts.args[0]) throw new Fail('collect needs a PBIP folder', 2);
  return collect(resolve(opts.args[0]), opts);
}

/** Merge dataflow nodes into an existing upstream file (or start one). */
async function cmdAdd(opts) {
  if (!opts.args[0]) throw new Fail('add needs a PBIP folder', 2);
  const pbip = resolve(opts.args[0]);
  const out = opts.out || join(pbip, '.lineage', 'upstream.json');
  const got = await collect(pbip, opts);
  const doc = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {
    version: 1, generatedBy: 'databricks-upstream-lineage skill (dataflow_lineage.mjs)', anchors: {}, nodes: [], edges: [], stops: [],
  };
  const merged = mergeInto(doc, got);
  doc.generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  return {
    out, modelTables: got.modelTables.length, dataflowNodes: got.nodes.filter(n => n.system === 'dataflow').length, ...merged,
    transformed: got.nodes.filter(n => n.details?.transform?.shape === 'transformed').map(n => `${n.name}: ${n.details.transform.summary}`),
    databricksTablesToTrace: got.databricksSeeds.filter(t => !doc.nodes.some(n => n.id.toLowerCase() === `dbx:${t}`.toLowerCase() && n.details)),
    errors: got.errors,
  };
}

/** Replace the file's dataflow nodes (and their edges and stops) with fresh ones. */
export function mergeInto(doc, got) {
  const lower = (s) => String(s).toLowerCase();
  const fresh = new Set(got.nodes.map(n => lower(n.id)));
  const isDf = (id) => lower(id).startsWith('pbi-df:');
  doc.nodes = doc.nodes.filter(n => !isDf(n.id) && !fresh.has(lower(n.id))).concat(
    got.nodes.filter(n => isDf(n.id) || !doc.nodes.some(m => lower(m.id) === lower(n.id))));
  const edgeKey = (e) => `${lower(e.from)}>${lower(e.to)}`;
  doc.edges = doc.edges.filter(e => !isDf(e.to) && !isDf(e.from));
  const have = new Set(doc.edges.map(edgeKey));
  for (const e of got.edges) if (!have.has(edgeKey(e))) { doc.edges.push(e); have.add(edgeKey(e)); }
  const stopNodes = new Set(doc.stops.map(s => lower(s.node)));
  doc.stops = doc.stops.filter(s => !isDf(s.node));
  for (const s of got.stops) if (!stopNodes.has(lower(s.node)) || isDf(s.node)) doc.stops.push(s);
  return { nodes: doc.nodes.length, edges: doc.edges.length, stops: doc.stops.length };
}

function parse(argv) {
  const o = { args: [], staleHours: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--m') o.m = true;
    else if (a === '--workspace' || a === '--out' || a === '--stale-hours') {
      const v = argv[++i];
      if (v == null) throw new Fail(`${a} needs a value`, 2);
      if (a === '--stale-hours') o.staleHours = Number(v); else o[a.slice(2)] = v;
    } else if (!o.cmd) o.cmd = a;
    else o.args.push(a);
  }
  return o;
}

const COMMANDS = { list: cmdList, show: cmdShow, collect: cmdCollect, add: cmdAdd };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parse(process.argv.slice(2));
    const fn = COMMANDS[opts.cmd];
    if (!fn) throw new Fail(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0], 2);
    process.stdout.write(`${JSON.stringify(await fn(opts), null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.code || 1);
  }
}
