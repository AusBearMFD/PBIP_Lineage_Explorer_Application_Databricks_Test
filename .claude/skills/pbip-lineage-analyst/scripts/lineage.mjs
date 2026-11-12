#!/usr/bin/env node
/**
 * lineage.mjs — run the PBIP Lineage Explorer's own engine (packages/core) from
 * the command line, so an AI agent sees exactly what the app shows.
 *
 *   node lineage.mjs <command> <pbip-folder> [options]
 *
 * Commands (all print JSON to stdout; progress and warnings go to stderr):
 *   summary          What was found: reports, models, counts, orphans, sources, warnings.
 *   measure          Everything about one measure: DAX, upstream chain, dependents,
 *                    visuals (report > page > visual), filters, orphan status.
 *                      --name "<Measure>" | "Table[Measure]"
 *   search           Find measures, columns and tables by name.        --q <text>
 *   orphans          Unused measures by category, and unused columns.
 *   visuals          Every visual with report, page, type, title and fields.
 *                      [--report <name>] [--page <name>]
 *   sources          Each model table's data source (Databricks catalog.schema.table,
 *                    SQL, Fabric...) and its upstream lineage if .lineage/upstream.json exists.
 *   change-impact    What a DAX edit to a measure affects, including every other place
 *                    the references it REMOVES are used.
 *                      --name "<Measure>" (--new-dax "<DAX>" | --new-dax-file <path>)
 *   compare-local    Compare two versions in a local git clone (same engine as the
 *                    app's Version Compare).  [--base <ref>] [--head <ref> | --worktree]
 *
 * Common options: --pretty (indent JSON), --max <n> (cap long lists, default 200).
 * Exit codes: 0 ok · 2 bad arguments · 4 not found.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadCore } from './lib/load-core.mjs';

// The app's own engine: live source inside the app repo, else the bundled copy.
const { core, source: ENGINE_SOURCE, skipped: ENGINE_SKIPPED } = await loadCore();
const {
  identifyProjectStructure, isRelevantFile, analyze, analyzeWorkspace, traceMeasureLineage,
  analyzeImpact, findOrphansByCategory, buildDependencyStripData, classifyMeasureUsage, buildTypedDownstream,
  parseDaxExpression, compareFileMaps, groupCompareRecords, COMPARE_GROUPS,
  parseUpstreamLineage, anchorForTable, summarizeUpstream, systemLabel,
} = core;

const SKIP_DIRS = new Set(['node_modules', '.git', '.vs', '.vscode', 'bin', 'obj', 'dist', 'build', '__pycache__']);

class UsageError extends Error {}
class NotFoundError extends Error {}

// --- arguments ----------------------------------------------------------------

function parseArgs(argv) {
  const [command, folder, ...rest] = argv;
  const opts = { command, folder, max: 200, pretty: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (v === undefined) throw new UsageError(`${a} needs a value`); return v; };
    switch (a) {
      case '--name': opts.name = val(); break;
      case '--q': opts.q = val(); break;
      case '--report': opts.report = val(); break;
      case '--page': opts.page = val(); break;
      case '--new-dax': opts.newDax = val(); break;
      case '--new-dax-file': opts.newDax = readFileSync(val(), 'utf8'); break;
      case '--base': opts.base = val(); break;
      case '--head': opts.head = val(); break;
      case '--worktree': opts.worktree = true; break;
      case '--max': opts.max = Number(val()); break;
      case '--pretty': opts.pretty = true; break;
      default: throw new UsageError(`Unknown option ${a}`);
    }
  }
  if (!command || command === '--help' || command === 'help') throw new UsageError('');
  if (!folder) throw new UsageError('Give the PBIP folder after the command.');
  if (!existsSync(folder)) throw new NotFoundError(`Folder not found: ${folder}`);
  return opts;
}

// --- reading a PBIP folder (mirrors src/parser/pbipReader.js) -----------------

/** Find .Report and .SemanticModel folders, not descending into either. */
function scanFolder(root) {
  const reports = [];
  const models = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.report')) { reports.push(full); continue; }
      if (lower.endsWith('.semanticmodel') || lower.endsWith('.dataset')) { models.push(full); continue; }
      if (e.name.startsWith('.') || SKIP_DIRS.has(lower)) continue;
      walk(full, depth + 1);
    }
  };
  const base = basename(root).toLowerCase();
  if (base.endsWith('.report')) reports.push(root);
  else if (base.endsWith('.semanticmodel')) models.push(root);
  else walk(root, 0);
  return { reports, models };
}

/** Relevant files under a folder, keyed by forward-slash path relative to it. */
function readFiles(folder) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.pbi' || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        walk(full);
      } else {
        const rel = relative(folder, full).split(sep).join('/');
        if (isRelevantFile(rel)) files.set(rel, readFileSync(full, 'utf8'));
      }
    }
  };
  walk(folder);
  return files;
}

/** The semantic model folder a report's definition.pbir points at (byPath), if any. */
function modelForReport(reportDir, models) {
  try {
    const pbir = JSON.parse(readFileSync(join(reportDir, 'definition.pbir'), 'utf8').replace(/^﻿/, ''));
    const p = pbir?.datasetReference?.byPath?.path;
    if (p) {
      const target = resolve(reportDir, p);
      return models.find(m => resolve(m) === target) || (existsSync(target) ? target : null);
    }
  } catch { /* no or unreadable definition.pbir */ }
  // Fall back to a sibling model with the same base name.
  const name = basename(reportDir).replace(/\.report$/i, '');
  return models.find(m => basename(m).replace(/\.(semanticmodel|dataset)$/i, '') === name) || null;
}

/** Load a folder into the same combined graph the app builds. */
function load(root) {
  const t0 = Date.now();
  const { reports: reportDirs, models: modelDirs } = scanFolder(resolve(root));
  const warnings = [];
  if (reportDirs.length === 0 && modelDirs.length === 0) {
    throw new NotFoundError(`No .Report or .SemanticModel folders under ${root}`);
  }

  const modelStructureByKey = new Map();
  const modelKeyFor = (dir) => relative(resolve(root), dir).split(sep).join('/') || basename(dir);
  const reports = [];
  const legacy = [];
  for (const dir of reportDirs) {
    const modelDir = modelForReport(dir, modelDirs);
    const modelKey = modelDir ? modelKeyFor(modelDir) : `__unresolved__:${modelKeyFor(dir)}`;
    if (modelDir && !modelStructureByKey.has(modelKey)) {
      modelStructureByKey.set(modelKey, identifyProjectStructure(readFiles(modelDir)));
    }
    const files = readFiles(dir);
    if (files.has('report.json') && ![...files.keys()].some(k => k.startsWith('definition/pages/'))) {
      legacy.push(basename(dir));
    }
    reports.push({
      reportKey: modelKeyFor(dir),
      reportName: basename(dir).replace(/\.report$/i, ''),
      modelKey,
      reportStructure: identifyProjectStructure(files),
      dir,
    });
  }
  if (legacy.length) {
    warnings.push(`${legacy.length} report(s) use the older PBIR-Legacy format (one report.json), whose visuals this engine doesn't read, so their visuals and orphan counts are incomplete: ${legacy.join(', ')}. Convert them to PBIR (open and save in a current Power BI Desktop).`);
  }
  for (const dir of modelDirs) {
    const key = modelKeyFor(dir);
    if (!modelStructureByKey.has(key)) modelStructureByKey.set(key, identifyProjectStructure(readFiles(dir)));
  }

  let graph;
  if (reports.length === 0) {
    const [[key, structure]] = [...modelStructureByKey];
    graph = analyze({ modelStructure: structure }).graph;
    graph.workspace = { reports: [], primaryModelKey: key, multiModel: modelStructureByKey.size > 1 };
    if (modelStructureByKey.size > 1) warnings.push('Several models and no reports: only the first model was analyzed.');
  } else {
    graph = analyzeWorkspace({ reports, modelStructureByKey }).graph;
  }

  // Upstream lineage, if the folder has one.
  let upstream = null;
  const upPath = join(resolve(root), '.lineage', 'upstream.json');
  if (existsSync(upPath)) {
    const r = parseUpstreamLineage(readFileSync(upPath, 'utf8'));
    upstream = r.upstream;
    if (r.errors.length) warnings.push(`.lineage/upstream.json ignored: ${r.errors.join('; ')}`);
    else if (r.warnings.length) warnings.push(`.lineage/upstream.json: ${r.warnings.length} note(s), e.g. ${r.warnings[0]}`);
  }

  process.stderr.write(`Loaded ${reportDirs.length} report(s) and ${modelStructureByKey.size} model(s) in ${Date.now() - t0} ms\n`);
  return { root: resolve(root), graph, reports, models: [...modelStructureByKey.keys()], warnings, upstream };
}

// --- helpers --------------------------------------------------------------------

const nodesOfType = (graph, type) => [...graph.nodes.values()].filter(n => n.type === type);

function pageNameOf(graph, visualId) {
  const v = graph.nodes.get(visualId);
  if (v?.metadata?.pageName) return v.metadata.pageName;
  for (const id of (graph.adjacency.upstream.get(visualId) || [])) {
    const n = graph.nodes.get(id);
    if (n?.type === 'page') return n.metadata?.displayName || n.name;
  }
  return '';
}

function visualRow(graph, id) {
  const v = graph.nodes.get(id);
  return {
    id,
    report: v?.metadata?.reportName || '',
    page: pageNameOf(graph, id),
    visual: v?.metadata?.title || v?.name || id,
    type: v?.metadata?.visualType || '',
  };
}

/** Group visual rows as report > page > [visuals]. */
function byReportAndPage(rows) {
  const out = {};
  for (const r of rows) {
    const rep = r.report || '(this report)';
    out[rep] ??= {};
    (out[rep][r.page || '(unknown page)'] ??= []).push(r.visual + (r.type ? ` [${r.type}]` : ''));
  }
  return out;
}

function findMeasure(graph, name) {
  const m = String(name).match(/^'?(.+?)'?\[(.+)\]$/);
  const table = m ? m[1] : null;
  const measure = m ? m[2] : String(name).replace(/^\[|\]$/g, '');
  const hits = nodesOfType(graph, 'measure').filter(n =>
    n.name.toLowerCase() === measure.toLowerCase() &&
    (!table || (n.metadata?.table || '').toLowerCase() === table.toLowerCase()));
  if (hits.length === 0) {
    const close = nodesOfType(graph, 'measure').filter(n => n.name.toLowerCase().includes(measure.toLowerCase())).slice(0, 10).map(n => `${n.metadata?.table}[${n.name}]`);
    throw new NotFoundError(`No measure named "${name}".${close.length ? ` Similar: ${close.join(', ')}` : ''}`);
  }
  if (hits.length > 1) process.stderr.write(`Note: ${hits.length} measures are named "${measure}"; using ${hits[0].metadata?.table}[${hits[0].name}]. Pass Table[Measure] to choose.\n`);
  return hits[0];
}

/** Downstream BFS that never passes through `blockedId` (the measure being edited). */
function downstreamAvoiding(graph, startId, blockedId) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of (graph.adjacency.downstream.get(cur) || [])) {
      if (next === blockedId || seen.has(next) || next === startId) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function consumersOf(graph, ids) {
  const visuals = [];
  const measures = [];
  for (const id of ids) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    if (n.type === 'visual') visuals.push(visualRow(graph, id));
    if (n.type === 'measure') measures.push(`${n.metadata?.table || ''}[${n.name}]`);
  }
  const reports = [...new Set(visuals.map(v => v.report).filter(Boolean))];
  return { measures: measures.sort(), visualCount: visuals.length, reports, visuals: byReportAndPage(visuals) };
}

function cap(list, max) {
  return list.length > max ? { shown: list.slice(0, max), more: list.length - max } : list;
}

// --- commands -------------------------------------------------------------------

function cmdSummary(ctx, opts) {
  const { graph } = ctx;
  const orphans = findOrphansByCategory(graph);
  const tables = nodesOfType(graph, 'table');
  const sourceTypes = {};
  for (const t of tables) {
    const st = t.metadata?.dataSource?.sourceType;
    if (st) sourceTypes[st] = (sourceTypes[st] || 0) + 1;
  }
  return {
    folder: ctx.root,
    engine: ENGINE_SKIPPED.length ? `${ENGINE_SOURCE} (${ENGINE_SKIPPED.join('; ')})` : ENGINE_SOURCE,
    reports: ctx.reports.map(r => ({ name: r.reportName, model: r.modelKey })),
    models: ctx.models,
    counts: {
      tables: tables.length,
      measures: nodesOfType(graph, 'measure').length,
      columns: nodesOfType(graph, 'column').length,
      pages: nodesOfType(graph, 'page').length,
      visuals: nodesOfType(graph, 'visual').length,
    },
    orphans: {
      unusedButFilterOrSecurity: orphans.filterSecurity.length,
      usedOnlyByOtherMeasures: orphans.visual.length,
      completelyUnused: orphans.true.length,
      unusedColumns: orphans.columns.length,
    },
    tablesBySourceType: sourceTypes,
    upstreamLineageFile: ctx.upstream ? { generatedAt: ctx.upstream.generatedAt, nodes: ctx.upstream.nodes.size } : null,
    warnings: ctx.warnings,
  };
}

function cmdMeasure(ctx, opts) {
  if (!opts.name) throw new UsageError('measure needs --name');
  const { graph } = ctx;
  const node = findMeasure(graph, opts.name);
  const strip = buildDependencyStripData(node.id, graph);
  const lineage = traceMeasureLineage(node.id, graph);
  const usage = classifyMeasureUsage(node.id, graph, buildTypedDownstream(graph.edges));
  const impact = analyzeImpact(node.id, graph);
  const downstreamMeasures = [...impact.downstream].map(id => graph.nodes.get(id)).filter(n => n?.type === 'measure');
  const visualRows = [...impact.downstream].filter(id => graph.nodes.get(id)?.type === 'visual').map(id => visualRow(graph, id));
  const chainText = (c, depth = 0) => c ? [`${'  '.repeat(depth)}[${c.name}]${c.columns?.length ? ' uses ' + c.columns.map(col => `${col.table}[${col.name}]`).join(', ') : ''}`, ...(c.children || []).flatMap(ch => chainText(ch, depth + 1))] : [];
  return {
    measure: `${node.metadata?.table}[${node.name}]`,
    id: node.id,
    expression: node.metadata?.expression || '',
    formatString: node.metadata?.formatString || '',
    usage, // 'none' = reaches a visual; otherwise an orphan category
    upstream: {
      chain: chainText(lineage?.measureChain),
      measures: strip.upstreamMeasures.map(m => `${m.table}[${m.name}]`),
      columns: strip.upstreamColumns.map(c => `${c.table}[${c.column}]`),
      sourceColumns: (lineage?.sourceTable || []).map(r => ({ pbi: `${r.pbiTable}[${r.pbiColumn}]`, source: r.sourceTableFull || [r.sourceTablePath, r.sourceColumn].filter(Boolean).join('.') })),
    },
    downstream: {
      directDependents: strip.downstreamMeasures.map(m => `${m.table}[${m.name}]${m.kind === 'calculatedColumn' ? ' (calculated column)' : ''}`),
      allDependentMeasures: downstreamMeasures.map(m => `${m.metadata?.table}[${m.name}]`).sort(),
      visualCount: visualRows.length,
      reports: [...new Set(visualRows.map(v => v.report).filter(Boolean))],
      visuals: byReportAndPage(visualRows),
      activeFilters: strip.filters,
    },
  };
}

function cmdSearch(ctx, opts) {
  if (!opts.q) throw new UsageError('search needs --q');
  const q = opts.q.toLowerCase();
  const hits = { measures: [], columns: [], tables: [] };
  for (const n of ctx.graph.nodes.values()) {
    if (!n.name?.toLowerCase().includes(q)) continue;
    if (n.type === 'measure') hits.measures.push(`${n.metadata?.table}[${n.name}]`);
    if (n.type === 'column') hits.columns.push(`${n.metadata?.table}[${n.name}]`);
    if (n.type === 'table') hits.tables.push(n.name);
  }
  return { query: opts.q, measures: cap(hits.measures, opts.max), columns: cap(hits.columns, opts.max), tables: cap(hits.tables, opts.max) };
}

function cmdOrphans(ctx, opts) {
  const o = findOrphansByCategory(ctx.graph);
  const name = (n) => `${n.metadata?.table || n.table || ''}[${n.name}]`;
  return {
    explanation: {
      completelyUnused: 'Nothing references it and it reaches no visual, filter or RLS role. Safe to delete after a check.',
      usedOnlyByOtherMeasures: 'Other measures reference it, but none of them reach a visual. Wired in, yet nothing shows it.',
      unusedButFilterOrSecurity: 'Reaches no visual, but an active filter or RLS role uses it. Doing work; risky to delete.',
      unusedColumns: 'Columns no measure, visual, relationship, filter or role uses.',
    },
    warnings: ctx.warnings,
    completelyUnused: cap(o.true.map(name), opts.max),
    usedOnlyByOtherMeasures: cap(o.visual.map(name), opts.max),
    unusedButFilterOrSecurity: cap(o.filterSecurity.map(name), opts.max),
    unusedColumns: cap(o.columns.map(name), opts.max),
  };
}

function cmdVisuals(ctx, opts) {
  const { graph } = ctx;
  let rows = nodesOfType(graph, 'visual').map(v => {
    const r = visualRow(graph, v.id);
    const fields = (graph.adjacency.upstream.get(v.id) || []).map(id => graph.nodes.get(id)).filter(Boolean)
      .filter(n => n.type === 'measure' || n.type === 'column').map(n => `${n.metadata?.table || ''}[${n.name}]`);
    return { ...r, fields };
  });
  if (opts.report) rows = rows.filter(r => r.report.toLowerCase() === opts.report.toLowerCase());
  if (opts.page) rows = rows.filter(r => r.page.toLowerCase() === opts.page.toLowerCase());
  rows.sort((a, b) => (a.report + a.page + a.visual).localeCompare(b.report + b.page + b.visual));
  return { count: rows.length, warnings: ctx.warnings, visuals: cap(rows, opts.max) };
}

function cmdSources(ctx) {
  const rows = nodesOfType(ctx.graph, 'table').filter(t => t.metadata?.dataSource).map(t => {
    const ds = t.metadata.dataSource;
    const row = {
      table: t.name,
      type: ds.sourceType,
      server: ds.server || '',
      source: ds.fqn || [ds.database, ds.schema, ds.sourceTable].filter(Boolean).join('.'),
      objectKind: ds.objectKind || '',
      mode: ds.mode || '',
    };
    if (ds.nativeTables?.length) row.nativeQueryTables = ds.nativeTables;
    if (ctx.upstream) {
      const key = anchorForTable(ctx.upstream, t.name, ds);
      const s = key ? summarizeUpstream(ctx.upstream, key) : null;
      row.upstream = s ? {
        hops: s.depth,
        origins: s.origins.map(n => `${n.name} (${systemLabel(n.system)})`),
        bestKnown: s.bestKnown.map(n => `${n.name}${n.stopReason ? ` — ${n.stopReason}` : ''}`),
        staleOrFailed: s.stale.map(n => `${n.name}: ${n.freshness?.status}${n.freshness?.message ? ` (${n.freshness.message})` : ''}`),
        inferredLinks: s.inferredEdges,
      } : 'not in .lineage/upstream.json';
    }
    return row;
  });
  rows.sort((a, b) => a.table.localeCompare(b.table));
  const databricks = rows.filter(r => r.type === 'Databricks');
  return {
    tables: rows,
    databricksTables: [...new Set(databricks.flatMap(r => [r.source, ...(r.nativeQueryTables || [])]).filter(Boolean))].sort(),
    unresolvedDatabricks: databricks.filter(r => r.source.split('.').length < 3).map(r => r.table),
    // Tables read from Power BI dataflows (ids from the M; the dataflow script resolves names).
    dataflowTables: rows.filter(r => r.type === 'Dataflow').map(r => {
      const ds = nodesOfType(ctx.graph, 'table').find(t => t.name === r.table).metadata.dataSource;
      return { table: r.table, workspaceId: ds.server || null, dataflowId: ds.database || null, entity: ds.sourceTable || null };
    }),
  };
}

function cmdChangeImpact(ctx, opts) {
  if (!opts.name || !opts.newDax) throw new UsageError('change-impact needs --name and --new-dax or --new-dax-file');
  const { graph } = ctx;
  const node = findMeasure(graph, opts.name);
  const table = node.metadata?.table || '';
  const oldDeps = parseDaxExpression(node.metadata?.expression || '');
  const newDeps = parseDaxExpression(opts.newDax);

  // Resolve a bare [Name] to a measure, else a column on the measure's table.
  const resolveRef = (ref) => {
    const m = nodesOfType(graph, 'measure').find(n => n.name === ref.measure);
    if (m) return m;
    return graph.nodes.get(`column::${table}.${ref.measure}`) || null;
  };
  const key = (n) => n?.id;
  const refsOf = (deps) => {
    const out = new Map();
    for (const r of deps.measureRefs) { const n = resolveRef(r); if (n) out.set(key(n), n); }
    for (const c of deps.columnRefs) { const n = graph.nodes.get(`column::${c.table}.${c.column}`); if (n) out.set(key(n), n); }
    return out;
  };
  const before = refsOf(oldDeps);
  const after = refsOf(newDeps);
  const removed = [...before.values()].filter(n => !after.has(n.id));
  const added = [...after.values()].filter(n => !before.has(n.id));

  const label = (n) => `${n.metadata?.table || ''}[${n.name}]`;
  const editedImpact = consumersOf(graph, analyzeImpact(node.id, graph).downstream);

  return {
    measure: label(node),
    thisMeasure: {
      note: 'Everything downstream of the measure being edited sees the new result.',
      ...editedImpact,
    },
    removedReferences: removed.map(n => {
      const elsewhere = consumersOf(graph, downstreamAvoiding(graph, n.id, node.id));
      return {
        reference: label(n),
        kind: n.type,
        usedElsewhere: elsewhere.measures.length + elsewhere.visualCount > 0,
        ...elsewhere,
      };
    }),
    addedReferences: added.map(n => ({ reference: label(n), kind: n.type, alreadyUsedBy: consumersOf(graph, analyzeImpact(n.id, graph).downstream).visualCount + ' visual(s)' })),
    guidance: removed.some(n => downstreamAvoiding(graph, n.id, node.id).size > 0)
      ? 'A reference removed from this formula is still used elsewhere. If it was removed because it is wrong, the same problem may affect the places listed under removedReferences; fixing it at its source could resolve them all. The user decides.'
      : 'No removed reference is used anywhere else.',
  };
}

// --- compare-local: same engine as the app's Version Compare -------------------

function git(folder, args, input) {
  return execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, input });
}

function filesAtRef(repo, ref) {
  const names = git(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(p => p && isRelevantFile(p));
  if (names.length === 0) return new Map();
  // One `git cat-file --batch` for all files: far faster than one process per file.
  const out = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: names.map(n => `${ref}:${n}`).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024,
  }).stdout;
  const files = new Map();
  let pos = 0;
  for (const name of names) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString();
    const size = Number(header.split(' ')[2]);
    pos = nl + 1;
    if (header.endsWith('missing') || Number.isNaN(size)) continue;
    files.set(name, out.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return files;
}

function filesInWorktree(repo) {
  const names = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(p => p && isRelevantFile(p));
  const files = new Map();
  for (const n of names) {
    const full = join(repo, n);
    if (existsSync(full)) files.set(n, readFileSync(full, 'utf8'));
  }
  return files;
}

function cmdCompareLocal(_ctx, opts) {
  const repo = resolve(opts.folder);
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const base = opts.base || (() => {
    try { return git(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim(); } catch { return 'main'; }
  })();
  const head = opts.worktree ? null : (opts.head || 'HEAD');
  const mergeBase = git(top, ['merge-base', base, head || 'HEAD']).trim();
  const before = filesAtRef(top, mergeBase);
  const after = head ? filesAtRef(top, head) : filesInWorktree(top);
  const { records, summary } = compareFileMaps(before, after);
  const describe = (r) => {
    const where = [r.location?.report, r.location?.page, r.location?.visual, r.location?.table].filter(Boolean).join(' > ');
    const props = (r.props || []).map(p => p.label || p.name || p.key).filter(Boolean);
    const flags = Object.entries(r.flags || {}).filter(([, v]) => v).map(([k]) => k);
    return {
      change: r.change,
      name: r.name,
      ...(where ? { where } : {}),
      ...(props.length ? { changed: props } : {}),
      ...(flags.length ? { flags } : {}),
      ...(r.impact ? { impact: r.impact.summary || r.impact.severity || r.impact } : {}),
    };
  };
  const sections = {};
  for (const section of ['modified', 'additions']) {
    const groups = groupCompareRecords(records, section);
    if (groups.length) sections[section] = groups.map(g => ({ group: g.label, count: g.records.length, changes: cap(g.records.map(describe), opts.max) }));
  }
  return {
    repo: top,
    base: `${base} (compared from merge-base ${mergeBase.slice(0, 7)})`,
    head: head || 'working tree (uncommitted changes included)',
    summary,
    changes: sections,
    note: 'For the GitHub online version of this comparison (a pull request or remote branch), use integrations/github-compare or mfd_utils.pbip_compare.',
  };
}

// --- main -----------------------------------------------------------------------

const COMMANDS = {
  summary: cmdSummary, measure: cmdMeasure, search: cmdSearch, orphans: cmdOrphans,
  visuals: cmdVisuals, sources: cmdSources, 'change-impact': cmdChangeImpact, 'compare-local': cmdCompareLocal,
};

function usage() {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
  return text.replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, '');
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[opts.command];
  if (!fn) throw new UsageError(`Unknown command "${opts.command}".`);
  const ctx = opts.command === 'compare-local' ? null : load(opts.folder);
  const result = fn(ctx, opts);
  process.stdout.write(JSON.stringify(result, null, opts.pretty ? 2 : 0) + '\n');
} catch (err) {
  if (err instanceof UsageError) {
    if (err.message) process.stderr.write(`${err.message}\n\n`);
    process.stderr.write(usage());
    process.exit(2);
  }
  if (err instanceof NotFoundError) { process.stderr.write(`${err.message}\n`); process.exit(4); }
  throw err;
}
