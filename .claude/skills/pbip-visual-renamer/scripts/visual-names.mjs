#!/usr/bin/env node
/**
 * visual-names.mjs — list and rename Power BI visuals' Selection-pane names in
 * PBIR reports (definition/pages/<page>/visuals/<visual>/visual.json).
 *
 *   node visual-names.mjs list  <pbip-folder> [--report <name>] [--only-candidates] [--out list.json]
 *   node visual-names.mjs apply <plan.json> [--dry-run] [--allow-dirty] [--out rename-report]
 *
 * Where Power BI keeps the name shown in the Selection pane:
 *   - a group:        visualGroup.displayName
 *   - any other visual: its title text, visual.visualContainerObjects.title[0].properties.text.
 *     With no title text, the Selection pane shows the visual type ("Card", "Matrix"...),
 *     which is a "default" name.
 * Title text is also what the visual shows as its title when the title is switched on,
 * so `list` reports each visual's title switch (titleShow: "true" | "false" | "unset").
 *
 * `list` prints every visual with: report, page, visual folder, type, current name, why
 * it's a candidate (default name / duplicate on its page), title switch, and hints for a
 * good name (fields, text box text, button text and action, position).
 *
 * `apply` reads a plan written by the agent and approved by the user:
 *   { "folder": "<pbip-folder>", "renames": [
 *       { "file": "<visual.json path relative to folder>", "newName": "Sales by region",
 *         "reason": "default name" | "duplicate name", "keepTitleHidden": true } ] }
 * For a visual whose title switch is unset, `keepTitleHidden: true` also writes
 * show=false so the new name doesn't appear as a visible title. Visuals whose title is
 * switched on are refused unless the entry has "changeVisibleTitle": true.
 * It writes <out>.csv and <out>.md: report, page, visual, type, before, after, reason.
 * It refuses to touch files with uncommitted git changes unless --allow-dirty.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename, sep, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const TYPE_NAMES = {
  card: 'Card', cardVisual: 'Card (new)', multiRowCard: 'Multi-row card', kpi: 'KPI', textbox: 'Text box',
  shape: 'Shape', basicShape: 'Shape', image: 'Image', actionButton: 'Button', pageNavigator: 'Page navigator',
  bookmarkNavigator: 'Bookmark navigator', slicer: 'Slicer', advancedSlicerVisual: 'Slicer (new)', listSlicer: 'List slicer',
  textSlicer: 'Text slicer', tableEx: 'Table', pivotTable: 'Matrix', barChart: 'Bar chart',
  clusteredBarChart: 'Clustered bar chart', columnChart: 'Column chart', clusteredColumnChart: 'Clustered column chart',
  lineChart: 'Line chart', areaChart: 'Area chart', lineClusteredColumnComboChart: 'Line and clustered column chart',
  lineStackedColumnComboChart: 'Line and stacked column chart', pieChart: 'Pie chart', donutChart: 'Donut chart',
  gauge: 'Gauge', map: 'Map', filledMap: 'Filled map', azureMap: 'Azure map', treemap: 'Treemap',
  waterfallChart: 'Waterfall chart', funnel: 'Funnel', scatterChart: 'Scatter chart', ribbonChart: 'Ribbon chart',
  decompositionTreeVisual: 'Decomposition tree', keyDriversVisual: 'Key influencers', qnaVisual: 'Q&A',
};
const typeName = (t) => TYPE_NAMES[t] || (t ? t.replace(/_[A-F0-9_]{20,}$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : 'Visual');

const lit = (o) => o?.expr?.Literal?.Value;
const unquote = (v) => (typeof v === 'string' && /^'.*'$/s.test(v)) ? v.slice(1, -1).replace(/''/g, "'") : v;

function readJson(file) {
  const raw = readFileSync(file, 'utf8');
  return { raw, data: JSON.parse(raw.replace(/^﻿/, '')) };
}

function findReports(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name.toLowerCase().endsWith('.report')) out.push(full);
      else if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
    }
  };
  if (basename(root).toLowerCase().endsWith('.report')) out.push(root); else walk(root, 0);
  return out;
}

/** Fields a visual uses, as Table[Field] or the query's own name. */
function fieldsOf(visual) {
  const out = [];
  for (const role of Object.values(visual?.query?.queryState || {})) {
    for (const p of (role?.projections || [])) {
      const f = p.field || {};
      const node = f.Measure || f.Column || f.Aggregation?.Expression?.Column || f.HierarchyLevel?.Expression?.Hierarchy;
      const entity = node?.Expression?.SourceRef?.Entity;
      const prop = node?.Property || f.HierarchyLevel?.Level;
      out.push(p.displayName || (entity && prop ? `${entity}[${prop}]` : p.nativeQueryRef || p.queryRef || ''));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function textOf(visual) {
  const paras = visual?.objects?.general?.[0]?.properties?.paragraphs || [];
  return paras.flatMap(p => (p.textRuns || []).map(r => r.value || '')).join(' ').replace(/\s+/g, ' ').trim();
}

function buttonOf(visual, container) {
  const text = unquote(lit(visual?.objects?.text?.[0]?.properties?.text));
  const link = container?.visualLink?.[0]?.properties || {};
  const action = unquote(lit(link.type));
  const target = unquote(lit(link.navigationSection)) || unquote(lit(link.bookmark)) || unquote(lit(link.webUrl));
  return { text: text || '', action: action || '', target: target || '' };
}

function describeVisual(file, root, report, page) {
  const { data } = readJson(file);
  const v = data.visual || {};
  const vco = v.visualContainerObjects || {};
  const titleProps = vco.title?.[0]?.properties || {};
  const isGroup = !!data.visualGroup;
  const type = isGroup ? 'group' : (v.visualType || 'unknown');
  const titleText = titleProps.text;
  const literalTitle = unquote(lit(titleText));
  const conditional = !!titleText && literalTitle === undefined;
  const show = lit(titleProps.show);
  const name = isGroup ? (data.visualGroup.displayName || '') : (literalTitle || '');
  const isDefault = isGroup ? /^Group( \d+)?$/i.test(name) || !name : !name && !conditional;
  const pos = data.position || {};
  const hints = {};
  const fields = fieldsOf(v);
  if (fields.length) hints.fields = fields;
  if (type === 'textbox') hints.text = textOf(v).slice(0, 160);
  if (type === 'actionButton') hints.button = buttonOf(v, vco);
  if (data.parentGroupName) hints.inGroup = data.parentGroupName;
  if (data.isHidden) hints.hiddenOnPage = true;
  return {
    report, page: page.displayName, pageFolder: page.folder,
    file: relative(root, file).split(sep).join('/'),
    visual: data.name || basename(dirname(file)),
    type, typeName: isGroup ? 'Group' : typeName(type),
    name: name || (isGroup ? 'Group' : typeName(type)),
    nameSource: isGroup ? 'groupDisplayName' : conditional ? 'conditionalTitle' : literalTitle ? 'titleText' : 'typeDefault',
    titleShow: isGroup ? 'n/a' : show === undefined ? 'unset' : String(show),
    isDefault,
    position: { x: Math.round(pos.x || 0), y: Math.round(pos.y || 0), width: Math.round(pos.width || 0), height: Math.round(pos.height || 0) },
    hints,
  };
}

function list(root, opts) {
  const rows = [];
  const legacy = [];
  for (const repDir of findReports(root)) {
    const report = basename(repDir).replace(/\.report$/i, '');
    if (opts.report && report.toLowerCase() !== opts.report.toLowerCase()) continue;
    const pagesDir = join(repDir, 'definition', 'pages');
    if (!existsSync(pagesDir)) { if (existsSync(join(repDir, 'report.json'))) legacy.push(report); continue; }
    for (const p of readdirSync(pagesDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      let displayName = p.name;
      try { displayName = readJson(join(pagesDir, p.name, 'page.json')).data.displayName || p.name; } catch { /* keep folder name */ }
      const page = { displayName, folder: p.name };
      const visualsDir = join(pagesDir, p.name, 'visuals');
      if (!existsSync(visualsDir)) continue;
      for (const v of readdirSync(visualsDir, { withFileTypes: true })) {
        const f = join(visualsDir, v.name, 'visual.json');
        if (v.isDirectory() && existsSync(f)) rows.push(describeVisual(f, root, report, page));
      }
    }
  }
  // Duplicate names on the same page (default type names count: two "Card"s are duplicates).
  const byPage = new Map();
  for (const r of rows) {
    const k = `${r.report}\u0000${r.pageFolder}\u0000${r.name.toLowerCase()}`;
    (byPage.get(k) || byPage.set(k, []).get(k)).push(r);
  }
  for (const group of byPage.values()) {
    if (group.length > 1) for (const r of group) r.duplicateCount = group.length;
  }
  for (const r of rows) {
    r.candidate = r.isDefault ? 'default name' : r.duplicateCount ? 'duplicate name' : null;
  }
  const shown = opts.onlyCandidates ? rows.filter(r => r.candidate) : rows;
  return {
    folder: root,
    totals: {
      visuals: rows.length,
      defaultNames: rows.filter(r => r.isDefault).length,
      duplicateNames: rows.filter(r => !r.isDefault && r.duplicateCount).length,
      titleSwitchedOnAmongCandidates: rows.filter(r => r.candidate && r.titleShow === 'true').length,
      titleSwitchUnsetAmongCandidates: rows.filter(r => r.candidate && r.titleShow === 'unset').length,
    },
    legacyReportsSkipped: legacy,
    visuals: shown,
  };
}

function gitDirty(root, files) {
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch { return []; } // not a git repo: nothing to protect
}

function apply(planPath, opts) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const root = resolve(plan.folder);
  const renames = plan.renames || [];
  if (!renames.length) throw new Error('The plan has no renames.');
  const dirty = gitDirty(root, renames.map(r => r.file));
  if (dirty.length && !opts.allowDirty) {
    throw new Error(`These files have uncommitted changes; commit or stash them first (or pass --allow-dirty):\n${dirty.join('\n')}`);
  }
  const before = new Map(list(root, {}).visuals.map(v => [v.file, v]));
  const results = [];
  for (const r of renames) {
    const file = join(root, r.file);
    const info = before.get(r.file.split(sep).join('/'));
    if (!info) { results.push({ ...r, status: 'skipped: visual not found' }); continue; }
    if (!r.newName || !r.newName.trim()) { results.push({ ...r, status: 'skipped: empty name' }); continue; }
    if (info.nameSource === 'conditionalTitle') { results.push({ ...r, status: 'skipped: title is a conditional expression' }); continue; }
    if (info.titleShow === 'true' && !r.changeVisibleTitle) { results.push({ ...r, status: 'skipped: title is visible; needs changeVisibleTitle' }); continue; }

    const { raw, data } = readJson(file);
    if (info.type === 'group') {
      data.visualGroup.displayName = r.newName;
    } else {
      data.visual ??= {};
      data.visual.visualContainerObjects ??= {};
      const vco = data.visual.visualContainerObjects;
      vco.title ??= [{ properties: {} }];
      vco.title[0].properties ??= {};
      const props = vco.title[0].properties;
      props.text = { expr: { Literal: { Value: `'${r.newName.replace(/'/g, "''")}'` } } };
      if (info.titleShow === 'unset' && r.keepTitleHidden) props.show = { expr: { Literal: { Value: 'false' } } };
    }
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const text = JSON.stringify(data, null, 2).replace(/\n/g, eol) + (/\r?\n$/.test(raw) ? eol : '');
    if (!opts.dryRun) writeFileSync(file, (raw.startsWith('﻿') ? '﻿' : '') + text, 'utf8');
    results.push({
      report: info.report, page: info.page, visual: info.visual, type: info.typeName,
      before: info.name, after: r.newName, reason: r.reason || info.candidate || '',
      titleShow: info.titleShow === 'unset' && r.keepTitleHidden ? 'unset -> false' : info.titleShow,
      file: r.file, status: opts.dryRun ? 'dry run' : 'renamed',
    });
  }
  const out = opts.out || 'visual-rename-report';
  const cols = ['report', 'page', 'visual', 'type', 'before', 'after', 'reason', 'titleShow', 'status', 'file'];
  const csv = [cols.join(','), ...results.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const md = ['| Report | Page | Visual | Type | Before | After | Reason |', '|---|---|---|---|---|---|---|',
    ...results.filter(r => r.after).map(r => `| ${r.report} | ${r.page} | ${r.visual} | ${r.type} | ${r.before} | ${r.after} | ${r.reason} |`)].join('\n');
  writeFileSync(`${out}.csv`, csv, 'utf8');
  writeFileSync(`${out}.md`, md + '\n', 'utf8');
  return {
    renamed: results.filter(r => r.status === 'renamed' || r.status === 'dry run').length,
    skipped: results.filter(r => String(r.status).startsWith('skipped')),
    report: { csv: resolve(`${out}.csv`), markdown: resolve(`${out}.md`) },
    dryRun: !!opts.dryRun,
  };
}

// --- main -----------------------------------------------------------------------
const [cmd, target, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--report') opts.report = rest[++i];
  else if (a === '--out') opts.out = rest[++i];
  else if (a === '--only-candidates') opts.onlyCandidates = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--allow-dirty') opts.allowDirty = true;
  else { process.stderr.write(`Unknown option ${a}\n`); process.exit(2); }
}
if (!['list', 'apply'].includes(cmd) || !target) {
  process.stderr.write('Usage:\n  node visual-names.mjs list <pbip-folder> [--report <name>] [--only-candidates] [--out list.json]\n  node visual-names.mjs apply <plan.json> [--dry-run] [--allow-dirty] [--out rename-report]\n');
  process.exit(2);
}
try {
  const result = cmd === 'list' ? list(resolve(target), opts) : apply(target, opts);
  const json = JSON.stringify(result, null, 2);
  if (cmd === 'list' && opts.out) { writeFileSync(opts.out, json, 'utf8'); process.stdout.write(JSON.stringify(result.totals) + `\nWrote ${resolve(opts.out)}\n`); }
  else process.stdout.write(json + '\n');
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
