/**
 * Upstream table details: a side panel that opens when an upstream table is
 * clicked (lineage tree node, Model Diagram chain row, Source Mapping cell).
 *
 * Shows what `.lineage/upstream.json` carries for that node: status and
 * schedule, recent runs or refreshes, the job or dataflow that builds it, its
 * SQL or Power Query (with a direct / shaped / transformed verdict and the
 * steps that change the data), what feeds it and what it feeds, columns and
 * links into Databricks or Power BI. Everything shown comes from the file; the
 * app itself never calls Databricks or Power BI.
 */

import { systemLabel, analyzeMQuery, M_SHAPE } from '@pbip-lineage/core';

let _getInfo = () => null;   // key -> upstreamNeighbors(...) result, set by upstreamLayer
let _history = [];
let _lastFocus = null;

/** Called once by upstreamLayer with a lookup for node info. */
export function initUpstreamDetails(getInfo) {
  _getInfo = getInfo;
  // Any element with data-upstream-key opens the panel (Model Diagram, Source Mapping...).
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-upstream-key]');
    if (!el || el.closest('#upstream-details')) return;
    e.preventDefault();
    openUpstreamDetails(el.dataset.upstreamKey);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeUpstreamDetails();
  });
}

function isOpen() {
  const el = document.getElementById('upstream-details');
  return !!el && !el.classList.contains('hidden');
}

function panel() {
  let el = document.getElementById('upstream-details');
  if (!el) {
    el = document.createElement('aside');
    el.id = 'upstream-details';
    el.className = 'ud-panel hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Upstream table details');
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-ud-key]');
      if (nav) { openUpstreamDetails(nav.dataset.udKey, { push: true }); return; }
      if (e.target.closest('.ud-close')) closeUpstreamDetails();
      if (e.target.closest('.ud-back')) {
        _history.pop();
        const prev = _history[_history.length - 1];
        if (prev) render(prev);
      }
      const copy = e.target.closest('.ud-copy');
      if (copy) {
        const code = copy.closest('.ud-code-wrap')?.querySelector('code')?.textContent || '';
        navigator.clipboard?.writeText(code).then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }).catch(() => {});
      }
    });
  }
  return el;
}

/**
 * Open the panel on an upstream node.
 * @param {string} key - node id or normalized key
 * @param {{ push?: boolean }} [opts] - push: keep the current node for "Back"
 */
export function openUpstreamDetails(key, opts = {}) {
  if (!key) return;
  if (!opts.push) _history = [];
  if (_history[_history.length - 1] !== key) _history.push(key);
  if (!isOpen()) _lastFocus = document.activeElement;
  render(key);
}

export function closeUpstreamDetails() {
  const el = document.getElementById('upstream-details');
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
  _history = [];
  _lastFocus?.focus?.();
}

function render(key) {
  const el = panel();
  const info = _getInfo(key);
  if (!info) {
    el.innerHTML = `${header('Upstream', key, '')}<p class="vc-muted">This table isn't in the upstream lineage file.</p>`;
  } else {
    el.innerHTML = body(info);
  }
  el.classList.remove('hidden');
  el.scrollTop = 0;
  el.querySelector('.ud-close')?.focus();
}

// --- Content -----------------------------------------------------------------------

function header(kind, title, pills) {
  const back = _history.length > 1 ? '<button type="button" class="ud-back" title="Back to the previous table">← Back</button>' : '';
  return `<div class="ud-top">${back}<span class="md-panel-kind">${esc(kind)}</span>
    <button type="button" class="ud-close" aria-label="Close details" title="Close (Esc)">×</button></div>
    <h2 class="ud-title">${esc(title)}</h2>${pills ? `<div class="ud-pills">${pills}</div>` : ''}`;
}

function body(info) {
  const { node: n, feeds, fedBy, terminal } = info;
  const d = n.details || {};
  const kind = /^dataflow/i.test(n.kind || '') ? `Power BI ${n.kind}` : `${systemLabel(n.system)} ${n.kind || 'table'}`;
  const transform = d.transform || (d.mQuery ? analyzeMQuery(d.mQuery, { name: n.name.split(' / ').pop() }) : null);

  const pills = [];
  const status = n.freshness?.status || (n.kind === 'view' ? 'view' : null);
  if (status) pills.push(`<span class="ud-pill ud-${esc(status)}">${esc(STATUS_TEXT[status] || status)}</span>`);
  if (transform) pills.push(`<span class="ud-pill ud-shape-${esc(transform.shape)}" title="${esc(transform.summary)}">${transform.shape === M_SHAPE.TRANSFORMED ? '⚑ ' : ''}${esc(SHAPE_TEXT[transform.shape] || transform.shape)}</span>`);
  if (terminal === 'origin') pills.push('<span class="ud-pill ud-origin">★ Origin</span>');
  else if (terminal === 'best_known' && !fedBy.length) pills.push('<span class="ud-pill ud-best">☆ Trail ends here</span>');

  let html = header(kind, n.name, pills.join(''));

  // Status and schedule
  const facts = [];
  if (n.lastUpdated) facts.push(row('Last updated', when(n.lastUpdated)));
  // "Built by" already explains a job you can't view; don't say it twice.
  const permissionNote = d.writer?.visible === false && /permission/i.test(n.freshness?.message || '');
  if (n.freshness?.message && !(permissionNote && status === 'ok')) facts.push(row(status === 'ok' ? 'Note' : 'Why', esc(n.freshness.message)));
  if (d.schedule) {
    const s = d.schedule;
    facts.push(row('Schedule', `${esc(s.summary)}${s.observed ? `<div class="vc-muted">Observed: ${esc(s.observed)}</div>` : ''}${s.source ? `<div class="vc-muted ud-src">Source: ${esc(s.source)}</div>` : ''}`));
    if (s.overdue && s.message) facts.push(row('Attention', `<span class="up-stale">⚠ ${esc(s.message)}</span>`));
  }
  if (n.owner) facts.push(row('Owner', esc(n.owner)));
  if (d.dataflow) {
    const f = d.dataflow;
    facts.push(row('Dataflow', `${esc(f.name || f.id)}${f.workspace ? ` <span class="vc-muted">in ${esc(f.workspace)}</span>` : ''}${f.modified ? `<div class="vc-muted">Definition last changed ${when(f.modified)}</div>` : ''}`));
  }
  if (d.writer) {
    const w = d.writer;
    const name = w.jobName ? `${esc(w.jobName)}${w.jobId ? ` <span class="vc-muted">(job ${esc(w.jobId)})</span>` : ''}` : w.jobId ? `Job ${esc(w.jobId)}` : 'A person, not a job';
    let txt = name;
    if (w.runAs) txt += `<div class="vc-muted">Runs as ${esc(w.runAs)}</div>`;
    if (w.operation) txt += `<div class="vc-muted">Writes with ${esc(w.operation)}</div>`;
    if (w.allJobs?.length > 1) txt += `<div class="vc-muted">All writers: ${w.allJobs.map(j => `${esc(j.job)} (${j.writes})`).join(', ')}</div>`;
    if (w.tasks?.length) txt += `<div class="vc-muted">Tasks: ${w.tasks.map(t => `${esc(t.key)} · ${esc(t.type)}${t.target ? ` ${esc(t.target)}` : ''}`).join('<br>')}</div>`;
    if (w.note) txt += `<div class="ud-note">${esc(w.note)}</div>`;
    facts.push(row('Built by', txt));
  }
  if (facts.length) html += `<div class="md-panel-sub">Status</div><dl class="ud-facts">${facts.join('')}</dl>`;

  // Runs
  if (d.runs?.length) {
    html += `<div class="md-panel-sub">Recent ${d.dataflow ? 'refreshes' : 'runs'}</div>`;
    html += '<div class="ud-table-wrap"><table class="ud-runs"><thead><tr><th>When</th><th>Result</th><th>What</th><th>Rows</th></tr></thead><tbody>';
    const byTime = [...d.runs].sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    for (const r of byTime.slice(0, 12)) {
      const ok = /^(succeeded|success|completed)$/i.test(r.status || '');
      const what = [r.trigger, r.operation, r.job && !d.writer?.jobName ? `job ${r.job}` : '', r.by ? `by ${r.by}` : ''].filter(Boolean).join(' · ');
      const res = `<span class="ud-run-${ok ? 'ok' : 'bad'}">${esc(r.status || '')}</span>${r.message ? `<div class="vc-muted">${esc(r.message)}</div>` : ''}`;
      const time = r.url ? `<a href="${attr(r.url)}" target="_blank" rel="noopener noreferrer">${when(r.time, true)}</a>` : when(r.time, true);
      html += `<tr><td>${time}</td><td>${res}</td><td>${esc(what)}</td><td class="ud-num">${r.rows != null ? Number(r.rows).toLocaleString() : ''}</td></tr>`;
    }
    html += '</tbody></table></div>';
    if (d.runsSource) html += `<p class="vc-muted ud-src">Source: ${esc(d.runsSource)}.</p>`;
  }

  // Power Query (dataflow) with its verdict
  if (transform) {
    html += '<div class="md-panel-sub">How the Power Query changes the data</div>';
    html += `<div class="ud-verdict ud-shape-${esc(transform.shape)}">${transform.shape === M_SHAPE.TRANSFORMED ? '⚑ ' : ''}${esc(transform.summary)}</div>`;
    html += `<p class="vc-muted ud-src">${esc(SHAPE_HELP[transform.shape] || '')}</p>`;
    if (transform.changes?.length) {
      html += '<ul class="ud-changes">';
      for (const c of transform.changes) {
        const flag = TRANSFORM_FLAGS.has(c.category);
        html += `<li class="${flag ? 'ud-flag' : ''}"><strong>${esc(c.label)}</strong>${c.detail ? `: <code>${esc(c.detail)}</code>` : ''} <span class="vc-muted">· step ${esc(c.step)}</span></li>`;
      }
      html += '</ul>';
    }
    const reads = [...(transform.sources || []).map(s => s.label), ...(transform.references || []).map(r => `query ${r}`)];
    if (reads.length) html += `<p class="ud-reads"><span class="vc-muted">Reads:</span> ${reads.map(esc).join(', ')}</p>`;
  }
  if (d.mQuery) html += code('Power Query (M)', d.mQuery, 'm');

  // SQL
  if (d.sql) html += code(d.sqlSource ? `SQL · ${d.sqlSource}` : 'SQL', d.sql, 'sql');
  else if (d.sqlNote) html += `<div class="md-panel-sub">SQL</div><p class="vc-muted">${esc(d.sqlNote)}</p>`;
  if (transform?.nativeSql && !d.sql) html += code('Custom SQL in the query', transform.nativeSql.replace(/#\((lf|cr)\)/g, '\n').replace(/#\(tab\)/g, '\t'), 'sql');

  // Lineage neighbours
  html += '<div class="md-panel-sub">Lineage</div>';
  html += neighbours('Fed by', fedBy, 'from');
  html += neighbours('Feeds', feeds, 'to');
  if (!fedBy.length && n.stopReason) html += `<p class="ud-note">☆ Trail ends here: ${esc(n.stopReason)}</p>`;
  else if (!fedBy.length && terminal === 'origin') html += '<p class="ud-note">★ A source system: nothing further upstream is expected.</p>';

  // Columns
  if (d.columns?.length) {
    html += `<details class="ud-cols"><summary class="md-panel-sub">Columns <span class="ch-topic-count">${d.columns.length}</span></summary><div class="ud-col-list">${d.columns.map(c => `<span>${esc(c)}</span>`).join('')}</div></details>`;
  }
  if (n.note) html += `<p class="ud-note">${esc(n.note)}</p>`;

  // Links
  const links = (d.links || []).filter(l => /^https:\/\//i.test(l.url || ''));
  if (links.length) {
    html += `<div class="md-panel-sub">Open</div><ul class="ud-links">${links.map(l => `<li><a href="${attr(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.url)} ↗</a></li>`).join('')}</ul>`;
    html += '<p class="vc-muted ud-src">Links need access in Databricks or Power BI.</p>';
  }
  if (!n.details) html += '<p class="vc-muted ud-src">No details were collected for this table. Re-run the upstream lineage skill (build_upstream.py) to add SQL, schedule and runs.</p>';
  return html;
}

function neighbours(label, list, dir) {
  if (!list.length) return `<div class="ud-nb"><span class="vc-muted">${esc(label)}: nothing ${dir === 'from' ? 'recorded upstream' : 'in this file'}</span></div>`;
  const items = list.filter(x => x.node).map(({ node, edge }) => {
    const inferred = edge.confidence === 'inferred' ? ' <span class="up-inferred">inferred</span>' : '';
    const stale = node.freshness?.status && node.freshness.status !== 'ok' ? ` <span class="up-stale">⚠ ${esc(node.freshness.status)}</span>` : '';
    const via = [edge.via, edge.evidence].filter(Boolean).join(' · ');
    return `<li><button type="button" class="dep-nav ud-nav" data-ud-key="${attr(node.key)}" title="Show this table's details">${esc(node.name)}</button>
      <span class="vc-muted">${esc(systemLabel(node.system))}${via ? ` · ${esc(via)}` : ''}</span>${inferred}${stale}</li>`;
  });
  return `<div class="ud-nb"><span class="vc-muted">${esc(label)}</span><ul>${items.join('')}</ul></div>`;
}

function code(title, text, lang) {
  return `<div class="ud-code-wrap"><div class="ud-code-head"><span class="md-panel-sub">${esc(title)}</span>
    <button type="button" class="ud-copy" title="Copy to clipboard">Copy</button></div>
    <pre class="ud-code"><code class="lang-${lang}">${esc(text)}</code></pre></div>`;
}

const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
const STATUS_TEXT = { ok: '✓ Up to date', stale: '⚠ Stale', failed: '✕ Last run failed', view: 'View (always current)', unknown: 'Status unknown' };
const SHAPE_TEXT = { direct: 'Direct from source', shaped: 'Shaped', transformed: 'Transformed' };
const SHAPE_HELP = {
  direct: 'Reads the source and at most sets data types: this table is the source as-is.',
  shaped: 'Keeps or drops rows and columns, or renames them, but adds no new values.',
  transformed: 'Joins, appends, adds or computes columns, groups, replaces values or adds data of its own, so its numbers can differ from the source\'s. Review these steps when a number looks wrong.',
};
const TRANSFORM_FLAGS = new Set(['join', 'append', 'newColumn', 'aggregate', 'values', 'manual', 'nativeSql', 'function']);

function when(iso, compact = false) {
  const t = new Date(iso);
  if (!iso || isNaN(t)) return esc(iso || '');
  const hours = (Date.now() - t) / 36e5;
  const ago = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min ago` : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
  const abs = t.toLocaleString(undefined, compact ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' });
  return `<time datetime="${attr(iso)}" title="${attr(t.toISOString())}">${esc(abs)}</time> <span class="vc-muted">(${ago})</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const attr = esc;
