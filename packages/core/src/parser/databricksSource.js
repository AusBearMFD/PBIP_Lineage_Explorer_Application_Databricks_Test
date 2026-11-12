/**
 * Databricks source detection for Power Query (M) expressions.
 *
 * Power BI reaches Databricks through the Databricks connector, which comes in
 * three spellings:
 *
 *   Databricks.Catalogs(host, httpPath, [options])            // navigation
 *   DatabricksMultiCloud.Catalogs(host, httpPath, [options])  // navigation
 *   Databricks.Query(host, httpPath, [options])               // native SQL
 *
 * Navigation steps then pick a catalog, schema and table or view:
 *
 *   Source{[Name="facilities-prod",Kind="Database"]}[Data]
 *     {[Name="publish",Kind="Schema"]}[Data]
 *     {[Name="date_dim",Kind="Table"]}[Data]        (or Kind="View")
 *
 * Native SQL comes through Value.NativeQuery(...) or Databricks.Query(...), and
 * can read several tables (FROM ... JOIN ...).
 *
 * Model parameters (DBX_Catalog etc.) are substituted with their values before
 * this runs (graphBuilder.resolveParameters), so only literal names are handled.
 * An unresolved parameter is reported as-is in `unresolved` rather than guessed.
 */

const CONNECTOR_RE = /\b(DatabricksMultiCloud\.Catalogs|Databricks\.Catalogs|Databricks\.Query|Databricks\.Contents)\s*\(/i;

/**
 * Detect a Databricks source in an M expression.
 * @param {string} mExpression - M code with block comments already removed.
 * @returns {null | {
 *   type: 'Databricks', server: string|null, httpPath: string|null,
 *   database: string|null, schema: string|null, sourceTable: string|null,
 *   objectKind: 'Table'|'View'|null, connector: string, fqn: string|null,
 *   nativeTables: string[], unresolved: string[]
 * }}
 */
export function extractDatabricksSource(mExpression) {
  if (!mExpression) return null;
  const expr = mExpression.replace(/\/\*[\s\S]*?\*\//g, '');
  const connectorMatch = expr.match(CONNECTOR_RE);
  if (!connectorMatch) return null;

  const result = {
    type: 'Databricks',
    server: null,
    httpPath: null,
    database: null,
    schema: null,
    sourceTable: null,
    objectKind: null,
    connector: connectorMatch[1],
    fqn: null,
    nativeTables: [],
    unresolved: [],
  };

  // Host and HTTP path: the first two arguments, quoted literals after
  // parameter substitution. An identifier means an unresolved parameter.
  const args = readArguments(expr, connectorMatch.index + connectorMatch[0].length);
  if (args[0]) {
    const host = unquote(args[0]);
    if (host) result.server = host; else result.unresolved.push(args[0].trim());
  }
  if (args[1]) {
    const path = unquote(args[1]);
    if (path) result.httpPath = path; else result.unresolved.push(args[1].trim());
  }
  // [Catalog="..."] / [Database="..."] in the options record set defaults.
  const options = args[2] || '';
  const optCatalog = options.match(/\bCatalog\s*=\s*"([^"]+)"/i);
  if (optCatalog) result.database = optCatalog[1];
  const optDatabase = options.match(/\bDatabase\s*=\s*"([^"]+)"/i);
  if (optDatabase) result.schema = optDatabase[1];

  // Navigation steps, in order of appearance.
  const navRe = /\{\s*\[\s*Name\s*=\s*("([^"]*)"|[A-Za-z_][\w.]*)\s*,\s*Kind\s*=\s*"(\w+)"\s*\]\s*\}/gi;
  let m;
  while ((m = navRe.exec(expr)) !== null) {
    const literal = m[2];
    const kind = m[3].toLowerCase();
    const name = literal !== undefined ? literal : null;
    if (name === null) { result.unresolved.push(m[1]); continue; }
    if (kind === 'database' || kind === 'catalog') result.database = name;
    else if (kind === 'schema') result.schema = name;
    else if (kind === 'table' || kind === 'view') {
      result.sourceTable = name;
      result.objectKind = kind === 'view' ? 'View' : 'Table';
    }
  }

  // Native SQL: Value.NativeQuery(<source>, "SQL", ...) or Databricks.Query(..., [Query="..."]).
  const sqlTexts = [];
  const nqRe = /Value\.NativeQuery\s*\(/gi;
  while ((m = nqRe.exec(expr)) !== null) {
    const a = readArguments(expr, m.index + m[0].length);
    if (a[1]) sqlTexts.push(unquote(a[1]) || '');
  }
  const queryOpt = expr.match(/\bQuery\s*=\s*"((?:[^"]|"")*)"/i);
  if (queryOpt) sqlTexts.push(queryOpt[1].replace(/""/g, '"'));
  for (const sql of sqlTexts) {
    for (const t of tablesInSql(sql)) {
      if (!result.nativeTables.includes(t)) result.nativeTables.push(t);
    }
  }
  if (!result.sourceTable && result.nativeTables.length > 0) {
    const parts = result.nativeTables[0].split('.');
    if (parts.length === 3) [result.database, result.schema, result.sourceTable] = parts;
    else if (parts.length === 2) [result.schema, result.sourceTable] = parts;
    else result.sourceTable = parts[0];
  }

  if (result.database && result.schema && result.sourceTable) {
    result.fqn = `${result.database}.${result.schema}.${result.sourceTable}`;
  }

  return result;
}

/**
 * Fully-qualified Databricks table names read by a SQL statement
 * (FROM and JOIN targets), with backticks removed.
 * @param {string} sql
 * @returns {string[]}
 */
export function tablesInSql(sql) {
  if (!sql) return [];
  const out = [];
  // Strip string literals and comments so they can't look like table names.
  const clean = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  const re = /\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_][\w-]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][\w-]*)){0,2})/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1].replace(/`/g, '').replace(/\s+/g, '');
    if (/^(select|lateral|unnest|values)$/i.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Read the comma-separated arguments of a call, starting just after "(".
 * Respects nested brackets, records and quoted strings ("" escapes).
 */
function readArguments(text, start) {
  const args = [];
  let depth = 0;
  let current = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Copy the whole quoted string, including "" escapes.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { args.push(current); return args; }
      depth--;
    }
    if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current);
  return args;
}

/** Value of a quoted M string literal, or null when the text isn't one. */
function unquote(text) {
  const t = (text || '').trim();
  const m = t.match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : null;
}
