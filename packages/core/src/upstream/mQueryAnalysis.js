/**
 * Power Query (M) analysis for upstream lineage: what a query reads, and
 * whether it passes the source through or reshapes it.
 *
 * Used for Power BI dataflows (whose queries create the tables a model reads)
 * and for any other M the upstream file carries. Three verdicts:
 *
 *   direct       reads a source and at most sets data types, promotes headers,
 *                reorders or sorts: the table is the source as-is.
 *   shaped       also keeps or drops rows and columns, renames, expands, or
 *                removes duplicates: no new values, but not every source row
 *                or column arrives.
 *   transformed  joins or appends tables, adds or computes columns, groups,
 *                pivots, replaces values, runs custom SQL that joins or
 *                computes, calls a custom function, or builds data in the
 *                query itself. Numbers here can differ from the source's, so
 *                these queries are flagged for review.
 *
 * Regex-free where it matters: a small scanner skips strings, quoted
 * identifiers (#"..."), and comments, and tracks brackets and let/in nesting,
 * so steps split correctly even with `each let ... in ...` inside them.
 */

import { extractDatabricksSource, tablesInSql } from '../parser/databricksSource.js';
import { extractDataflowSource } from '../parser/dataflowSource.js';

export const M_SHAPE = { DIRECT: 'direct', SHAPED: 'shaped', TRANSFORMED: 'transformed' };

// Outermost function of a step -> category. Anything not listed falls back by prefix.
const FN_CATEGORY = {
  // reading and type-only steps
  'Table.TransformColumnTypes': 'types', 'Table.PromoteHeaders': 'types', 'Table.DemoteHeaders': 'types',
  'Table.Buffer': 'types', 'Table.ReorderColumns': 'types', 'Table.Sort': 'types',
  'Table.TransformColumnNames': 'rename',
  // shaping: fewer rows/columns or new names, no new values
  'Table.SelectColumns': 'columns', 'Table.RemoveColumns': 'columns',
  'Table.RenameColumns': 'rename',
  'Table.SelectRows': 'filter', 'Table.RemoveRowsWithErrors': 'filter', 'Table.RemoveMatchingRows': 'filter',
  'Table.FirstN': 'filter', 'Table.LastN': 'filter', 'Table.Range': 'filter', 'Table.Skip': 'filter',
  'Table.RemoveFirstN': 'filter', 'Table.RemoveLastN': 'filter', 'Table.RemoveRows': 'filter',
  'Table.Distinct': 'dedupe',
  'Table.ExpandTableColumn': 'expand', 'Table.ExpandRecordColumn': 'expand', 'Table.ExpandListColumn': 'expand',
  // transforms
  'Table.NestedJoin': 'join', 'Table.Join': 'join', 'Table.FuzzyNestedJoin': 'join', 'Table.FuzzyJoin': 'join',
  'Table.AddJoinColumn': 'join',
  'Table.Combine': 'append',
  'Table.AddColumn': 'newColumn', 'Table.AddIndexColumn': 'newColumn', 'Table.DuplicateColumn': 'newColumn',
  'Table.CombineColumns': 'newColumn', 'Table.SplitColumn': 'newColumn', 'Table.AddRankColumn': 'newColumn',
  'Table.AddFuzzyClusterColumn': 'newColumn', 'Table.CombineColumnsToRecord': 'newColumn',
  'Table.Group': 'aggregate', 'Table.Pivot': 'aggregate', 'Table.Unpivot': 'aggregate',
  'Table.UnpivotOtherColumns': 'aggregate', 'Table.Transpose': 'aggregate', 'Table.AggregateTableColumn': 'aggregate',
  'Table.ReplaceValue': 'values', 'Table.ReplaceErrorValues': 'values', 'Table.TransformColumns': 'values',
  'Table.FillDown': 'values', 'Table.FillUp': 'values', 'Table.ReplaceRows': 'values', 'Table.TransformRows': 'values',
  'Table.InsertRows': 'manual',
  '#table': 'manual', 'Table.FromRows': 'manual', 'Table.FromRecords': 'manual', 'Table.FromList': 'manual',
  'Table.FromColumns': 'manual', 'Table.FromValue': 'manual',
  'Value.NativeQuery': 'nativeSql',
};

const SOURCE_FNS = /^(Sql\.Databases?|Databricks(MultiCloud)?\.\w+|PowerPlatform\.Dataflows|PowerBI\.Dataflows|Lakehouse\.Contents|Fabric\.\w+|SharePoint\.\w+|Excel\.(Workbook|CurrentWorkbook)|Csv\.Document|Web\.(Contents|Page)|File\.Contents|Folder\.(Files|Contents)|Json\.Document|Xml\.(Tables|Document)|OData\.Feed|Odbc\.\w+|OleDb\.\w+|Oracle\.Database|AzureStorage\.\w+|AnalysisServices\.\w+|Snowflake\.\w+|GoogleBigQuery\.\w+|PostgreSQL\.Database|MySQL\.Database|Access\.Database|Binary\.\w+)$/;
const OUTPUT_FNS = /^(Pipeline|TableAction|ValueAction|NavigationTable)\./;

const SHAPED_CATS = new Set(['columns', 'rename', 'filter', 'dedupe', 'expand', 'other', 'nativeSqlSimple']);
const TRANSFORM_CATS = new Set(['join', 'append', 'newColumn', 'aggregate', 'values', 'manual', 'nativeSql', 'function']);

export const M_CHANGE_LABELS = {
  join: 'Joins tables', append: 'Appends tables', newColumn: 'Adds columns', aggregate: 'Groups or pivots rows',
  values: 'Changes values', manual: 'Data typed or generated in the query', nativeSql: 'Custom SQL',
  nativeSqlSimple: 'Reads with custom SQL',
  function: 'Calls a custom function', columns: 'Keeps or removes columns', rename: 'Renames columns',
  filter: 'Filters rows', dedupe: 'Removes duplicates', expand: 'Expands nested columns', other: 'Other step',
};

// --- Scanner -------------------------------------------------------------------

/**
 * Walk M text, calling visit(i, ch, state) for each character outside strings,
 * quoted identifiers and comments. state = { depth, letDepth }.
 * Returns early when visit returns true.
 */
function scan(text, visit) {
  let depth = 0;
  let letDepth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || (ch === '#' && text[i + 1] === '"')) {
      i += ch === '#' ? 2 : 1;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[\w.#]/.test(text[i - 1]))) {
      let j = i;
      while (j < n && /[\w.]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (word === 'let') letDepth++;
      if (visit(i, word, { depth, letDepth, isWord: true })) return;
      if (word === 'in') letDepth = Math.max(0, letDepth - 1);
      i = j;
      continue;
    }
    // A closing bracket is reported at the depth of what it closes (then
    // leaves it), so a call's own ")" is seen at depth 0 from inside it.
    if ('([{'.includes(ch)) depth++;
    if (visit(i, ch, { depth, letDepth, isWord: false })) return;
    if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    i++;
  }
}

/** Split at a separator that sits outside brackets and nested let/in. */
function splitTop(text, sep, baseLet = 0) {
  const parts = [];
  let start = 0;
  scan(text, (i, tok, s) => {
    if (!s.isWord && tok === sep && s.depth === 0 && s.letDepth === baseLet) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

function unquote(name) {
  const t = String(name || '').trim();
  return t.startsWith('#"') ? t.slice(2, -1).replace(/""/g, '"') : t;
}

function stripComments(text) {
  let out = '';
  let last = 0;
  // Remove comments while keeping strings intact.
  const re = /"(?:[^"]|"")*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0][0] === '"') continue;
    out += text.slice(last, m.index) + ' ';
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

// --- Documents -----------------------------------------------------------------

/**
 * Split a Power Query section document (a dataflow's `pbi:mashup.document`,
 * or a .pq file) into its shared queries.
 * @param {string} doc
 * @returns {{ name: string, expression: string }[]}
 */
export function parseMashupDocument(doc) {
  if (!doc) return [];
  const body = String(doc).replace(/^﻿/, '').replace(/^\s*section\s+[^;]+;/i, '');
  const out = [];
  for (const stmt of splitTop(body, ';')) {
    const m = stmt.match(/^(?:\[[\s\S]*?\]\s*)?shared\s+(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*=\s*([\s\S]*)$/);
    if (m) out.push({ name: unquote(m[1]), expression: m[2].trim() });
  }
  return out;
}

/** The `let` steps of an expression: [{ name, expr }], plus the `in` result. */
export function letSteps(expression) {
  const text = String(expression || '').trim();
  if (!/^let\b/.test(text)) return { steps: [], result: text };
  let inAt = -1;
  scan(text, (i, tok, s) => {
    if (s.isWord && tok === 'in' && s.letDepth === 1 && s.depth === 0) { inAt = i; return true; }
    return false;
  });
  if (inAt < 0) return { steps: [], result: text };
  const body = text.slice(3, inAt);
  const steps = [];
  for (const part of splitTop(body, ',', 0)) {
    const m = part.match(/^(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*=\s*([\s\S]*)$/);
    if (m) steps.push({ name: unquote(m[1]), expr: m[2].trim() });
  }
  return { steps, result: text.slice(inAt + 2).trim() };
}

// --- Analysis ------------------------------------------------------------------

function outerFunction(expr) {
  const t = expr.trim().replace(/^each\s+/, '');
  const m = t.match(/^(#table|[A-Z][\w]*(?:\.[A-Z][\w]*)+|#"(?:[^"]|"")*"|[A-Za-z_]\w*)\s*\(/);
  if (!m) return null;
  return m[1].startsWith('#"') ? unquote(m[1]) : m[1];
}

/** Top-level arguments of the first call in expr. */
function callArgs(expr) {
  const open = expr.indexOf('(');
  if (open < 0) return [];
  let close = -1;
  const inner = expr.slice(open + 1);
  scan(inner, (i, tok, s) => {
    if (!s.isWord && tok === ')' && s.depth === 0) { close = i; return true; }
    return false;
  });
  return splitTop(close < 0 ? inner : inner.slice(0, close), ',');
}

const str = (a) => { const m = String(a || '').trim().match(/^"((?:[^"]|"")*)"$/); return m ? m[1].replace(/""/g, '"') : null; };
const names = (a) => [...String(a || '').matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replace(/""/g, '"'));
const short = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const SQL_COMPLEX = /\b(JOIN|UNION|GROUP\s+BY|CASE\s+WHEN|OVER\s*\(|PIVOT|SUM\s*\(|COUNT\s*\(|AVG\s*\(|MIN\s*\(|MAX\s*\(|COALESCE\s*\(|ISNULL\s*\()/i;

function nativeSqlIn(expr) {
  // The first argument is often a whole connector call with commas of its own,
  // so read the arguments with the scanner rather than a regex.
  const at = expr.search(/Value\.NativeQuery\s*\(/i);
  if (at >= 0) {
    const sql = str(callArgs(expr.slice(at))[1]);
    if (sql != null) return sql;
  }
  const opt = expr.match(/\bQuery\s*=\s*"((?:[^"]|"")*)"/i);
  if (opt) return opt[1].replace(/""/g, '"');
  return null;
}

function typeOnlyTransform(args) {
  // Table.TransformColumns(t, {{"Col", type text}}) or {{"Col", Number.From, type number}}:
  // nothing left once column names, types and X.From conversions are removed.
  const rest = String(args[1] || '')
    .replace(/"(?:[^"]|"")*"/g, '')
    .replace(/\btype\s+(?:nullable\s+)?\w+/g, '')
    .replace(/\b\w+\.From\b/g, '')
    .replace(/[{},\s]/g, '');
  return rest === '';
}

/**
 * What one M query reads and how it changes the data.
 * @param {string} expression - the query's M (a `let ... in ...` expression)
 * @param {{ queryNames?: string[], name?: string }} [opts] - names of the queries in the
 *   same document, so references and custom-function calls are recognised, and this
 *   query's own name (never counted as a reference)
 * @returns {{
 *   shape: 'direct'|'shaped'|'transformed', summary: string,
 *   steps: { name: string, fn: string|null, category: string }[],
 *   changes: { category: string, label: string, step: string, detail: string }[],
 *   sources: { type: string, label: string, id: string|null }[],
 *   references: string[], nativeSql: string|null, flags: string[]
 * }}
 */
export function analyzeMQuery(expression, opts = {}) {
  const text = stripComments(String(expression || ''));
  const queryNames = new Set((opts.queryNames || []).filter(n => n && n !== opts.name));
  const { steps: rawSteps, result } = letSteps(text);
  const stepNames = new Set(rawSteps.map(s => s.name));
  const list = rawSteps.length ? rawSteps : [{ name: '(expression)', expr: result }];

  const steps = [];
  const changes = [];
  for (const s of list) {
    const fn = outerFunction(s.expr);
    let category;
    if (!fn) category = /^(#(date|datetime|datetimezone|duration|time|binary)\s*\(|[-\d"]|\{\s*["\d#])/.test(s.expr.trim()) ? 'value' : 'source';
    else if (FN_CATEGORY[fn]) category = FN_CATEGORY[fn];
    else if (SOURCE_FNS.test(fn)) category = 'source';
    else if (OUTPUT_FNS.test(fn)) category = 'output';
    else if (queryNames.has(fn)) category = 'function';
    else if (/^Table\./.test(fn)) category = 'other';
    else if (/^(Date|DateTime|Number|Text|List|Record|Duration|Time)\./.test(fn)) category = 'value';
    else category = 'source';

    const args = fn ? callArgs(s.expr.replace(/^each\s+/, '')) : [];
    // Refine: a type-only TransformColumns is a type step; the Excel/SharePoint
    // "enter data" pattern and #table literals are manual data.
    if (fn === 'Table.TransformColumns' && typeOnlyTransform(args)) category = 'types';
    if (category === 'manual' && fn === 'Table.FromValue') category = 'source';
    if (category === 'source' && /Sql\.Database|Databricks\.Query/.test(fn || '') && nativeSqlIn(s.expr)) category = 'nativeSql';
    // Table.FromRecords(Source[value]) converts what a source returned; only a
    // literal list, Enter-data text or a generated list is data made in the query.
    if (category === 'manual' && fn !== '#table' && fn !== 'Table.InsertRows') {
      const first = String(args[0] || '').trim();
      const madeHere = first.startsWith('{') || /Binary\.(Decompress|FromText)/.test(first) || /List\.(Dates|Numbers|Generate|DateTimes|Times)/.test(first);
      if (!madeHere) category = 'source';
    }

    steps.push({ name: s.name, fn: fn || null, category });

    let detail = '';
    if (category === 'join') {
      const right = String(args[2] || '').trim();
      const kind = (s.expr.match(/JoinKind\.(\w+)/) || [])[1];
      detail = `with ${unquote(right) || 'another table'}${kind ? ` (${kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} join)` : ''}`;
    } else if (category === 'append') {
      detail = `${(args[0] || '').replace(/[{}]/g, '').split(',').map(x => unquote(x)).filter(Boolean).join(', ')}`;
    } else if (category === 'newColumn') {
      if (fn === 'Table.AddColumn') detail = `"${str(args[1]) ?? args[1]}" = ${short(args[2], 120)}`;
      else if (fn === 'Table.DuplicateColumn') detail = `"${str(args[2]) ?? ''}" copied from "${str(args[1]) ?? ''}"`;
      else if (fn === 'Table.AddIndexColumn') detail = `"${str(args[1]) ?? 'Index'}" (row number)`;
      else detail = short(names(args[1]).join(', ') || args[1], 100);
    } else if (category === 'aggregate') {
      detail = fn === 'Table.Group' ? `by ${names(args[1]).join(', ') || short(args[1], 60)}` : fn.replace('Table.', '');
    } else if (category === 'values') {
      detail = fn === 'Table.ReplaceValue' ? `${short(args[1], 40)} → ${short(args[2], 40)} in ${names(args[4]).join(', ')}`
        : fn === 'Table.ReplaceErrorValues' ? `errors replaced in ${names(args[1]).slice(0, 6).join(', ')}`
        : `${fn.replace('Table.', '')} ${names(args[1]).slice(0, 6).join(', ')}`;
    } else if (category === 'nativeSql') {
      const sql = nativeSqlIn(s.expr) || '';
      detail = SQL_COMPLEX.test(sql) ? `joins, aggregates or computes in SQL: ${short(sql, 160)}` : `reads with SQL: ${short(sql, 160)}`;
      if (!SQL_COMPLEX.test(sql)) category = 'nativeSqlSimple';
      steps[steps.length - 1].category = category;
    } else if (category === 'manual') {
      detail = /Binary\.Decompress|Json\.Document/.test(s.expr) ? 'rows typed in with Enter data'
        : /List\.(Dates|Numbers|Generate|DateTimes)/.test(s.expr) ? 'rows generated in the query' : 'table written in the query';
    } else if (category === 'function') {
      detail = `${fn}(…)`;
    } else if (category === 'filter') {
      detail = fn === 'Table.SelectRows' ? short(args[1], 120) : fn.replace('Table.', '');
    } else if (category === 'columns') {
      detail = `${fn === 'Table.RemoveColumns' ? 'removes' : 'keeps'} ${names(args[1]).slice(0, 8).join(', ')}${names(args[1]).length > 8 ? '…' : ''}`;
    } else if (category === 'rename') {
      const pairs = [...String(args[1] || '').matchAll(/\{\s*"((?:[^"]|"")*)"\s*,\s*"((?:[^"]|"")*)"\s*\}/g)].map(m => `${m[1]} → ${m[2]}`);
      detail = pairs.slice(0, 6).join(', ') + (pairs.length > 6 ? '…' : '');
    } else if (category === 'expand') {
      detail = `${unquote(String(args[1] || '').replace(/^"|"$/g, ''))}: ${names(args[2]).slice(0, 6).join(', ')}`;
    } else if (category === 'other') {
      detail = fn || short(s.expr, 80);
    }
    if (category !== 'source' && category !== 'types' && category !== 'output' && category !== 'value') {
      changes.push({ category, label: M_CHANGE_LABELS[category] || category, step: s.name, detail });
    }
  }

  // Other queries this one reads (references by name, outside its own steps).
  const references = [];
  scan(text, (i, tok, s) => {
    if (s.isWord && queryNames.has(tok) && !stepNames.has(tok) && !references.includes(tok)) references.push(tok);
    return false;
  });
  for (const m of text.matchAll(/#"((?:[^"]|"")*)"/g)) {
    const nm = m[1].replace(/""/g, '"');
    if (queryNames.has(nm) && !stepNames.has(nm) && !references.includes(nm)) references.push(nm);
  }

  const sources = sourcesIn(text);
  const cats = new Set(changes.map(c => c.category));
  const transformed = [...cats].some(c => TRANSFORM_CATS.has(c));
  const shaped = [...cats].some(c => SHAPED_CATS.has(c)) || references.length > 0;
  const shape = transformed ? M_SHAPE.TRANSFORMED : shaped ? M_SHAPE.SHAPED : M_SHAPE.DIRECT;
  const nativeSql = nativeSqlIn(text);

  const flags = [...new Set(changes.filter(c => TRANSFORM_CATS.has(c.category)).map(c => c.label))];
  const lc = (l) => l[0].toLowerCase() + l.slice(1);
  const summary = shape === M_SHAPE.DIRECT
    ? `Direct: reads ${sources[0]?.label || references[0] || 'its source'} and only sets data types`
    : shape === M_SHAPE.SHAPED
      ? `Shaped: ${[...new Set(changes.map(c => lc(c.label)))].join(', ') || `built from ${references.join(', ')}`}; no new values`
      : `Transformed: ${flags.map(lc).join(', ')}`;

  return { shape, summary, steps, changes, sources, references, nativeSql, flags };
}

/** Data sources named in M text, with upstream node ids where one can be formed. */
export function sourcesIn(text) {
  const out = [];
  const add = (type, label, id) => { if (!out.some(o => o.label === label)) out.push({ type, label, id: id || null }); };
  const dbx = extractDatabricksSource(text);
  if (dbx) {
    if (dbx.fqn) add('databricks', dbx.fqn, `dbx:${dbx.fqn.toLowerCase()}`);
    for (const t of dbx.nativeTables || []) add('databricks', t, t.split('.').length === 3 ? `dbx:${t.toLowerCase()}` : null);
    if (!dbx.fqn && !(dbx.nativeTables || []).length) add('databricks', dbx.server || 'Databricks', null);
  }
  const df = extractDataflowSource(text);
  if (df) add('dataflow', `${df.entity || '?'} (dataflow ${df.dataflowId})`, df.dataflowId && df.entity ? `pbi-df:${df.dataflowId}/${df.entity}`.toLowerCase() : null);
  for (const m of text.matchAll(/Sql\.Database\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/gi)) {
    const item = text.match(/\[\s*Schema\s*=\s*"([^"]+)"\s*,\s*Item\s*=\s*"([^"]+)"\s*\]/i);
    // M strings write line breaks as #(lf); the SQL itself names the tables it reads.
    const sql = (nativeSqlIn(text) || '').replace(/#\((lf|cr|tab)\)/g, ' ');
    const sqlTables = sql ? tablesInSql(sql) : [];
    if (item) add('sqlserver', `${m[2]}.${item[1]}.${item[2]} on ${m[1]}`, `sql:${m[2]}.${item[1]}.${item[2]}`.toLowerCase());
    else if (sqlTables.length) {
      for (const t of sqlTables) {
        const parts = t.split('.');
        const full = parts.length === 3 ? t : parts.length === 2 ? `${m[2]}.${t}` : `${m[2]}.dbo.${t}`;
        add('sqlserver', `${full} on ${m[1]}`, `sql:${full}`.toLowerCase());
      }
    } else add('sqlserver', `${m[2]} on ${m[1]}`, null);
  }
  for (const m of text.matchAll(/SharePoint\.(?:Files|Contents|Tables)\s*\(\s*"([^"]+)"/gi)) add('sharepoint', m[1], null);
  for (const m of text.matchAll(/Web\.Contents\s*\(\s*"([^"]+)"/gi)) add(/sharepoint\.com/i.test(m[1]) ? 'sharepoint' : 'web', m[1], null);
  if (/Lakehouse\.Contents/.test(text)) add('fabric', 'Fabric lakehouse', null);
  if (/Binary\.Decompress\s*\(\s*Binary\.FromText/.test(text)) add('manual', 'Entered data', null);
  if (/\bExcel\.Workbook\b/.test(text) && !out.some(o => o.type === 'sharepoint' || o.type === 'web')) add('file', 'Excel file', null);
  if (/\bCsv\.Document\b/.test(text) && !out.some(o => o.type === 'sharepoint' || o.type === 'web')) add('file', 'CSV file', null);
  return out;
}
