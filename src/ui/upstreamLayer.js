/**
 * Upstream lineage in the web app: loads `.lineage/upstream.json` from the
 * opened project folder, runs the toolbar toggle and its filter bar, and hands
 * the views (lineage tree, Source Mapping, Model Diagram) what they need.
 *
 * With the toggle off, or no file, every helper here returns null and the
 * views look exactly as they did before.
 */

import {
  parseUpstreamLineage, anchorForTable, upstreamTree, summarizeUpstream, terminalOf,
  systemsInUpstream, systemLabel, upstreamNeighbors, analyzeMQuery, UPSTREAM_FILE_PATH, TERMINAL, CONFIDENCE,
} from '@pbip-lineage/core';
import { initUpstreamDetails, closeUpstreamDetails } from './upstreamDetails.js';

const STORAGE_KEY = 'pbip-lineage.upstream';

let _upstream = null;      // parsed file, or null
let _info = null;          // { origin: 'folder'|'sample', path, warnings[] }
let _graph = null;         // current lineage graph (to look up a table's data source)
let _modelName = '';
let _enabled = readStored().enabled ?? true;
let _filters = { systems: null, maxDepth: 12, hideInferred: false };
let _onChange = () => {};

// A dataflow table's Power Query verdict: stored by the collector, or worked out here.
const _transforms = new WeakMap();
function transformOf(n) {
  if (!n?.details) return null;
  if (n.details.transform) return n.details.transform;
  if (!n.details.mQuery) return null;
  if (!_transforms.has(n)) _transforms.set(n, analyzeMQuery(n.details.mQuery, { name: n.name.split(' / ').pop() }));
  return _transforms.get(n);
}

function readStored() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function store() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: _enabled })); } catch { /* storage unavailable */ }
}

/**
 * Wire up the toolbar toggle.
 * @param {{ onChange: function }} callbacks - called after the toggle or a filter changes
 */
export function initUpstreamLayer(callbacks = {}) {
  _onChange = callbacks.onChange || (() => {});
  // Clicking an upstream table (tree node, diagram row, mapping cell) opens its details.
  initUpstreamDetails((key) => (isUpstreamOn() ? upstreamNeighbors(_upstream, key) : null));
  window.addEventListener('resize', () => {
    const bar = document.getElementById('upstream-bar');
    if (bar && !bar.classList.contains('hidden')) {
      document.documentElement.style.setProperty('--upstream-bar-h', `${bar.offsetHeight}px`);
    }
  });
  const btn = document.getElementById('btn-upstream');
  if (btn) btn.addEventListener('click', () => {
    if (!_upstream) return;
    _enabled = !_enabled;
    store();
    if (!_enabled) closeUpstreamDetails();
    refreshChrome();
    _onChange();
  });
}

/**
 * Read `.lineage/upstream.json` from a project folder, if it has one.
 * @param {FileSystemDirectoryHandle|null} rootHandle
 * @returns {Promise<string|null>} file text, or null when there's no file
 */
export async function readUpstreamFile(rootHandle) {
  if (!rootHandle?.getDirectoryHandle) return null;
  try {
    const dir = await rootHandle.getDirectoryHandle('.lineage');
    const file = await (await dir.getFileHandle('upstream.json')).getFile();
    return await file.text();
  } catch {
    return null; // no .lineage folder or file: the feature simply stays off
  }
}

/**
 * Set (or clear) the upstream lineage for the loaded project.
 * @param {string|null} text - file contents
 * @param {{ graph: object, modelName?: string, origin?: string }} ctx
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function setUpstreamLineage(text, ctx = {}) {
  _graph = ctx.graph || _graph;
  _modelName = ctx.modelName || '';
  _filters = { systems: null, maxDepth: 12, hideInferred: false };
  closeUpstreamDetails();
  if (!text) {
    _upstream = null;
    _info = null;
    refreshChrome();
    return { ok: false, errors: [], warnings: [] };
  }
  const { upstream, errors, warnings } = parseUpstreamLineage(text);
  _upstream = upstream;
  _info = upstream ? { origin: ctx.origin || 'folder', path: UPSTREAM_FILE_PATH, warnings } : null;
  if (errors.length) console.warn(`Ignored ${UPSTREAM_FILE_PATH}:`, errors);
  if (warnings.length) console.info(`${UPSTREAM_FILE_PATH} warnings:`, warnings);
  refreshChrome(errors);
  return { ok: !!upstream, errors, warnings };
}

/** Keep the graph current (workspace and single-report loads both call this). */
export function setUpstreamGraph(graph, modelName = '') {
  _graph = graph;
  if (modelName) _modelName = modelName;
}

/** True when upstream lineage should be drawn. */
export function isUpstreamOn() {
  return !!(_upstream && _enabled);
}

function dataSourceFor(tableName) {
  return _graph?.nodes?.get(`table::${tableName}`)?.metadata?.dataSource || null;
}

function filterOpts() {
  return { maxDepth: _filters.maxDepth, hideInferred: _filters.hideInferred, systems: _filters.systems };
}

/** The upstream tree for a model table, or null. */
export function upstreamForTable(tableName) {
  if (!isUpstreamOn()) return null;
  const key = anchorForTable(_upstream, tableName, dataSourceFor(tableName), _modelName);
  if (!key) return null;
  return upstreamTree(_upstream, key, filterOpts());
}

/** Key of the upstream node a model table starts from (for its details panel), or null. */
export function upstreamKeyForTable(tableName) {
  if (!isUpstreamOn()) return null;
  return anchorForTable(_upstream, tableName, dataSourceFor(tableName), _modelName) || null;
}

/** One-line upstream facts for a model table, or null. */
export function upstreamSummaryForTable(tableName) {
  if (!isUpstreamOn()) return null;
  const key = anchorForTable(_upstream, tableName, dataSourceFor(tableName), _modelName);
  if (!key) return null;
  return summarizeUpstream(_upstream, key, filterOpts());
}

/**
 * Lineage-tree child nodes continuing a table's lineage upstream. The anchor
 * itself is usually the source connection already drawn, so the tree starts at
 * what feeds it; when the anchor differs from the drawn source, it's included.
 * @param {string} tableName
 * @param {string} [drawnSourceName] - the source table name the tree already shows
 * @returns {object[]} children for lineageTree.js (empty when nothing to add)
 */
export function upstreamTreeChildren(tableName, drawnSourceName = '') {
  const tree = upstreamForTable(tableName);
  if (!tree) return [];
  const anchorIsDrawn = drawnSourceName &&
    tree.node.name.toLowerCase().split('.').pop() === String(drawnSourceName).toLowerCase().split('.').pop();
  if (anchorIsDrawn) return tree.children.map(toTreeNode);
  return [toTreeNode({ ...tree, edge: null })];
}

function toTreeNode(t) {
  const n = t.node;
  const isLeaf = t.children.length === 0;
  const term = isLeaf && !t.truncated ? terminalOf(_upstream, n) : (n.terminal || null);
  const type = term === TERMINAL.ORIGIN ? 'origin' : term === TERMINAL.BEST_KNOWN && isLeaf ? 'bestKnown' : 'upstream';
  const parts = n.name.split('.');
  const shortName = shortTail(n.name);
  const mark = type === 'origin' ? '★ ' : type === 'bestKnown' ? '☆ ' : '';
  const kindLabel = /^dataflow/i.test(n.kind || '') ? `Power BI ${n.kind}` : `${systemLabel(n.system)} ${n.kind || 'table'}`;
  const fresh = n.freshness?.status && n.freshness.status !== 'ok' ? ` · ⚠ ${n.freshness.status}` : '';
  const label = type === 'origin' ? `Origin · ${systemLabel(n.system)}`
    : type === 'bestKnown' ? `Best known · ${systemLabel(n.system)}`
    : kindLabel;

  const detail = [
    n.name,
    `${kindLabel}${shortName !== n.name ? ` in ${parts[0]}` : ''}`,
    t.edge?.via && `Built by: ${t.edge.via}`,
    t.edge && `Link: ${t.edge.confidence === CONFIDENCE.INFERRED ? 'inferred by the agent' : 'recorded'}${t.edge.evidence ? ` (${t.edge.evidence})` : ''}`,
    n.lastUpdated && `Last updated: ${n.lastUpdated}`,
    n.freshness?.status && `Freshness: ${n.freshness.status}${n.freshness.lastRun ? ` · last run ${n.freshness.lastRun}` : ''}${n.freshness.job ? ` · ${n.freshness.job}` : ''}${n.freshness.message ? ` · ${n.freshness.message}` : ''}`,
    type === 'bestKnown' && `Trail ends here: ${n.stopReason || 'no further lineage found'}`,
    t.truncated && 'More upstream: raise the depth filter to see it',
    n.note,
    transformOf(n)?.shape === 'transformed' && `⚑ ${transformOf(n).summary}`,
    'Click ⓘ for its SQL or Power Query, schedule and recent runs',
  ].filter(Boolean).join('\n');

  return {
    name: mark + shortName,
    layer: 7,
    layerLabel: label + fresh,
    type,
    inferred: t.edge?.confidence === CONFIDENCE.INFERRED,
    stale: !!fresh,
    // Opens the details panel (lineageTree draws an ⓘ button for it).
    upstreamKey: n.key,
    transformed: transformOf(n)?.shape === 'transformed',
    detail,
    children: t.children.map(toTreeNode),
  };
}

/** Text for a Model Diagram box row and its tooltip, or null. */
export function upstreamBadgeForTable(tableName) {
  const s = upstreamSummaryForTable(tableName);
  if (!s) return null;
  const ends = [
    ...s.origins.map(n => `★ ${n.name} (${systemLabel(n.system)})`),
    ...s.bestKnown.map(n => `☆ ${n.name}${n.stopReason ? ` — ${n.stopReason}` : ''}`),
  ];
  const lead = s.origins[0] ? `★ ${systemLabel(s.origins[0].system)}` : s.bestKnown[0] ? `☆ ${shortTail(s.bestKnown[0].name)}` : 'Upstream';
  return {
    text: `${lead} · ${s.depth} hop${s.depth !== 1 ? 's' : ''}${s.stale.length ? ' · ⚠ stale' : ''}`,
    title: [`Upstream: ${s.depth} hop${s.depth !== 1 ? 's' : ''} through ${s.systems.join(', ')}`, ...ends,
      s.stale.length ? `Stale or failed: ${s.stale.map(n => n.name).join(', ')}` : '',
      s.inferredEdges ? `${s.inferredEdges} inferred link${s.inferredEdges !== 1 ? 's' : ''}` : ''].filter(Boolean).join('\n'),
    stale: s.stale.length > 0,
  };
}

/**
 * Upstream columns for the Source Mapping table, or null when off.
 * @returns {null|{ upstreamTable: string, originSystem: string, depth: string, trailEnd: string }}
 */
export function upstreamColumnsForTable(tableName) {
  if (!isUpstreamOn()) return null;
  const s = upstreamSummaryForTable(tableName);
  if (!s) return { upstreamTable: '', originSystem: '', depth: '', trailEnd: '' };
  return {
    upstreamTable: s.firstHop,
    // Keys for the details panel: the first table upstream, and the table's own source.
    firstHopKey: upstreamForTable(tableName)?.children[0]?.node.key || '',
    originSystem: [...new Set(s.origins.map(n => systemLabel(n.system)))].join(', '),
    depth: String(s.depth),
    trailEnd: [
      ...s.origins.map(n => `★ ${n.name}`),
      ...s.bestKnown.map(n => `☆ ${n.name}${n.stopReason ? ` (${n.stopReason})` : ''}`),
    ].join('; '),
  };
}

/** Plain-text chain for the Model Diagram panel, or null. */
export function upstreamPanelHtml(tableName, esc) {
  const tree = upstreamForTable(tableName);
  if (!tree) return '';
  const lines = [];
  const walk = (t, depth) => {
    const term = t.children.length === 0 && !t.truncated ? terminalOf(_upstream, t.node) : null;
    const mark = term === TERMINAL.ORIGIN ? '<span class="up-mark up-origin">★</span> ' : term === TERMINAL.BEST_KNOWN ? '<span class="up-mark up-best">☆</span> ' : '';
    const inferred = t.edge?.confidence === CONFIDENCE.INFERRED ? ' <span class="up-inferred">inferred</span>' : '';
    const stale = t.node.freshness?.status && t.node.freshness.status !== 'ok' ? ` <span class="up-stale">⚠ ${esc(t.node.freshness.status)}</span>` : '';
    const reason = term === TERMINAL.BEST_KNOWN ? ` <span class="vc-muted">— ${esc(t.node.stopReason || 'no further lineage found')}</span>` : '';
    const tf = transformOf(t.node);
    const flag = tf?.shape === 'transformed' ? ` <span class="up-stale" title="${esc(tf.summary)}">⚑ transformed</span>` : '';
    lines.push(`<li style="padding-left:${depth * 14}px">${mark}<button type="button" class="dep-nav up-chain-nav" data-upstream-key="${esc(t.node.key)}" title="Show SQL, schedule and recent runs">${esc(t.node.name)}</button>${flag} <span class="vc-muted">${esc(systemLabel(t.node.system))}${t.edge?.via ? ` · ${esc(t.edge.via)}` : ''}</span>${inferred}${stale}${reason}</li>`);
    t.children.forEach(c => walk(c, depth + 1));
  };
  walk(tree, 0);
  return `<div class="md-panel-sub">Upstream lineage</div><ul class="md-changes up-chain">${lines.join('')}</ul>`;
}

// --- Toolbar button and filter bar ---------------------------------------------

function refreshChrome(errors = []) {
  const btn = document.getElementById('btn-upstream');
  if (btn) {
    btn.disabled = !_upstream;
    btn.classList.toggle('active', isUpstreamOn());
    btn.setAttribute('aria-pressed', String(isUpstreamOn()));
    btn.title = _upstream
      ? `Upstream lineage is ${_enabled ? 'on' : 'off'} — click to ${_enabled ? 'hide' : 'show'} where each source table's data comes from (${UPSTREAM_FILE_PATH}).`
      : errors.length
        ? `Upstream lineage: ${UPSTREAM_FILE_PATH} couldn't be read — ${errors[0]}`
        : `Upstream lineage: no ${UPSTREAM_FILE_PATH} in this project folder. Ask the AI agent to run the upstream-lineage skill to create one.`;
  }
  renderBar();
}

function renderBar() {
  const bar = document.getElementById('upstream-bar');
  if (!bar) return;
  if (!isUpstreamOn()) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    document.body.classList.remove('upstream-bar-on');
    return;
  }
  bar.classList.remove('hidden');
  document.body.classList.add('upstream-bar-on');

  const systems = systemsInUpstream(_upstream);
  const active = _filters.systems || new Set(systems);
  const generated = _upstream.generatedAt ? new Date(_upstream.generatedAt) : null;
  const when = generated && !isNaN(generated) ? generated.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown date';
  const tables = countAnchoredTables();
  const ends = countEnds();

  let html = '<span class="upstream-bar-title">Upstream lineage</span>';
  html += `<span class="upstream-bar-meta" title="${esc(_info?.path || '')}${_upstream.generatedBy ? ` · by ${esc(_upstream.generatedBy)}` : ''}${_upstream.pbipCommit ? ` · describes commit ${esc(_upstream.pbipCommit)}` : ''}">${_info?.origin === 'sample' ? 'Sample file' : 'From'} ${esc(when)} · ${tables} table${tables !== 1 ? 's' : ''} traced · <span class="up-mark up-origin">★</span> ${ends.origin} · <span class="up-mark up-best">☆</span> ${ends.best}</span>`;
  html += '<span class="upstream-bar-group" role="group" aria-label="Systems">';
  for (const s of systems) {
    html += `<button type="button" class="upstream-chip${active.has(s) ? ' on' : ''}" data-system="${esc(s)}" aria-pressed="${active.has(s)}">${esc(systemLabel(s))}</button>`;
  }
  html += '</span>';
  html += `<label class="upstream-bar-ctl">Depth <select id="upstream-depth"><option value="12"${_filters.maxDepth > 1 ? ' selected' : ''}>All hops</option><option value="1"${_filters.maxDepth === 1 ? ' selected' : ''}>1 hop</option></select></label>`;
  html += `<label class="upstream-bar-ctl"><input type="checkbox" id="upstream-hide-inferred"${_filters.hideInferred ? ' checked' : ''}> Hide inferred links</label>`;
  html += '<span class="upstream-bar-legend"><i class="up-line"></i>recorded <i class="up-line up-line-dash"></i>inferred</span>';
  if (_info?.warnings?.length) html += `<span class="upstream-bar-warn" title="${esc(_info.warnings.join('\n'))}">⚠ ${_info.warnings.length} note${_info.warnings.length !== 1 ? 's' : ''} about the file</span>`;
  bar.innerHTML = html;
  // The bar can wrap onto two lines on narrow screens; move the layout down by its real height.
  document.documentElement.style.setProperty('--upstream-bar-h', `${bar.offsetHeight}px`);

  bar.querySelectorAll('.upstream-chip').forEach(chip => chip.addEventListener('click', () => {
    const next = new Set(_filters.systems || systems);
    const s = chip.dataset.system;
    if (next.has(s)) next.delete(s); else next.add(s);
    _filters.systems = next.size === systems.length ? null : next;
    renderBar();
    _onChange();
  }));
  bar.querySelector('#upstream-depth')?.addEventListener('change', (e) => {
    _filters.maxDepth = Number(e.target.value);
    _onChange();
  });
  bar.querySelector('#upstream-hide-inferred')?.addEventListener('change', (e) => {
    _filters.hideInferred = e.target.checked;
    _onChange();
  });
}

function countAnchoredTables() {
  if (!_graph) return 0;
  let n = 0;
  for (const node of _graph.nodes.values()) {
    if (node.type !== 'table') continue;
    if (anchorForTable(_upstream, node.name, node.metadata?.dataSource, _modelName)) n++;
  }
  return n;
}

function countEnds() {
  let origin = 0;
  let best = 0;
  for (const node of _upstream.nodes.values()) {
    const term = terminalOf(_upstream, node);
    if (term === TERMINAL.ORIGIN) origin++;
    else if (term === TERMINAL.BEST_KNOWN) best++;
  }
  return { origin, best };
}

/** "catalog.schema.table" -> "schema.table" for compact labels; other names as they are. */
function shortTail(name) {
  const parts = String(name || '').split('.');
  return parts.length === 3 && !/[/:]/.test(name) ? parts.slice(-2).join('.') : String(name || '');
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
