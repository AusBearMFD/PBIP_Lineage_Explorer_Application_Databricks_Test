// Bundled copy of the PBIP Lineage Explorer engine (packages/core), so the skills run outside the app repo.
// Built from PBIP_Lineage_Explorer_Application_Databricks_Test @ ef830d1 on 2026-11-12. Rebuild: tools\Sync-PowerBISkills.ps1 -RebuildEngine.
// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/databricksSource.js
var CONNECTOR_RE = /\b(DatabricksMultiCloud\.Catalogs|Databricks\.Catalogs|Databricks\.Query|Databricks\.Contents)\s*\(/i;
function extractDatabricksSource(mExpression) {
  if (!mExpression) return null;
  const expr = mExpression.replace(/\/\*[\s\S]*?\*\//g, "");
  const connectorMatch = expr.match(CONNECTOR_RE);
  if (!connectorMatch) return null;
  const result = {
    type: "Databricks",
    server: null,
    httpPath: null,
    database: null,
    schema: null,
    sourceTable: null,
    objectKind: null,
    connector: connectorMatch[1],
    fqn: null,
    nativeTables: [],
    unresolved: []
  };
  const args = readArguments(expr, connectorMatch.index + connectorMatch[0].length);
  if (args[0]) {
    const host = unquote(args[0]);
    if (host) result.server = host;
    else result.unresolved.push(args[0].trim());
  }
  if (args[1]) {
    const path = unquote(args[1]);
    if (path) result.httpPath = path;
    else result.unresolved.push(args[1].trim());
  }
  const options = args[2] || "";
  const optCatalog = options.match(/\bCatalog\s*=\s*"([^"]+)"/i);
  if (optCatalog) result.database = optCatalog[1];
  const optDatabase = options.match(/\bDatabase\s*=\s*"([^"]+)"/i);
  if (optDatabase) result.schema = optDatabase[1];
  const navRe = /\{\s*\[\s*Name\s*=\s*("([^"]*)"|[A-Za-z_][\w.]*)\s*,\s*Kind\s*=\s*"(\w+)"\s*\]\s*\}/gi;
  let m;
  while ((m = navRe.exec(expr)) !== null) {
    const literal = m[2];
    const kind = m[3].toLowerCase();
    const name = literal !== void 0 ? literal : null;
    if (name === null) {
      result.unresolved.push(m[1]);
      continue;
    }
    if (kind === "database" || kind === "catalog") result.database = name;
    else if (kind === "schema") result.schema = name;
    else if (kind === "table" || kind === "view") {
      result.sourceTable = name;
      result.objectKind = kind === "view" ? "View" : "Table";
    }
  }
  const sqlTexts = [];
  const nqRe = /Value\.NativeQuery\s*\(/gi;
  while ((m = nqRe.exec(expr)) !== null) {
    const a = readArguments(expr, m.index + m[0].length);
    if (a[1]) sqlTexts.push(unquote(a[1]) || "");
  }
  const queryOpt = expr.match(/\bQuery\s*=\s*"((?:[^"]|"")*)"/i);
  if (queryOpt) sqlTexts.push(queryOpt[1].replace(/""/g, '"'));
  for (const sql of sqlTexts) {
    for (const t of tablesInSql(sql)) {
      if (!result.nativeTables.includes(t)) result.nativeTables.push(t);
    }
  }
  if (!result.sourceTable && result.nativeTables.length > 0) {
    const parts = result.nativeTables[0].split(".");
    if (parts.length === 3) [result.database, result.schema, result.sourceTable] = parts;
    else if (parts.length === 2) [result.schema, result.sourceTable] = parts;
    else result.sourceTable = parts[0];
  }
  if (result.database && result.schema && result.sourceTable) {
    result.fqn = `${result.database}.${result.schema}.${result.sourceTable}`;
  }
  return result;
}
function tablesInSql(sql) {
  if (!sql) return [];
  const out = [];
  const clean = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
  const re = /\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_][\w-]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][\w-]*)){0,2})/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1].replace(/`/g, "").replace(/\s+/g, "");
    if (/^(select|lateral|unnest|values)$/i.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
function readArguments(text, start) {
  const args = [];
  let depth = 0;
  let current = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        j++;
      }
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        args.push(current);
        return args;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current);
  return args;
}
function unquote(text) {
  const t = (text || "").trim();
  const m = t.match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : null;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/dataflowSource.js
var CONNECTOR_RE2 = /\b(PowerPlatform\.Dataflows|PowerBI\.Dataflows)\s*\(/i;
function extractDataflowSource(mExpression) {
  if (!mExpression) return null;
  const expr = mExpression.replace(/\/\*[\s\S]*?\*\//g, "");
  const conn = expr.match(CONNECTOR_RE2);
  if (!conn) return null;
  const pick = (re) => (expr.match(re) || [])[1] || null;
  const workspaceId = pick(/workspaceId\s*=\s*"([^"]+)"/i);
  const dataflowId = pick(/dataflowId\s*=\s*"([^"]+)"/i);
  const entity = pick(/\bentity\s*=\s*"((?:[^"]|"")+)"/i)?.replace(/""/g, '"') || null;
  return {
    type: "Dataflow",
    connector: conn[1],
    workspaceId,
    dataflowId,
    entity,
    // The generic fields the rest of the engine uses for any source.
    server: workspaceId,
    database: dataflowId,
    schema: null,
    sourceTable: entity
  };
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/tmdlParser.js
function parseTmdlModel(tmdlFiles, relationshipFiles = []) {
  const tables = [];
  const relationships = [];
  for (const { content, path } of tmdlFiles) {
    const parsed = parseTableFile(content, path);
    if (parsed && parsed.name) {
      tables.push(parsed);
    }
  }
  for (const { content } of relationshipFiles) {
    const rels = parseRelationships(content);
    relationships.push(...rels);
  }
  return { tables, relationships };
}
function getIndentLevel(line) {
  const match = line.match(/^(\t*)/);
  if (match && match[1].length > 0) {
    return match[1].length;
  }
  const spaceMatch = line.match(/^( +)/);
  if (spaceMatch) {
    return Math.floor(spaceMatch[1].length / 4) || (spaceMatch[1].length > 0 ? 1 : 0);
  }
  return 0;
}
function unquoteName(name) {
  if (name && name.startsWith("'") && name.endsWith("'")) {
    return name.slice(1, -1);
  }
  return name || "";
}
function parseTableFile(content, fileName) {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const result = { name: "", columns: [], measures: [], calculatedColumns: [], partitions: [] };
  let tableName = "";
  for (const line of lines) {
    const tableMatch = line.match(/^table\s+(.+)$/);
    if (tableMatch) {
      tableName = unquoteName(tableMatch[1].trim());
      break;
    }
  }
  if (!tableName) {
    return null;
  }
  result.name = tableName;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndentLevel(line);
    if (indent === 1 || indent === 0 && !trimmed.startsWith("table ")) {
      const colMatch = trimmed.match(/^column\s+(.+)$/);
      if (colMatch) {
        const colRaw = colMatch[1].trim();
        const colEqMatch = colRaw.match(/^(.+?)\s*=\s*(.*)$/);
        const colName = unquoteName((colEqMatch ? colEqMatch[1] : colRaw).trim());
        const col = parseColumnBlock(lines, i, colName);
        if (colEqMatch) {
          const inlineExpr = extractDaxExpression(lines, i) || colEqMatch[2].trim();
          if (inlineExpr) col.expression = inlineExpr;
        }
        if (col.expression) {
          result.calculatedColumns.push(col);
        } else {
          result.columns.push(col);
        }
        i++;
        continue;
      }
      const measureMatch = trimmed.match(/^measure\s+(.+?)\s*=\s*(.*)$/);
      if (measureMatch) {
        const measureName = unquoteName(measureMatch[1].trim());
        const firstPart = measureMatch[2].trim();
        const daxExpr = extractDaxExpression(lines, i);
        result.measures.push({
          name: measureName,
          expression: daxExpr || firstPart,
          ...parseMeasureProperties(lines, i)
        });
        i++;
        continue;
      }
      const partMatch = trimmed.match(/^partition\s+(.+)$/);
      if (partMatch) {
        const partRaw = partMatch[1].trim();
        const partEqMatch = partRaw.match(/^(.+?)\s*=\s*(.*)$/);
        const partName = unquoteName((partEqMatch ? partEqMatch[1] : partRaw).trim());
        const partType = partEqMatch ? partEqMatch[2].trim().toLowerCase() : "";
        const partition = parsePartitionBlock(lines, i, partName, partType);
        result.partitions.push(partition);
        i++;
        continue;
      }
      if (trimmed === "refreshPolicy") {
        const rpSource = parseRefreshPolicyBlock(lines, i);
        if (rpSource) {
          result.refreshPolicySource = rpSource;
        }
        i++;
        continue;
      }
      if (trimmed === "calculationGroup") {
        result.calculationGroup = true;
        if (!result.calculationItems) result.calculationItems = [];
        const cgIndent = indent;
        let j = i + 1;
        while (j < lines.length) {
          const cgLine = lines[j];
          const cgTrimmed = cgLine.trim();
          if (!cgTrimmed) {
            j++;
            continue;
          }
          const cgLineIndent = getIndentLevel(cgLine);
          if (cgLineIndent <= cgIndent) break;
          const nestedCiMatch = cgTrimmed.match(/^calculationItem\s+(.+?)\s*=\s*(.*)$/);
          if (nestedCiMatch) {
            const ciName = unquoteName(nestedCiMatch[1].trim());
            const ciExpr = extractDaxExpression(lines, j);
            result.calculationItems.push({
              name: ciName,
              expression: ciExpr || nestedCiMatch[2].trim()
            });
          }
          j++;
        }
        i = j;
        continue;
      }
      const ciMatch = trimmed.match(/^calculationItem\s+(.+?)\s*=\s*(.*)$/);
      if (ciMatch) {
        if (!result.calculationItems) result.calculationItems = [];
        const ciName = unquoteName(ciMatch[1].trim());
        const ciExpr = extractDaxExpression(lines, i);
        result.calculationItems.push({
          name: ciName,
          expression: ciExpr || ciMatch[2].trim()
        });
        i++;
        continue;
      }
    }
    i++;
  }
  return result;
}
function parseColumnBlock(lines, startIndex, name) {
  const col = { name, dataType: "", sourceColumn: "", expression: null, isHidden: false };
  const baseIndent = getIndentLevel(lines[startIndex]);
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const indent = getIndentLevel(line);
    if (indent <= baseIndent) break;
    if (trimmed === "isHidden") {
      col.isHidden = true;
      i++;
      continue;
    }
    const propMatch = trimmed.match(/^(\w+)\s*[:=]\s*(.+)$/);
    if (propMatch) {
      const key = propMatch[1].toLowerCase();
      const value = propMatch[2].trim();
      if (key === "datatype") col.dataType = value;
      else if (key === "sourcecolumn") col.sourceColumn = value;
      else if (key === "expression") col.expression = value;
    }
    i++;
  }
  return col;
}
function parseMeasureProperties(lines, startIndex) {
  const props = {};
  const baseIndent = getIndentLevel(lines[startIndex]);
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const indent = getIndentLevel(line);
    if (indent <= baseIndent) break;
    if (trimmed === "isHidden") {
      props.isHidden = true;
      i++;
      continue;
    }
    const propMatch = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (propMatch) {
      const key = propMatch[1];
      props[key] = propMatch[2].trim();
    }
    i++;
  }
  return props;
}
function extractDaxExpression(lines, startIndex) {
  const startLine = lines[startIndex];
  const trimmed = startLine.trim();
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) return "";
  const firstPart = trimmed.substring(eqIndex + 1).trim();
  const baseIndent = getIndentLevel(startLine);
  const parts = [firstPart];
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const lineTrimmed = line.trim();
    if (!lineTrimmed) {
      i++;
      continue;
    }
    const indent = getIndentLevel(line);
    if (indent <= baseIndent) break;
    if (lineTrimmed.match(/^\w+\s*:/)) break;
    parts.push(lineTrimmed);
    i++;
  }
  return parts.join("\n").trim();
}
function parsePartitionBlock(lines, startIndex, name, type) {
  const partition = { name, type: type || "", mode: "", sourceExpression: null };
  const baseIndent = getIndentLevel(lines[startIndex]);
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const indent = getIndentLevel(line);
    if (indent <= baseIndent) break;
    const modeMatch = trimmed.match(/^mode\s*[:=]\s*(.+)$/i);
    if (modeMatch) {
      partition.mode = modeMatch[1].trim().toLowerCase();
      i++;
      continue;
    }
    const sourceMatch = trimmed.match(/^source\s*=\s*(.*)$/i);
    if (sourceMatch) {
      const firstPart = sourceMatch[1].trim();
      const parts = firstPart ? [firstPart] : [];
      const sourceIndent = getIndentLevel(line);
      let j = i + 1;
      while (j < lines.length) {
        const sLine = lines[j];
        const sTrimmed = sLine.trim();
        if (!sTrimmed) {
          j++;
          continue;
        }
        const sIndent = getIndentLevel(sLine);
        if (sIndent <= sourceIndent) break;
        parts.push(sTrimmed);
        j++;
      }
      partition.sourceExpression = parts.join("\n").trim() || null;
      i = j;
      continue;
    }
    i++;
  }
  return partition;
}
function extractRenameColumns(mExpression) {
  const renameMap = /* @__PURE__ */ new Map();
  if (!mExpression) return renameMap;
  const renameBlockMatch = mExpression.match(/Table\.RenameColumns\s*\([^,]+,\s*\{([\s\S]*?)\}\s*\)/i);
  if (!renameBlockMatch) return renameMap;
  const block = renameBlockMatch[1];
  const pairPattern = /\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = pairPattern.exec(block)) !== null) {
    const oldName = m[1];
    const newName = m[2];
    renameMap.set(newName, oldName);
  }
  return renameMap;
}
function parseRefreshPolicyBlock(lines, startIndex) {
  const baseIndent = getIndentLevel(lines[startIndex]);
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const indent = getIndentLevel(line);
    if (indent <= baseIndent) break;
    const sourceMatch = trimmed.match(/^sourceExpression\s*[:=]\s*(.*)$/i);
    if (sourceMatch) {
      const firstPart = sourceMatch[1].trim();
      const parts = firstPart ? [firstPart] : [];
      const sourceIndent = getIndentLevel(line);
      let j = i + 1;
      while (j < lines.length) {
        const sLine = lines[j];
        const sTrimmed = sLine.trim();
        if (!sTrimmed) {
          j++;
          continue;
        }
        const sIndent = getIndentLevel(sLine);
        if (sIndent <= sourceIndent) break;
        parts.push(sTrimmed);
        j++;
      }
      return parts.join("\n").trim() || null;
    }
    i++;
  }
  return null;
}
function extractMDataSource(mExpression) {
  if (!mExpression) return null;
  const result = { server: null, database: null, schema: null, sourceTable: null, type: null };
  const cleanExpr = mExpression.replace(/\/\*[\s\S]*?\*\//g, "");
  const dbx = extractDatabricksSource(cleanExpr);
  if (dbx) return dbx;
  const dataflow = extractDataflowSource(cleanExpr);
  if (dataflow) return dataflow;
  const sqlMatch = cleanExpr.match(/Sql\.Database\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/i);
  if (sqlMatch) {
    result.type = "SQL";
    result.server = sqlMatch[1];
    result.database = sqlMatch[2];
  }
  if (result.server && result.server.includes(".fabric.microsoft.com")) {
    result.type = "Fabric/Lakehouse";
  }
  const schemaItemMatch = cleanExpr.match(/\{[^}]*Schema\s*=\s*"([^"]+)"[^}]*Item\s*=\s*"([^"]+)"[^}]*\}/i);
  if (schemaItemMatch) {
    result.schema = schemaItemMatch[1];
    result.sourceTable = schemaItemMatch[2];
  }
  if (!result.sourceTable && !/GoogleBigQuery/i.test(cleanExpr)) {
    const nameMatch = cleanExpr.match(/\{[^}]*Name\s*=\s*"([^"]+)"[^}]*\}/i);
    if (nameMatch) {
      result.sourceTable = nameMatch[1];
    }
  }
  const bqMatch = cleanExpr.match(/GoogleBigQuery\.Database\s*\(\s*(?:"([^"]*)"|\[([^\]]*)\]|(\w+))/i);
  if (bqMatch && !result.type) {
    result.type = "BigQuery";
    result.server = bqMatch[1] || bqMatch[2] || bqMatch[3] || null;
  }
  if (/Value\.NativeQuery/i.test(cleanExpr)) {
    const nativeQueryMatch = cleanExpr.match(/Value\.NativeQuery\s*\([^,]*,\s*"([\s\S]*?)"\s*[,)]/i);
    if (nativeQueryMatch) {
      const sql = nativeQueryMatch[1];
      const fromMatch = sql.match(/FROM\s+`?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2})`?/i);
      if (fromMatch) {
        const parts = fromMatch[1].split(".");
        if (parts.length === 3) {
          result.server = result.server || parts[0];
          result.database = parts[1];
          result.sourceTable = parts[2];
        } else if (parts.length === 2) {
          result.database = parts[0];
          result.sourceTable = parts[1];
        }
      }
    }
    if (!result.sourceTable) {
      const tableInBackticks = cleanExpr.match(/\.([A-Za-z_][A-Za-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]+)`/);
      if (tableInBackticks) {
        result.database = result.database || tableInBackticks[1];
        result.sourceTable = tableInBackticks[2];
      }
    }
    if (!result.type && (result.database || result.sourceTable)) {
      result.type = "BigQuery";
    }
  }
  if (bqMatch && !result.sourceTable) {
    const nameMatches = [...cleanExpr.matchAll(/\{\s*\[(?:[^[\]]*,\s*)?Name\s*=\s*"([^"]+)"[^\]]*\]\s*\}/gi)];
    if (nameMatches.length >= 3) {
      result.server = result.server || nameMatches[0][1];
      result.database = nameMatches[nameMatches.length - 2][1];
      result.sourceTable = nameMatches[nameMatches.length - 1][1];
    } else if (nameMatches.length === 2) {
      result.database = nameMatches[0][1];
      result.sourceTable = nameMatches[1][1];
    } else if (nameMatches.length === 1) {
      result.sourceTable = nameMatches[0][1];
    }
    const bqSchemaItem = cleanExpr.match(/\{[^}]*Schema\s*=\s*"([^"]+)"[^}]*Item\s*=\s*"([^"]+)"[^}]*\}/i);
    if (bqSchemaItem) {
      result.database = bqSchemaItem[1];
      result.sourceTable = bqSchemaItem[2];
    }
  }
  if (!result.server) {
    const webMatch = mExpression.match(/Web\.Contents\s*\(\s*"([^"]+)"/i);
    if (webMatch) {
      result.type = "Web";
      result.server = webMatch[1];
    }
  }
  if (!result.type) {
    const fileMatch = mExpression.match(/(Excel\.Workbook|Csv\.Document|File\.Contents)\s*\(/i);
    if (fileMatch) {
      result.type = fileMatch[1].split(".")[0];
    }
  }
  return result.server || result.database || result.sourceTable ? result : null;
}
function extractNestedJoins(mExpression) {
  if (!mExpression) return [];
  const cleanExpr = mExpression.replace(/\/\*[\s\S]*?\*\//g, "");
  const results = [];
  const pattern = /Table\s*\.\s*(?:NestedJoin|FuzzyNestedJoin)\s*\([^{}]*?,\s*\{[^}]*\}\s*,\s*(?:#"([^"]+)"|([A-Za-z_]\w*))/g;
  let match;
  while ((match = pattern.exec(cleanExpr)) !== null) {
    const name = (match[1] || match[2] || "").trim();
    if (name && !results.includes(name)) results.push(name);
  }
  return results;
}
function parseExpressions(content) {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const expressions = [];
  const parameters = /* @__PURE__ */ new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const exprMatch = trimmed.match(/^expression\s+(.+?)\s*=\s*(.*)$/);
    if (exprMatch) {
      const name = unquoteName(exprMatch[1].trim());
      const firstPart = exprMatch[2].trim();
      const literalMatch = firstPart.match(/^"([^"]*)"(\s*meta\s*\[.*\])?\s*$/);
      if (literalMatch) {
        parameters.set(name, literalMatch[1]);
        expressions.push({ name, mExpression: literalMatch[1], kind: "parameter" });
        i++;
        continue;
      }
      const baseIndent = getIndentLevel(line);
      const parts = [];
      if (firstPart && firstPart !== "m") {
        parts.push(firstPart);
      }
      let j = i + 1;
      while (j < lines.length) {
        const eLine = lines[j];
        const eTrimmed = eLine.trim();
        if (!eTrimmed) {
          j++;
          continue;
        }
        const eIndent = getIndentLevel(eLine);
        if (eIndent <= baseIndent) {
          const propMatch = eTrimmed.match(/^(\w+)\s*[:=]/);
          if (propMatch && eIndent === baseIndent + 1) {
            j++;
            continue;
          }
          break;
        }
        if (eTrimmed.match(/^(annotation|lineageTag|queryGroup|description)\s*[:=]/i)) {
          j++;
          continue;
        }
        parts.push(eTrimmed);
        j++;
      }
      const mExpression = parts.join("\n").trim();
      const isParameterExpr = /IsParameterQuery\s*=\s*true/i.test(mExpression) || /^#datetime\s*\(/i.test(mExpression) || /^#date\s*\(/i.test(mExpression) || /^\d+(\.\d+)?\s*(meta\b|$)/i.test(mExpression);
      const exprKind = !mExpression || isParameterExpr ? "parameter" : "expression";
      expressions.push({ name, mExpression, kind: exprKind });
      if (isParameterExpr) {
        const quotedVal = mExpression.match(/^"([^"]*)"/);
        if (quotedVal) {
          parameters.set(name, quotedVal[1]);
        }
      } else if (!mExpression.includes("\n") && mExpression.startsWith('"') && mExpression.endsWith('"')) {
        parameters.set(name, mExpression.slice(1, -1));
      }
      i = j;
      continue;
    }
    i++;
  }
  return { expressions, parameters };
}
function parseRelationships(content) {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const relationships = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndentLevel(line);
    const relMatch = trimmed.match(/^relationship\s+(.+)$/);
    if (relMatch) {
      if (current) relationships.push(current);
      current = {
        name: unquoteName(relMatch[1].trim()),
        fromTable: "",
        fromColumn: "",
        toTable: "",
        toColumn: "",
        crossFilter: "single"
      };
      continue;
    }
    if (!current) continue;
    const inlineMatch = trimmed.match(/^(\w[\w\s']*)\[(\w[\w\s']*)\]\s*->\s*(\w[\w\s']*)\[(\w[\w\s']*)\]/);
    if (inlineMatch) {
      current.fromTable = unquoteName(inlineMatch[1].trim());
      current.fromColumn = unquoteName(inlineMatch[2].trim());
      current.toTable = unquoteName(inlineMatch[3].trim());
      current.toColumn = unquoteName(inlineMatch[4].trim());
      continue;
    }
    const propMatch = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (propMatch && indent > 0) {
      const key = propMatch[1].toLowerCase();
      const value = propMatch[2].trim();
      if (key === "fromtable") current.fromTable = unquoteName(value);
      else if (key === "totable") current.toTable = unquoteName(value);
      else if (key === "crossfilteringbehavior" || key === "crossfilter") current.crossFilter = value;
    }
    const fromColMatch = trimmed.match(/^fromColumn:\s*(.+)$/i);
    if (fromColMatch) {
      const ref = fromColMatch[1].trim();
      const bracketMatch = ref.match(/^(\w[\w\s']*)\[(\w[\w\s']*)\]/);
      const dotMatch = ref.match(/^(.+)\.(\w+)$/);
      if (bracketMatch) {
        current.fromTable = unquoteName(bracketMatch[1].trim());
        current.fromColumn = unquoteName(bracketMatch[2].trim());
      } else if (dotMatch) {
        current.fromTable = unquoteName(dotMatch[1].trim());
        current.fromColumn = unquoteName(dotMatch[2].trim());
      } else {
        current.fromColumn = unquoteName(ref);
      }
    }
    const toColMatch = trimmed.match(/^toColumn:\s*(.+)$/i);
    if (toColMatch) {
      const ref = toColMatch[1].trim();
      const bracketMatch = ref.match(/^(\w[\w\s']*)\[(\w[\w\s']*)\]/);
      const dotMatch = ref.match(/^(.+)\.(\w+)$/);
      if (bracketMatch) {
        current.toTable = unquoteName(bracketMatch[1].trim());
        current.toColumn = unquoteName(bracketMatch[2].trim());
      } else if (dotMatch) {
        current.toTable = unquoteName(dotMatch[1].trim());
        current.toColumn = unquoteName(dotMatch[2].trim());
      } else {
        current.toColumn = unquoteName(ref);
      }
    }
  }
  if (current) relationships.push(current);
  return relationships;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/upstream/mQueryAnalysis.js
var M_SHAPE = { DIRECT: "direct", SHAPED: "shaped", TRANSFORMED: "transformed" };
var FN_CATEGORY = {
  // reading and type-only steps
  "Table.TransformColumnTypes": "types",
  "Table.PromoteHeaders": "types",
  "Table.DemoteHeaders": "types",
  "Table.Buffer": "types",
  "Table.ReorderColumns": "types",
  "Table.Sort": "types",
  "Table.TransformColumnNames": "rename",
  // shaping: fewer rows/columns or new names, no new values
  "Table.SelectColumns": "columns",
  "Table.RemoveColumns": "columns",
  "Table.RenameColumns": "rename",
  "Table.SelectRows": "filter",
  "Table.RemoveRowsWithErrors": "filter",
  "Table.RemoveMatchingRows": "filter",
  "Table.FirstN": "filter",
  "Table.LastN": "filter",
  "Table.Range": "filter",
  "Table.Skip": "filter",
  "Table.RemoveFirstN": "filter",
  "Table.RemoveLastN": "filter",
  "Table.RemoveRows": "filter",
  "Table.Distinct": "dedupe",
  "Table.ExpandTableColumn": "expand",
  "Table.ExpandRecordColumn": "expand",
  "Table.ExpandListColumn": "expand",
  // transforms
  "Table.NestedJoin": "join",
  "Table.Join": "join",
  "Table.FuzzyNestedJoin": "join",
  "Table.FuzzyJoin": "join",
  "Table.AddJoinColumn": "join",
  "Table.Combine": "append",
  "Table.AddColumn": "newColumn",
  "Table.AddIndexColumn": "newColumn",
  "Table.DuplicateColumn": "newColumn",
  "Table.CombineColumns": "newColumn",
  "Table.SplitColumn": "newColumn",
  "Table.AddRankColumn": "newColumn",
  "Table.AddFuzzyClusterColumn": "newColumn",
  "Table.CombineColumnsToRecord": "newColumn",
  "Table.Group": "aggregate",
  "Table.Pivot": "aggregate",
  "Table.Unpivot": "aggregate",
  "Table.UnpivotOtherColumns": "aggregate",
  "Table.Transpose": "aggregate",
  "Table.AggregateTableColumn": "aggregate",
  "Table.ReplaceValue": "values",
  "Table.ReplaceErrorValues": "values",
  "Table.TransformColumns": "values",
  "Table.FillDown": "values",
  "Table.FillUp": "values",
  "Table.ReplaceRows": "values",
  "Table.TransformRows": "values",
  "Table.InsertRows": "manual",
  "#table": "manual",
  "Table.FromRows": "manual",
  "Table.FromRecords": "manual",
  "Table.FromList": "manual",
  "Table.FromColumns": "manual",
  "Table.FromValue": "manual",
  "Value.NativeQuery": "nativeSql"
};
var SOURCE_FNS = /^(Sql\.Databases?|Databricks(MultiCloud)?\.\w+|PowerPlatform\.Dataflows|PowerBI\.Dataflows|Lakehouse\.Contents|Fabric\.\w+|SharePoint\.\w+|Excel\.(Workbook|CurrentWorkbook)|Csv\.Document|Web\.(Contents|Page)|File\.Contents|Folder\.(Files|Contents)|Json\.Document|Xml\.(Tables|Document)|OData\.Feed|Odbc\.\w+|OleDb\.\w+|Oracle\.Database|AzureStorage\.\w+|AnalysisServices\.\w+|Snowflake\.\w+|GoogleBigQuery\.\w+|PostgreSQL\.Database|MySQL\.Database|Access\.Database|Binary\.\w+)$/;
var OUTPUT_FNS = /^(Pipeline|TableAction|ValueAction|NavigationTable)\./;
var SHAPED_CATS = /* @__PURE__ */ new Set(["columns", "rename", "filter", "dedupe", "expand", "other", "nativeSqlSimple"]);
var TRANSFORM_CATS = /* @__PURE__ */ new Set(["join", "append", "newColumn", "aggregate", "values", "manual", "nativeSql", "function"]);
var M_CHANGE_LABELS = {
  join: "Joins tables",
  append: "Appends tables",
  newColumn: "Adds columns",
  aggregate: "Groups or pivots rows",
  values: "Changes values",
  manual: "Data typed or generated in the query",
  nativeSql: "Custom SQL",
  nativeSqlSimple: "Reads with custom SQL",
  function: "Calls a custom function",
  columns: "Keeps or removes columns",
  rename: "Renames columns",
  filter: "Filters rows",
  dedupe: "Removes duplicates",
  expand: "Expands nested columns",
  other: "Other step"
};
function scan(text, visit) {
  let depth = 0;
  let letDepth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "#" && text[i + 1] === '"') {
      i += ch === "#" ? 2 : 1;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[\w.#]/.test(text[i - 1]))) {
      let j = i;
      while (j < n && /[\w.]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (word === "let") letDepth++;
      if (visit(i, word, { depth, letDepth, isWord: true })) return;
      if (word === "in") letDepth = Math.max(0, letDepth - 1);
      i = j;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (visit(i, ch, { depth, letDepth, isWord: false })) return;
    if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    i++;
  }
}
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
  return parts.map((p) => p.trim()).filter(Boolean);
}
function unquote2(name) {
  const t = String(name || "").trim();
  return t.startsWith('#"') ? t.slice(2, -1).replace(/""/g, '"') : t;
}
function stripComments(text) {
  let out = "";
  let last = 0;
  const re = /"(?:[^"]|"")*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let m;
  while (m = re.exec(text)) {
    if (m[0][0] === '"') continue;
    out += text.slice(last, m.index) + " ";
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}
function parseMashupDocument(doc) {
  if (!doc) return [];
  const body = String(doc).replace(/^﻿/, "").replace(/^\s*section\s+[^;]+;/i, "");
  const out = [];
  for (const stmt of splitTop(body, ";")) {
    const m = stmt.match(/^(?:\[[\s\S]*?\]\s*)?shared\s+(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*=\s*([\s\S]*)$/);
    if (m) out.push({ name: unquote2(m[1]), expression: m[2].trim() });
  }
  return out;
}
function letSteps(expression) {
  const text = String(expression || "").trim();
  if (!/^let\b/.test(text)) return { steps: [], result: text };
  let inAt = -1;
  scan(text, (i, tok, s) => {
    if (s.isWord && tok === "in" && s.letDepth === 1 && s.depth === 0) {
      inAt = i;
      return true;
    }
    return false;
  });
  if (inAt < 0) return { steps: [], result: text };
  const body = text.slice(3, inAt);
  const steps = [];
  for (const part of splitTop(body, ",", 0)) {
    const m = part.match(/^(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*=\s*([\s\S]*)$/);
    if (m) steps.push({ name: unquote2(m[1]), expr: m[2].trim() });
  }
  return { steps, result: text.slice(inAt + 2).trim() };
}
function outerFunction(expr) {
  const t = expr.trim().replace(/^each\s+/, "");
  const m = t.match(/^(#table|[A-Z][\w]*(?:\.[A-Z][\w]*)+|#"(?:[^"]|"")*"|[A-Za-z_]\w*)\s*\(/);
  if (!m) return null;
  return m[1].startsWith('#"') ? unquote2(m[1]) : m[1];
}
function callArgs(expr) {
  const open = expr.indexOf("(");
  if (open < 0) return [];
  let close = -1;
  const inner = expr.slice(open + 1);
  scan(inner, (i, tok, s) => {
    if (!s.isWord && tok === ")" && s.depth === 0) {
      close = i;
      return true;
    }
    return false;
  });
  return splitTop(close < 0 ? inner : inner.slice(0, close), ",");
}
var str = (a) => {
  const m = String(a || "").trim().match(/^"((?:[^"]|"")*)"$/);
  return m ? m[1].replace(/""/g, '"') : null;
};
var names = (a) => [...String(a || "").matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
var short = (s, n = 140) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
};
var SQL_COMPLEX = /\b(JOIN|UNION|GROUP\s+BY|CASE\s+WHEN|OVER\s*\(|PIVOT|SUM\s*\(|COUNT\s*\(|AVG\s*\(|MIN\s*\(|MAX\s*\(|COALESCE\s*\(|ISNULL\s*\()/i;
function nativeSqlIn(expr) {
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
  const rest = String(args[1] || "").replace(/"(?:[^"]|"")*"/g, "").replace(/\btype\s+(?:nullable\s+)?\w+/g, "").replace(/\b\w+\.From\b/g, "").replace(/[{},\s]/g, "");
  return rest === "";
}
function analyzeMQuery(expression, opts = {}) {
  const text = stripComments(String(expression || ""));
  const queryNames = new Set((opts.queryNames || []).filter((n) => n && n !== opts.name));
  const { steps: rawSteps, result } = letSteps(text);
  const stepNames = new Set(rawSteps.map((s) => s.name));
  const list = rawSteps.length ? rawSteps : [{ name: "(expression)", expr: result }];
  const steps = [];
  const changes = [];
  for (const s of list) {
    const fn = outerFunction(s.expr);
    let category;
    if (!fn) category = /^(#(date|datetime|datetimezone|duration|time|binary)\s*\(|[-\d"]|\{\s*["\d#])/.test(s.expr.trim()) ? "value" : "source";
    else if (FN_CATEGORY[fn]) category = FN_CATEGORY[fn];
    else if (SOURCE_FNS.test(fn)) category = "source";
    else if (OUTPUT_FNS.test(fn)) category = "output";
    else if (queryNames.has(fn)) category = "function";
    else if (/^Table\./.test(fn)) category = "other";
    else if (/^(Date|DateTime|Number|Text|List|Record|Duration|Time)\./.test(fn)) category = "value";
    else category = "source";
    const args = fn ? callArgs(s.expr.replace(/^each\s+/, "")) : [];
    if (fn === "Table.TransformColumns" && typeOnlyTransform(args)) category = "types";
    if (category === "manual" && fn === "Table.FromValue") category = "source";
    if (category === "source" && /Sql\.Database|Databricks\.Query/.test(fn || "") && nativeSqlIn(s.expr)) category = "nativeSql";
    if (category === "manual" && fn !== "#table" && fn !== "Table.InsertRows") {
      const first = String(args[0] || "").trim();
      const madeHere = first.startsWith("{") || /Binary\.(Decompress|FromText)/.test(first) || /List\.(Dates|Numbers|Generate|DateTimes|Times)/.test(first);
      if (!madeHere) category = "source";
    }
    steps.push({ name: s.name, fn: fn || null, category });
    let detail = "";
    if (category === "join") {
      const right = String(args[2] || "").trim();
      const kind = (s.expr.match(/JoinKind\.(\w+)/) || [])[1];
      detail = `with ${unquote2(right) || "another table"}${kind ? ` (${kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} join)` : ""}`;
    } else if (category === "append") {
      detail = `${(args[0] || "").replace(/[{}]/g, "").split(",").map((x) => unquote2(x)).filter(Boolean).join(", ")}`;
    } else if (category === "newColumn") {
      if (fn === "Table.AddColumn") detail = `"${str(args[1]) ?? args[1]}" = ${short(args[2], 120)}`;
      else if (fn === "Table.DuplicateColumn") detail = `"${str(args[2]) ?? ""}" copied from "${str(args[1]) ?? ""}"`;
      else if (fn === "Table.AddIndexColumn") detail = `"${str(args[1]) ?? "Index"}" (row number)`;
      else detail = short(names(args[1]).join(", ") || args[1], 100);
    } else if (category === "aggregate") {
      detail = fn === "Table.Group" ? `by ${names(args[1]).join(", ") || short(args[1], 60)}` : fn.replace("Table.", "");
    } else if (category === "values") {
      detail = fn === "Table.ReplaceValue" ? `${short(args[1], 40)} \u2192 ${short(args[2], 40)} in ${names(args[4]).join(", ")}` : fn === "Table.ReplaceErrorValues" ? `errors replaced in ${names(args[1]).slice(0, 6).join(", ")}` : `${fn.replace("Table.", "")} ${names(args[1]).slice(0, 6).join(", ")}`;
    } else if (category === "nativeSql") {
      const sql = nativeSqlIn(s.expr) || "";
      detail = SQL_COMPLEX.test(sql) ? `joins, aggregates or computes in SQL: ${short(sql, 160)}` : `reads with SQL: ${short(sql, 160)}`;
      if (!SQL_COMPLEX.test(sql)) category = "nativeSqlSimple";
      steps[steps.length - 1].category = category;
    } else if (category === "manual") {
      detail = /Binary\.Decompress|Json\.Document/.test(s.expr) ? "rows typed in with Enter data" : /List\.(Dates|Numbers|Generate|DateTimes)/.test(s.expr) ? "rows generated in the query" : "table written in the query";
    } else if (category === "function") {
      detail = `${fn}(\u2026)`;
    } else if (category === "filter") {
      detail = fn === "Table.SelectRows" ? short(args[1], 120) : fn.replace("Table.", "");
    } else if (category === "columns") {
      detail = `${fn === "Table.RemoveColumns" ? "removes" : "keeps"} ${names(args[1]).slice(0, 8).join(", ")}${names(args[1]).length > 8 ? "\u2026" : ""}`;
    } else if (category === "rename") {
      const pairs = [...String(args[1] || "").matchAll(/\{\s*"((?:[^"]|"")*)"\s*,\s*"((?:[^"]|"")*)"\s*\}/g)].map((m) => `${m[1]} \u2192 ${m[2]}`);
      detail = pairs.slice(0, 6).join(", ") + (pairs.length > 6 ? "\u2026" : "");
    } else if (category === "expand") {
      detail = `${unquote2(String(args[1] || "").replace(/^"|"$/g, ""))}: ${names(args[2]).slice(0, 6).join(", ")}`;
    } else if (category === "other") {
      detail = fn || short(s.expr, 80);
    }
    if (category !== "source" && category !== "types" && category !== "output" && category !== "value") {
      changes.push({ category, label: M_CHANGE_LABELS[category] || category, step: s.name, detail });
    }
  }
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
  const cats = new Set(changes.map((c) => c.category));
  const transformed = [...cats].some((c) => TRANSFORM_CATS.has(c));
  const shaped = [...cats].some((c) => SHAPED_CATS.has(c)) || references.length > 0;
  const shape = transformed ? M_SHAPE.TRANSFORMED : shaped ? M_SHAPE.SHAPED : M_SHAPE.DIRECT;
  const nativeSql = nativeSqlIn(text);
  const flags = [...new Set(changes.filter((c) => TRANSFORM_CATS.has(c.category)).map((c) => c.label))];
  const lc2 = (l) => l[0].toLowerCase() + l.slice(1);
  const summary = shape === M_SHAPE.DIRECT ? `Direct: reads ${sources[0]?.label || references[0] || "its source"} and only sets data types` : shape === M_SHAPE.SHAPED ? `Shaped: ${[...new Set(changes.map((c) => lc2(c.label)))].join(", ") || `built from ${references.join(", ")}`}; no new values` : `Transformed: ${flags.map(lc2).join(", ")}`;
  return { shape, summary, steps, changes, sources, references, nativeSql, flags };
}
function sourcesIn(text) {
  const out = [];
  const add = (type, label, id) => {
    if (!out.some((o) => o.label === label)) out.push({ type, label, id: id || null });
  };
  const dbx = extractDatabricksSource(text);
  if (dbx) {
    if (dbx.fqn) add("databricks", dbx.fqn, `dbx:${dbx.fqn.toLowerCase()}`);
    for (const t of dbx.nativeTables || []) add("databricks", t, t.split(".").length === 3 ? `dbx:${t.toLowerCase()}` : null);
    if (!dbx.fqn && !(dbx.nativeTables || []).length) add("databricks", dbx.server || "Databricks", null);
  }
  const df = extractDataflowSource(text);
  if (df) add("dataflow", `${df.entity || "?"} (dataflow ${df.dataflowId})`, df.dataflowId && df.entity ? `pbi-df:${df.dataflowId}/${df.entity}`.toLowerCase() : null);
  for (const m of text.matchAll(/Sql\.Database\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/gi)) {
    const item = text.match(/\[\s*Schema\s*=\s*"([^"]+)"\s*,\s*Item\s*=\s*"([^"]+)"\s*\]/i);
    const sql = (nativeSqlIn(text) || "").replace(/#\((lf|cr|tab)\)/g, " ");
    const sqlTables = sql ? tablesInSql(sql) : [];
    if (item) add("sqlserver", `${m[2]}.${item[1]}.${item[2]} on ${m[1]}`, `sql:${m[2]}.${item[1]}.${item[2]}`.toLowerCase());
    else if (sqlTables.length) {
      for (const t of sqlTables) {
        const parts = t.split(".");
        const full = parts.length === 3 ? t : parts.length === 2 ? `${m[2]}.${t}` : `${m[2]}.dbo.${t}`;
        add("sqlserver", `${full} on ${m[1]}`, `sql:${full}`.toLowerCase());
      }
    } else add("sqlserver", `${m[2]} on ${m[1]}`, null);
  }
  for (const m of text.matchAll(/SharePoint\.(?:Files|Contents|Tables)\s*\(\s*"([^"]+)"/gi)) add("sharepoint", m[1], null);
  for (const m of text.matchAll(/Web\.Contents\s*\(\s*"([^"]+)"/gi)) add(/sharepoint\.com/i.test(m[1]) ? "sharepoint" : "web", m[1], null);
  if (/Lakehouse\.Contents/.test(text)) add("fabric", "Fabric lakehouse", null);
  if (/Binary\.Decompress\s*\(\s*Binary\.FromText/.test(text)) add("manual", "Entered data", null);
  if (/\bExcel\.Workbook\b/.test(text) && !out.some((o) => o.type === "sharepoint" || o.type === "web")) add("file", "Excel file", null);
  if (/\bCsv\.Document\b/.test(text) && !out.some((o) => o.type === "sharepoint" || o.type === "web")) add("file", "CSV file", null);
  return out;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/upstream/upstreamLineage.js
var UPSTREAM_FILE_PATH = ".lineage/upstream.json";
var TERMINAL = { ORIGIN: "origin", BEST_KNOWN: "best_known" };
var CONFIDENCE = { RECORDED: "recorded", INFERRED: "inferred" };
var SYSTEM_LABELS = {
  databricks: "Databricks",
  sqlserver: "SQL Server",
  fabric: "Fabric",
  dataflow: "Power BI dataflow",
  powerbi: "Power BI",
  dbt: "dbt",
  file: "File",
  api: "API",
  external: "External system"
};
function systemLabel(system) {
  return SYSTEM_LABELS[(system || "").toLowerCase()] || system || "Unknown";
}
var norm = (id) => String(id || "").trim().toLowerCase();
function parseUpstreamLineage(input) {
  const errors = [];
  const warnings = [];
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return { upstream: null, errors: [`Not valid JSON: ${err.message}`], warnings };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { upstream: null, errors: ["The file must contain a JSON object."], warnings };
  }
  if (raw.version !== 1) errors.push(`Unsupported version ${JSON.stringify(raw.version)}; this app reads version 1.`);
  if (!Array.isArray(raw.nodes)) errors.push('"nodes" must be a list.');
  if (!Array.isArray(raw.edges)) errors.push('"edges" must be a list.');
  if (errors.length) return { upstream: null, errors, warnings };
  const nodes = /* @__PURE__ */ new Map();
  for (const n of raw.nodes) {
    if (!n || !n.id) {
      warnings.push("Skipped a node with no id.");
      continue;
    }
    const key = norm(n.id);
    if (nodes.has(key)) {
      warnings.push(`Duplicate node ${n.id}; kept the first.`);
      continue;
    }
    nodes.set(key, {
      id: n.id,
      key,
      system: n.system || systemFromId(n.id),
      kind: n.kind || "table",
      name: n.name || nameFromId(n.id),
      terminal: n.terminal || null,
      lastUpdated: n.lastUpdated || null,
      freshness: n.freshness || null,
      note: n.note || "",
      owner: n.owner || "",
      details: n.details && typeof n.details === "object" && !Array.isArray(n.details) ? n.details : null
    });
  }
  const edges = [];
  for (const e of raw.edges) {
    if (!e || !e.from || !e.to) {
      warnings.push('Skipped an edge without "from" and "to".');
      continue;
    }
    const from = norm(e.from);
    const to = norm(e.to);
    for (const [key, id] of [[from, e.from], [to, e.to]]) {
      if (!nodes.has(key)) {
        warnings.push(`Edge names ${id}, which isn't in "nodes"; added it.`);
        nodes.set(key, { id, key, system: systemFromId(id), kind: "table", name: nameFromId(id), terminal: null, lastUpdated: null, freshness: null, note: "" });
      }
    }
    if (from === to) {
      warnings.push(`Skipped an edge from ${e.from} to itself.`);
      continue;
    }
    edges.push({
      from,
      to,
      via: e.via || "",
      evidence: e.evidence || "",
      confidence: e.confidence === CONFIDENCE.INFERRED ? CONFIDENCE.INFERRED : CONFIDENCE.RECORDED
    });
  }
  for (const s of Array.isArray(raw.stops) ? raw.stops : []) {
    const key = norm(s?.node);
    const node = nodes.get(key);
    if (!node) {
      warnings.push(`A stop names ${s?.node}, which isn't in "nodes"; skipped.`);
      continue;
    }
    node.terminal = s.terminal === TERMINAL.ORIGIN ? TERMINAL.ORIGIN : TERMINAL.BEST_KNOWN;
    node.stopReason = s.reason || "";
  }
  const anchors = /* @__PURE__ */ new Map();
  for (const [k, v] of Object.entries(raw.anchors || {})) anchors.set(String(k), norm(v));
  const feeders = /* @__PURE__ */ new Map();
  for (const e of edges) {
    if (!feeders.has(e.to)) feeders.set(e.to, []);
    feeders.get(e.to).push(e);
  }
  return {
    upstream: {
      version: 1,
      generatedAt: raw.generatedAt || null,
      generatedBy: raw.generatedBy || "",
      pbipCommit: raw.pbipCommit || null,
      anchors,
      nodes,
      edges,
      feeders
    },
    errors,
    warnings
  };
}
function sourceNodeIdForTable(dataSource) {
  if (!dataSource) return null;
  if (dataSource.sourceType === "Databricks" || dataSource.type === "Databricks") {
    const fqn = dataSource.fqn || [dataSource.database, dataSource.schema, dataSource.sourceTable].filter(Boolean).join(".");
    return fqn && fqn.split(".").length === 3 ? `dbx:${fqn}` : null;
  }
  if ((dataSource.sourceType === "SQL" || dataSource.type === "SQL") && dataSource.database && dataSource.sourceTable) {
    return `sql:${dataSource.database}.${dataSource.schema || "dbo"}.${dataSource.sourceTable}`;
  }
  if ((dataSource.sourceType === "Dataflow" || dataSource.type === "Dataflow") && dataSource.database && dataSource.sourceTable) {
    return `pbi-df:${dataSource.database}/${dataSource.sourceTable}`;
  }
  return null;
}
function upstreamNeighbors(upstream, key) {
  const node = upstream?.nodes.get(norm(key));
  if (!node) return null;
  const fedBy = (upstream.feeders.get(node.key) || []).map((e) => ({ node: upstream.nodes.get(e.from), edge: e }));
  const feeds = upstream.edges.filter((e) => e.from === node.key).map((e) => ({ node: upstream.nodes.get(e.to), edge: e }));
  return { node, feeds, fedBy, terminal: terminalOf(upstream, node) };
}
function anchorForTable(upstream, tableName, dataSource, modelName = "") {
  if (!upstream || !tableName) return null;
  const candidates = [modelName && `${modelName}/${tableName}`, tableName];
  for (const c of candidates) {
    if (c && upstream.anchors.has(c)) return upstream.anchors.get(c);
  }
  for (const [k, v] of upstream.anchors) {
    if (k.split("/").pop() === tableName) return v;
  }
  const own = norm(sourceNodeIdForTable(dataSource));
  if (own && upstream.nodes.has(own)) return own;
  return null;
}
function upstreamTree(upstream, startKey, opts = {}) {
  const maxDepth = opts.maxDepth ?? 12;
  const start = upstream?.nodes.get(startKey);
  if (!start) return null;
  const walk = (key, depth, path, edge) => {
    const node = upstream.nodes.get(key);
    const out = { node, edge: edge || null, depth, children: [], truncated: false };
    if (depth >= maxDepth) {
      out.truncated = (upstream.feeders.get(key) || []).length > 0;
      return out;
    }
    for (const e of upstream.feeders.get(key) || []) {
      if (opts.hideInferred && e.confidence === CONFIDENCE.INFERRED) continue;
      if (path.has(e.from)) continue;
      const fromNode = upstream.nodes.get(e.from);
      if (opts.systems && fromNode && !opts.systems.has((fromNode.system || "").toLowerCase())) continue;
      out.children.push(walk(e.from, depth + 1, /* @__PURE__ */ new Set([...path, e.from]), e));
    }
    return out;
  };
  return walk(startKey, 0, /* @__PURE__ */ new Set([startKey]), null);
}
function terminalOf(upstream, node) {
  if (node.terminal === TERMINAL.ORIGIN) return TERMINAL.ORIGIN;
  if (node.terminal === TERMINAL.BEST_KNOWN) return TERMINAL.BEST_KNOWN;
  return (upstream.feeders.get(node.key) || []).length === 0 ? TERMINAL.BEST_KNOWN : null;
}
function summarizeUpstream(upstream, startKey, opts = {}) {
  const tree = upstreamTree(upstream, startKey, opts);
  if (!tree) return null;
  const origins = [];
  const bestKnown = [];
  const systems = /* @__PURE__ */ new Set();
  const stale = [];
  let inferredEdges = 0;
  let depth = 0;
  const seen = /* @__PURE__ */ new Set();
  const visit = (t) => {
    if (seen.has(t.node.key + "@" + t.depth)) return;
    seen.add(t.node.key + "@" + t.depth);
    depth = Math.max(depth, t.depth);
    systems.add(t.node.system);
    if (t.edge?.confidence === CONFIDENCE.INFERRED) inferredEdges++;
    if (t.node.freshness?.status && t.node.freshness.status !== "ok") stale.push(t.node);
    if (t.children.length === 0) {
      const term = terminalOf(upstream, t.node);
      if (term === TERMINAL.ORIGIN) {
        if (!origins.includes(t.node)) origins.push(t.node);
      } else if (!bestKnown.includes(t.node)) bestKnown.push(t.node);
    }
    t.children.forEach(visit);
  };
  visit(tree);
  return {
    firstHop: tree.children[0]?.node.name || "",
    depth,
    origins,
    bestKnown,
    systems: [...systems].map(systemLabel),
    inferredEdges,
    stale
  };
}
function systemsInUpstream(upstream) {
  return [...new Set([...upstream.nodes.values()].map((n) => (n.system || "").toLowerCase()))].filter(Boolean).sort();
}
function isUpstreamStale(upstream, currentCommit) {
  if (!upstream?.pbipCommit || !currentCommit) return false;
  const a = upstream.pbipCommit.toLowerCase();
  const b = currentCommit.toLowerCase();
  return !(a.startsWith(b) || b.startsWith(a));
}
function systemFromId(id) {
  const prefix = String(id).split(":")[0].toLowerCase();
  return { dbx: "databricks", sql: "sqlserver", fabric: "fabric", "pbi-df": "dataflow", dbt: "dbt", file: "file", api: "api", ext: "external" }[prefix] || "external";
}
function nameFromId(id) {
  const s = String(id);
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/daxParser.js
var TABLE_FUNCTIONS = [
  "CALCULATE",
  "CALCULATETABLE",
  "FILTER",
  "SUMX",
  "AVERAGEX",
  "COUNTX",
  "MAXX",
  "MINX",
  "RANKX",
  "ADDCOLUMNS",
  "SELECTCOLUMNS",
  "RELATEDTABLE",
  "ALL",
  "ALLEXCEPT",
  "VALUES",
  "DISTINCT",
  "TOPN",
  "GENERATE",
  "TABLEOF",
  "NAMEOF",
  "SAMEPERIODLASTYEAR",
  "DATEADD",
  "DATESYTD",
  "DATESMTD",
  "DATESQTD"
];
function stripStringsAndComments(dax) {
  return dax.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ").replace(/"(?:[^"\\]|"")*"/g, " ");
}
function extractColumnRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const pattern = /(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]/g;
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    const table = m[1] || m[2];
    const column = m[3];
    const key = `${table}[${column}]`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ table, column });
    }
  }
  return refs;
}
function extractMeasureRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const pattern = /(?<![\w'])\[([^\]]+)\]/g;
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    const measure = m[1];
    if (!seen.has(measure)) {
      seen.add(measure);
      refs.push({ measure });
    }
  }
  return refs;
}
function extractTableRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const funcList = TABLE_FUNCTIONS.join("|");
  const pattern = new RegExp(
    `(?:${funcList})\\s*\\(\\s*(?:'([^']+)'|([A-Za-z_]\\w*))`,
    "gi"
  );
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    const table = m[1] || m[2];
    if (table && !seen.has(table) && !isDAXKeyword(table)) {
      seen.add(table);
      refs.push(table);
    }
  }
  return refs;
}
function isDAXKeyword(name) {
  const keywords = /* @__PURE__ */ new Set([
    "TRUE",
    "FALSE",
    "BLANK",
    "NOT",
    "AND",
    "OR",
    "IN",
    "VAR",
    "RETURN",
    "IF",
    "SWITCH",
    "SELECTEDVALUE"
  ]);
  return keywords.has(name.toUpperCase());
}
function extractUseRelationshipRefs(dax) {
  const clean = stripStringsAndComments(dax);
  const pattern = /USERELATIONSHIP\s*\(\s*(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]\s*,\s*(?:'([^']+)'|([A-Za-z_]\w*))\[([^\]]+)\]\s*\)/gi;
  const refs = [];
  let m;
  while ((m = pattern.exec(clean)) !== null) {
    refs.push({
      fromTable: m[1] || m[2],
      fromColumn: m[3],
      toTable: m[4] || m[5],
      toColumn: m[6]
    });
  }
  return refs;
}
function parseDaxExpression(daxExpression) {
  if (!daxExpression || typeof daxExpression !== "string") {
    return { tableRefs: [], columnRefs: [], measureRefs: [], useRelationshipRefs: [] };
  }
  const columnRefs = extractColumnRefs(daxExpression);
  const measureRefs = extractMeasureRefs(daxExpression);
  const tableRefs = extractTableRefs(daxExpression);
  const useRelationshipRefs = extractUseRelationshipRefs(daxExpression);
  const tableSet = new Set(tableRefs);
  for (const col of columnRefs) {
    if (!tableSet.has(col.table)) {
      tableSet.add(col.table);
      tableRefs.push(col.table);
    }
  }
  return { tableRefs, columnRefs, measureRefs, useRelationshipRefs };
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/changeTypes.js
var CHANGE_TYPES = {
  DEFAULT_PAGE_CHANGED: "default_page_changed",
  PAGE_ADDED: "page_added",
  PAGE_REMOVED: "page_removed",
  FILTER_ADDED: "filter_added",
  FILTER_REMOVED: "filter_removed",
  FILTER_CHANGED: "filter_changed",
  MEASURE_CHANGED: "measure_changed",
  MEASURE_ADDED: "measure_added",
  MEASURE_REMOVED: "measure_removed",
  VISUAL_VISIBILITY_CHANGED: "visual_visibility_changed",
  VISUAL_FILTER_ADDED: "visual_filter_added",
  VISUAL_FILTER_REMOVED: "visual_filter_removed",
  VISUAL_FILTER_CHANGED: "visual_filter_changed",
  VISUAL_BOOKMARK_CHANGED: "visual_bookmark_changed",
  VISUAL_ADDED: "visual_added",
  VISUAL_REMOVED: "visual_removed",
  VISUAL_FIELD_CHANGED: "visual_field_changed",
  BOOKMARK_CHANGED: "bookmark_changed",
  CALC_ITEM_CHANGED: "calc_item_changed",
  CALC_ITEM_ADDED: "calc_item_added",
  CALC_ITEM_REMOVED: "calc_item_removed",
  COLUMN_ADDED: "column_added",
  COLUMN_REMOVED: "column_removed",
  COLUMN_TYPE_CHANGED: "column_type_changed",
  RELATIONSHIP_ADDED: "relationship_added",
  RELATIONSHIP_REMOVED: "relationship_removed",
  RELATIONSHIP_CHANGED: "relationship_changed",
  SOURCE_EXPRESSION_CHANGED: "source_expression_changed",
  EXPRESSION_CHANGED: "expression_changed",
  PARAMETER_CHANGED: "parameter_changed"
};
var CHANGE_SCOPES = {
  PAGE: "page",
  REPORT: "report",
  VISUAL: "visual",
  MEASURE: "measure",
  BOOKMARK: "bookmark",
  COLUMN: "column",
  RELATIONSHIP: "relationship",
  SOURCE: "source",
  EXPRESSION: "expression"
};
function createChange({ type, scope, target, description, impact = [], details = {} }) {
  return { type, scope, target, description, impact, details };
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/filterDiff.js
function diffFilters(beforeFilters, afterFilters, context) {
  const changes = [];
  const { scope, target, locationLabel } = context;
  const beforeMap = /* @__PURE__ */ new Map();
  for (const f of beforeFilters) {
    if (f.name) beforeMap.set(f.name, f);
  }
  const afterMap = /* @__PURE__ */ new Map();
  for (const f of afterFilters) {
    if (f.name) afterMap.set(f.name, f);
  }
  for (const [name, filter] of afterMap) {
    if (!beforeMap.has(name)) {
      const filterDesc = describeFilter(filter);
      const changeType = scope === CHANGE_SCOPES.VISUAL ? CHANGE_TYPES.VISUAL_FILTER_ADDED : CHANGE_TYPES.FILTER_ADDED;
      changes.push(createChange({
        type: changeType,
        scope,
        target: { ...target, filterName: name },
        description: `Added filter on ${filterDesc} to ${locationLabel}`,
        details: { after: summarizeFilter(filter) }
      }));
    }
  }
  for (const [name, filter] of beforeMap) {
    if (!afterMap.has(name)) {
      const filterDesc = describeFilter(filter);
      const changeType = scope === CHANGE_SCOPES.VISUAL ? CHANGE_TYPES.VISUAL_FILTER_REMOVED : CHANGE_TYPES.FILTER_REMOVED;
      changes.push(createChange({
        type: changeType,
        scope,
        target: { ...target, filterName: name },
        description: `Removed filter on ${filterDesc} from ${locationLabel}`,
        details: { before: summarizeFilter(filter) }
      }));
    }
  }
  for (const [name, afterFilter] of afterMap) {
    const beforeFilter = beforeMap.get(name);
    if (!beforeFilter) continue;
    const beforeSummary = summarizeFilter(beforeFilter);
    const afterSummary = summarizeFilter(afterFilter);
    if (JSON.stringify(beforeSummary) !== JSON.stringify(afterSummary)) {
      const filterDesc = describeFilter(afterFilter);
      const changeType = scope === CHANGE_SCOPES.VISUAL ? CHANGE_TYPES.VISUAL_FILTER_CHANGED : CHANGE_TYPES.FILTER_CHANGED;
      let description = `Changed filter on ${filterDesc} in ${locationLabel}`;
      const valueDiff = describeValueChange(beforeFilter, afterFilter);
      if (valueDiff) description += `: ${valueDiff}`;
      changes.push(createChange({
        type: changeType,
        scope,
        target: { ...target, filterName: name },
        description,
        details: { before: beforeSummary, after: afterSummary }
      }));
    }
  }
  return changes;
}
function detectReportFilterChanges(beforeFiles, afterFiles) {
  const beforeReport = findReportJson(beforeFiles);
  const afterReport = findReportJson(afterFiles);
  if (!beforeReport && !afterReport) return [];
  try {
    const beforeConfig = beforeReport ? JSON.parse(beforeReport) : {};
    const afterConfig = afterReport ? JSON.parse(afterReport) : {};
    const beforeFilters = extractReportFilters(beforeConfig);
    const afterFilters = extractReportFilters(afterConfig);
    return diffFilters(beforeFilters, afterFilters, {
      scope: CHANGE_SCOPES.REPORT,
      target: {},
      locationLabel: "filters on all pages"
    });
  } catch {
    return [];
  }
}
function extractReportFilters(config) {
  if (config.filterConfig?.filters) return config.filterConfig.filters;
  const filters = [];
  if (config.filters && Array.isArray(config.filters)) {
    return config.filters;
  }
  return filters;
}
function describeFilter(filter) {
  const field = filter.field;
  if (!field) return `"${filter.name || "unknown"}"`;
  let entity = "";
  let property = "";
  if (field.Column) {
    entity = field.Column.Expression?.SourceRef?.Entity || "";
    property = field.Column.Property || "";
  } else if (field.Measure) {
    entity = field.Measure.Expression?.SourceRef?.Entity || "";
    property = field.Measure.Property || "";
  }
  if (entity && property) return `${entity}[${property}]`;
  if (entity) return entity;
  if (property) return property;
  return `"${filter.name || "unknown"}"`;
}
function summarizeFilter(filter) {
  const summary = {
    entity: "",
    property: "",
    type: filter.type || "",
    isHiddenInViewMode: filter.isHiddenInViewMode || false
  };
  const field = filter.field;
  if (field?.Column) {
    summary.entity = field.Column.Expression?.SourceRef?.Entity || "";
    summary.property = field.Column.Property || "";
  } else if (field?.Measure) {
    summary.entity = field.Measure.Expression?.SourceRef?.Entity || "";
    summary.property = field.Measure.Property || "";
  }
  summary.values = extractFilterValues(filter);
  return summary;
}
function extractFilterValues(filter) {
  const values = [];
  const where = filter.filter?.Where;
  if (!Array.isArray(where)) return values;
  for (const clause of where) {
    const inExpr = clause.Condition?.In;
    if (inExpr?.Values) {
      for (const valArr of inExpr.Values) {
        for (const val of valArr) {
          if (val.Literal?.Value) {
            values.push(val.Literal.Value.replace(/^'|'$/g, ""));
          }
        }
      }
    }
    const notExpr = clause.Condition?.Not?.Expression?.In;
    if (notExpr?.Values) {
      for (const valArr of notExpr.Values) {
        for (const val of valArr) {
          if (val.Literal?.Value) {
            values.push("NOT: " + val.Literal.Value.replace(/^'|'$/g, ""));
          }
        }
      }
    }
    const comparison = clause.Condition?.Comparison || clause.Condition?.comparison;
    if (comparison) {
      const op = comparison.ComparisonKind ?? "";
      const right = comparison.Right?.Literal?.Value;
      if (right !== void 0) {
        values.push(`${op} ${String(right).replace(/^'|'$/g, "")}`);
      }
    }
  }
  return values;
}
function describeValueChange(beforeFilter, afterFilter) {
  const beforeValues = extractFilterValues(beforeFilter);
  const afterValues = extractFilterValues(afterFilter);
  if (beforeValues.length === 0 && afterValues.length === 0) return "";
  const added = afterValues.filter((v) => !beforeValues.includes(v));
  const removed = beforeValues.filter((v) => !afterValues.includes(v));
  const parts = [];
  if (added.length > 0) parts.push(`selected ${added.map((v) => `"${v}"`).join(", ")}`);
  if (removed.length > 0) parts.push(`deselected ${removed.map((v) => `"${v}"`).join(", ")}`);
  return parts.join("; ");
}
function findReportJson(files) {
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/report.json") || lower === "definition/report.json") {
      return content;
    }
  }
  return null;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/pbirParser.js
function parsePbirReport(visualFiles, pageFiles) {
  const pages = [];
  const visuals = [];
  let reportFilters = [];
  for (const { path, content } of pageFiles) {
    const lowerPath = path.replace(/\\/g, "/").toLowerCase();
    if (lowerPath.endsWith("/report.json") || lowerPath === "report.json") {
      try {
        const config = JSON.parse(content);
        reportFilters = extractFilterRefs(config.filterConfig?.filters || []);
      } catch (err) {
      }
      continue;
    }
    if (lowerPath.endsWith(".pbir")) continue;
    try {
      const config = JSON.parse(content);
      const pageFolderId = extractPageIdFromPath(path);
      const pageName = extractPageName(path, config);
      pages.push({
        id: pageFolderId || pageName,
        name: pageName,
        displayName: config.displayName || config.name || pageName,
        order: config.ordinal ?? config.order ?? pages.length,
        width: config.width || config.defaultSize?.width || 1280,
        height: config.height || config.defaultSize?.height || 720,
        filters: extractFilterRefs(config.filterConfig?.filters || []),
        path
      });
    } catch (err) {
      const pageName = extractPageName(path, null);
      const pageFolderId2 = extractPageIdFromPath(path);
      if (pageName) {
        pages.push({
          id: pageFolderId2 || pageName,
          name: pageName,
          displayName: pageName,
          order: pages.length,
          filters: [],
          path
        });
      }
    }
  }
  for (const { path, content } of visualFiles) {
    try {
      const config = JSON.parse(content);
      const pageId = extractPageIdFromPath(path);
      const parsed = parseVisualConfig(config, pageId);
      parsed.path = path;
      visuals.push(parsed);
    } catch (err) {
      console.warn(`Failed to parse visual config: ${path}`, err);
    }
  }
  return { pages, visuals, reportFilters };
}
function filterIsActive(filter) {
  return extractFilterValues(filter).length > 0;
}
function extractFilterRefs(filterArr) {
  const refs = [];
  if (!Array.isArray(filterArr)) return refs;
  for (const filter of filterArr) {
    const ref = extractFromPbirField(filter.field, "filter");
    if (!ref) continue;
    refs.push({
      ...ref,
      name: filter.name || "",
      filterType: filter.type || "",
      isHiddenInViewMode: filter.isHiddenInViewMode === true,
      isActive: filterIsActive(filter)
    });
  }
  return refs;
}
function extractPageName(path, config) {
  if (config && (config.displayName || config.name)) {
    return config.displayName || config.name;
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const pageIdx = parts.findIndex((p) => p.toLowerCase() === "pages");
  if (pageIdx !== -1 && pageIdx + 1 < parts.length) {
    return parts[pageIdx + 1];
  }
  const jsonIdx = parts.length - 1;
  return parts[Math.max(0, jsonIdx - 1)];
}
function extractPageIdFromPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const pagesIdx = parts.findIndex((p) => p.toLowerCase() === "pages");
  if (pagesIdx !== -1 && pagesIdx + 1 < parts.length) {
    return parts[pagesIdx + 1];
  }
  return "";
}
function parseVisualConfig(config, pageName) {
  const visual = config.visual || config;
  const id = visual.id || config.id || config.name || "";
  const isGroup = !!config.visualGroup;
  const visualType = isGroup ? "group" : visual.visualType || visual.type || config.visualType || "unknown";
  let title = "";
  if (visual.title) {
    title = typeof visual.title === "string" ? visual.title : visual.title.text || "";
  }
  if (!title && visual.objects?.title?.properties?.text) {
    const textProp = visual.objects.title.properties.text;
    if (typeof textProp === "string") title = textProp;
    else if (textProp.expr?.Literal?.Value) title = textProp.expr.Literal.Value.replace(/^'|'$/g, "");
  }
  if (!title && visual.vcObjects?.title) {
    const titleArr = visual.vcObjects.title;
    if (Array.isArray(titleArr) && titleArr[0]?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr[0].properties.text.expr.Literal.Value.replace(/^'|'$/g, "");
    } else if (titleArr?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr.properties.text.expr.Literal.Value.replace(/^'|'$/g, "");
    }
  }
  if (!title && visual.visualContainerObjects?.title) {
    const titleArr = visual.visualContainerObjects.title;
    if (Array.isArray(titleArr) && titleArr[0]?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr[0].properties.text.expr.Literal.Value.replace(/^'|'$/g, "");
    } else if (titleArr?.properties?.text?.expr?.Literal?.Value) {
      title = titleArr.properties.text.expr.Literal.Value.replace(/^'|'$/g, "");
    }
  }
  const fields = extractFieldReferences(visual, config);
  const filterConfigFilters = config.filterConfig?.filters || visual.filterConfig?.filters || [];
  const filters = extractFilterRefs(filterConfigFilters);
  const isHidden = config.isHidden === true || visual.isHidden === true;
  const parentGroupName = config.parentGroupName || null;
  if (isGroup && !title && config.visualGroup?.displayName) {
    title = config.visualGroup.displayName;
  }
  return {
    id,
    type: visualType,
    visualType,
    page: pageName,
    pageId: pageName,
    title,
    fields,
    filters,
    position: config.position || null,
    isHidden,
    parentGroupName
  };
}
function extractFieldReferences(visualConfig, fullConfig) {
  const fields = [];
  const seen = /* @__PURE__ */ new Set();
  function addField(field) {
    const key = `${field.type}|${field.table}|${field.column || ""}|${field.measure || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      fields.push(field);
    }
  }
  const query = visualConfig.prototypeQuery || visualConfig.query;
  const sourceAliasMap = {};
  if (query?.From) {
    for (const from of query.From) {
      if (from.Name && from.Entity) {
        sourceAliasMap[from.Name] = from.Entity;
      }
    }
  }
  if (query?.Select) {
    for (const selectItem of query.Select) {
      const ref = extractFromSelectItem(selectItem, sourceAliasMap);
      if (ref) addField(ref);
    }
  }
  const queryState = visualConfig.query?.queryState || visualConfig.queryState;
  if (queryState) {
    for (const [role, roleState] of Object.entries(queryState)) {
      if (!roleState || typeof roleState !== "object") continue;
      const projections = roleState.projections;
      if (Array.isArray(projections)) {
        for (const proj of projections) {
          const ref = extractFromPbirProjection(proj, role);
          if (ref) addField(ref);
        }
      }
      const fieldParams = roleState.fieldParameters;
      if (Array.isArray(fieldParams)) {
        for (const fp of fieldParams) {
          const paramExpr = fp.parameterExpr || fp.ParameterExpr;
          if (!paramExpr) continue;
          const col = paramExpr.Column || paramExpr.column;
          if (!col) continue;
          const sourceRef = col.Expression?.SourceRef || col.expression?.sourceRef;
          const entity = sourceRef?.Entity || sourceRef?.entity || "";
          if (entity) {
            addField({ type: "fieldParameter", table: entity, column: null, measure: null, role });
          }
        }
      }
    }
  }
  const bindings = visualConfig.dataRoleBindings || visualConfig.columnBindings;
  if (bindings) {
    for (const [role, binding] of Object.entries(bindings)) {
      const items = Array.isArray(binding) ? binding : binding.items || binding.bindings || [binding];
      for (const item of items) {
        const ref = extractFromBinding(item, role);
        if (ref) addField(ref);
      }
    }
  }
  deepSearchForRefs(visualConfig.vcObjects, addField);
  deepSearchForRefs(visualConfig.visualContainerObjects, addField);
  deepSearchForRefs(visualConfig.objects, addField);
  deepSearchForRefs(visualConfig.dataTransforms, addField);
  return fields;
}
function extractFromPbirProjection(proj, role) {
  const field = proj?.field;
  if (!field) return null;
  return extractFromPbirField(field, role);
}
function extractFromPbirField(field, role) {
  if (!field) return null;
  if (field.Measure) {
    const entity = field.Measure.Expression?.SourceRef?.Entity || "";
    const property = field.Measure.Property || "";
    if (entity || property) {
      return { type: "measure", table: entity, column: null, measure: property, role: role || "" };
    }
  }
  if (field.Column) {
    const entity = field.Column.Expression?.SourceRef?.Entity || "";
    const property = field.Column.Property || "";
    if (entity || property) {
      return { type: "column", table: entity, column: property, measure: null, role: role || "" };
    }
  }
  if (field.Aggregation) {
    const expr = field.Aggregation.Expression;
    if (expr?.Column) {
      const entity = expr.Column.Expression?.SourceRef?.Entity || "";
      const property = expr.Column.Property || "";
      if (entity || property) {
        return { type: "column", table: entity, column: property, measure: null, role: role || "" };
      }
    }
  }
  return null;
}
function extractFromSelectItem(selectItem, sourceAliasMap = {}) {
  function resolveEntity(sourceRef) {
    if (!sourceRef) return "";
    if (sourceRef.Entity) return sourceRef.Entity;
    if (sourceRef.Source && sourceAliasMap[sourceRef.Source]) {
      return sourceAliasMap[sourceRef.Source];
    }
    return sourceRef.Source || "";
  }
  if (selectItem.Column) {
    const col = selectItem.Column;
    const entity = resolveEntity(col.Expression?.SourceRef);
    const property = col.Property || col.Name || "";
    if (entity || property) {
      return {
        type: "column",
        table: entity,
        column: property,
        measure: null,
        role: selectItem.Name || ""
      };
    }
  }
  if (selectItem.Measure) {
    const meas = selectItem.Measure;
    const entity = resolveEntity(meas.Expression?.SourceRef);
    const property = meas.Property || meas.Name || "";
    if (entity || property) {
      return {
        type: "measure",
        table: entity,
        column: null,
        measure: property,
        role: selectItem.Name || ""
      };
    }
  }
  if (selectItem.Aggregation) {
    const agg = selectItem.Aggregation;
    const expr = agg.Expression;
    if (expr?.Column) {
      const entity = resolveEntity(expr.Column.Expression?.SourceRef);
      const property = expr.Column.Property || "";
      if (entity || property) {
        return {
          type: "column",
          table: entity,
          column: property,
          measure: null,
          role: selectItem.Name || ""
        };
      }
    }
  }
  return null;
}
function extractFromBinding(item, role) {
  if (!item || typeof item !== "object") return null;
  if (item.table && (item.column || item.measure)) {
    return {
      type: item.measure ? "measure" : "column",
      table: item.table,
      column: item.column || null,
      measure: item.measure || null,
      role
    };
  }
  const expr = item.Expression || item.expression || item;
  if (expr?.SourceRef?.Entity) {
    return {
      type: item.measure || item.Measure ? "measure" : "column",
      table: expr.SourceRef.Entity,
      column: item.Property || item.column || null,
      measure: item.Property || item.measure || null,
      role
    };
  }
  return null;
}
function deepSearchForRefs(obj, addField, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 15) return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepSearchForRefs(item, addField, depth + 1);
    }
    return;
  }
  if (obj.SourceRef?.Entity && obj.Property) {
    addField({
      type: "column",
      // default; caller context may override
      table: obj.SourceRef.Entity,
      column: obj.Property,
      measure: null,
      role: ""
    });
  }
  if (obj.Column?.Expression?.SourceRef?.Entity) {
    addField({
      type: "column",
      table: obj.Column.Expression.SourceRef.Entity,
      column: obj.Column.Property || "",
      measure: null,
      role: obj.Name || ""
    });
  }
  if (obj.Measure?.Expression?.SourceRef?.Entity) {
    addField({
      type: "measure",
      table: obj.Measure.Expression.SourceRef.Entity,
      column: null,
      measure: obj.Measure.Property || "",
      role: obj.Name || ""
    });
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      deepSearchForRefs(value, addField, depth + 1);
    }
  }
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/roleParser.js
function parseRoles(roleFiles = []) {
  const roles = [];
  for (const { content } of roleFiles) {
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("///") || trimmed.startsWith("//")) continue;
      const roleMatch = trimmed.match(/^role\s+(.+)$/);
      if (roleMatch) {
        current = {
          name: unquoteName(roleMatch[1].trim()),
          modelPermission: "",
          tablePermissions: []
        };
        roles.push(current);
        continue;
      }
      if (!current) continue;
      const permMatch = trimmed.match(/^modelPermission\s*:\s*(.+)$/);
      if (permMatch) {
        current.modelPermission = permMatch[1].trim();
        continue;
      }
      const tpMatch = trimmed.match(/^tablePermission\s+(.+?)\s*=\s*(.*)$/);
      if (tpMatch) {
        const table = unquoteName(tpMatch[1].trim());
        const expression = (extractDaxExpression(lines, i) || tpMatch[2] || "").trim();
        current.tablePermissions.push({ table, expression });
      }
    }
  }
  return roles;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/utils/constants.js
var NODE_TYPES = {
  TABLE: "table",
  COLUMN: "column",
  MEASURE: "measure",
  VISUAL: "visual",
  PAGE: "page",
  SOURCE: "source",
  EXPRESSION: "expression",
  /** A row-level-security role defined in the semantic model. */
  ROLE: "role"
};
var EDGE_TYPES = {
  VISUAL_TO_FIELD: "visual_to_field",
  MEASURE_TO_MEASURE: "measure_to_measure",
  MEASURE_TO_COLUMN: "measure_to_column",
  COLUMN_TO_TABLE: "column_to_table",
  TABLE_RELATIONSHIP: "table_relationship",
  VISUAL_TO_PAGE: "visual_to_page",
  FIELD_PARAM_TO_FIELD: "field_param_to_field",
  TABLE_TO_SOURCE: "table_to_source",
  CALC_COLUMN_TO_COLUMN: "calc_column_to_column",
  CALC_COLUMN_TO_MEASURE: "calc_column_to_measure",
  MEASURE_TO_USERELATIONSHIP: "measure_to_userelationship",
  TABLE_TO_EXPRESSION: "table_to_expression",
  EXPRESSION_TO_SOURCE: "expression_to_source",
  COLUMN_TO_SOURCE_COLUMN: "column_to_source_column",
  TABLE_TO_TABLE_JOIN: "table_to_table_join",
  /** An active (non-default) report/page/visual filter pane reference to a field. */
  FILTER_TO_FIELD: "filter_to_field",
  /** A row-level-security role's table permission referencing a field. */
  RLS_TO_FIELD: "rls_to_field"
};
var ENRICHMENT_TYPES = {
  FIELD_PARAMETER: "field_parameter",
  CALCULATION_GROUP: "calculation_group"
};
var LAYER_COLORS = {
  visual: "#4caf50",
  // Grouping node for "Used by N visuals" — same family as visual, dimmer.
  visualGroup: "#2e7d32",
  measure: "#ff9800",
  // Things that REFERENCE the selected measure (measures / calc columns).
  dependent: "#e91e63",
  dependentGroup: "#ad1457",
  subMeasure: "#ffb74d",
  table: "#4285f4",
  column: "#9c27b0",
  expression: "#795548",
  source: "#607d8b",
  hub: "#546e7a",
  // A report grouping its visuals, in a multi-report workspace.
  report: "#26a69a",
  // Upstream lineage beyond the source connection (from .lineage/upstream.json).
  upstream: "#5c9ead",
  origin: "#66bb6a",
  bestKnown: "#ffa726"
};

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/enrichment.js
function detectFieldParameter(table) {
  const result = { isFieldParam: false, referencedFields: [], switchMeasure: null };
  if (!table) return result;
  const columns = table.columns || [];
  const measures = table.measures || [];
  const nameofPattern = /NAMEOF\s*\(\s*(?:'([^']+)'\s*\[([^\]]+)\]|\[([^\]]+)\])\s*\)/gi;
  const nameofFields = [];
  for (const col of columns) {
    const expr = col.expression || col.daxExpression || "";
    let m;
    nameofPattern.lastIndex = 0;
    while ((m = nameofPattern.exec(expr)) !== null) {
      if (m[1] && m[2]) {
        nameofFields.push({ name: m[2], reference: `'${m[1]}'[${m[2]}]` });
      } else if (m[3]) {
        nameofFields.push({ name: m[3], reference: `[${m[3]}]` });
      }
    }
  }
  const partitions = table.partitions || [];
  for (const partition of partitions) {
    const src = partition.sourceExpression || "";
    const rowPattern = /\(\s*"([^"]+)"\s*,\s*NAMEOF\s*\(\s*(?:'([^']+)'\s*\[([^\]]+)\]|\[([^\]]+)\])\s*\)\s*,\s*(\d+)\s*\)/gi;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(src)) !== null) {
      const displayName = rowMatch[1];
      const refTable = rowMatch[2];
      const refField = rowMatch[3] || rowMatch[4];
      const ordinal = parseInt(rowMatch[5], 10);
      if (refTable && refField) {
        nameofFields.push({ name: refField, reference: `'${refTable}'[${refField}]`, displayName, ordinal });
      } else if (refField) {
        nameofFields.push({ name: refField, reference: `[${refField}]`, displayName, ordinal });
      }
    }
    let m;
    nameofPattern.lastIndex = 0;
    while ((m = nameofPattern.exec(src)) !== null) {
      const refField = m[2] || m[3];
      if (refField && !nameofFields.some((f) => f.name === refField)) {
        if (m[1] && m[2]) {
          nameofFields.push({ name: m[2], reference: `'${m[1]}'[${m[2]}]` });
        } else if (m[3]) {
          nameofFields.push({ name: m[3], reference: `[${m[3]}]` });
        }
      }
    }
  }
  if (nameofFields.length === 0) return result;
  result.isFieldParam = true;
  result.referencedFields = nameofFields;
  for (const measure of measures) {
    const expr = measure.expression || measure.daxExpression || "";
    if (/SWITCH\s*\(\s*SELECTEDVALUE\s*\(/i.test(expr)) {
      result.switchMeasure = measure.name;
      const switchBranchPattern = /,\s*(?:\d+|"[^"]*")\s*,\s*(?:'([^']+)'\s*\[([^\]]+)\]|\[([^\]]+)\])/g;
      let branchMatch;
      while ((branchMatch = switchBranchPattern.exec(expr)) !== null) {
        const name = branchMatch[2] || branchMatch[3];
        let reference;
        if (branchMatch[1] && branchMatch[2]) {
          reference = `'${branchMatch[1]}'[${branchMatch[2]}]`;
        } else if (branchMatch[3]) {
          reference = `[${branchMatch[3]}]`;
        }
        if (name && !result.referencedFields.some((f) => f.name === name)) {
          result.referencedFields.push({ name, reference });
        }
      }
      break;
    }
  }
  return result;
}
function detectCalculationGroup(table) {
  const result = { isCalcGroup: false, calculationItems: [] };
  if (!table) return result;
  const props = table.properties || {};
  if (props.calculationGroup || table.calculationGroup) {
    result.isCalcGroup = true;
  }
  const allExprs = [
    ...(table.columns || []).map((c) => c.expression || c.daxExpression || ""),
    ...(table.measures || []).map((m) => m.expression || m.daxExpression || "")
  ];
  for (const expr of allExprs) {
    if (/CALCULATIONGROUP\s*\(/i.test(expr)) {
      result.isCalcGroup = true;
      break;
    }
  }
  if (table.calculationItems && Array.isArray(table.calculationItems)) {
    result.isCalcGroup = true;
    result.calculationItems = table.calculationItems.map((item) => ({
      name: item.name || "",
      expression: item.expression || item.daxExpression || ""
    }));
  }
  return result;
}
function detectEnrichments(tables, measures) {
  const fieldParameters = [];
  const calculationGroups = [];
  if (!tables || !Array.isArray(tables)) {
    return { fieldParameters, calculationGroups };
  }
  for (const table of tables) {
    const fpResult = detectFieldParameter(table);
    if (fpResult.isFieldParam) {
      fieldParameters.push({
        tableName: table.name,
        fields: fpResult.referencedFields,
        switchMeasure: fpResult.switchMeasure
      });
    }
    const cgResult = detectCalculationGroup(table);
    if (cgResult.isCalcGroup) {
      calculationGroups.push({
        tableName: table.name,
        items: cgResult.calculationItems
      });
    }
  }
  return { fieldParameters, calculationGroups };
}
function applyEnrichments(graph, enrichments) {
  if (!graph || !enrichments) return graph;
  const { fieldParameters = [], calculationGroups = [] } = enrichments;
  const fpMap = /* @__PURE__ */ new Map();
  for (const fp of fieldParameters) {
    fpMap.set(fp.tableName, fp);
  }
  const cgMap = /* @__PURE__ */ new Map();
  for (const cg of calculationGroups) {
    cgMap.set(cg.tableName, cg);
  }
  for (const node of graph.nodes.values()) {
    const tableName = node.metadata?.table || node.name || node.id;
    if (fpMap.has(tableName)) {
      const fp = fpMap.get(tableName);
      node.metadata = node.metadata || {};
      node.metadata.enrichmentType = ENRICHMENT_TYPES.FIELD_PARAMETER;
      node.metadata.badge = "FP";
      node.metadata.fieldParameter = {
        fields: fp.fields,
        switchMeasure: fp.switchMeasure
      };
    }
    if (cgMap.has(tableName)) {
      const cg = cgMap.get(tableName);
      node.metadata = node.metadata || {};
      node.metadata.enrichmentType = ENRICHMENT_TYPES.CALCULATION_GROUP;
      node.metadata.badge = "CG";
      node.metadata.calculationGroup = {
        items: cg.items
      };
    }
  }
  for (const node of graph.nodes.values()) {
    if (node.type === "column" && node.metadata?.table) {
      if (cgMap.has(node.metadata.table)) {
        node.metadata.enrichmentType = ENRICHMENT_TYPES.CALCULATION_GROUP;
      }
    }
  }
  return graph;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/parser/projectStructure.js
var RELEVANT_EXTENSIONS = /* @__PURE__ */ new Set([".tmdl", ".json", ".pbir", ".platform"]);
function identifyProjectStructure(files) {
  const tmdlFiles = [];
  const visualFiles = [];
  const pageFiles = [];
  const relationshipFiles = [];
  const expressionFiles = [];
  const roleFiles = [];
  for (const [path, content] of files) {
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith(".tmdl")) {
      if (lowerPath.includes("relationship")) {
        relationshipFiles.push({ path, content });
      } else if (lowerPath.endsWith("/expressions.tmdl") || lowerPath === "expressions.tmdl" || lowerPath.endsWith("\\expressions.tmdl")) {
        expressionFiles.push({ path, content });
      } else if (/^role\s+/m.test(content)) {
        roleFiles.push({ path, content });
      } else if (/^table\s+/m.test(content)) {
        tmdlFiles.push({ path, content });
      }
    } else if (lowerPath.endsWith(".json")) {
      if (lowerPath.includes("/visuals/") && lowerPath.endsWith("visual.json")) {
        visualFiles.push({ path, content });
      } else if (lowerPath.endsWith("/page.json") || lowerPath.includes("/pages/") && lowerPath.endsWith(".json")) {
        pageFiles.push({ path, content });
      } else if (lowerPath.endsWith("/report.json") || lowerPath.endsWith("/definition.pbir")) {
        pageFiles.push({ path, content });
      }
    } else if (lowerPath.endsWith(".pbir")) {
      pageFiles.push({ path, content });
    }
  }
  return { tmdlFiles, visualFiles, pageFiles, relationshipFiles, expressionFiles, roleFiles };
}
function findDefinitionPbir(files) {
  for (const [path] of files) {
    if (path.toLowerCase() === "definition.pbir" || path.toLowerCase().endsWith("/definition.pbir")) {
      return path;
    }
  }
  return null;
}
function parseSemanticModelReference(content) {
  try {
    const config = JSON.parse(content);
    const byPath = config?.datasetReference?.byPath?.path;
    if (byPath) return byPath;
    return null;
  } catch {
    return null;
  }
}
function isRelevantFile(filename) {
  const ext = filename.includes(".") ? "." + filename.split(".").pop().toLowerCase() : "";
  return RELEVANT_EXTENSIONS.has(ext);
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/graph/graphBuilder.js
function createNode(id, name, type, metadata = {}) {
  return { id, name, type, metadata, enrichment: null };
}
function createEdge(sourceId, targetId, type, metadata) {
  const edge = { source: sourceId, target: targetId, type };
  if (metadata && Object.keys(metadata).length > 0) edge.metadata = metadata;
  return edge;
}
function extractDaxReferences(expression, currentTable, allNodes) {
  if (!expression) return [];
  const refs = [];
  const qualifiedPattern = /'([^']+)'\[([^\]]+)\]|(?<![\w.])(\w+(?:\s+\w+)*)\[([^\]]+)\]/g;
  let match;
  while ((match = qualifiedPattern.exec(expression)) !== null) {
    const table = (match[1] || match[3]).trim();
    const field = (match[2] || match[4]).trim();
    const colId = `column::${table}.${field}`;
    const measureId = `measure::${table}.${field}`;
    if (allNodes.has(measureId)) {
      refs.push(measureId);
    } else if (allNodes.has(colId)) {
      refs.push(colId);
    }
  }
  const unqualifiedPattern = /(?<![\w'])\[([^\]]+)\]/g;
  while ((match = unqualifiedPattern.exec(expression)) !== null) {
    const field = match[1].trim();
    const measureId = `measure::${currentTable}.${field}`;
    const colId = `column::${currentTable}.${field}`;
    if (allNodes.has(measureId) && !refs.includes(measureId)) {
      refs.push(measureId);
    } else if (allNodes.has(colId) && !refs.includes(colId)) {
      refs.push(colId);
    } else {
      let found = false;
      for (const [nodeId, node] of allNodes) {
        if (node.type === "measure" && node.name === field && nodeId !== `measure::${currentTable}.${field}`) {
          if (!refs.includes(nodeId)) {
            refs.push(nodeId);
            found = true;
          }
        }
      }
      if (!found) {
        for (const [nodeId, node] of allNodes) {
          if (node.type === "column" && node.name === field && nodeId !== `column::${currentTable}.${field}`) {
            if (!refs.includes(nodeId)) {
              refs.push(nodeId);
            }
          }
        }
      }
    }
  }
  return refs;
}
function ensureFieldNode(nodes, edges, field) {
  if (field.type === "fieldParameter") return null;
  let fieldId;
  if (field.type === "measure" && field.table && field.measure) {
    fieldId = `measure::${field.table}.${field.measure}`;
  } else if (field.table && field.column) {
    fieldId = `column::${field.table}.${field.column}`;
  }
  if (!fieldId) return null;
  if (!nodes.has(fieldId)) {
    const placeholderName = field.measure || field.column || "unknown";
    const placeholderType = field.type === "measure" ? NODE_TYPES.MEASURE : NODE_TYPES.COLUMN;
    nodes.set(fieldId, createNode(fieldId, placeholderName, placeholderType, {
      table: field.table,
      placeholder: true
    }));
    const tableId = `table::${field.table}`;
    if (field.table && !nodes.has(tableId)) {
      nodes.set(tableId, createNode(tableId, field.table, NODE_TYPES.TABLE, {
        table: field.table,
        placeholder: true
      }));
    }
    if (field.table && placeholderType === NODE_TYPES.COLUMN) {
      edges.push(createEdge(fieldId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
    }
  }
  return fieldId;
}
function buildAdjacency(edges) {
  const upstream = /* @__PURE__ */ new Map();
  const downstream = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  function add(map, key, value) {
    const dedupeKey = `${key}::>${value}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  for (const edge of edges) {
    add(upstream, edge.source, edge.target);
    add(downstream, edge.target, edge.source);
  }
  return { upstream, downstream };
}
function buildGraph(parsedModel, parsedReport, enrichments, roles) {
  const nodes = /* @__PURE__ */ new Map();
  const edges = [];
  if (parsedModel && parsedModel.tables) {
    let resolveParameters = function(mExpr) {
      if (!mExpr || pqParameters.size === 0) return mExpr;
      let resolved = mExpr;
      for (const [paramName, paramValue] of pqParameters) {
        const paramRegex = new RegExp(`(?<![\\w"'])\\b${paramName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?![\\w"'])`, "g");
        resolved = resolved.replace(paramRegex, `"${paramValue}"`);
      }
      return resolved;
    };
    for (const table of parsedModel.tables) {
      const tableId = `table::${table.name}`;
      nodes.set(tableId, createNode(tableId, table.name, NODE_TYPES.TABLE, { table: table.name }));
      if (table.columns) {
        for (const col of table.columns) {
          const colId = `column::${table.name}.${col.name}`;
          nodes.set(colId, createNode(colId, col.name, NODE_TYPES.COLUMN, {
            table: table.name,
            dataType: col.dataType,
            sourceColumn: col.sourceColumn,
            expression: col.expression,
            isHidden: col.isHidden || false
          }));
          edges.push(createEdge(colId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
        }
      }
      if (table.calculatedColumns) {
        for (const col of table.calculatedColumns) {
          const colId = `column::${table.name}.${col.name}`;
          nodes.set(colId, createNode(colId, col.name, NODE_TYPES.COLUMN, {
            table: table.name,
            dataType: col.dataType,
            sourceColumn: col.sourceColumn,
            expression: col.expression,
            isCalculated: true,
            isHidden: col.isHidden || false
          }));
          edges.push(createEdge(colId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
        }
      }
      if (table.measures) {
        for (const measure of table.measures) {
          const measureId = `measure::${table.name}.${measure.name}`;
          nodes.set(measureId, createNode(measureId, measure.name, NODE_TYPES.MEASURE, {
            table: table.name,
            expression: measure.expression,
            description: measure.description || "",
            // formatString/displayFolder come from parseMeasureProperties and are
            // surfaced in the Dependencies strip header.
            formatString: measure.formatString || "",
            displayFolder: measure.displayFolder || "",
            isHidden: measure.isHidden || false
          }));
        }
      }
    }
    for (const table of parsedModel.tables) {
      if (table.measures) {
        for (const measure of table.measures) {
          const measureId = `measure::${table.name}.${measure.name}`;
          const refs = extractDaxReferences(measure.expression, table.name, nodes);
          for (const refId of refs) {
            if (refId === measureId) continue;
            const refNode = nodes.get(refId);
            if (refNode) {
              const edgeType = refNode.type === NODE_TYPES.MEASURE ? EDGE_TYPES.MEASURE_TO_MEASURE : EDGE_TYPES.MEASURE_TO_COLUMN;
              edges.push(createEdge(measureId, refId, edgeType));
            }
          }
          const urRefs = extractUseRelationshipRefs(measure.expression || "");
          for (const ur of urRefs) {
            const fromColId = `column::${ur.fromTable}.${ur.fromColumn}`;
            const toColId = `column::${ur.toTable}.${ur.toColumn}`;
            if (nodes.has(fromColId)) {
              edges.push(createEdge(measureId, fromColId, EDGE_TYPES.MEASURE_TO_USERELATIONSHIP));
            }
            if (nodes.has(toColId)) {
              edges.push(createEdge(measureId, toColId, EDGE_TYPES.MEASURE_TO_USERELATIONSHIP));
            }
          }
        }
      }
      for (const col of [...table.calculatedColumns || [], ...table.columns || []]) {
        if (!col.expression) continue;
        const colId = `column::${table.name}.${col.name}`;
        const refs = extractDaxReferences(col.expression, table.name, nodes);
        for (const refId of refs) {
          if (refId === colId) continue;
          if (nodes.has(refId)) {
            const refNode = nodes.get(refId);
            const edgeType = refNode.type === NODE_TYPES.MEASURE ? EDGE_TYPES.CALC_COLUMN_TO_MEASURE : EDGE_TYPES.CALC_COLUMN_TO_COLUMN;
            edges.push(createEdge(colId, refId, edgeType));
          }
        }
      }
    }
    if (parsedModel.relationships) {
      for (const rel of parsedModel.relationships) {
        const fromTable = `table::${rel.fromTable}`;
        const toTable = `table::${rel.toTable}`;
        if (nodes.has(fromTable) && nodes.has(toTable)) {
          edges.push(createEdge(fromTable, toTable, EDGE_TYPES.TABLE_RELATIONSHIP));
        }
      }
    }
    if (roles && roles.length > 0) {
      for (const role of roles) {
        const roleId = `role::${role.name}`;
        nodes.set(roleId, createNode(roleId, role.name, NODE_TYPES.ROLE, {
          modelPermission: role.modelPermission || "",
          tablePermissions: (role.tablePermissions || []).map((tp) => tp.table)
        }));
        for (const tp of role.tablePermissions || []) {
          if (!tp.expression) continue;
          const refs = extractDaxReferences(tp.expression, tp.table, nodes);
          for (const refId of refs) {
            if (nodes.has(refId)) {
              edges.push(createEdge(roleId, refId, EDGE_TYPES.RLS_TO_FIELD, { table: tp.table }));
            }
          }
        }
      }
    }
    const pqParameters = parsedModel.parameters || /* @__PURE__ */ new Map();
    const expressionMap = /* @__PURE__ */ new Map();
    if (parsedModel.expressions) {
      for (const expr of parsedModel.expressions) {
        if (expr.kind === "expression") {
          const exprId = `expression::${expr.name}`;
          nodes.set(exprId, createNode(exprId, expr.name, NODE_TYPES.EXPRESSION, {
            mExpression: expr.mExpression
          }));
          expressionMap.set(expr.name, expr);
          const resolvedExpr = resolveParameters(expr.mExpression);
          const ds = extractMDataSource(resolvedExpr);
          if (ds) {
            const sourceKey = ds.database ? `${(ds.server || "").toLowerCase()}/${ds.database}` : (ds.server || "").toLowerCase();
            if (sourceKey) {
              const sourceId = `source::${sourceKey}`;
              if (!nodes.has(sourceId)) {
                const displayName = ds.database || ds.server || sourceKey;
                nodes.set(sourceId, createNode(sourceId, displayName, NODE_TYPES.SOURCE, {
                  server: ds.server,
                  database: ds.database,
                  sourceType: ds.type
                }));
              }
              edges.push(createEdge(exprId, sourceId, EDGE_TYPES.EXPRESSION_TO_SOURCE));
            }
            const exprNode = nodes.get(exprId);
            if (exprNode) {
              exprNode.metadata.dataSource = ds;
            }
          }
        }
      }
    }
    const sourceNodeCache = /* @__PURE__ */ new Map();
    for (const table of parsedModel.tables) {
      const sourceExpressions = [];
      for (const partition of table.partitions || []) {
        if (partition.sourceExpression) {
          sourceExpressions.push(partition);
        }
      }
      if (sourceExpressions.length === 0 && table.refreshPolicySource) {
        sourceExpressions.push({ sourceExpression: table.refreshPolicySource, mode: "import" });
      }
      for (const partition of sourceExpressions) {
        if (!partition.sourceExpression) continue;
        const resolvedExpr = resolveParameters(partition.sourceExpression);
        const ds = extractMDataSource(resolvedExpr);
        const trimmedSource = partition.sourceExpression.trim();
        let linkedExprName = null;
        let linkedExpr = null;
        const simpleRefMatch = trimmedSource.match(/^(\w+)$/);
        if (simpleRefMatch && expressionMap.has(simpleRefMatch[1])) {
          linkedExprName = simpleRefMatch[1];
          linkedExpr = expressionMap.get(linkedExprName);
        }
        if (!linkedExpr) {
          let fallbackExprName = null;
          let fallbackExpr = null;
          for (const [exprName, exprObj] of expressionMap) {
            if (exprObj.kind === "parameter") continue;
            const escaped = exprName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const refRegex = new RegExp(`(?<!["''\\w])` + escaped + `(?!["''\\w])`);
            if (refRegex.test(trimmedSource)) {
              const assignRegex = new RegExp("(?:Source\\s*=|:=)\\s*" + escaped + "\\b");
              if (assignRegex.test(trimmedSource)) {
                linkedExprName = exprName;
                linkedExpr = exprObj;
                break;
              }
              if (!fallbackExprName) {
                fallbackExprName = exprName;
                fallbackExpr = exprObj;
              }
            }
          }
          if (!linkedExpr && fallbackExprName) {
            linkedExprName = fallbackExprName;
            linkedExpr = fallbackExpr;
          }
        }
        let effectiveDs = ds;
        let effectiveExpr = resolvedExpr;
        if (!effectiveDs && linkedExpr) {
          effectiveExpr = resolveParameters(linkedExpr.mExpression);
          effectiveDs = extractMDataSource(effectiveExpr);
        }
        if (effectiveDs) {
          const sourceKey = effectiveDs.database ? `${(effectiveDs.server || "").toLowerCase()}/${effectiveDs.database}` : (effectiveDs.server || "").toLowerCase();
          if (sourceKey) {
            const sourceId = `source::${sourceKey}`;
            if (!sourceNodeCache.has(sourceId)) {
              const displayName = effectiveDs.database || effectiveDs.server || sourceKey;
              nodes.set(sourceId, createNode(sourceId, displayName, NODE_TYPES.SOURCE, {
                server: effectiveDs.server,
                database: effectiveDs.database,
                sourceType: effectiveDs.type
              }));
              sourceNodeCache.set(sourceId, true);
            }
            const tableId = `table::${table.name}`;
            edges.push(createEdge(tableId, sourceId, EDGE_TYPES.TABLE_TO_SOURCE));
            const tableNode = nodes.get(tableId);
            if (tableNode) {
              tableNode.metadata.dataSource = {
                server: effectiveDs.server,
                database: effectiveDs.database,
                schema: effectiveDs.schema,
                sourceTable: effectiveDs.sourceTable,
                sourceType: effectiveDs.type,
                mode: partition.mode
              };
              if (effectiveDs.type === "Databricks") {
                Object.assign(tableNode.metadata.dataSource, {
                  fqn: effectiveDs.fqn,
                  objectKind: effectiveDs.objectKind,
                  httpPath: effectiveDs.httpPath,
                  nativeTables: effectiveDs.nativeTables
                });
              }
              let renameMap = extractRenameColumns(resolvedExpr);
              if (renameMap.size === 0 && effectiveExpr !== resolvedExpr) {
                renameMap = extractRenameColumns(effectiveExpr);
              }
              if (renameMap.size > 0) {
                tableNode.metadata.renameMap = Object.fromEntries(renameMap);
              }
            }
          }
        }
        if (linkedExprName && linkedExpr) {
          const exprId = `expression::${linkedExprName}`;
          if (nodes.has(exprId)) {
            edges.push(createEdge(`table::${table.name}`, exprId, EDGE_TYPES.TABLE_TO_EXPRESSION));
          }
        }
        const joinSources = [resolvedExpr];
        if (effectiveExpr && effectiveExpr !== resolvedExpr) joinSources.push(effectiveExpr);
        const seenJoins = /* @__PURE__ */ new Set();
        for (const expr of joinSources) {
          for (const joinedName of extractNestedJoins(expr)) {
            const targetId = `table::${joinedName}`;
            if (!seenJoins.has(targetId) && nodes.has(targetId) && targetId !== `table::${table.name}`) {
              edges.push(createEdge(`table::${table.name}`, targetId, EDGE_TYPES.TABLE_TO_TABLE_JOIN));
              seenJoins.add(targetId);
            }
          }
        }
      }
    }
  }
  if (parsedModel && parsedModel.tables) {
    for (const table of parsedModel.tables) {
      const tableId = `table::${table.name}`;
      const tableNode = nodes.get(tableId);
      let ds = tableNode?.metadata?.dataSource;
      let renameMap = tableNode?.metadata?.renameMap || {};
      if (!ds || Object.keys(renameMap).length === 0) {
        const tableUp = function buildAdj() {
          const up = [];
          for (const edge of edges) {
            if (edge.source === tableId && (edge.type === EDGE_TYPES.TABLE_TO_EXPRESSION || edge.type === EDGE_TYPES.TABLE_TO_SOURCE)) {
              up.push(edge.target);
            }
          }
          return up;
        }();
        for (const upId of tableUp) {
          const upNode = nodes.get(upId);
          if (!ds && upNode?.metadata?.dataSource) {
            ds = upNode.metadata.dataSource;
          }
          if (Object.keys(renameMap).length === 0 && upNode?.type === "expression" && upNode.metadata?.mExpression) {
            const exprRenames = extractRenameColumns(upNode.metadata.mExpression);
            if (exprRenames.size > 0) {
              renameMap = Object.fromEntries(exprRenames);
            }
          }
        }
      }
      if (!ds) continue;
      for (const col of table.columns || []) {
        const colId = `column::${table.name}.${col.name}`;
        const colNode = nodes.get(colId);
        if (!colNode) continue;
        const sourceCol = col.sourceColumn || col.name;
        const originalCol = renameMap[sourceCol] || sourceCol;
        colNode.metadata.sourceColumn = sourceCol;
        colNode.metadata.originalSourceColumn = originalCol;
        colNode.metadata.wasRenamed = originalCol !== sourceCol;
        if (ds.sourceTable) {
          const fullTable = ds.schema ? `${ds.schema}.${ds.sourceTable}` : ds.sourceTable;
          const fullTableWithDb = ds.database ? `${ds.database}.${fullTable}` : fullTable;
          colNode.metadata.sourceTableFull = `${fullTableWithDb}.${originalCol}`;
          colNode.metadata.sourceTablePath = fullTableWithDb;
        }
      }
    }
  }
  if (parsedReport) {
    if (parsedReport.pages) {
      for (const page of parsedReport.pages) {
        const pageId = `page::${page.id}`;
        nodes.set(pageId, createNode(pageId, page.name, NODE_TYPES.PAGE, {
          pageId: page.id,
          width: page.width || 1280,
          height: page.height || 720,
          ordinal: page.order ?? 0
        }));
      }
    }
    if (parsedReport.visuals) {
      for (const visual of parsedReport.visuals) {
        const visualId = `visual::${visual.pageId}/${visual.id}`;
        nodes.set(visualId, createNode(visualId, visual.title || visual.visualType, NODE_TYPES.VISUAL, {
          visualType: visual.visualType,
          pageId: visual.pageId,
          title: visual.title || "",
          position: visual.position || null,
          isHidden: visual.isHidden || false,
          parentGroupName: visual.parentGroupName || null
        }));
        const pageId = `page::${visual.pageId}`;
        if (nodes.has(pageId)) {
          edges.push(createEdge(visualId, pageId, EDGE_TYPES.VISUAL_TO_PAGE));
        }
        const pageNode = nodes.get(pageId);
        if (pageNode) {
          const vNode = nodes.get(visualId);
          if (vNode) vNode.metadata.pageName = pageNode.name;
        }
        if (visual.fields) {
          for (const field of visual.fields) {
            let fieldId;
            if (field.type === "fieldParameter" && field.table) {
              const fpTableId = `table::${field.table}`;
              if (nodes.has(fpTableId)) {
                edges.push(createEdge(visualId, fpTableId, EDGE_TYPES.VISUAL_TO_FIELD));
              }
              continue;
            } else if (field.type === "measure" && field.table && field.measure) {
              fieldId = `measure::${field.table}.${field.measure}`;
            } else if (field.table && field.column) {
              fieldId = `column::${field.table}.${field.column}`;
            }
            if (fieldId) {
              if (!nodes.has(fieldId)) {
                const placeholderName = field.measure || field.column || "unknown";
                const placeholderType = field.type === "measure" ? NODE_TYPES.MEASURE : NODE_TYPES.COLUMN;
                nodes.set(fieldId, createNode(fieldId, placeholderName, placeholderType, {
                  table: field.table,
                  placeholder: true
                }));
                const tableId = `table::${field.table}`;
                if (field.table && !nodes.has(tableId)) {
                  nodes.set(tableId, createNode(tableId, field.table, NODE_TYPES.TABLE, {
                    table: field.table,
                    placeholder: true
                  }));
                }
                if (field.table && placeholderType === NODE_TYPES.COLUMN) {
                  edges.push(createEdge(fieldId, tableId, EDGE_TYPES.COLUMN_TO_TABLE));
                }
              }
              edges.push(createEdge(
                visualId,
                fieldId,
                EDGE_TYPES.VISUAL_TO_FIELD,
                field.role ? { role: field.role } : null
              ));
            }
          }
        }
        for (const filterRef of visual.filters || []) {
          const fieldId = ensureFieldNode(nodes, edges, filterRef);
          if (fieldId) {
            edges.push(createEdge(visualId, fieldId, EDGE_TYPES.FILTER_TO_FIELD, {
              isActive: filterRef.isActive === true,
              scope: "visual",
              ownerName: visual.title || visual.visualType || visual.id,
              filterName: filterRef.name || ""
            }));
          }
        }
      }
    }
    for (const page of parsedReport.pages || []) {
      const pageId = `page::${page.id}`;
      if (!nodes.has(pageId)) continue;
      for (const filterRef of page.filters || []) {
        const fieldId = ensureFieldNode(nodes, edges, filterRef);
        if (fieldId) {
          edges.push(createEdge(pageId, fieldId, EDGE_TYPES.FILTER_TO_FIELD, {
            isActive: filterRef.isActive === true,
            scope: "page",
            ownerName: page.displayName || page.name || page.id,
            filterName: filterRef.name || ""
          }));
        }
      }
    }
    for (const filterRef of parsedReport.reportFilters || []) {
      const fieldId = ensureFieldNode(nodes, edges, filterRef);
      if (!fieldId) continue;
      for (const page of parsedReport.pages || []) {
        const pageId = `page::${page.id}`;
        if (nodes.has(pageId)) {
          edges.push(createEdge(pageId, fieldId, EDGE_TYPES.FILTER_TO_FIELD, {
            isActive: filterRef.isActive === true,
            scope: "report",
            ownerName: "Report",
            filterName: filterRef.name || ""
          }));
        }
      }
    }
  }
  if (enrichments) {
    if (enrichments.fieldParameters) {
      for (const fp of enrichments.fieldParameters) {
        const tableId = `table::${fp.tableName}`;
        const tableNode = nodes.get(tableId);
        if (tableNode) {
          tableNode.enrichment = { type: "field_parameter", data: fp };
        }
        const refPattern = /'([^']+)'\[([^\]]+)\]/;
        const fpDisplayNames = {};
        for (const field of fp.fields || []) {
          const refMatch = field.reference?.match(refPattern);
          if (!refMatch) continue;
          const refTable = refMatch[1];
          const refField = refMatch[2];
          const colId = `column::${refTable}.${refField}`;
          const measureId = `measure::${refTable}.${refField}`;
          const targetId = nodes.has(measureId) ? measureId : nodes.has(colId) ? colId : null;
          if (targetId) {
            edges.push(createEdge(tableId, targetId, EDGE_TYPES.FIELD_PARAM_TO_FIELD));
            if (field.displayName) {
              fpDisplayNames[targetId] = field.displayName;
            }
          }
        }
        if (tableNode && Object.keys(fpDisplayNames).length > 0) {
          tableNode.metadata.fpDisplayNames = fpDisplayNames;
        }
      }
    }
    if (enrichments.calculationGroups) {
      for (const cg of enrichments.calculationGroups) {
        const nodeId = `table::${cg.tableName}`;
        const node = nodes.get(nodeId);
        if (node) {
          node.enrichment = { type: "calculation_group", data: cg };
        }
      }
    }
  }
  const adjacency = buildAdjacency(edges);
  const graph = { nodes, edges, adjacency };
  if (parsedModel?.relationships) {
    const relCols = /* @__PURE__ */ new Set();
    for (const rel of parsedModel.relationships) {
      if (rel.fromTable && rel.fromColumn) relCols.add(`column::${rel.fromTable}.${rel.fromColumn}`);
      if (rel.toTable && rel.toColumn) relCols.add(`column::${rel.toTable}.${rel.toColumn}`);
    }
    graph.relationshipColumnIds = [...relCols];
  }
  graph.stats = computeStats(graph);
  return graph;
}
var ORPHAN_CATEGORIES = {
  /** Reaches at least one visual — genuinely in use, not an orphan. */
  NONE: "none",
  /**
   * Reaches no visual, but does reach an active filter or an RLS role. It IS
   * doing work, just nothing a report renders — safe to keep, risky to delete.
   */
  FILTER_SECURITY: "filterSecurity",
  /**
   * Reaches no visual, filter, or RLS role, but other measures/calculated
   * columns still reference it. Wired into the model, yet nothing surfaces it.
   */
  VISUAL: "visual",
  /** Reaches nothing and nothing references it — completely disconnected. */
  TRUE: "true"
};
function classifyMeasureUsage(measureId, graph, typedDownstream) {
  const consumers = typedDownstream || buildTypedDownstream(graph.edges || []);
  let reachesVisual = false;
  let reachesFilter = false;
  let reachesRls = false;
  let dependentCount = 0;
  const visited = /* @__PURE__ */ new Set([measureId]);
  const queue = [measureId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const { id: consumerId, type: edgeType, metadata } of consumers.get(current) || []) {
      if (edgeType === EDGE_TYPES.FILTER_TO_FIELD) {
        if (metadata?.isActive) reachesFilter = true;
        continue;
      }
      if (edgeType === EDGE_TYPES.RLS_TO_FIELD) {
        reachesRls = true;
        continue;
      }
      if (current === measureId) dependentCount++;
      if (visited.has(consumerId)) continue;
      visited.add(consumerId);
      const consumer = graph.nodes.get(consumerId);
      if (!consumer) continue;
      if (consumer.type === NODE_TYPES.VISUAL) {
        reachesVisual = true;
        continue;
      }
      if (consumer.type === NODE_TYPES.ROLE) {
        reachesRls = true;
        continue;
      }
      queue.push(consumerId);
    }
  }
  let category;
  if (reachesVisual) category = ORPHAN_CATEGORIES.NONE;
  else if (reachesFilter || reachesRls) category = ORPHAN_CATEGORIES.FILTER_SECURITY;
  else if (dependentCount > 0) category = ORPHAN_CATEGORIES.VISUAL;
  else category = ORPHAN_CATEGORIES.TRUE;
  return { category, reachesVisual, reachesFilter, reachesRls, dependentCount };
}
function buildTypedDownstream(edges) {
  const map = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    if (!map.has(edge.target)) map.set(edge.target, []);
    map.get(edge.target).push({ id: edge.source, type: edge.type, metadata: edge.metadata });
  }
  return map;
}
function isMeasureOrphan(measureId, graph) {
  return classifyMeasureUsage(measureId, graph).category !== ORPHAN_CATEGORIES.NONE;
}
function findColumnOrphans(graph) {
  const downstream = graph.adjacency ? graph.adjacency.downstream : /* @__PURE__ */ new Map();
  const orphans = [];
  const relationshipColumns = new Set(graph.relationshipColumnIds || []);
  for (const node of graph.nodes.values()) {
    if (node.type !== NODE_TYPES.COLUMN) continue;
    if (node.metadata?.placeholder) continue;
    if (relationshipColumns.has(node.id)) continue;
    const consumers = downstream.get(node.id) || [];
    const used = consumers.some((id) => {
      const c = graph.nodes.get(id);
      if (!c) return false;
      return c.type === NODE_TYPES.MEASURE || c.type === NODE_TYPES.VISUAL || c.type === NODE_TYPES.PAGE || c.type === NODE_TYPES.ROLE || c.type === NODE_TYPES.TABLE || c.type === NODE_TYPES.COLUMN && !!c.metadata?.expression;
    });
    if (used) continue;
    orphans.push({
      id: node.id,
      name: node.name,
      table: node.metadata?.table || "",
      dataType: node.metadata?.dataType || "",
      isCalculated: !!node.metadata?.isCalculated,
      isHidden: !!node.metadata?.isHidden
    });
  }
  orphans.sort((a, b) => (a.table + "." + a.name).localeCompare(b.table + "." + b.name));
  return orphans;
}
function computeStats(graph) {
  const counts = { tables: 0, columns: 0, measures: 0, visuals: 0, pages: 0, sources: 0, expressions: 0 };
  for (const node of graph.nodes.values()) {
    switch (node.type) {
      case NODE_TYPES.TABLE:
        counts.tables++;
        break;
      case NODE_TYPES.COLUMN:
        counts.columns++;
        break;
      case NODE_TYPES.MEASURE:
        counts.measures++;
        break;
      case NODE_TYPES.VISUAL:
        counts.visuals++;
        break;
      case NODE_TYPES.PAGE:
        counts.pages++;
        break;
      case NODE_TYPES.SOURCE:
        counts.sources++;
        break;
      case NODE_TYPES.EXPRESSION:
        counts.expressions++;
        break;
    }
  }
  let orphanedMeasures = 0;
  const orphanBreakdown = { filterSecurity: 0, visual: 0, true: 0 };
  const typedDownstream = buildTypedDownstream(graph.edges || []);
  for (const node of graph.nodes.values()) {
    if (node.type !== NODE_TYPES.MEASURE) continue;
    const { category } = classifyMeasureUsage(node.id, graph, typedDownstream);
    if (category === ORPHAN_CATEGORIES.NONE) continue;
    orphanedMeasures++;
    orphanBreakdown[category]++;
  }
  const orphanedColumns = findColumnOrphans(graph).length;
  return {
    tables: counts.tables,
    columns: counts.columns,
    measures: counts.measures,
    visuals: counts.visuals,
    pages: counts.pages,
    sources: counts.sources,
    edges: graph.edges.length,
    orphanedMeasures,
    orphanBreakdown,
    orphanedColumns
  };
}
function namespaceGraph(graph, prefix) {
  const remap = /* @__PURE__ */ new Map();
  for (const id of graph.nodes.keys()) remap.set(id, `${prefix}${id}`);
  const nodes = /* @__PURE__ */ new Map();
  for (const [id, node] of graph.nodes) {
    const newId = remap.get(id);
    let metadata = node.metadata;
    if (metadata && metadata.fpDisplayNames) {
      const fixed = {};
      for (const [k, v] of Object.entries(metadata.fpDisplayNames)) {
        fixed[remap.get(k) ?? k] = v;
      }
      metadata = { ...metadata, fpDisplayNames: fixed };
    }
    nodes.set(newId, { ...node, id: newId, metadata });
  }
  const edges = graph.edges.map((e) => ({
    ...e,
    source: remap.get(e.source) ?? e.source,
    target: remap.get(e.target) ?? e.target
  }));
  const adjacency = buildAdjacency(edges);
  const namespaced = { nodes, edges, adjacency };
  if (graph.relationshipColumnIds) {
    namespaced.relationshipColumnIds = graph.relationshipColumnIds.map((id) => remap.get(id) ?? id);
  }
  namespaced.stats = computeStats(namespaced);
  return namespaced;
}
function rescopeReportGraph(reportGraph, { reportKey, reportName, fieldPrefix = "" }) {
  const reportSuffix = `\xA7report:${reportKey}`;
  function remapId(id) {
    if (id.startsWith("page::") || id.startsWith("visual::")) {
      return `${id}${reportSuffix}`;
    }
    if (fieldPrefix && (id.startsWith("measure::") || id.startsWith("column::") || id.startsWith("table::"))) {
      return `${fieldPrefix}${id}`;
    }
    return id;
  }
  const nodes = /* @__PURE__ */ new Map();
  for (const [id, node] of reportGraph.nodes) {
    const newId = remapId(id);
    const isReportScoped = newId !== id && (id.startsWith("page::") || id.startsWith("visual::"));
    const metadata = isReportScoped ? { ...node.metadata, reportKey, reportName } : node.metadata;
    nodes.set(newId, newId === id ? node : { ...node, id: newId, metadata });
  }
  const edges = reportGraph.edges.map((e) => ({
    ...e,
    source: remapId(e.source),
    target: remapId(e.target)
  }));
  return { nodes, edges };
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/graph/impactAnalysis.js
function bfsTraverse(startId, adjacencyMap) {
  const visited = /* @__PURE__ */ new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = adjacencyMap.get(current) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor) && neighbor !== startId) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited;
}
function getUpstream(nodeId, adjacency) {
  return bfsTraverse(nodeId, adjacency.upstream);
}
function getDownstream(nodeId, adjacency) {
  return bfsTraverse(nodeId, adjacency.downstream);
}
function getDirectDependencies(nodeId, adjacency) {
  return {
    upstream: adjacency.upstream.get(nodeId) || [],
    downstream: adjacency.downstream.get(nodeId) || []
  };
}
function analyzeImpact(nodeId, graph) {
  const node = graph.nodes.get(nodeId) || null;
  const upstream = getUpstream(nodeId, graph.adjacency);
  const downstream = getDownstream(nodeId, graph.adjacency);
  return { upstream, downstream, node };
}
function findOrphans(graph) {
  const orphans = [];
  for (const node of graph.nodes.values()) {
    if (node.type === "measure" && isMeasureOrphan(node.id, graph)) {
      orphans.push(node.id);
    }
  }
  return orphans;
}
function findOrphansByCategory(graph) {
  const result = { filterSecurity: [], visual: [], true: [], columns: [], total: 0 };
  const typedDownstream = buildTypedDownstream(graph.edges || []);
  for (const node of graph.nodes.values()) {
    if (node.type !== "measure") continue;
    const usage = classifyMeasureUsage(node.id, graph, typedDownstream);
    if (usage.category === ORPHAN_CATEGORIES.NONE) continue;
    result[usage.category].push({
      id: node.id,
      name: node.name,
      table: node.metadata?.table || "",
      expression: node.metadata?.expression || "",
      isHidden: !!node.metadata?.isHidden,
      dependentCount: usage.dependentCount,
      reachesFilter: usage.reachesFilter,
      reachesRls: usage.reachesRls
    });
    result.total++;
  }
  for (const key of ["filterSecurity", "visual", "true"]) {
    result[key].sort((a, b) => (a.table + "." + a.name).localeCompare(b.table + "." + b.name));
  }
  result.columns = findColumnOrphans(graph);
  return result;
}
function exportImpactReport(nodeId, graph, format = "json") {
  const { upstream, downstream, node } = analyzeImpact(nodeId, graph);
  const upstreamNodes = [...upstream].map((id) => {
    const n = graph.nodes.get(id);
    return n ? { id: n.id, name: n.name, type: n.type } : { id };
  });
  const downstreamNodes = [...downstream].map((id) => {
    const n = graph.nodes.get(id);
    return n ? { id: n.id, name: n.name, type: n.type } : { id };
  });
  if (format === "markdown") {
    const lines = [];
    lines.push(`# Impact Report: ${node ? node.name : nodeId}`);
    lines.push("");
    if (node) {
      lines.push(`- **Type**: ${node.type}`);
      lines.push(`- **ID**: ${node.id}`);
      lines.push("");
    }
    lines.push(`## Upstream Dependencies (${upstreamNodes.length})`);
    lines.push("");
    if (upstreamNodes.length === 0) {
      lines.push("_None_");
    } else {
      for (const n of upstreamNodes) {
        lines.push(`- \`${n.type || "unknown"}\` **${n.name || n.id}**`);
      }
    }
    lines.push("");
    lines.push(`## Downstream Dependents (${downstreamNodes.length})`);
    lines.push("");
    if (downstreamNodes.length === 0) {
      lines.push("_None_");
    } else {
      for (const n of downstreamNodes) {
        lines.push(`- \`${n.type || "unknown"}\` **${n.name || n.id}**`);
      }
    }
    return lines.join("\n");
  }
  return {
    node: node ? { id: node.id, name: node.name, type: node.type, metadata: node.metadata } : null,
    upstream: upstreamNodes,
    downstream: downstreamNodes,
    summary: {
      upstreamCount: upstreamNodes.length,
      downstreamCount: downstreamNodes.length
    }
  };
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/graph/lineageTracer.js
function traceMeasureLineage(measureNodeId, graph) {
  const measureNode = graph.nodes.get(measureNodeId);
  if (!measureNode) return null;
  const impact = analyzeImpact(measureNodeId, graph);
  const visuals = traceVisuals(measureNode, impact, graph);
  const measureChain = buildMeasureChain(measureNodeId, graph);
  const sourceTable = buildSourceTable(measureChain, graph);
  const summaryTrees = buildSummaryTrees(measureNode, visuals, measureChain, sourceTable, graph);
  return { visuals, measureChain, sourceTable, summaryTrees };
}
function traceVisuals(measureNode, impact, graph) {
  const visuals = [];
  for (const nodeId of impact.downstream) {
    const node = graph.nodes.get(nodeId);
    if (!node || node.type !== "visual") continue;
    let pageName = node.metadata?.pageName || "";
    if (!pageName) {
      const upNeighborsForPage = graph.adjacency.upstream.get(nodeId) || [];
      for (const nId of upNeighborsForPage) {
        const n = graph.nodes.get(nId);
        if (n && n.type === "page") {
          pageName = n.name;
          break;
        }
      }
    }
    let bindingType = "direct";
    let fieldParameterTable = "";
    let fpDisplayName = "";
    const upNeighbors = graph.adjacency.upstream.get(nodeId) || [];
    for (const upId of upNeighbors) {
      const upNode = graph.nodes.get(upId);
      if (upNode && (upNode.enrichment?.type === "field_parameter" || upNode.metadata?.isFieldParameter)) {
        bindingType = "fieldParameter";
        fieldParameterTable = upNode.metadata?.table || upNode.name;
        const displayNames = upNode.metadata?.fpDisplayNames;
        if (displayNames && displayNames[measureNode.id]) {
          fpDisplayName = displayNames[measureNode.id];
        }
        break;
      }
    }
    visuals.push({
      page: pageName,
      // Set only in a multi-report workspace; required to tell apart visuals
      // that share a name/page across reports on the same semantic model.
      report: node.metadata?.reportName || "",
      visualType: node.metadata?.visualType || node.name,
      title: node.metadata?.title || node.name,
      id: node.id,
      metricDisplayName: fpDisplayName || measureNode.name,
      metricDaxName: `${measureNode.metadata?.table || ""}.${measureNode.name}`,
      bindingType,
      fieldParameterTable
    });
  }
  visuals.sort(
    (a, b) => (a.report + a.page + a.title).localeCompare(b.report + b.page + b.title)
  );
  return visuals;
}
function traceVisualLineage(visualNodeId, graph) {
  const visualNode = graph.nodes.get(visualNodeId);
  if (!visualNode) return null;
  let pageName = visualNode.metadata?.pageName || "";
  if (!pageName) {
    const upNeighborsForPage = graph.adjacency.upstream.get(visualNodeId) || [];
    for (const nId of upNeighborsForPage) {
      const n = graph.nodes.get(nId);
      if (n && n.type === "page") {
        pageName = n.name;
        break;
      }
    }
  }
  const directMeasureIds = /* @__PURE__ */ new Set();
  const fieldParamMeasureIds = /* @__PURE__ */ new Set();
  const upNeighbors = graph.adjacency.upstream.get(visualNodeId) || [];
  for (const upId of upNeighbors) {
    const upNode = graph.nodes.get(upId);
    if (!upNode) continue;
    if (upNode.type === "measure") {
      directMeasureIds.add(upId);
    } else if (upNode.type === "column") {
      const parentTableId = `table::${upNode.metadata?.table || ""}`;
      const parentTable = graph.nodes.get(parentTableId);
      const isFieldParam = parentTable?.enrichment?.type === "field_parameter" || upNode.enrichment?.type === "field_parameter" || upNode.metadata?.isFieldParameter;
      if (isFieldParam && parentTableId) {
        const fpUp = graph.adjacency.upstream.get(parentTableId) || [];
        for (const fpId of fpUp) {
          const fpNode = graph.nodes.get(fpId);
          if (fpNode?.type === "measure") fieldParamMeasureIds.add(fpId);
        }
      } else {
        const colUp = graph.adjacency.upstream.get(upId) || [];
        for (const cId of colUp) {
          const cNode = graph.nodes.get(cId);
          if (cNode?.type === "measure") directMeasureIds.add(cId);
        }
      }
    } else if (upNode.type === "table") {
      const isFieldParam = upNode.enrichment?.type === "field_parameter";
      if (isFieldParam) {
        const fpUp = graph.adjacency.upstream.get(upId) || [];
        for (const fpId of fpUp) {
          const fpNode = graph.nodes.get(fpId);
          if (fpNode?.type === "measure") fieldParamMeasureIds.add(fpId);
        }
      }
    }
  }
  const referencedFpTableIds = /* @__PURE__ */ new Set();
  const referencedCgTableIds = /* @__PURE__ */ new Set();
  for (const upId of upNeighbors) {
    const upNode = graph.nodes.get(upId);
    if (!upNode) continue;
    if (upNode.type === "table") {
      if (upNode.enrichment?.type === "field_parameter") {
        referencedFpTableIds.add(upId);
      }
      if (upNode.metadata?.enrichmentType === "calculation_group" || upNode.enrichment?.type === "calculation_group") {
        referencedCgTableIds.add(upId);
      }
    } else if (upNode.type === "column") {
      const parentTableId = `table::${upNode.metadata?.table || ""}`;
      const parentTable = graph.nodes.get(parentTableId);
      if (parentTable?.enrichment?.type === "field_parameter") {
        referencedFpTableIds.add(parentTableId);
      }
      if (parentTable?.metadata?.enrichmentType === "calculation_group" || upNode.metadata?.enrichmentType === "calculation_group") {
        referencedCgTableIds.add(parentTableId);
      }
    }
  }
  for (const edge of graph.edges) {
    if (edge.type === EDGE_TYPES.FIELD_PARAM_TO_FIELD && referencedFpTableIds.has(edge.source)) {
      const targetNode = graph.nodes.get(edge.target);
      if (targetNode?.type === "measure") fieldParamMeasureIds.add(edge.target);
    }
  }
  const fpDisplayNameMap = /* @__PURE__ */ new Map();
  for (const fpTableId of referencedFpTableIds) {
    const fpTable = graph.nodes.get(fpTableId);
    const displayNames = fpTable?.metadata?.fpDisplayNames;
    if (displayNames) {
      for (const [measureId, displayName] of Object.entries(displayNames)) {
        fpDisplayNameMap.set(measureId, displayName);
      }
    }
  }
  const measures = Array.from(directMeasureIds).map((measureId) => {
    const node = graph.nodes.get(measureId);
    return {
      measureId,
      measureName: node?.name || measureId,
      fpDisplayName: fpDisplayNameMap.get(measureId) || "",
      lineage: traceMeasureLineage(measureId, graph)
    };
  });
  const fpMeasures = Array.from(fieldParamMeasureIds).filter((id) => !directMeasureIds.has(id)).map((measureId) => {
    const node = graph.nodes.get(measureId);
    return {
      measureId,
      measureName: node?.name || measureId,
      fpDisplayName: fpDisplayNameMap.get(measureId) || "",
      lineage: traceMeasureLineage(measureId, graph)
    };
  });
  const calculationGroups = Array.from(referencedCgTableIds).map((cgTableId) => {
    const cgNode = graph.nodes.get(cgTableId);
    const items = cgNode?.metadata?.calculationGroup?.items || [];
    return {
      tableName: cgNode?.name || cgTableId.replace("table::", ""),
      items
    };
  });
  return {
    visual: {
      id: visualNodeId,
      title: visualNode.metadata?.title || visualNode.name || "",
      type: visualNode.metadata?.visualType || visualNode.name || "visual",
      page: pageName,
      objectId: visualNodeId.split("/").pop() || visualNodeId
    },
    measures,
    fpMeasures,
    fieldParameterMeasures: Array.from(fieldParamMeasureIds).map((id) => {
      const n = graph.nodes.get(id);
      return { id, name: n?.name || id, table: n?.metadata?.table || "" };
    }),
    calculationGroups
  };
}
function buildMeasureChain(measureNodeId, graph, ancestors = /* @__PURE__ */ new Set(), memo = /* @__PURE__ */ new Map()) {
  if (ancestors.has(measureNodeId)) {
    const node2 = graph.nodes.get(measureNodeId);
    return {
      id: measureNodeId,
      name: node2?.name || measureNodeId,
      table: node2?.metadata?.table || "",
      expression: "(circular reference)",
      children: [],
      columns: []
    };
  }
  if (memo.has(measureNodeId)) return memo.get(measureNodeId);
  const node = graph.nodes.get(measureNodeId);
  if (!node) return null;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(measureNodeId);
  const result = {
    id: measureNodeId,
    name: node.name,
    table: node.metadata?.table || "",
    expression: node.metadata?.expression || "",
    description: node.metadata?.description || "",
    children: [],
    // sub-measures
    columns: [],
    // leaf column references
    useRelationships: []
    // USERELATIONSHIP references
  };
  for (const edge of graph.edges) {
    if (edge.type === EDGE_TYPES.MEASURE_TO_USERELATIONSHIP && edge.source === measureNodeId) {
      const colNode = graph.nodes.get(edge.target);
      if (colNode) {
        result.useRelationships.push({
          column: colNode.name,
          table: colNode.metadata?.table || ""
        });
      }
    }
  }
  if (result.useRelationships.length > 0) {
    const relTables = new Set(result.useRelationships.map((ur) => ur.table));
    for (const edge of graph.edges) {
      if (edge.type === "table_relationship") {
        const srcNode = graph.nodes.get(edge.source);
        const tgtNode = graph.nodes.get(edge.target);
        if (srcNode && tgtNode && relTables.has(srcNode.name) && relTables.has(tgtNode.name)) {
          result.useRelationships.crossFilter = edge.metadata?.crossFilter || "single";
          result.useRelationships.fromTable = srcNode.name;
          result.useRelationships.toTable = tgtNode.name;
        }
      }
    }
  }
  const upNeighbors = graph.adjacency.upstream.get(measureNodeId) || [];
  for (const upId of upNeighbors) {
    const upNode = graph.nodes.get(upId);
    if (!upNode) continue;
    if (upNode.type === "measure") {
      const child = buildMeasureChain(upId, graph, nextAncestors, memo);
      if (child) result.children.push(child);
    } else if (upNode.type === "column") {
      result.columns.push({
        id: upId,
        name: upNode.name,
        table: upNode.metadata?.table || "",
        dataType: upNode.metadata?.dataType || "",
        sourceColumn: upNode.metadata?.sourceColumn || "",
        originalSourceColumn: upNode.metadata?.originalSourceColumn || "",
        wasRenamed: upNode.metadata?.wasRenamed || false,
        sourceTableFull: upNode.metadata?.sourceTableFull || "",
        sourceTablePath: upNode.metadata?.sourceTablePath || "",
        isHidden: upNode.metadata?.isHidden || false
      });
    }
  }
  memo.set(measureNodeId, result);
  return result;
}
function buildSourceTable(measureChain, graph) {
  const rows = [];
  const indexByCol = /* @__PURE__ */ new Map();
  function collectColumns(chain) {
    if (!chain) return;
    for (const col of chain.columns) {
      const parent = chain.name;
      const existingIdx = indexByCol.get(col.id);
      if (existingIdx !== void 0) {
        const existing = rows[existingIdx];
        if (parent && !existing.daxReferences.includes(parent)) {
          existing.daxReferences.push(parent);
        }
        continue;
      }
      const tableNodeId = `table::${col.table}`;
      const tableNode = graph.nodes.get(tableNodeId);
      let srcTable = col.sourceTablePath || "";
      let srcColumn = col.sourceTableFull || col.sourceColumn || col.name;
      if (tableNode) {
        const tableUp = graph.adjacency.upstream.get(tableNodeId) || [];
        for (const upId of tableUp) {
          const upNode = graph.nodes.get(upId);
          if (upNode && upNode.type === "expression") {
            if (upNode.metadata?.dataSource?.sourceTable && !srcTable) {
              const exprDs = upNode.metadata.dataSource;
              const exprFullTable = exprDs.schema ? `${exprDs.schema}.${exprDs.sourceTable}` : exprDs.sourceTable;
              srcTable = exprDs.database ? `${exprDs.database}.${exprFullTable}` : exprFullTable;
            }
          } else if (upNode && upNode.type === "source") {
            if (!srcTable && upNode.metadata?.database) {
              srcTable = `${upNode.metadata.database}.*`;
            }
          }
        }
      }
      if (srcTable && srcColumn && !srcColumn.includes(".")) {
        srcColumn = `${srcTable}.${srcColumn}`;
      }
      const mode = tableNode?.metadata?.dataSource?.mode || "";
      const daxReferences = parent ? [parent] : [];
      rows.push({
        daxReferences,
        daxReference: daxReferences[0] || "",
        // legacy alias (first parent)
        pbiTable: col.table,
        pbiColumn: col.name,
        dataType: col.dataType || "",
        isHidden: col.isHidden || false,
        sourceColumn: col.sourceColumn || col.name,
        originalSourceColumn: col.originalSourceColumn || "",
        sourceTable: srcTable,
        sourceColumnFull: srcColumn,
        renamed: col.wasRenamed,
        renameChain: col.wasRenamed ? { sourceName: col.originalSourceColumn || "", pqName: col.sourceColumn || "", pbiName: col.name } : null,
        mode
      });
      indexByCol.set(col.id, rows.length - 1);
    }
    for (const child of chain.children) {
      collectColumns(child);
    }
  }
  collectColumns(measureChain);
  return rows;
}
function buildSummaryTrees(measureNode, visuals, measureChain, sourceTable, graph) {
  const colSourceMap = /* @__PURE__ */ new Map();
  for (const row of sourceTable) {
    const key = `${row.pbiTable}.${row.pbiColumn}`;
    colSourceMap.set(key, row);
  }
  function buildChainSummary(chain, indent) {
    const prefix = "  ".repeat(indent);
    const lines = [];
    const daxShort = chain.expression ? chain.expression.split("\n")[0].substring(0, 80) + (chain.expression.length > 80 ? "..." : "") : "";
    lines.push(`${prefix}[${chain.name}] = ${daxShort}`);
    for (const child of chain.children) {
      lines.push(...buildChainSummary(child, indent + 2));
    }
    for (const col of chain.columns) {
      const key = `${col.table}.${col.name}`;
      const source = colSourceMap.get(key);
      let colLine = `${prefix}    ${col.table}[${col.name}]`;
      if (source?.sourceTable) colLine += ` -> Source: ${source.sourceTable}.${source.sourceColumnFull}`;
      if (source?.renamed) colLine += " (renamed)";
      lines.push(colLine);
    }
    return lines;
  }
  return visuals.map((v) => {
    const lines = [];
    lines.push(`Visual: ${v.visualType} "${v.title}" (${v.id.split("/").pop() || v.id})`);
    lines.push(`  Metric Display Name: ${v.metricDisplayName}`);
    lines.push(`  Metric DAX Name: ${v.metricDaxName}`);
    lines.push(...buildChainSummary(measureChain, 1));
    return lines.join("\n");
  });
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/graph/dependencyStrip.js
function resolveModelName(measureId, graph, fallback) {
  const ws = graph.workspace;
  if (!ws) return fallback || "";
  const match = /^model:(.+?)§/.exec(measureId);
  if (match) return match[1].replace(/\.semanticmodel$/i, "");
  if (ws.primaryModelKey) return String(ws.primaryModelKey).replace(/\.semanticmodel$/i, "");
  return fallback || "";
}
function findColumnVia(expression, table, column) {
  if (!expression) return "";
  const escaped = `(?:'${table}'|${table})?\\[${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`;
  const re = new RegExp(escaped);
  const m = re.exec(expression);
  if (!m) return "";
  const before = expression.slice(0, m.index);
  const fnMatches = [...before.matchAll(/([A-Z][A-Z0-9._]*)\s*\(/gi)];
  if (fnMatches.length === 0) return "";
  return fnMatches[fnMatches.length - 1][1].toUpperCase();
}
function buildDependencyStripData(measureNodeId, graph, options = {}) {
  const measureNode = graph.nodes.get(measureNodeId);
  if (!measureNode) return null;
  const upstreamIds = graph.adjacency.upstream.get(measureNodeId) || [];
  const downstreamIds = graph.adjacency.downstream.get(measureNodeId) || [];
  const visualIds = collectTransitiveDownstreamByType(measureNodeId, graph, NODE_TYPES.VISUAL);
  const roleByVisual = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    if (edge.type !== EDGE_TYPES.VISUAL_TO_FIELD) continue;
    if (edge.target !== measureNodeId) continue;
    if (edge.metadata?.role) roleByVisual.set(edge.source, edge.metadata.role);
  }
  const qualifiedName = `${measureNode.metadata?.table || ""}.${measureNode.name}`;
  const isRealRole = (role) => role && role !== qualifiedName && role !== measureNode.name && !role.includes(".");
  const visuals = [];
  for (const vId of visualIds) {
    const v = graph.nodes.get(vId);
    if (!v) continue;
    const rawRole = roleByVisual.get(vId) || "";
    visuals.push({
      id: vId,
      report: v.metadata?.reportName || "",
      page: v.metadata?.pageName || resolvePageName(vId, graph),
      visual: v.metadata?.title || v.name || vId,
      visualType: v.metadata?.visualType || "",
      role: isRealRole(rawRole) ? rawRole : ""
    });
  }
  visuals.sort(
    (a, b) => (a.report + " " + a.page + " " + a.visual).localeCompare(b.report + " " + b.page + " " + b.visual)
  );
  const downstreamMeasures = [];
  for (const id of dedupe(downstreamIds)) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    if (n.type === NODE_TYPES.MEASURE) {
      downstreamMeasures.push({
        id: n.id,
        name: n.name,
        table: n.metadata?.table || "",
        kind: n.enrichment?.type === "calculation_group" ? "calculationItem" : "measure",
        expression: n.metadata?.expression || ""
      });
    } else if (n.type === NODE_TYPES.COLUMN && n.metadata?.expression) {
      downstreamMeasures.push({
        id: n.id,
        name: n.name,
        table: n.metadata?.table || "",
        kind: "calculatedColumn",
        expression: n.metadata.expression
      });
    }
  }
  downstreamMeasures.sort((a, b) => a.name.localeCompare(b.name));
  const upstreamMeasures = [];
  for (const id of dedupe(upstreamIds)) {
    const n = graph.nodes.get(id);
    if (!n || n.type !== NODE_TYPES.MEASURE) continue;
    upstreamMeasures.push({
      id: n.id,
      name: n.name,
      table: n.metadata?.table || "",
      expression: n.metadata?.expression || ""
    });
  }
  upstreamMeasures.sort((a, b) => a.name.localeCompare(b.name));
  const columnIds = collectTransitiveUpstreamByType(measureNodeId, graph, NODE_TYPES.COLUMN);
  const ownExpression = measureNode.metadata?.expression || "";
  const upstreamColumns = [];
  for (const id of columnIds) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    const table = n.metadata?.table || "";
    const column = n.name;
    upstreamColumns.push({
      table,
      column,
      via: findColumnVia(ownExpression, table, column)
    });
  }
  upstreamColumns.sort((a, b) => (a.table + "[" + a.column + "]").localeCompare(b.table + "[" + b.column + "]"));
  return {
    measure: {
      name: measureNode.name,
      table: measureNode.metadata?.table || "",
      model: resolveModelName(measureNodeId, graph, options.modelName),
      formatString: measureNode.metadata?.formatString || "",
      expression: ownExpression
    },
    visuals,
    downstreamMeasures,
    upstreamMeasures,
    upstreamColumns,
    filters: getFieldFilterUsage(measureNodeId, graph)
  };
}
function getFieldFilterUsage(fieldId, graph, options = {}) {
  const { activeOnly = true } = options;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const edge of graph.edges || []) {
    if (edge.type !== EDGE_TYPES.FILTER_TO_FIELD) continue;
    if (edge.target !== fieldId) continue;
    const ownerNode = graph.nodes.get(edge.source);
    const meta = edge.metadata || {};
    if (activeOnly && meta.isActive !== true) continue;
    const scope = meta.scope || (ownerNode?.type === NODE_TYPES.VISUAL ? "visual" : "page");
    let report = ownerNode?.metadata?.reportName || "";
    let page = "";
    if (ownerNode?.type === NODE_TYPES.VISUAL) {
      page = ownerNode.metadata?.pageName || resolvePageName(edge.source, graph);
    } else if (ownerNode?.type === NODE_TYPES.PAGE) {
      page = ownerNode.name || "";
    }
    const owner = meta.ownerName || (scope === "report" ? "Report" : ownerNode?.metadata?.title || ownerNode?.name || "");
    const key = scope === "report" ? `report\xA7${report}\xA7${meta.filterName || ""}` : `${scope}\xA7${report}\xA7${page}\xA7${owner}\xA7${meta.filterName || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      scope,
      owner,
      report,
      page: scope === "report" ? "" : page,
      isActive: meta.isActive === true,
      filterName: meta.filterName || ""
    });
  }
  const order = { report: 0, page: 1, visual: 2 };
  out.sort(
    (a, b) => (order[a.scope] ?? 9) - (order[b.scope] ?? 9) || (a.report + a.page + a.owner).localeCompare(b.report + b.page + b.owner)
  );
  return out;
}
function buildMeasureSummaryRows(graph) {
  const rows = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== NODE_TYPES.MEASURE) continue;
    if (node.metadata?.placeholder) continue;
    const upstreamIds = graph.adjacency.upstream.get(node.id) || [];
    const downstreamIds = graph.adjacency.downstream.get(node.id) || [];
    let dependsOnMeasures = 0;
    for (const id of dedupe(upstreamIds)) {
      if (graph.nodes.get(id)?.type === NODE_TYPES.MEASURE) dependsOnMeasures++;
    }
    let dependentMeasures = 0;
    for (const id of dedupe(downstreamIds)) {
      const n = graph.nodes.get(id);
      if (!n) continue;
      if (n.type === NODE_TYPES.MEASURE) dependentMeasures++;
      else if (n.type === NODE_TYPES.COLUMN && n.metadata?.expression) dependentMeasures++;
    }
    const visualIds = collectTransitiveDownstreamByType(node.id, graph, NODE_TYPES.VISUAL);
    const pages = /* @__PURE__ */ new Set();
    const reports = /* @__PURE__ */ new Set();
    for (const vId of visualIds) {
      const v = graph.nodes.get(vId);
      if (!v) continue;
      const page = v.metadata?.pageName || resolvePageName(vId, graph);
      if (page) pages.add(`${v.metadata?.reportName || ""}\xA7${page}`);
      if (v.metadata?.reportName) reports.add(v.metadata.reportName);
    }
    const columnCount = collectTransitiveUpstreamByType(node.id, graph, NODE_TYPES.COLUMN).length;
    const usage = classifyMeasureUsage(node.id, graph);
    const filters = getFieldFilterUsage(node.id, graph);
    rows.push({
      id: node.id,
      name: node.name,
      table: node.metadata?.table || "",
      displayFolder: node.metadata?.displayFolder || "",
      formatString: node.metadata?.formatString || "",
      expression: node.metadata?.expression || "",
      isHidden: !!node.metadata?.isHidden,
      dependsOnMeasures,
      dependentMeasures,
      columnCount,
      visualCount: visualIds.length,
      pageCount: pages.size,
      reportCount: reports.size,
      orphanCategory: usage.category,
      filterCount: filters.length
    });
  }
  rows.sort((a, b) => (a.table + "." + a.name).localeCompare(b.table + "." + b.name));
  return rows;
}
function dedupe(ids) {
  return [...new Set(ids)];
}
function resolvePageName(visualId, graph) {
  const ups = graph.adjacency.upstream.get(visualId) || [];
  for (const id of ups) {
    const n = graph.nodes.get(id);
    if (n && n.type === NODE_TYPES.PAGE) return n.name;
  }
  return "";
}
function collectTransitiveDownstreamByType(startId, graph, type) {
  const found = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of graph.adjacency.downstream.get(cur) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const n = graph.nodes.get(next);
      if (n && n.type === type) found.add(next);
      queue.push(next);
    }
  }
  return [...found];
}
function collectTransitiveUpstreamByType(startId, graph, type) {
  const found = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of graph.adjacency.upstream.get(cur) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const n = graph.nodes.get(next);
      if (n && n.type === type) found.add(next);
      queue.push(next);
    }
  }
  return [...found];
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/pageDiff.js
function detectPageChanges(beforeFiles, afterFiles) {
  const changes = [];
  changes.push(...detectActivePageChange(beforeFiles, afterFiles));
  changes.push(...detectPageAddRemove(beforeFiles, afterFiles));
  changes.push(...detectPageFilterChanges(beforeFiles, afterFiles));
  return changes;
}
function detectActivePageChange(beforeFiles, afterFiles) {
  const changes = [];
  const beforePages = findPagesJson(beforeFiles);
  const afterPages = findPagesJson(afterFiles);
  if (!beforePages || !afterPages) return changes;
  try {
    const beforeConfig = JSON.parse(beforePages);
    const afterConfig = JSON.parse(afterPages);
    if (beforeConfig.activePageName !== afterConfig.activePageName) {
      const beforePageName = resolvePageDisplayName(beforeConfig.activePageName, beforeFiles);
      const afterPageName = resolvePageDisplayName(afterConfig.activePageName, afterFiles);
      changes.push(createChange({
        type: CHANGE_TYPES.DEFAULT_PAGE_CHANGED,
        scope: CHANGE_SCOPES.REPORT,
        target: { pageId: afterConfig.activePageName, pageName: afterPageName },
        description: `Default page changed from "${beforePageName}" to "${afterPageName}"`,
        details: {
          before: { pageId: beforeConfig.activePageName, pageName: beforePageName },
          after: { pageId: afterConfig.activePageName, pageName: afterPageName }
        }
      }));
    }
  } catch {
  }
  return changes;
}
function detectPageAddRemove(beforeFiles, afterFiles) {
  const changes = [];
  const beforePageIds = extractPageIds(beforeFiles);
  const afterPageIds = extractPageIds(afterFiles);
  for (const pageId of afterPageIds) {
    if (!beforePageIds.has(pageId)) {
      const pageName = resolvePageDisplayName(pageId, afterFiles);
      changes.push(createChange({
        type: CHANGE_TYPES.PAGE_ADDED,
        scope: CHANGE_SCOPES.PAGE,
        target: { pageId, pageName },
        description: `Page "${pageName}" was added`
      }));
    }
  }
  for (const pageId of beforePageIds) {
    if (!afterPageIds.has(pageId)) {
      const pageName = resolvePageDisplayName(pageId, beforeFiles);
      changes.push(createChange({
        type: CHANGE_TYPES.PAGE_REMOVED,
        scope: CHANGE_SCOPES.PAGE,
        target: { pageId, pageName },
        description: `Page "${pageName}" was removed`
      }));
    }
  }
  return changes;
}
function detectPageFilterChanges(beforeFiles, afterFiles) {
  const changes = [];
  const beforePageFiles = findAllPageJsonFiles(beforeFiles);
  const afterPageFiles = findAllPageJsonFiles(afterFiles);
  const allPageIds = /* @__PURE__ */ new Set([...beforePageFiles.keys(), ...afterPageFiles.keys()]);
  for (const pageId of allPageIds) {
    const beforeContent = beforePageFiles.get(pageId);
    const afterContent = afterPageFiles.get(pageId);
    if (!beforeContent && !afterContent) continue;
    try {
      const beforeConfig = beforeContent ? JSON.parse(beforeContent) : {};
      const afterConfig = afterContent ? JSON.parse(afterContent) : {};
      const pageName = afterConfig.displayName || beforeConfig.displayName || pageId;
      const beforeFilters = beforeConfig.filterConfig?.filters || [];
      const afterFilters = afterConfig.filterConfig?.filters || [];
      const filterChanges = diffFilters(beforeFilters, afterFilters, {
        scope: CHANGE_SCOPES.PAGE,
        target: { pageId, pageName },
        locationLabel: `page "${pageName}"`
      });
      changes.push(...filterChanges);
    } catch {
    }
  }
  return changes;
}
function findPagesJson(files) {
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/pages/pages.json") || lower === "definition/pages/pages.json") {
      return content;
    }
  }
  return null;
}
function extractPageIds(files) {
  const pageIds = /* @__PURE__ */ new Set();
  for (const [path] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/page.json")) {
      const parts = path.replace(/\\/g, "/").split("/");
      const pagesIdx = parts.findIndex((p) => p.toLowerCase() === "pages");
      if (pagesIdx !== -1 && pagesIdx + 1 < parts.length) {
        pageIds.add(parts[pagesIdx + 1]);
      }
    }
  }
  return pageIds;
}
function findAllPageJsonFiles(files) {
  const pageFiles = /* @__PURE__ */ new Map();
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/page.json")) {
      const parts = path.replace(/\\/g, "/").split("/");
      const pagesIdx = parts.findIndex((p) => p.toLowerCase() === "pages");
      if (pagesIdx !== -1 && pagesIdx + 1 < parts.length) {
        const pageId = parts[pagesIdx + 1];
        pageFiles.set(pageId, content);
      }
    }
  }
  return pageFiles;
}
function resolvePageDisplayName(pageId, files) {
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/page.json") && path.replace(/\\/g, "/").includes(`/${pageId}/`)) {
      try {
        const config = JSON.parse(content);
        return config.displayName || config.name || pageId;
      } catch {
      }
    }
  }
  return pageId;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/measureDiff.js
function detectMeasureChanges(beforeFiles, afterFiles) {
  const changes = [];
  const beforeModel = parseModelFromFiles(beforeFiles);
  const afterModel = parseModelFromFiles(afterFiles);
  if (!beforeModel || !afterModel) return changes;
  const beforeMeasures = buildMeasureMap(beforeModel.tables);
  const afterMeasures = buildMeasureMap(afterModel.tables);
  for (const [key, measure] of afterMeasures) {
    if (!beforeMeasures.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.MEASURE_ADDED,
        scope: CHANGE_SCOPES.MEASURE,
        target: { measureName: measure.name, tableName: measure.tableName },
        description: `Measure [${measure.name}] added to table "${measure.tableName}"`,
        details: { after: { expression: measure.expression } }
      }));
    }
  }
  for (const [key, measure] of beforeMeasures) {
    if (!afterMeasures.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.MEASURE_REMOVED,
        scope: CHANGE_SCOPES.MEASURE,
        target: { measureName: measure.name, tableName: measure.tableName },
        description: `Measure [${measure.name}] removed from table "${measure.tableName}"`,
        details: { before: { expression: measure.expression } }
      }));
    }
  }
  for (const [key, afterMeasure] of afterMeasures) {
    const beforeMeasure = beforeMeasures.get(key);
    if (!beforeMeasure) continue;
    const beforeExpr = normalizeExpression(beforeMeasure.expression);
    const afterExpr = normalizeExpression(afterMeasure.expression);
    if (beforeExpr !== afterExpr) {
      changes.push(createChange({
        type: CHANGE_TYPES.MEASURE_CHANGED,
        scope: CHANGE_SCOPES.MEASURE,
        target: { measureName: afterMeasure.name, tableName: afterMeasure.tableName },
        description: `Measure [${afterMeasure.name}] expression changed in table "${afterMeasure.tableName}"`,
        details: {
          before: { expression: beforeMeasure.expression },
          after: { expression: afterMeasure.expression }
        }
      }));
    }
  }
  changes.push(...detectCalcItemChanges(beforeModel.tables, afterModel.tables));
  changes.push(...detectColumnChanges(beforeModel.tables, afterModel.tables));
  return changes;
}
function detectCalcItemChanges(beforeTables, afterTables) {
  const changes = [];
  const beforeCalcItems = buildCalcItemMap(beforeTables);
  const afterCalcItems = buildCalcItemMap(afterTables);
  for (const [key, item] of afterCalcItems) {
    if (!beforeCalcItems.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.CALC_ITEM_ADDED,
        scope: CHANGE_SCOPES.MEASURE,
        target: { calcGroupName: item.tableName, calcItemName: item.name },
        description: `Calculation item [${item.name}] added to calculation group "${item.tableName}"`,
        details: { after: { expression: item.expression } }
      }));
    }
  }
  for (const [key, item] of beforeCalcItems) {
    if (!afterCalcItems.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.CALC_ITEM_REMOVED,
        scope: CHANGE_SCOPES.MEASURE,
        target: { calcGroupName: item.tableName, calcItemName: item.name },
        description: `Calculation item [${item.name}] removed from calculation group "${item.tableName}"`,
        details: { before: { expression: item.expression } }
      }));
    }
  }
  for (const [key, afterItem] of afterCalcItems) {
    const beforeItem = beforeCalcItems.get(key);
    if (!beforeItem) continue;
    if (normalizeExpression(beforeItem.expression) !== normalizeExpression(afterItem.expression)) {
      changes.push(createChange({
        type: CHANGE_TYPES.CALC_ITEM_CHANGED,
        scope: CHANGE_SCOPES.MEASURE,
        target: { calcGroupName: afterItem.tableName, calcItemName: afterItem.name },
        description: `Calculation item [${afterItem.name}] expression changed in "${afterItem.tableName}"`,
        details: {
          before: { expression: beforeItem.expression },
          after: { expression: afterItem.expression }
        }
      }));
    }
  }
  return changes;
}
function parseModelFromFiles(files) {
  const structure = identifyProjectStructure(files);
  if (!structure.tmdlFiles || structure.tmdlFiles.length === 0) return null;
  return parseTmdlModel(structure.tmdlFiles, structure.relationshipFiles || []);
}
function buildMeasureMap(tables) {
  const map = /* @__PURE__ */ new Map();
  for (const table of tables) {
    for (const measure of table.measures || []) {
      const key = `${table.name}.${measure.name}`;
      map.set(key, {
        name: measure.name,
        tableName: table.name,
        expression: measure.expression || ""
      });
    }
  }
  return map;
}
function buildCalcItemMap(tables) {
  const map = /* @__PURE__ */ new Map();
  for (const table of tables) {
    if (!table.calculationGroup || !table.calculationItems) continue;
    for (const item of table.calculationItems) {
      const key = `${table.name}.${item.name}`;
      map.set(key, {
        name: item.name,
        tableName: table.name,
        expression: item.expression || ""
      });
    }
  }
  return map;
}
function detectColumnChanges(beforeTables, afterTables) {
  const changes = [];
  const beforeColumns = buildColumnMap(beforeTables);
  const afterColumns = buildColumnMap(afterTables);
  for (const [key, col] of afterColumns) {
    if (!beforeColumns.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.COLUMN_ADDED,
        scope: CHANGE_SCOPES.COLUMN,
        target: { columnName: col.name, tableName: col.tableName },
        description: `Column [${col.name}] added to table "${col.tableName}"`,
        details: { after: { dataType: col.dataType } }
      }));
    }
  }
  for (const [key, col] of beforeColumns) {
    if (!afterColumns.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.COLUMN_REMOVED,
        scope: CHANGE_SCOPES.COLUMN,
        target: { columnName: col.name, tableName: col.tableName },
        description: `Column [${col.name}] removed from table "${col.tableName}"`,
        details: { before: { dataType: col.dataType } }
      }));
    }
  }
  for (const [key, afterCol] of afterColumns) {
    const beforeCol = beforeColumns.get(key);
    if (!beforeCol) continue;
    if (beforeCol.dataType && afterCol.dataType && beforeCol.dataType !== afterCol.dataType) {
      changes.push(createChange({
        type: CHANGE_TYPES.COLUMN_TYPE_CHANGED,
        scope: CHANGE_SCOPES.COLUMN,
        target: { columnName: afterCol.name, tableName: afterCol.tableName },
        description: `Column [${afterCol.name}] in "${afterCol.tableName}" data type changed from ${beforeCol.dataType} to ${afterCol.dataType}`,
        details: {
          before: { dataType: beforeCol.dataType },
          after: { dataType: afterCol.dataType }
        }
      }));
    }
  }
  return changes;
}
function buildColumnMap(tables) {
  const map = /* @__PURE__ */ new Map();
  for (const table of tables) {
    for (const col of table.columns || []) {
      const key = `${table.name}.${col.name}`;
      map.set(key, {
        name: col.name,
        tableName: table.name,
        dataType: col.dataType || ""
      });
    }
  }
  return map;
}
function normalizeExpression(expr) {
  if (!expr) return "";
  return expr.replace(/\s+/g, " ").trim();
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/visualDiff.js
function detectVisualChanges(beforeFiles, afterFiles) {
  const changes = [];
  const beforeVisuals = findAllVisualFiles(beforeFiles);
  const afterVisuals = findAllVisualFiles(afterFiles);
  for (const [key, info] of afterVisuals) {
    if (!beforeVisuals.has(key)) {
      const { visualId, pageId } = info;
      const config = parseJson(info.content);
      const title = extractVisualTitle(config) || visualId;
      const pageName = resolvePageName2(info, afterFiles);
      changes.push(createChange({
        type: CHANGE_TYPES.VISUAL_ADDED,
        scope: CHANGE_SCOPES.VISUAL,
        target: { visualId, visualName: title, pageId, pageName },
        description: `Visual "${title}" added to page "${pageName}"`
      }));
    }
  }
  for (const [key, info] of beforeVisuals) {
    if (!afterVisuals.has(key)) {
      const { visualId, pageId } = info;
      const config = parseJson(info.content);
      const title = extractVisualTitle(config) || visualId;
      const pageName = resolvePageName2(info, beforeFiles);
      changes.push(createChange({
        type: CHANGE_TYPES.VISUAL_REMOVED,
        scope: CHANGE_SCOPES.VISUAL,
        target: { visualId, visualName: title, pageId, pageName },
        description: `Visual "${title}" removed from page "${pageName}"`
      }));
    }
  }
  for (const [key, afterInfo] of afterVisuals) {
    const beforeInfo = beforeVisuals.get(key);
    if (!beforeInfo) continue;
    if (beforeInfo.content === afterInfo.content) continue;
    const beforeConfig = parseJson(beforeInfo.content);
    const afterConfig = parseJson(afterInfo.content);
    if (!beforeConfig || !afterConfig) continue;
    const { visualId, pageId } = afterInfo;
    const title = extractVisualTitle(afterConfig) || extractVisualTitle(beforeConfig) || visualId;
    const pageName = resolvePageName2(afterInfo, afterFiles);
    const target = { visualId, visualName: title, pageId, pageName };
    changes.push(...detectVisibilityChange(beforeConfig, afterConfig, target));
    changes.push(...detectBookmarkRefChange(beforeConfig, afterConfig, target));
    changes.push(...detectVisualFilterChanges(beforeConfig, afterConfig, target));
    changes.push(...detectFieldBindingChanges(beforeConfig, afterConfig, target));
  }
  return changes;
}
function detectVisibilityChange(beforeConfig, afterConfig, target) {
  const beforeHidden = beforeConfig.isHidden === true;
  const afterHidden = afterConfig.isHidden === true;
  if (beforeHidden === afterHidden) return [];
  return [createChange({
    type: CHANGE_TYPES.VISUAL_VISIBILITY_CHANGED,
    scope: CHANGE_SCOPES.VISUAL,
    target,
    description: afterHidden ? `Visual "${target.visualName}" was hidden in page "${target.pageName}"` : `Visual "${target.visualName}" was unhidden in page "${target.pageName}"`,
    details: { before: { isHidden: beforeHidden }, after: { isHidden: afterHidden } }
  })];
}
function detectBookmarkRefChange(beforeConfig, afterConfig, target) {
  const beforeRefs = extractBookmarkRefs(beforeConfig);
  const afterRefs = extractBookmarkRefs(afterConfig);
  if (beforeRefs.length === 0 && afterRefs.length === 0) return [];
  const beforeSet = new Set(beforeRefs);
  const afterSet = new Set(afterRefs);
  const added = afterRefs.filter((r) => !beforeSet.has(r));
  const removed = beforeRefs.filter((r) => !afterSet.has(r));
  if (added.length === 0 && removed.length === 0) return [];
  return [createChange({
    type: CHANGE_TYPES.VISUAL_BOOKMARK_CHANGED,
    scope: CHANGE_SCOPES.VISUAL,
    target,
    description: `Button/bookmark reference changed in visual "${target.visualName}" on page "${target.pageName}"`,
    details: { before: beforeRefs, after: afterRefs }
  })];
}
function detectVisualFilterChanges(beforeConfig, afterConfig, target) {
  const beforeFilters = beforeConfig.filterConfig?.filters || [];
  const afterFilters = afterConfig.filterConfig?.filters || [];
  if (beforeFilters.length === 0 && afterFilters.length === 0) return [];
  return diffFilters(beforeFilters, afterFilters, {
    scope: CHANGE_SCOPES.VISUAL,
    target,
    locationLabel: `visual "${target.visualName}" on page "${target.pageName}"`
  });
}
function detectFieldBindingChanges(beforeConfig, afterConfig, target) {
  const beforeFields = extractFieldsSimple(beforeConfig);
  const afterFields = extractFieldsSimple(afterConfig);
  const beforeSet = new Set(beforeFields.map((f) => `${f.type}|${f.table}|${f.field}`));
  const afterSet = new Set(afterFields.map((f) => `${f.type}|${f.table}|${f.field}`));
  const added = afterFields.filter((f) => !beforeSet.has(`${f.type}|${f.table}|${f.field}`));
  const removed = beforeFields.filter((f) => !afterSet.has(`${f.type}|${f.table}|${f.field}`));
  if (added.length === 0 && removed.length === 0) return [];
  const parts = [];
  if (added.length > 0) {
    parts.push(`added ${added.map((f) => `${f.table}[${f.field}]`).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`removed ${removed.map((f) => `${f.table}[${f.field}]`).join(", ")}`);
  }
  return [createChange({
    type: CHANGE_TYPES.VISUAL_FIELD_CHANGED,
    scope: CHANGE_SCOPES.VISUAL,
    target,
    description: `Field bindings changed in visual "${target.visualName}" on page "${target.pageName}": ${parts.join("; ")}`,
    details: { added, removed }
  })];
}
function extractFieldsSimple(config) {
  const fields = [];
  const seen = /* @__PURE__ */ new Set();
  function add(type, table, field) {
    const key = `${type}|${table}|${field}`;
    if (!seen.has(key) && table && field) {
      seen.add(key);
      fields.push({ type, table, field });
    }
  }
  const visual = config.visual || config;
  const query = visual.prototypeQuery || visual.query;
  const aliasMap = {};
  if (query?.From) {
    for (const from of query.From) {
      if (from.Name && from.Entity) aliasMap[from.Name] = from.Entity;
    }
  }
  if (query?.Select) {
    for (const item of query.Select) {
      if (item.Column) {
        const entity = item.Column.Expression?.SourceRef?.Entity || aliasMap[item.Column.Expression?.SourceRef?.Source] || "";
        add("column", entity, item.Column.Property || "");
      }
      if (item.Measure) {
        const entity = item.Measure.Expression?.SourceRef?.Entity || aliasMap[item.Measure.Expression?.SourceRef?.Source] || "";
        add("measure", entity, item.Measure.Property || "");
      }
    }
  }
  const queryState = visual.query?.queryState || visual.queryState;
  if (queryState) {
    for (const roleState of Object.values(queryState)) {
      if (!roleState?.projections) continue;
      for (const proj of roleState.projections) {
        const f = proj?.field;
        if (f?.Column) {
          add("column", f.Column.Expression?.SourceRef?.Entity || "", f.Column.Property || "");
        }
        if (f?.Measure) {
          add("measure", f.Measure.Expression?.SourceRef?.Entity || "", f.Measure.Property || "");
        }
      }
    }
  }
  return fields;
}
function extractBookmarkRefs(config) {
  const refs = [];
  const bookmarkPattern = /Bookmark[a-fA-F0-9]{20,}/g;
  const json = JSON.stringify(config);
  let match;
  while ((match = bookmarkPattern.exec(json)) !== null) {
    if (!refs.includes(match[0])) refs.push(match[0]);
  }
  return refs;
}
function extractVisualTitle(config) {
  if (!config) return "";
  const visual = config.visual || config;
  if (visual.title) {
    return typeof visual.title === "string" ? visual.title : visual.title.text || "";
  }
  if (visual.vcObjects?.title) {
    const arr = visual.vcObjects.title;
    if (Array.isArray(arr) && arr[0]?.properties?.text?.expr?.Literal?.Value) {
      return arr[0].properties.text.expr.Literal.Value.replace(/^'|'$/g, "");
    }
  }
  if (visual.visualContainerObjects?.title) {
    const arr = visual.visualContainerObjects.title;
    if (Array.isArray(arr) && arr[0]?.properties?.text?.expr?.Literal?.Value) {
      return arr[0].properties.text.expr.Literal.Value.replace(/^'|'$/g, "");
    }
  }
  return config.name || "";
}
function findAllVisualFiles(files) {
  const visuals = /* @__PURE__ */ new Map();
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.includes("/visuals/") && lower.endsWith("/visual.json")) {
      const parts = path.replace(/\\/g, "/").split("/");
      const visualsIdx = parts.findLastIndex((p) => p.toLowerCase() === "visuals");
      if (visualsIdx !== -1 && visualsIdx + 1 < parts.length) {
        const visualId = parts[visualsIdx + 1];
        const pagesIdx = parts.findIndex((p) => p.toLowerCase() === "pages");
        const hasPage = pagesIdx !== -1 && pagesIdx + 1 < parts.length;
        const pageId = hasPage ? parts[pagesIdx + 1] : "";
        const pageDir = hasPage ? parts.slice(0, pagesIdx + 2).join("/") : "";
        visuals.set(parts.slice(0, visualsIdx + 2).join("/"), { content, visualId, pageId, pageDir, path });
      }
    }
  }
  return visuals;
}
function resolvePageName2({ pageId, pageDir }, files) {
  if (!pageId) return "unknown";
  const own = parseJson(files.get(`${pageDir}/page.json`));
  if (own) return own.displayName || own.name || pageId;
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith("/page.json") && path.replace(/\\/g, "/").includes(`/${pageId}/`)) {
      try {
        const config = JSON.parse(content);
        return config.displayName || config.name || pageId;
      } catch {
      }
    }
  }
  return pageId;
}
function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/bookmarkDiff.js
function detectBookmarkChanges(beforeFiles, afterFiles) {
  const changes = [];
  const beforeBookmarks = findAllBookmarkFiles(beforeFiles);
  const afterBookmarks = findAllBookmarkFiles(afterFiles);
  for (const [id, info] of afterBookmarks) {
    if (!beforeBookmarks.has(id)) {
      const config = parseJson2(info.content);
      const name = config?.displayName || id;
      changes.push(createChange({
        type: CHANGE_TYPES.BOOKMARK_CHANGED,
        scope: CHANGE_SCOPES.BOOKMARK,
        target: { bookmarkId: id, bookmarkName: name },
        description: `Bookmark "${name}" was added`,
        details: { after: summarizeBookmark(config) }
      }));
    }
  }
  for (const [id, info] of beforeBookmarks) {
    if (!afterBookmarks.has(id)) {
      const config = parseJson2(info.content);
      const name = config?.displayName || id;
      changes.push(createChange({
        type: CHANGE_TYPES.BOOKMARK_CHANGED,
        scope: CHANGE_SCOPES.BOOKMARK,
        target: { bookmarkId: id, bookmarkName: name },
        description: `Bookmark "${name}" was removed`,
        details: { before: summarizeBookmark(config) }
      }));
    }
  }
  for (const [id, afterInfo] of afterBookmarks) {
    const beforeInfo = beforeBookmarks.get(id);
    if (!beforeInfo || beforeInfo.content === afterInfo.content) continue;
    const beforeConfig = parseJson2(beforeInfo.content);
    const afterConfig = parseJson2(afterInfo.content);
    if (!beforeConfig || !afterConfig) continue;
    const name = afterConfig.displayName || beforeConfig.displayName || id;
    const beforeSummary = summarizeBookmark(beforeConfig);
    const afterSummary = summarizeBookmark(afterConfig);
    if (JSON.stringify(beforeSummary) !== JSON.stringify(afterSummary)) {
      const descParts = [];
      if (beforeSummary.activeSection !== afterSummary.activeSection) {
        descParts.push(`active section changed`);
      }
      if (JSON.stringify(beforeSummary.targetVisuals) !== JSON.stringify(afterSummary.targetVisuals)) {
        descParts.push(`target visuals changed`);
      }
      if (JSON.stringify(beforeSummary.filterOverrides) !== JSON.stringify(afterSummary.filterOverrides)) {
        descParts.push(`filter overrides changed`);
      }
      const description = descParts.length > 0 ? `Bookmark "${name}" changed: ${descParts.join(", ")}` : `Bookmark "${name}" was modified`;
      changes.push(createChange({
        type: CHANGE_TYPES.BOOKMARK_CHANGED,
        scope: CHANGE_SCOPES.BOOKMARK,
        target: { bookmarkId: id, bookmarkName: name },
        description,
        details: { before: beforeSummary, after: afterSummary }
      }));
    }
  }
  return changes;
}
function summarizeBookmark(config) {
  if (!config) return {};
  const summary = {
    displayName: config.displayName || "",
    activeSection: config.explorationState?.activeSection || "",
    targetVisuals: config.options?.targetVisualNames || [],
    applyOnlyToTargets: config.options?.applyOnlyToTargetVisuals || false,
    filterOverrides: []
  };
  const filters = config.explorationState?.filters;
  if (filters) {
    if (filters.byName) {
      for (const [name, state] of Object.entries(filters.byName)) {
        summary.filterOverrides.push({ name, type: "byName", ...state });
      }
    }
    if (filters.byExpr) {
      for (const entry of Array.isArray(filters.byExpr) ? filters.byExpr : []) {
        summary.filterOverrides.push({ type: "byExpr", ...entry });
      }
    }
  }
  return summary;
}
function findAllBookmarkFiles(files) {
  const bookmarks = /* @__PURE__ */ new Map();
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.endsWith(".bookmark.json")) {
      const parts = path.replace(/\\/g, "/").split("/");
      const fileName = parts[parts.length - 1];
      const bookmarkId = fileName.replace(".bookmark.json", "");
      bookmarks.set(bookmarkId, { content, path });
    }
  }
  return bookmarks;
}
function parseJson2(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/relationshipDiff.js
function detectRelationshipChanges(beforeFiles, afterFiles) {
  const changes = [];
  const beforeModel = parseModelFromFiles2(beforeFiles);
  const afterModel = parseModelFromFiles2(afterFiles);
  if (!beforeModel || !afterModel) return changes;
  const beforeRels = buildRelationshipMap(beforeModel.relationships || []);
  const afterRels = buildRelationshipMap(afterModel.relationships || []);
  for (const [key, rel] of afterRels) {
    if (!beforeRels.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.RELATIONSHIP_ADDED,
        scope: CHANGE_SCOPES.RELATIONSHIP,
        target: { fromTable: rel.fromTable, fromColumn: rel.fromColumn, toTable: rel.toTable, toColumn: rel.toColumn },
        description: `Relationship added: ${rel.fromTable}[${rel.fromColumn}] -> ${rel.toTable}[${rel.toColumn}]`,
        details: { after: { crossFilter: rel.crossFilter } }
      }));
    }
  }
  for (const [key, rel] of beforeRels) {
    if (!afterRels.has(key)) {
      changes.push(createChange({
        type: CHANGE_TYPES.RELATIONSHIP_REMOVED,
        scope: CHANGE_SCOPES.RELATIONSHIP,
        target: { fromTable: rel.fromTable, fromColumn: rel.fromColumn, toTable: rel.toTable, toColumn: rel.toColumn },
        description: `Relationship removed: ${rel.fromTable}[${rel.fromColumn}] -> ${rel.toTable}[${rel.toColumn}]`,
        details: { before: { crossFilter: rel.crossFilter } }
      }));
    }
  }
  for (const [key, afterRel] of afterRels) {
    const beforeRel = beforeRels.get(key);
    if (!beforeRel) continue;
    if (beforeRel.crossFilter !== afterRel.crossFilter) {
      changes.push(createChange({
        type: CHANGE_TYPES.RELATIONSHIP_CHANGED,
        scope: CHANGE_SCOPES.RELATIONSHIP,
        target: { fromTable: afterRel.fromTable, fromColumn: afterRel.fromColumn, toTable: afterRel.toTable, toColumn: afterRel.toColumn },
        description: `Relationship ${afterRel.fromTable}[${afterRel.fromColumn}] -> ${afterRel.toTable}[${afterRel.toColumn}] cross-filter changed from "${beforeRel.crossFilter}" to "${afterRel.crossFilter}"`,
        details: {
          before: { crossFilter: beforeRel.crossFilter },
          after: { crossFilter: afterRel.crossFilter }
        }
      }));
    }
  }
  return changes;
}
function parseModelFromFiles2(files) {
  const structure = identifyProjectStructure(files);
  if (!structure.tmdlFiles || structure.tmdlFiles.length === 0) {
    if (!structure.relationshipFiles || structure.relationshipFiles.length === 0) return null;
  }
  return parseTmdlModel(structure.tmdlFiles || [], structure.relationshipFiles || []);
}
function buildRelationshipMap(relationships) {
  const map = /* @__PURE__ */ new Map();
  for (const rel of relationships) {
    const key = `${rel.fromTable}.${rel.fromColumn}->${rel.toTable}.${rel.toColumn}`;
    map.set(key, rel);
  }
  return map;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/sourceDiff.js
function detectSourceChanges(beforeFiles, afterFiles) {
  const changes = [];
  const beforeStructure = identifyProjectStructure(beforeFiles);
  const afterStructure = identifyProjectStructure(afterFiles);
  changes.push(...detectPartitionSourceChanges(beforeStructure, afterStructure));
  changes.push(...detectExpressionFileChanges(beforeStructure, afterStructure));
  return changes;
}
function detectPartitionSourceChanges(beforeStructure, afterStructure) {
  const changes = [];
  const beforeModel = parseModel(beforeStructure);
  const afterModel = parseModel(afterStructure);
  if (!beforeModel || !afterModel) return changes;
  const beforeSources = buildSourceMap(beforeModel.tables);
  const afterSources = buildSourceMap(afterModel.tables);
  for (const [key, afterSource] of afterSources) {
    const beforeSource = beforeSources.get(key);
    if (!beforeSource) continue;
    if (beforeSource.sourceExpression && afterSource.sourceExpression) {
      const beforeNorm = normalizeWhitespace(beforeSource.sourceExpression);
      const afterNorm = normalizeWhitespace(afterSource.sourceExpression);
      if (beforeNorm !== afterNorm) {
        changes.push(createChange({
          type: CHANGE_TYPES.SOURCE_EXPRESSION_CHANGED,
          scope: CHANGE_SCOPES.SOURCE,
          target: { tableName: afterSource.tableName, partitionName: afterSource.partitionName },
          description: `Source expression changed for partition "${afterSource.partitionName}" in table "${afterSource.tableName}"`,
          details: {
            before: { sourceExpression: beforeSource.sourceExpression },
            after: { sourceExpression: afterSource.sourceExpression }
          }
        }));
      }
    }
  }
  return changes;
}
function detectExpressionFileChanges(beforeStructure, afterStructure) {
  const changes = [];
  const beforeExprs = buildExpressionMap(beforeStructure.expressionFiles || []);
  const afterExprs = buildExpressionMap(afterStructure.expressionFiles || []);
  for (const [name, afterContent] of afterExprs) {
    const beforeContent = beforeExprs.get(name);
    if (beforeContent === void 0) continue;
    if (normalizeWhitespace(beforeContent) !== normalizeWhitespace(afterContent)) {
      const isParameter = isParameterLike(afterContent);
      const changeType = isParameter ? CHANGE_TYPES.PARAMETER_CHANGED : CHANGE_TYPES.EXPRESSION_CHANGED;
      const label = isParameter ? "Parameter" : "Expression";
      changes.push(createChange({
        type: changeType,
        scope: CHANGE_SCOPES.EXPRESSION,
        target: { expressionName: name },
        description: `${label} "${name}" changed`,
        details: {
          before: { content: beforeContent },
          after: { content: afterContent }
        }
      }));
    }
  }
  return changes;
}
function parseModel(structure) {
  if (!structure.tmdlFiles || structure.tmdlFiles.length === 0) return null;
  return parseTmdlModel(structure.tmdlFiles, structure.relationshipFiles || []);
}
function buildSourceMap(tables) {
  const map = /* @__PURE__ */ new Map();
  for (const table of tables) {
    for (const partition of table.partitions || []) {
      if (partition.sourceExpression) {
        const key = `${table.name}.${partition.name}`;
        map.set(key, {
          tableName: table.name,
          partitionName: partition.name,
          sourceExpression: partition.sourceExpression
        });
      }
    }
  }
  return map;
}
function buildExpressionMap(expressionFiles) {
  const map = /* @__PURE__ */ new Map();
  for (const { content } of expressionFiles) {
    const lines = content.split("\n");
    let currentName = null;
    let currentParts = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.replace(/\r$/, "").trim();
      const exprMatch = trimmed.match(/^expression\s+(.+?)\s*=\s*(.*)$/);
      if (exprMatch) {
        if (currentName) {
          map.set(currentName, currentParts.join("\n").trim());
        }
        currentName = unquoteName2(exprMatch[1].trim());
        const rest = exprMatch[2].trim();
        currentParts = rest ? [rest] : [];
        continue;
      }
      if (currentName) {
        currentParts.push(line.replace(/\r$/, ""));
      }
    }
    if (currentName) {
      map.set(currentName, currentParts.join("\n").trim());
    }
  }
  return map;
}
function unquoteName2(name) {
  if (name && name.startsWith("'") && name.endsWith("'")) {
    return name.slice(1, -1);
  }
  return name || "";
}
function isParameterLike(content) {
  if (!content) return false;
  const trimmed = content.trim();
  if (/^"[^"]*"(\s*meta\s*\[.*\])?\s*$/.test(trimmed)) return true;
  if (/^\d+(\.\d+)?\s*(meta\b|$)/i.test(trimmed)) return true;
  if (/^#(datetime|date)\s*\(/i.test(trimmed)) return true;
  return false;
}
function normalizeWhitespace(str2) {
  if (!str2) return "";
  return str2.replace(/\s+/g, " ").trim();
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/impactResolver.js
function resolveImpact(measureName, tableName, graph) {
  if (!graph) return [];
  const impacts = [];
  const seen = /* @__PURE__ */ new Set();
  const measureNodeId = `measure::${tableName}.${measureName}`;
  const measureNode = graph.nodes.get(measureNodeId);
  if (!measureNode) return impacts;
  const directVisuals = findDownstreamVisuals(measureNodeId, graph);
  for (const visual of directVisuals) {
    const key = `direct:${visual.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      impacts.push({
        type: "direct",
        visualId: visual.id,
        visualName: visual.name || visual.id,
        pageId: visual.metadata?.pageId || "",
        pageName: resolvePageNameFromGraph(visual.metadata?.pageId, graph),
        reason: `directly uses measure [${measureName}]`
      });
    }
  }
  const fpImpacts = resolveFieldParameterImpact(measureName, tableName, graph);
  for (const impact of fpImpacts) {
    const key = `fp:${impact.visualId}`;
    if (!seen.has(key)) {
      seen.add(key);
      impacts.push(impact);
    }
  }
  const cgImpacts = resolveCalcGroupImpact(measureNodeId, graph);
  for (const impact of cgImpacts) {
    const key = `cg:${impact.visualId}`;
    if (!seen.has(key)) {
      seen.add(key);
      impacts.push(impact);
    }
  }
  return impacts;
}
function resolveCalcItemImpact(calcGroupName, graph) {
  if (!graph) return [];
  const impacts = [];
  const seen = /* @__PURE__ */ new Set();
  const tableNodeId = `table::${calcGroupName}`;
  const tableNode = graph.nodes.get(tableNodeId);
  if (tableNode) {
    const visuals = findDownstreamVisuals(tableNodeId, graph);
    for (const visual of visuals) {
      const key = `cg_table:${visual.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        impacts.push({
          type: "calculation_group",
          visualId: visual.id,
          visualName: visual.name || visual.id,
          pageId: visual.metadata?.pageId || "",
          pageName: resolvePageNameFromGraph(visual.metadata?.pageId, graph),
          reason: `uses calculation group "${calcGroupName}"`
        });
      }
    }
  }
  for (const node of graph.nodes.values()) {
    if (node.metadata?.enrichmentType === ENRICHMENT_TYPES.CALCULATION_GROUP && (node.name === calcGroupName || node.metadata?.table === calcGroupName)) {
      const visuals = findDownstreamVisuals(node.id, graph);
      for (const visual of visuals) {
        const key = `cg_enrich:${visual.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          impacts.push({
            type: "calculation_group",
            visualId: visual.id,
            visualName: visual.name || visual.id,
            pageId: visual.metadata?.pageId || "",
            pageName: resolvePageNameFromGraph(visual.metadata?.pageId, graph),
            reason: `uses calculation group "${calcGroupName}"`
          });
        }
      }
    }
  }
  return impacts;
}
function findDownstreamVisuals(nodeId, graph) {
  const visuals = [];
  const visited = /* @__PURE__ */ new Set();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    const downstream = graph.adjacency.downstream.get(current) || [];
    for (const neighbor of downstream) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      const node = graph.nodes.get(neighbor);
      if (node?.type === NODE_TYPES.VISUAL) {
        visuals.push(node);
      } else {
        queue.push(neighbor);
      }
    }
  }
  return visuals;
}
function resolveFieldParameterImpact(measureName, tableName, graph) {
  const impacts = [];
  for (const node of graph.nodes.values()) {
    if (node.metadata?.enrichmentType !== ENRICHMENT_TYPES.FIELD_PARAMETER) continue;
    const fpFields = node.metadata?.fieldParameter?.fields || [];
    const fpTableName = node.metadata?.table || node.name;
    const isReferenced = fpFields.some((field) => {
      if (field.reference) {
        const ref = field.reference;
        if (ref.includes(`'${tableName}'[${measureName}]`)) return true;
        if (ref === `[${measureName}]`) return true;
      }
      return field.name === measureName;
    });
    if (!isReferenced) continue;
    const fpTableNodeId = `table::${fpTableName}`;
    const fpVisuals = findDownstreamVisuals(fpTableNodeId, graph);
    for (const visual of fpVisuals) {
      impacts.push({
        type: "field_parameter",
        visualId: visual.id,
        visualName: visual.name || visual.id,
        pageId: visual.metadata?.pageId || "",
        pageName: resolvePageNameFromGraph(visual.metadata?.pageId, graph),
        reason: `uses field parameter "${fpTableName}" which references [${measureName}]`
      });
    }
  }
  return impacts;
}
function resolveCalcGroupImpact(measureNodeId, graph) {
  const impacts = [];
  const directVisuals = findDownstreamVisuals(measureNodeId, graph);
  for (const visual of directVisuals) {
    const upstream = graph.adjacency.upstream.get(visual.id) || [];
    for (const upId of upstream) {
      const upNode = graph.nodes.get(upId);
      if (upNode?.metadata?.enrichmentType === ENRICHMENT_TYPES.CALCULATION_GROUP) {
        impacts.push({
          type: "calculation_group",
          visualId: visual.id,
          visualName: visual.name || visual.id,
          pageId: visual.metadata?.pageId || "",
          pageName: resolvePageNameFromGraph(visual.metadata?.pageId, graph),
          reason: `applies calculation group "${upNode.name || upNode.id}" to this measure`
        });
      }
    }
  }
  return impacts;
}
function resolvePageNameFromGraph(pageId, graph) {
  if (!pageId) return "unknown";
  const pageNodeId = `page::${pageId}`;
  const pageNode = graph.nodes.get(pageNodeId);
  return pageNode?.name || pageId;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/changeDetector.js
function detectChanges(beforeFiles, afterFiles, graph = null) {
  const allChanges = [];
  const reports = pairByProject(filterReportFiles(beforeFiles), filterReportFiles(afterFiles), ".report");
  const models = pairByProject(filterModelFiles(beforeFiles), filterModelFiles(afterFiles), ".semanticmodel");
  for (const [beforeReport, afterReport] of reports) {
    allChanges.push(...detectPageChanges(beforeReport, afterReport));
    allChanges.push(...detectReportFilterChanges(beforeReport, afterReport));
    allChanges.push(...detectVisualChanges(beforeReport, afterReport));
    allChanges.push(...detectBookmarkChanges(beforeReport, afterReport));
  }
  for (const [beforeModel, afterModel] of models) {
    allChanges.push(...detectMeasureChanges(beforeModel, afterModel));
    allChanges.push(...detectRelationshipChanges(beforeModel, afterModel));
    allChanges.push(...detectSourceChanges(beforeModel, afterModel));
  }
  if (graph) {
    for (const change of allChanges) {
      if (change.type === CHANGE_TYPES.MEASURE_CHANGED || change.type === CHANGE_TYPES.MEASURE_ADDED || change.type === CHANGE_TYPES.MEASURE_REMOVED) {
        const { measureName, tableName } = change.target;
        if (measureName && tableName) {
          change.impact = resolveImpact(measureName, tableName, graph);
        }
      } else if (change.type === CHANGE_TYPES.CALC_ITEM_CHANGED || change.type === CHANGE_TYPES.CALC_ITEM_ADDED || change.type === CHANGE_TYPES.CALC_ITEM_REMOVED) {
        const { calcGroupName } = change.target;
        if (calcGroupName) {
          change.impact = resolveCalcItemImpact(calcGroupName, graph);
        }
      }
    }
  }
  const summary = buildSummary(allChanges);
  return { changes: allChanges, summary };
}
function buildSummary(changes) {
  const byType = {};
  const byScope = {};
  for (const change of changes) {
    byType[change.type] = (byType[change.type] || 0) + 1;
    byScope[change.scope] = (byScope[change.scope] || 0) + 1;
  }
  return {
    totalChanges: changes.length,
    byType,
    byScope
  };
}
function pairByProject(beforeFiles, afterFiles, suffix) {
  const groups = /* @__PURE__ */ new Map();
  const add = (files, side2) => {
    for (const [path, content] of files) {
      const parts = path.replace(/\\/g, "/").split("/");
      const idx = parts.findIndex((p) => p.toLowerCase().endsWith(suffix));
      const key = idx === -1 ? "" : parts.slice(0, idx + 1).join("/");
      if (!groups.has(key)) groups.set(key, [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()]);
      groups.get(key)[side2].set(path, content);
    }
  };
  add(beforeFiles, 0);
  add(afterFiles, 1);
  return [...groups.values()];
}
function filterReportFiles(files) {
  const filtered = /* @__PURE__ */ new Map();
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.includes(".report/") || lower.includes("/definition/pages/") || lower.includes("/definition/bookmarks/") || lower.endsWith("/report.json") || lower.endsWith("/pages.json") || lower.endsWith("/page.json") || lower.endsWith("/visual.json") || lower.endsWith(".bookmark.json") || lower.endsWith(".pbir")) {
      filtered.set(path, content);
    }
  }
  if (filtered.size === 0) return files;
  return filtered;
}
function filterModelFiles(files) {
  const filtered = /* @__PURE__ */ new Map();
  for (const [path, content] of files) {
    const lower = path.toLowerCase().replace(/\\/g, "/");
    if (lower.includes(".semanticmodel/") || lower.endsWith(".tmdl")) {
      filtered.set(path, content);
    }
  }
  if (filtered.size === 0) return files;
  return filtered;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/changeTopics.js
var CHANGE_TOPICS = [
  { key: "measures", label: "Measures & calculation items" },
  { key: "columns", label: "Columns" },
  { key: "relationships", label: "Relationships" },
  { key: "sources", label: "Data sources & Power Query" },
  { key: "pages", label: "Pages" },
  { key: "visuals", label: "Visuals" },
  { key: "filters", label: "Filters" },
  { key: "bookmarks", label: "Bookmarks" },
  { key: "other", label: "Other" }
];
var TOPIC_BY_TYPE = {
  [CHANGE_TYPES.MEASURE_ADDED]: "measures",
  [CHANGE_TYPES.MEASURE_REMOVED]: "measures",
  [CHANGE_TYPES.MEASURE_CHANGED]: "measures",
  [CHANGE_TYPES.CALC_ITEM_ADDED]: "measures",
  [CHANGE_TYPES.CALC_ITEM_REMOVED]: "measures",
  [CHANGE_TYPES.CALC_ITEM_CHANGED]: "measures",
  [CHANGE_TYPES.COLUMN_ADDED]: "columns",
  [CHANGE_TYPES.COLUMN_REMOVED]: "columns",
  [CHANGE_TYPES.COLUMN_TYPE_CHANGED]: "columns",
  [CHANGE_TYPES.RELATIONSHIP_ADDED]: "relationships",
  [CHANGE_TYPES.RELATIONSHIP_REMOVED]: "relationships",
  [CHANGE_TYPES.RELATIONSHIP_CHANGED]: "relationships",
  [CHANGE_TYPES.SOURCE_EXPRESSION_CHANGED]: "sources",
  [CHANGE_TYPES.EXPRESSION_CHANGED]: "sources",
  [CHANGE_TYPES.PARAMETER_CHANGED]: "sources",
  [CHANGE_TYPES.PAGE_ADDED]: "pages",
  [CHANGE_TYPES.PAGE_REMOVED]: "pages",
  [CHANGE_TYPES.DEFAULT_PAGE_CHANGED]: "pages",
  [CHANGE_TYPES.VISUAL_ADDED]: "visuals",
  [CHANGE_TYPES.VISUAL_REMOVED]: "visuals",
  [CHANGE_TYPES.VISUAL_FIELD_CHANGED]: "visuals",
  [CHANGE_TYPES.VISUAL_VISIBILITY_CHANGED]: "visuals",
  [CHANGE_TYPES.VISUAL_BOOKMARK_CHANGED]: "visuals",
  [CHANGE_TYPES.FILTER_ADDED]: "filters",
  [CHANGE_TYPES.FILTER_REMOVED]: "filters",
  [CHANGE_TYPES.FILTER_CHANGED]: "filters",
  [CHANGE_TYPES.VISUAL_FILTER_ADDED]: "filters",
  [CHANGE_TYPES.VISUAL_FILTER_REMOVED]: "filters",
  [CHANGE_TYPES.VISUAL_FILTER_CHANGED]: "filters",
  [CHANGE_TYPES.BOOKMARK_CHANGED]: "bookmarks"
};
function topicForChange(change) {
  return TOPIC_BY_TYPE[change?.type] || "other";
}
function changeAction(change) {
  const type = change?.type || "";
  if (type.endsWith("_added")) return "added";
  if (type.endsWith("_removed")) return "removed";
  return "changed";
}
function groupChangesByTopic(changes) {
  const buckets = new Map(CHANGE_TOPICS.map((t) => [t.key, []]));
  for (const change of changes || []) {
    buckets.get(topicForChange(change)).push(change);
  }
  return CHANGE_TOPICS.filter((t) => buckets.get(t.key).length > 0).map((t) => ({ key: t.key, label: t.label, changes: buckets.get(t.key) }));
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/diff/textDiff.js
var MAX_LCS_CELLS = 4e6;
function splitLines(text) {
  if (text == null || text === "") return [];
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function diffLines(beforeText, afterText) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = [];
  for (let k = 0; k < start; k++) ops.push({ op: "=", i: k, j: k });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let truncated = false;
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    truncated = true;
    for (let k = 0; k < midA.length; k++) ops.push({ op: "-", i: start + k });
    for (let k = 0; k < midB.length; k++) ops.push({ op: "+", j: start + k });
  } else {
    ops.push(...lcsOps(midA, midB, start));
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ op: "=", i: endA + k, j: endB + k });
  const rows = pairIntoRows(ops, a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.op === "+") added++;
    else if (op.op === "-") removed++;
  }
  return { rows, added, removed, truncated };
}
function lcsOps(midA, midB, offset) {
  const n = midA.length;
  const m = midB.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[i2 * width + j2] = midA[i2] === midB[j2] ? dp[(i2 + 1) * width + j2 + 1] + 1 : Math.max(dp[(i2 + 1) * width + j2], dp[i2 * width + j2 + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ op: "=", i: offset + i, j: offset + j });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ op: "-", i: offset + i });
      i++;
    } else {
      ops.push({ op: "+", j: offset + j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: "-", i: offset + i });
    i++;
  }
  while (j < m) {
    ops.push({ op: "+", j: offset + j });
    j++;
  }
  return ops;
}
function pairIntoRows(ops, a, b) {
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.op === "=") {
      rows.push({ type: "same", left: a[op.i], right: b[op.j], leftNo: op.i + 1, rightNo: op.j + 1 });
      k++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (k < ops.length && ops[k].op !== "=") {
      if (ops[k].op === "-") dels.push(ops[k].i);
      else adds.push(ops[k].j);
      k++;
    }
    const len = Math.max(dels.length, adds.length);
    for (let r = 0; r < len; r++) {
      const di = dels[r];
      const aj = adds[r];
      if (di !== void 0 && aj !== void 0) {
        rows.push({ type: "changed", left: a[di], right: b[aj], leftNo: di + 1, rightNo: aj + 1 });
      } else if (di !== void 0) {
        rows.push({ type: "removed", left: a[di], right: null, leftNo: di + 1, rightNo: null });
      } else {
        rows.push({ type: "added", left: null, right: b[aj], leftNo: null, rightNo: aj + 1 });
      }
    }
  }
  return rows;
}
function collapseUnchanged(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.type === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep[k] = true;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((row, idx) => {
    if (keep[idx]) {
      if (skipped) {
        out.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      out.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: "skip", count: skipped });
  return out;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/compare/snapshot.js
var AGGREGATIONS = ["Sum", "Average", "Count", "Min", "Max", "Count (distinct)", "Median", "Standard deviation", "Variance"];
var COMPARISON_OPS = ["=", ">", ">=", "<", "<="];
var IGNORED_TMDL_PROPS = /* @__PURE__ */ new Set(["lineagetag", "sourcelineagetag", "annotation", "changedproperty", "isnameinferred", "extendedproperty"]);
function buildSnapshot(files) {
  const modelFiles = /* @__PURE__ */ new Map();
  const reportFiles = /* @__PURE__ */ new Map();
  for (const [path, content] of files || []) {
    const loc = locateFile(path);
    if (!loc) continue;
    const bucket = loc.kind === "model" ? modelFiles : reportFiles;
    if (!bucket.has(loc.key)) bucket.set(loc.key, { name: loc.name, files: /* @__PURE__ */ new Map() });
    bucket.get(loc.key).files.set(path, content);
  }
  const models = /* @__PURE__ */ new Map();
  for (const [key, { name, files: f }] of modelFiles) {
    const model = buildModel(name, f);
    if (model) models.set(key, model);
  }
  const reports = /* @__PURE__ */ new Map();
  for (const [key, { name, files: f }] of reportFiles) {
    const report = buildReport(name, f);
    if (report) reports.set(key, report);
  }
  return { models, reports };
}
function locateFile(path) {
  const parts = path.replace(/\\/g, "/").split("/");
  const lower = path.toLowerCase();
  const mi = parts.findIndex((p) => /\.semanticmodel$/i.test(p));
  if (mi !== -1) return { kind: "model", key: parts.slice(0, mi + 1).join("/"), name: parts[mi].replace(/\.semanticmodel$/i, "") };
  const ri = parts.findIndex((p) => /\.report$/i.test(p));
  if (ri !== -1) return { kind: "report", key: parts.slice(0, ri + 1).join("/"), name: parts[ri].replace(/\.report$/i, "") };
  if (lower.endsWith(".tmdl")) return { kind: "model", key: "", name: "" };
  if (lower.endsWith(".json") || lower.endsWith(".pbir")) return { kind: "report", key: "", name: "" };
  return null;
}
function buildModel(name, files) {
  return buildModelFromStructure(name, identifyProjectStructure(files));
}
function buildModelFromStructure(name, structure) {
  if (!structure) return null;
  if (!structure.tmdlFiles.length && !structure.relationshipFiles.length && !structure.roleFiles.length && !structure.expressionFiles.length) return null;
  const tables = /* @__PURE__ */ new Map();
  for (const { path, content } of structure.tmdlFiles) {
    const parsed = parseTableFile(content, path);
    if (!parsed?.name) continue;
    const childProps = scanChildProperties(content);
    const table = {
      name: parsed.name,
      isCalculationGroup: !!parsed.calculationGroup,
      columns: /* @__PURE__ */ new Map(),
      measures: /* @__PURE__ */ new Map(),
      calcItems: /* @__PURE__ */ new Map(),
      partitions: /* @__PURE__ */ new Map()
    };
    for (const col of [...parsed.columns, ...parsed.calculatedColumns]) {
      table.columns.set(col.name, {
        name: col.name,
        dataType: col.dataType || "",
        sourceColumn: col.sourceColumn || "",
        expression: col.expression || "",
        isHidden: !!col.isHidden,
        props: childProps.get(`column|${col.name}`) || {}
      });
    }
    for (const m of parsed.measures) {
      table.measures.set(m.name, {
        name: m.name,
        expression: m.expression || "",
        props: childProps.get(`measure|${m.name}`) || {}
      });
    }
    for (const ci of parsed.calculationItems || []) {
      table.calcItems.set(ci.name, { name: ci.name, expression: ci.expression || "" });
    }
    for (const p of parsed.partitions) {
      const src = extractMDataSource(p.sourceExpression || "");
      table.partitions.set(p.name, {
        name: p.name,
        type: p.type || "",
        mode: p.mode || "",
        sourceExpression: p.sourceExpression || "",
        source: describeDataSource(src)
      });
    }
    tables.set(table.name, table);
  }
  const relationships = /* @__PURE__ */ new Map();
  for (const { content } of structure.relationshipFiles) {
    for (const rel of parseRelationshipBlocks(content)) relationships.set(rel.name, rel);
  }
  const roles = /* @__PURE__ */ new Map();
  for (const { content } of structure.roleFiles) {
    for (const role of parseRoleBlocks(content)) roles.set(role.name, role);
  }
  const expressions = /* @__PURE__ */ new Map();
  for (const { content } of structure.expressionFiles) {
    for (const e of parseExpressions(content).expressions) {
      expressions.set(e.name, { name: e.name, kind: e.kind, value: e.mExpression || "" });
    }
  }
  return { name, tables, relationships, roles, expressions };
}
function scanChildProperties(content) {
  const out = /* @__PURE__ */ new Map();
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = indentOf(line);
    if (indent <= 1) {
      current = null;
      const m = indent === 1 && trimmed.match(/^(column|measure)\s+(.+?)(?:\s*=.*)?$/);
      if (m) {
        current = {};
        out.set(`${m[1]}|${unquoteName(m[2].trim())}`, current);
      }
      continue;
    }
    if (!current || indent !== 2) continue;
    const kv = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv) {
      if (!IGNORED_TMDL_PROPS.has(kv[1].toLowerCase())) current[kv[1]] = kv[2].trim();
    } else if (/^\w+$/.test(trimmed) && !IGNORED_TMDL_PROPS.has(trimmed.toLowerCase())) {
      current[trimmed] = "true";
    }
  }
  return out;
}
function parseRelationshipBlocks(content) {
  const rels = [];
  let current = null;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const decl = indentOf(line) === 0 && trimmed.match(/^relationship\s+(.+)$/);
    if (decl) {
      current = { name: unquoteName(decl[1].trim()), props: {} };
      rels.push(current);
      continue;
    }
    if (!current || indentOf(line) === 0) continue;
    const kv = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv && !IGNORED_TMDL_PROPS.has(kv[1].toLowerCase())) current.props[kv[1]] = kv[2].trim();
    else if (/^\w+$/.test(trimmed) && !IGNORED_TMDL_PROPS.has(trimmed.toLowerCase())) current.props[trimmed] = "true";
  }
  return rels.map(({ name, props }) => {
    const from = parseColumnRef(props.fromColumn);
    const to = parseColumnRef(props.toColumn);
    return {
      name,
      fromTable: from.table,
      fromColumn: from.column,
      toTable: to.table,
      toColumn: to.column,
      isActive: props.isActive !== "false",
      crossFilter: props.crossFilteringBehavior || "oneDirection",
      fromCardinality: props.fromCardinality || "many",
      toCardinality: props.toCardinality || "one",
      securityFilter: props.securityFilteringBehavior || "oneDirection",
      relyOnReferentialIntegrity: props.relyOnReferentialIntegrity === "true",
      joinOnDateBehavior: props.joinOnDateBehavior || ""
    };
  });
}
function parseColumnRef(ref) {
  if (!ref) return { table: "", column: "" };
  const bracket = ref.match(/^(.+?)\[(.+)\]$/);
  if (bracket) return { table: unquoteName(bracket[1].trim()), column: bracket[2].trim() };
  const quoted = ref.match(/^('(?:[^']|'')+'|[^.]+)\.(.+)$/);
  if (quoted) return { table: unquoteName(quoted[1].trim()), column: unquoteName(quoted[2].trim()) };
  return { table: "", column: unquoteName(ref.trim()) };
}
function parseRoleBlocks(content) {
  const lines = content.split(/\r?\n/);
  const roles = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const indent = indentOf(line);
    const roleMatch = indent === 0 && trimmed.match(/^role\s+(.+)$/);
    if (roleMatch) {
      current = { name: unquoteName(roleMatch[1].trim()), modelPermission: "", members: [], tablePermissions: /* @__PURE__ */ new Map(), columnPermissions: [] };
      roles.push(current);
      continue;
    }
    if (!current) continue;
    const perm = trimmed.match(/^modelPermission\s*:\s*(.+)$/);
    if (perm) {
      current.modelPermission = perm[1].trim();
      continue;
    }
    const member = trimmed.match(/^member\s+(.+)$/);
    if (member) {
      current.members.push(unquoteName(member[1].trim()));
      continue;
    }
    const tp = trimmed.match(/^tablePermission\s+(.+?)(?:\s*=\s*(.*))?$/);
    if (tp) {
      const table = unquoteName(tp[1].trim());
      const expr = tp[2] !== void 0 ? (extractDaxExpression(lines, i) || tp[2] || "").trim() : "";
      current.tablePermissions.set(table, expr);
      continue;
    }
    const cp = trimmed.match(/^columnPermission\s+(.+)$/);
    if (cp) {
      const metaLine = lines.slice(i + 1).find((l) => l.trim());
      const level = metaLine?.trim().match(/^metadataPermission\s*:\s*(.+)$/)?.[1] || "";
      current.columnPermissions.push(`${unquoteName(cp[1].trim())}${level ? `: ${level}` : ""}`);
    }
  }
  return roles;
}
function describeDataSource(ds) {
  if (!ds) return "";
  const parts = [ds.type, ds.server, ds.database, ds.schema, ds.sourceTable].filter(Boolean);
  return parts.join(" \xB7 ");
}
function indentOf(line) {
  const m = line.match(/^(\s*)/)[1];
  let tabs = 0;
  let spaces = 0;
  for (const ch of m) {
    if (ch === "	") tabs++;
    else spaces++;
  }
  return tabs + Math.floor(spaces / 4);
}
function buildReport(name, files) {
  const report = {
    name,
    modelRef: "",
    activePageId: "",
    theme: "",
    filters: /* @__PURE__ */ new Map(),
    pages: /* @__PURE__ */ new Map(),
    visuals: /* @__PURE__ */ new Map(),
    // "pageId/visualId" -> visual
    bookmarks: /* @__PURE__ */ new Map(),
    hasDefinition: false
  };
  let any = false;
  for (const [path, content] of files) {
    const norm3 = path.replace(/\\/g, "/");
    const parts = norm3.split("/");
    const lower = norm3.toLowerCase();
    const json = lower.endsWith(".json") || lower.endsWith(".pbir") ? safeJson(content) : null;
    const pagesIdx = parts.findIndex((p) => p.toLowerCase() === "pages");
    if (lower.endsWith("definition.pbir")) {
      any = true;
      report.hasDefinition = true;
      const ref = json?.datasetReference;
      report.modelRef = ref?.byPath?.path || (ref?.byConnection ? `Connection: ${ref.byConnection.pbiModelDatabaseName || ref.byConnection.connectionString || "remote model"}` : "");
    } else if (lower.endsWith("/report.json") || lower === "report.json" || lower === "definition/report.json") {
      any = true;
      report.theme = json?.themeCollection?.customTheme?.name || json?.themeCollection?.baseTheme?.name || "";
      for (const f of json?.filterConfig?.filters || []) addFilter(report.filters, f);
    } else if (lower.endsWith("/pages/pages.json")) {
      any = true;
      report.activePageId = json?.activePageName || "";
    } else if (lower.endsWith("/page.json") && pagesIdx !== -1) {
      any = true;
      const pageId = parts[pagesIdx + 1];
      const page = ensurePage(report, pageId);
      page.name = json?.displayName || json?.name || pageId;
      page.hidden = json?.visibility === "HiddenInViewMode";
      page.hasFile = true;
      for (const f of json?.filterConfig?.filters || []) addFilter(page.filters, f);
    } else if (lower.endsWith("/visual.json") && pagesIdx !== -1) {
      any = true;
      const visualsIdx = parts.findLastIndex((p) => p.toLowerCase() === "visuals");
      const pageId = parts[pagesIdx + 1];
      const visualId = parts[visualsIdx + 1];
      if (!json || !visualId) continue;
      ensurePage(report, pageId);
      report.visuals.set(`${pageId}/${visualId}`, buildVisual(json, pageId, visualId));
    } else if (lower.endsWith(".bookmark.json")) {
      any = true;
      const id = parts[parts.length - 1].replace(/\.bookmark\.json$/i, "");
      if (json) report.bookmarks.set(id, buildBookmark(json, id));
    }
  }
  return any ? report : null;
}
function ensurePage(report, pageId) {
  if (!report.pages.has(pageId)) {
    report.pages.set(pageId, { id: pageId, name: pageId, hidden: false, filters: /* @__PURE__ */ new Map(), hasFile: false });
  }
  return report.pages.get(pageId);
}
function buildVisual(config, pageId, visualId) {
  const visual = config.visual || {};
  const isGroup = !!config.visualGroup;
  const type = isGroup ? "group" : visual.visualType || config.visualType || "unknown";
  const title = visualTitle(config);
  const { labels, refs } = visualFields(config);
  const filters = /* @__PURE__ */ new Map();
  for (const f of config.filterConfig?.filters || visual.filterConfig?.filters || []) addFilter(filters, f);
  return {
    id: visualId,
    pageId,
    type,
    title,
    isHidden: config.isHidden === true || visual.isHidden === true,
    fields: labels,
    refs,
    filters,
    slicerSelection: slicerSelectionOf(visual.objects)
  };
}
function slicerSelectionOf(objects) {
  const general = objects?.general;
  const props = Array.isArray(general) ? general[0]?.properties : general?.properties;
  return describeFilterCondition(props?.filter?.filter);
}
function visualDisplayName(v) {
  return v.title || `${prettyVisualType(v.type)} (untitled)`;
}
function visualLabel(v) {
  return `${visualDisplayName(v)} (${prettyVisualType(v.type)} \xB7 ${String(v.id).slice(0, 7)})`;
}
var VISUAL_TYPE_NAMES = {
  tableEx: "Table",
  pivotTable: "Matrix",
  card: "Card",
  multiRowCard: "Multi-row card",
  cardVisual: "Card",
  slicer: "Slicer",
  advancedSlicerVisual: "Button slicer",
  textbox: "Text box",
  image: "Image",
  shape: "Shape",
  actionButton: "Button",
  kpi: "KPI",
  gauge: "Gauge",
  map: "Map",
  filledMap: "Filled map",
  azureMap: "Azure map",
  lineChart: "Line chart",
  areaChart: "Area chart",
  barChart: "Bar chart",
  columnChart: "Column chart",
  clusteredBarChart: "Clustered bar chart",
  clusteredColumnChart: "Clustered column chart",
  lineClusteredColumnComboChart: "Line and clustered column chart",
  pieChart: "Pie chart",
  donutChart: "Donut chart",
  scatterChart: "Scatter chart",
  waterfallChart: "Waterfall chart",
  funnel: "Funnel",
  treemap: "Treemap",
  group: "Group"
};
function prettyVisualType(type) {
  if (!type) return "Visual";
  return VISUAL_TYPE_NAMES[type] || type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
function visualTitle(config) {
  const visual = config.visual || config;
  if (config.visualGroup?.displayName) return config.visualGroup.displayName;
  if (typeof visual.title === "string") return visual.title;
  if (visual.title?.text) return visual.title.text;
  for (const holder of [visual.visualContainerObjects, visual.vcObjects, visual.objects]) {
    const t = holder?.title;
    const props = Array.isArray(t) ? t[0]?.properties : t?.properties;
    const text = props?.text;
    if (typeof text === "string") return text;
    const lit = text?.expr?.Literal?.Value;
    if (lit !== void 0) return decodeLiteral(lit);
  }
  return "";
}
function visualFields(config) {
  const visual = config.visual || config;
  const labels = [];
  const refs = /* @__PURE__ */ new Set();
  const queryState = visual.query?.queryState || visual.queryState;
  if (queryState && typeof queryState === "object") {
    for (const [role, state] of Object.entries(queryState)) {
      for (const proj of state?.projections || []) {
        const label = fieldLabel(proj?.field, {}, refs);
        if (label) labels.push(`${role}: ${label}${proj.displayName ? ` as "${proj.displayName}"` : ""}`);
      }
      for (const fp of state?.fieldParameters || []) {
        const entity = fp?.parameterExpr?.Column?.Expression?.SourceRef?.Entity;
        if (entity) {
          labels.push(`${role}: field parameter ${entity}`);
          refs.add(`table|${entity}|`);
        }
      }
    }
  }
  const pq = visual.prototypeQuery;
  if (!labels.length && pq?.Select) {
    const alias = {};
    for (const f of pq.From || []) if (f.Name && f.Entity) alias[f.Name] = f.Entity;
    for (const item of pq.Select) {
      const label = fieldLabel(item, alias, refs);
      if (label) labels.push(`Fields: ${label}`);
    }
  }
  return { labels: [...new Set(labels)], refs };
}
function fieldLabel(f, alias = {}, refs = null) {
  if (!f || typeof f !== "object") return "";
  const entityOf = (x) => x?.Expression?.SourceRef?.Entity || alias[x?.Expression?.SourceRef?.Source] || x?.Expression?.SourceRef?.Source || "";
  if (f.Measure) {
    const t = entityOf(f.Measure);
    refs?.add(`measure|${t}|${f.Measure.Property}`);
    return `${t}[${f.Measure.Property}]`;
  }
  if (f.Column) {
    const t = entityOf(f.Column);
    refs?.add(`column|${t}|${f.Column.Property}`);
    return `${t}[${f.Column.Property}]`;
  }
  if (f.Aggregation) {
    const inner = fieldLabel(f.Aggregation.Expression, alias, refs);
    const fn = AGGREGATIONS[f.Aggregation.Function] || `Aggregate ${f.Aggregation.Function}`;
    return inner ? `${fn} of ${inner}` : "";
  }
  if (f.HierarchyLevel) {
    const h = f.HierarchyLevel.Expression?.Hierarchy;
    const t = entityOf(h);
    if (t) refs?.add(`table|${t}|`);
    return `${t}[${h?.Hierarchy || ""}].${f.HierarchyLevel.Level || ""}`;
  }
  if (f.Literal) return decodeLiteral(f.Literal.Value);
  return "";
}
function addFilter(map, filter) {
  if (!filter || typeof filter !== "object") return;
  const field = fieldLabel(filter.field) || "(unknown field)";
  const key = filter.name || `field:${field}`;
  const condition = describeFilterCondition(filter.filter);
  const refs = /* @__PURE__ */ new Set();
  fieldLabel(filter.field, {}, refs);
  map.set(key, {
    key,
    field,
    type: filter.type || "",
    condition,
    applied: condition !== "",
    hidden: filter.isHiddenInViewMode === true,
    locked: filter.isLockedInViewMode === true,
    refs
  });
}
function describeFilterCondition(filterDef) {
  const where = filterDef?.Where;
  if (!Array.isArray(where) || where.length === 0) return "";
  const alias = {};
  for (const f of filterDef.From || []) if (f.Name && f.Entity) alias[f.Name] = f.Entity;
  return where.map((w) => describeCondition(w?.Condition, alias)).filter(Boolean).join(" and ");
}
function describeCondition(c, alias) {
  if (!c) return "";
  const expr = (e) => fieldLabel(e, alias) || stableJson(e);
  if (c.In) {
    const lhs = (c.In.Expressions || []).map(expr).join(", ");
    if (c.In.Values) {
      const vals = c.In.Values.map((row) => row.map((v) => v?.Literal ? decodeLiteral(v.Literal.Value) : expr(v)).join(" / "));
      return `${lhs} is ${vals.length === 1 ? vals[0] : `one of ${vals.join(", ")}`}`;
    }
    return `${lhs} in ${stableJson(c.In.Table || c.In)}`;
  }
  if (c.Not) return `not (${describeCondition(c.Not.Expression, alias)})`;
  if (c.And) return `${describeCondition(c.And.Left, alias)} and ${describeCondition(c.And.Right, alias)}`;
  if (c.Or) return `(${describeCondition(c.Or.Left, alias)} or ${describeCondition(c.Or.Right, alias)})`;
  if (c.Comparison) {
    const op = COMPARISON_OPS[c.Comparison.ComparisonKind] ?? `op${c.Comparison.ComparisonKind}`;
    return `${expr(c.Comparison.Left)} ${op} ${expr(c.Comparison.Right)}`;
  }
  if (c.Between) return `${expr(c.Between.Expression)} between ${expr(c.Between.LowerBound)} and ${expr(c.Between.UpperBound)}`;
  for (const k of ["Contains", "StartsWith", "EndsWith"]) {
    if (c[k]) return `${expr(c[k].Left)} ${k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} ${expr(c[k].Right)}`;
  }
  return stableJson(c);
}
function decodeLiteral(v) {
  if (v === null || v === void 0) return "";
  const s = String(v);
  let m = s.match(/^'((?:[^']|'')*)'$/);
  if (m) return m[1].replace(/''/g, "'");
  m = s.match(/^(-?\d+(?:\.\d+)?)[DLM]$/);
  if (m) return m[1];
  m = s.match(/^datetime'(.+)'$/i);
  if (m) return m[1].replace(/T00:00:00(\.0+)?$/, "");
  return s;
}
function buildBookmark(json, id) {
  const state = json.explorationState || {};
  const { activeSection, ...rest } = state;
  const opts = json.options || {};
  return {
    id,
    name: json.displayName || id,
    pageId: activeSection || "",
    targetVisuals: (opts.targetVisualNames || []).length,
    targetVisualIds: opts.targetVisualNames || [],
    appliesToSelectedVisuals: opts.applyOnlyToTargetVisuals === true,
    capturesData: opts.suppressData !== true,
    capturesDisplay: opts.suppressDisplay !== true,
    capturesCurrentPage: opts.suppressActiveSection !== true,
    capturedState: stableJson(rest),
    state
    // raw explorationState, used to work out what the bookmark changes
  };
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function stableJson(value) {
  if (value === void 0) return "";
  return JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => {
    o[k] = v[k];
    return o;
  }, {}) : v);
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/compare/dependencyImpact.js
var IMPACT_GROUPS = [
  { key: "visual", label: "Visuals" },
  { key: "filter", label: "Filters" },
  { key: "security", label: "Security (RLS)" },
  { key: "measure", label: "Downstream measures" },
  { key: "column", label: "Calculated columns" },
  { key: "table", label: "Calculated tables and field parameters" },
  { key: "relationship", label: "Relationships" }
];
var BREAK_EFFECT = {
  visual: "Will show an error",
  filter: "Filter will stop working",
  security: "Role filter will error, so members of the role can't query the model",
  measure: "Will return an error",
  column: "Will fail on refresh",
  table: "Will fail on refresh",
  relationship: "Will be invalid"
};
var CHANGE_EFFECT = {
  visual: "Values may change",
  filter: "Filters on the new values",
  security: "Rows this role can see may change",
  measure: "Results may change",
  column: "Values may change on refresh",
  table: "Contents may change on refresh",
  relationship: "Both sides must keep matching data types"
};
function buildDependencyIndex(snapshot) {
  const perModel = /* @__PURE__ */ new Map();
  const modelKeys = [...snapshot.models.keys()];
  for (const [key, model] of snapshot.models) perModel.set(key, indexModel(model));
  for (const [reportKey, report] of snapshot.reports) {
    const modelKey = resolveModelKey(reportKey, report.modelRef, modelKeys);
    if (modelKey == null || !perModel.has(modelKey)) continue;
    indexReport(perModel.get(modelKey), report, snapshot.reports.size > 1);
  }
  return { perModel };
}
function describeImpact(index, modelKey, target, mode) {
  const dep = index?.perModel.get(modelKey);
  if (!dep) return null;
  const breaks = mode !== "changed";
  const start = [];
  let note = "";
  if (target.kind === "measure") {
    if (breaks && mode === "removed" && dep.measures.has(lc(target.name))) {
      note = `A measure named [${target.name}] still exists in ${dep.measures.get(lc(target.name)).table}, so references by name keep working (it was most likely moved).`;
      return { severity: "none", headline: "Nothing breaks", groups: [], note };
    }
    start.push(measureKey(target.name));
  } else if (target.kind === "column") {
    start.push(columnKey(target.table, target.name));
  } else if (target.kind === "table") {
    start.push(tableKey(target.name));
    for (const c of target.columns || []) start.push(columnKey(target.name, c));
    for (const m of target.measures || []) {
      if (!dep.measures.has(lc(m))) start.push(measureKey(m));
    }
  }
  const found = /* @__PURE__ */ new Map();
  const queue = start.map((k) => ({ key: k, via: "" }));
  const seenKeys = new Set(start);
  while (queue.length) {
    const { key, via } = queue.shift();
    for (const id of dep.users.get(key) || []) {
      if (found.has(id)) continue;
      const obj = dep.objects.get(id);
      if (!obj || obj.self === key) continue;
      found.set(id, { obj, via });
      for (const next of obj.provides || []) {
        if (!seenKeys.has(next)) {
          seenKeys.add(next);
          queue.push({ key: next, via: obj.short });
        }
      }
    }
  }
  const groups = IMPACT_GROUPS.map((g) => ({ ...g, items: [] }));
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  for (const { obj, via } of found.values()) {
    byKey[obj.group].items.push({
      label: obj.label,
      via,
      effect: (breaks ? BREAK_EFFECT : CHANGE_EFFECT)[obj.group]
    });
  }
  for (const g of groups) g.items.sort((a, b) => (a.via ? 1 : 0) - (b.via ? 1 : 0) || a.label.localeCompare(b.label));
  const nonEmpty = groups.filter((g) => g.items.length);
  if (!nonEmpty.length) {
    return {
      severity: "none",
      headline: breaks ? "Nothing else uses it, so nothing breaks" : "Nothing else uses it",
      groups: []
    };
  }
  return { severity: breaks ? "breaks" : "changes", headline: headline(nonEmpty, breaks), groups: nonEmpty, ...note ? { note } : {} };
}
function impactTouchesSecurity(impact) {
  return !!impact?.groups?.some((g) => g.key === "security" && g.items.length);
}
function resolveModelKey(reportKey, modelRef, modelKeys) {
  if (modelRef && !modelRef.startsWith("Connection:")) {
    const base = (reportKey || "").split("/").slice(0, -1);
    for (const part of modelRef.replace(/\\/g, "/").split("/")) {
      if (part === "..") base.pop();
      else if (part && part !== ".") base.push(part);
    }
    const resolved = base.join("/").toLowerCase();
    const exact = modelKeys.find((k) => k.toLowerCase() === resolved);
    if (exact != null) return exact;
    const byName = modelKeys.find((k) => k.split("/").pop().toLowerCase() === resolved.split("/").pop());
    if (byName != null) return byName;
  } else if (modelRef) {
    return null;
  }
  return modelKeys.length === 1 ? modelKeys[0] : null;
}
function indexModel(model) {
  const dep = {
    measures: /* @__PURE__ */ new Map(),
    // lower-case measure name -> { table, name }
    columns: /* @__PURE__ */ new Set(),
    // columnKey of every column
    users: /* @__PURE__ */ new Map(),
    // dependency key -> Set<object id>
    objects: /* @__PURE__ */ new Map()
    // object id -> { group, label, short, self, provides }
  };
  for (const t of model.tables.values()) {
    for (const m of t.measures.values()) dep.measures.set(lc(m.name), { table: t.name, name: m.name });
    for (const c of t.columns.values()) dep.columns.add(columnKey(t.name, c.name));
  }
  const addObject = (id, obj, dax) => {
    dep.objects.set(id, obj);
    for (const key of daxDependencies(dep, dax, obj.homeTable)) addUser(dep, key, id);
  };
  for (const t of model.tables.values()) {
    for (const m of t.measures.values()) {
      addObject(`measure:${lc(m.name)}`, {
        group: "measure",
        label: `${t.name}[${m.name}]`,
        short: `[${m.name}]`,
        self: measureKey(m.name),
        provides: [measureKey(m.name)],
        homeTable: t.name
      }, m.expression);
    }
    for (const c of t.columns.values()) {
      if (!c.expression) continue;
      addObject(`column:${columnKey(t.name, c.name)}`, {
        group: "column",
        label: `${t.name}[${c.name}]`,
        short: `${t.name}[${c.name}]`,
        self: columnKey(t.name, c.name),
        provides: [columnKey(t.name, c.name)],
        homeTable: t.name
      }, c.expression);
    }
    for (const p of t.partitions.values()) {
      if (p.type !== "calculated" || !p.sourceExpression) continue;
      addObject(`table:${lc(t.name)}`, {
        group: "table",
        label: `${t.name}${/NAMEOF\s*\(/i.test(p.sourceExpression) ? " (field parameter)" : ""}`,
        short: t.name,
        self: tableKey(t.name),
        provides: [tableKey(t.name), ...[...t.columns.keys()].map((c) => columnKey(t.name, c))],
        homeTable: t.name
      }, p.sourceExpression);
    }
  }
  for (const role of model.roles.values()) {
    for (const [table, expr] of role.tablePermissions) {
      if (!expr) continue;
      addObject(`role:${lc(role.name)}|${lc(table)}`, {
        group: "security",
        label: `RLS role "${role.name}" (filter on ${table})`,
        short: `role ${role.name}`,
        self: "",
        provides: [],
        homeTable: table
      }, expr);
    }
  }
  for (const r of model.relationships.values()) {
    const id = `rel:${lc(r.name)}`;
    dep.objects.set(id, {
      group: "relationship",
      label: `${r.fromTable}[${r.fromColumn}] \u2192 ${r.toTable}[${r.toColumn}]${r.isActive ? "" : " (inactive)"}`,
      short: "relationship",
      self: "",
      provides: []
    });
    addUser(dep, columnKey(r.fromTable, r.fromColumn), id);
    addUser(dep, columnKey(r.toTable, r.toColumn), id);
  }
  return dep;
}
function indexReport(dep, report, showReportName) {
  const prefix = showReportName && report.name ? `${report.name} \u203A ` : "";
  const pname = (id) => report.pages.get(id)?.name || id;
  const addRefs = (id, obj, refs) => {
    dep.objects.set(id, obj);
    for (const ref of refs) {
      const [kind, table, name] = ref.split("|");
      if (kind === "measure") addUser(dep, measureKey(name), id);
      else if (kind === "column") addUser(dep, columnKey(table, name), id);
      else if (kind === "table") addUser(dep, tableKey(table), id);
    }
  };
  const rk = report.name || "";
  for (const [vKey, v] of report.visuals) {
    addRefs(`visual:${rk}|${vKey}`, {
      group: "visual",
      label: `${visualLabel(v)} on ${prefix}${pname(v.pageId)}`,
      short: "visual",
      self: "",
      provides: []
    }, v.refs);
    for (const [fKey, f] of v.filters) {
      addRefs(`filter:${rk}|${vKey}|${fKey}`, {
        group: "filter",
        label: `Visual filter on ${visualLabel(v)} (${prefix}${pname(v.pageId)})`,
        short: "filter",
        self: "",
        provides: []
      }, f.refs);
    }
  }
  for (const p of report.pages.values()) {
    for (const [fKey, f] of p.filters) {
      addRefs(`filter:${rk}|page:${p.id}|${fKey}`, {
        group: "filter",
        label: `Page filter on ${prefix}${p.name}`,
        short: "filter",
        self: "",
        provides: []
      }, f.refs);
    }
  }
  for (const [fKey, f] of report.filters) {
    addRefs(`filter:${rk}|report|${fKey}`, {
      group: "filter",
      label: `Report filter (all pages${report.name && showReportName ? ` of ${report.name}` : ""})`,
      short: "filter",
      self: "",
      provides: []
    }, f.refs);
  }
}
function daxDependencies(dep, dax, homeTable) {
  if (!dax) return [];
  const keys = /* @__PURE__ */ new Set();
  for (const { table, column } of extractColumnRefs(dax)) {
    const ck = columnKey(table, column);
    if (dep.columns.has(ck)) keys.add(ck);
    else if (dep.measures.has(lc(column))) keys.add(measureKey(column));
    else keys.add(ck);
    keys.add(tableKey(table));
  }
  for (const { measure } of extractMeasureRefs(dax)) {
    if (dep.measures.has(lc(measure))) keys.add(measureKey(measure));
    else if (homeTable && dep.columns.has(columnKey(homeTable, measure))) keys.add(columnKey(homeTable, measure));
    else keys.add(measureKey(measure));
  }
  for (const t of extractTableRefs(dax)) keys.add(tableKey(t));
  return [...keys];
}
function addUser(dep, key, id) {
  if (!dep.users.has(key)) dep.users.set(key, /* @__PURE__ */ new Set());
  dep.users.get(key).add(id);
}
function headline(groups, breaks) {
  const n = (g) => g.items.length;
  const noun = {
    visual: ["visual", "visuals"],
    filter: ["filter", "filters"],
    security: ["RLS role filter", "RLS role filters"],
    measure: ["measure", "measures"],
    column: ["calculated column", "calculated columns"],
    table: ["calculated table", "calculated tables"],
    relationship: ["relationship", "relationships"]
  };
  const parts = groups.map((g) => `${n(g)} ${noun[g.key][n(g) === 1 ? 0 : 1]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return breaks ? `Breaks ${list}` : `May change ${list} (nothing breaks)`;
}
function lc(s) {
  return String(s ?? "").toLowerCase();
}
function measureKey(name) {
  return `m|${lc(name)}`;
}
function columnKey(table, column) {
  return `c|${lc(table)}|${lc(column)}`;
}
function tableKey(table) {
  return `t|${lc(table)}`;
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/compare/modelDiagram.js
function modelDiagramData(model) {
  if (!model) return { tables: [], relationships: [] };
  const relationships = [...model.relationships.values()].map((r) => relRecord(r, "unchanged"));
  const keyColumns = keyColumnIndex(relationships);
  const tables = [...model.tables.values()].map((t) => tableRecord(t, "unchanged", keyColumns.get(t.name)));
  return { tables, relationships };
}
function diffModelDiagram(before, after) {
  const bTables = before?.tables || /* @__PURE__ */ new Map();
  const aTables = after?.tables || /* @__PURE__ */ new Map();
  const bRels = new Map(before?.relationships || []);
  const aRels = new Map(after?.relationships || []);
  for (const [name, ar] of [...aRels]) {
    if (bRels.has(name)) continue;
    const match = [...bRels].find(([bn, br]) => !aRels.has(bn) && endpoints(br) === endpoints(ar));
    if (match) {
      bRels.delete(match[0]);
      bRels.set(name, match[1]);
    }
  }
  const relationships = [];
  for (const name of union(bRels.keys(), aRels.keys())) {
    const br = bRels.get(name);
    const ar = aRels.get(name);
    if (!br) {
      relationships.push(relRecord(ar, "added"));
      continue;
    }
    if (!ar) {
      relationships.push(relRecord(br, "removed"));
      continue;
    }
    const changes = relationshipChanges(br, ar);
    relationships.push({ ...relRecord(ar, changes.length ? "changed" : "unchanged"), id: ar.name, changes, before: relRecord(br, "unchanged") });
  }
  const keyColumns = keyColumnIndex(relationships);
  const tables = [];
  for (const name of union(bTables.keys(), aTables.keys())) {
    const bt = bTables.get(name);
    const at = aTables.get(name);
    if (!bt || !at) {
      tables.push(tableRecord(at || bt, at ? "added" : "removed", keyColumns.get(name)));
      continue;
    }
    const columnChanges = [];
    for (const c of union(bt.columns.keys(), at.columns.keys())) {
      const bc = bt.columns.get(c);
      const ac = at.columns.get(c);
      if (!bc) columnChanges.push({ name: c, status: "added", detail: ac.dataType || "" });
      else if (!ac) columnChanges.push({ name: c, status: "removed", detail: bc.dataType || "" });
      else {
        const details = [];
        if (bc.dataType !== ac.dataType) details.push(`${bc.dataType || "?"} \u2192 ${ac.dataType || "?"}`);
        if (norm2(bc.expression) !== norm2(ac.expression)) details.push("formula edited");
        if (bc.sourceColumn !== ac.sourceColumn) details.push("source column changed");
        if (details.length) columnChanges.push({ name: c, status: "changed", detail: details.join(", ") });
      }
    }
    const measureChanges = { added: [], removed: [], changed: [] };
    for (const m of union(bt.measures.keys(), at.measures.keys())) {
      const bm = bt.measures.get(m);
      const am = at.measures.get(m);
      if (!bm) measureChanges.added.push(m);
      else if (!am) measureChanges.removed.push(m);
      else if (norm2(bm.expression) !== norm2(am.expression)) measureChanges.changed.push(m);
    }
    const otherChanges = [];
    const bSrc = [...bt.partitions.values()].map((p) => `${p.mode}|${p.source}|${norm2(p.sourceExpression)}`).join("\n");
    const aSrc = [...at.partitions.values()].map((p) => `${p.mode}|${p.source}|${norm2(p.sourceExpression)}`).join("\n");
    if (bSrc !== aSrc) otherChanges.push("Data source or Power Query changed");
    const changed = columnChanges.length || otherChanges.length || measureChanges.added.length || measureChanges.removed.length || measureChanges.changed.length;
    tables.push({
      ...tableRecord(at, changed ? "changed" : "unchanged", keyColumns.get(name)),
      columnChanges,
      measureChanges,
      otherChanges,
      removedColumns: columnChanges.filter((c) => c.status === "removed").map((c) => c.name)
    });
  }
  return { tables, relationships };
}
function summarizeDiagramDiff(diff) {
  const s = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, relsAdded: 0, relsRemoved: 0, relsChanged: 0, relsDeactivated: 0, relsActivated: 0 };
  for (const t of diff.tables) {
    if (t.status === "added") s.tablesAdded++;
    else if (t.status === "removed") s.tablesRemoved++;
    else if (t.status === "changed") s.tablesChanged++;
  }
  for (const r of diff.relationships) {
    if (r.status === "added") s.relsAdded++;
    else if (r.status === "removed") s.relsRemoved++;
    else if (r.status === "changed") {
      s.relsChanged++;
      if (r.before?.isActive && !r.isActive) s.relsDeactivated++;
      if (!r.before?.isActive && r.isActive) s.relsActivated++;
    }
  }
  s.total = s.tablesAdded + s.tablesRemoved + s.tablesChanged + s.relsAdded + s.relsRemoved + s.relsChanged;
  return s;
}
function layoutModelDiagram(nodes, links, options = {}) {
  const gap = options.gap ?? 48;
  const labelRoom = options.labelRoom ?? gap;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map(nodes.map((n) => [n.id, /* @__PURE__ */ new Set()]));
  for (const l of links) {
    if (l.source === l.target || !adj.has(l.source) || !adj.has(l.target)) continue;
    adj.get(l.source).add(l.target);
    adj.get(l.target).add(l.source);
  }
  const seen = /* @__PURE__ */ new Set();
  const components = [];
  const loose = [];
  for (const n of [...nodes].sort((a, b) => adj.get(b.id).size - adj.get(a.id).size || a.id.localeCompare(b.id))) {
    if (seen.has(n.id)) continue;
    if (!adj.get(n.id).size) {
      seen.add(n.id);
      loose.push(n);
      continue;
    }
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(byId.get(id));
      for (const nb of adj.get(id)) if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
    components.push(comp);
  }
  const blocks = components.map((comp) => layoutComponent(comp, adj, gap, labelRoom));
  if (loose.length) blocks.push(layoutGrid(loose.sort((a, b) => a.id.localeCompare(b.id)), gap, true));
  const totalArea = blocks.reduce((s, b) => s + (b.width + gap) * (b.height + gap), 0);
  const maxRowWidth = options.maxRowWidth ?? Math.max(900, Math.sqrt(totalArea) * 1.6, ...blocks.map((b) => b.width));
  const positions = /* @__PURE__ */ new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  let looseBounds = null;
  for (const b of blocks) {
    if (x > 0 && x + b.width > maxRowWidth) {
      x = 0;
      y += rowH + gap * 2;
      rowH = 0;
    }
    for (const [id, p] of b.positions) positions.set(id, { ...p, x: p.x + x, y: p.y + y });
    if (b.isLoose) looseBounds = { x, y, w: b.width, h: b.height };
    x += b.width + gap * 2;
    rowH = Math.max(rowH, b.height);
    width = Math.max(width, x - gap * 2);
  }
  return { positions, width, height: y + rowH, loose: looseBounds };
}
function layoutComponent(comp, adj, gap, labelRoom) {
  const byId = new Map(comp.map((n) => [n.id, n]));
  if (comp.length === 1) return normalise([{ ...comp[0], x: 0, y: 0 }]);
  const degree = (id) => adj.get(id).size;
  let core = comp.map((n) => n.id).filter((id) => degree(id) > 1);
  if (!core.length) core = [comp[0].id];
  const coreSet = new Set(core);
  const leavesOf = new Map(core.map((id) => [id, []]));
  for (const n of comp) {
    if (coreSet.has(n.id)) continue;
    const hub = [...adj.get(n.id)].find((nb) => coreSet.has(nb));
    leavesOf.get(hub).push(n);
  }
  const blocks = new Map(core.map((id) => [id, starBlock(byId.get(id), leavesOf.get(id).sort((a, b) => a.id.localeCompare(b.id)), gap, labelRoom)]));
  const coreEdges = [];
  for (const id of core) for (const nb of adj.get(id)) if (coreSet.has(nb) && id < nb) coreEdges.push([id, nb]);
  const centres = forceLayout(core.map((id) => ({ id, w: blocks.get(id).w, h: blocks.get(id).h })), coreEdges, adj, gap + labelRoom / 2);
  const blockBoxes = core.map((id) => {
    const b = blocks.get(id);
    const c = centres.get(id);
    return { id, w: b.w, h: b.h, x: c.x - b.w / 2, y: c.y - b.h / 2 };
  });
  removeOverlaps(blockBoxes, gap);
  const boxes = [];
  for (const bb of blockBoxes) {
    for (const m of blocks.get(bb.id).members) boxes.push({ id: m.id, w: m.w, h: m.h, x: bb.x + m.dx, y: bb.y + m.dy });
  }
  removeOverlaps(boxes, gap * 0.6);
  return normalise(boxes);
}
function starBlock(hub, leaves, gap, labelRoom) {
  const placed = [{ id: hub.id, w: hub.w, h: hub.h, cx: 0, cy: 0 }];
  if (leaves.length) {
    const maxW = Math.max(...leaves.map((l) => l.w));
    const maxH = Math.max(...leaves.map((l) => l.h));
    const rings = leaves.length > 12 ? [leaves.filter((_, i) => i % 3 === 0), leaves.filter((_, i) => i % 3 !== 0)] : [leaves];
    let rx = hub.w / 2 + maxW / 2 + Math.max(gap, labelRoom);
    let ry = hub.h / 2 + maxH / 2 + gap + Math.min(labelRoom, 40);
    rings.forEach((ring, ri) => {
      const n = ring.length;
      const start = n <= 2 ? 0 : -Math.PI / 2 + ri * (Math.PI / n);
      let tries = [];
      for (let attempt = 0; attempt < 80; attempt++) {
        tries = ring.map((leaf, i) => {
          const angle = start + 2 * Math.PI * i / n;
          return { id: leaf.id, w: leaf.w, h: leaf.h, cx: Math.cos(angle) * rx, cy: Math.sin(angle) * ry };
        });
        const clash = tries.some((a, i) => [...placed, ...tries.slice(i + 1)].some((b) => boxesOverlap(a, b, gap * 0.5)));
        if (!clash) break;
        rx *= 1.06;
        ry *= 1.06;
      }
      placed.push(...tries);
      rx += maxW + gap;
      ry += maxH + gap;
    });
  }
  const minX = Math.min(...placed.map((p) => p.cx - p.w / 2));
  const minY = Math.min(...placed.map((p) => p.cy - p.h / 2));
  const maxX = Math.max(...placed.map((p) => p.cx + p.w / 2));
  const maxY = Math.max(...placed.map((p) => p.cy + p.h / 2));
  return {
    w: maxX - minX,
    h: maxY - minY,
    members: placed.map((p) => ({ id: p.id, w: p.w, h: p.h, dx: p.cx - p.w / 2 - minX, dy: p.cy - p.h / 2 - minY }))
  };
}
function boxesOverlap(a, b, pad) {
  return Math.abs(a.cx - b.cx) * 2 < a.w + b.w + pad * 2 && Math.abs(a.cy - b.cy) * 2 < a.h + b.h + pad * 2;
}
function forceLayout(items, edges, adj, gap) {
  const ids = items.map((n) => n.id);
  const size = new Map(items.map((n) => [n.id, n]));
  const pos = /* @__PURE__ */ new Map();
  if (items.length === 1) {
    pos.set(ids[0], { x: 0, y: 0 });
    return pos;
  }
  const neighbours = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of edges) {
    neighbours.get(a).push(b);
    neighbours.get(b).push(a);
  }
  const root = [...ids].sort((a, b) => adj.get(b).size - adj.get(a).size || a.localeCompare(b))[0];
  const depth = /* @__PURE__ */ new Map([[root, 0]]);
  const order = [root];
  for (let i = 0; i < order.length; i++) {
    for (const nb of [...neighbours.get(order[i])].sort()) {
      if (!depth.has(nb)) {
        depth.set(nb, depth.get(order[i]) + 1);
        order.push(nb);
      }
    }
  }
  for (const id of ids) if (!depth.has(id)) {
    depth.set(id, 1);
    order.push(id);
  }
  const unit = Math.sqrt(items.reduce((s, n) => s + n.w * n.h, 0) / items.length) + gap;
  const rings = /* @__PURE__ */ new Map();
  for (const id of order) {
    const d = depth.get(id);
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d).push(id);
  }
  for (const [d, ring] of rings) {
    ring.forEach((id, i) => {
      const angle = 2 * Math.PI * i / ring.length + d * 0.6;
      pos.set(id, { x: Math.cos(angle) * d * unit, y: Math.sin(angle) * d * unit });
    });
  }
  const ideal = (a, b) => (Math.hypot(size.get(a).w, size.get(a).h) + Math.hypot(size.get(b).w, size.get(b).h)) / 2 * 0.75 + gap;
  let temp = unit;
  for (let iter = 0; iter < 300; iter++) {
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]);
        const b = pos.get(ids[j]);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = 0.01 * (i + 1);
          dy = 0.01 * (j + 1);
          dist = Math.hypot(dx, dy);
        }
        const k = ideal(ids[i], ids[j]);
        const f = k * k / dist;
        disp.get(ids[i]).x += dx / dist * f;
        disp.get(ids[i]).y += dy / dist * f;
        disp.get(ids[j]).x -= dx / dist * f;
        disp.get(ids[j]).y -= dy / dist * f;
      }
    }
    for (const [s, t] of edges) {
      const a = pos.get(s);
      const b = pos.get(t);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const f = dist * dist / ideal(s, t);
      disp.get(s).x -= dx / dist * f;
      disp.get(s).y -= dy / dist * f;
      disp.get(t).x += dx / dist * f;
      disp.get(t).y += dy / dist * f;
    }
    for (const id of ids) {
      const p = pos.get(id);
      const d = disp.get(id);
      d.x -= p.x * 0.05;
      d.y -= p.y * 0.05;
      const len = Math.max(Math.hypot(d.x, d.y), 0.01);
      p.x += d.x / len * Math.min(len, temp);
      p.y += d.y / len * Math.min(len, temp);
    }
    temp = Math.max(temp * 0.985, 2);
  }
  return pos;
}
function layoutGrid(nodes, gap, isLoose) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.5)));
  const colW = Math.max(...nodes.map((n) => n.w));
  const boxes = [];
  let y = 0;
  for (let i = 0; i < nodes.length; i += cols) {
    const row = nodes.slice(i, i + cols);
    const rowH = Math.max(...row.map((n) => n.h));
    row.forEach((n, j) => boxes.push({ id: n.id, w: n.w, h: n.h, x: j * (colW + gap / 2), y }));
    y += rowH + gap / 2;
  }
  return { ...normalise(boxes), isLoose };
}
function removeOverlaps(boxes, pad) {
  for (let pass = 0; pass < 400; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ox = Math.min(a.x + a.w + pad, b.x + b.w + pad) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h + pad, b.y + b.h + pad) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const shift = ox / 2 + 0.5;
          if (a.x + a.w / 2 <= b.x + b.w / 2) {
            a.x -= shift;
            b.x += shift;
          } else {
            a.x += shift;
            b.x -= shift;
          }
        } else {
          const shift = oy / 2 + 0.5;
          if (a.y + a.h / 2 <= b.y + b.h / 2) {
            a.y -= shift;
            b.y += shift;
          } else {
            a.y += shift;
            b.y -= shift;
          }
        }
      }
    }
    if (!moved) break;
  }
}
function normalise(boxes) {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const positions = /* @__PURE__ */ new Map();
  let width = 0;
  let height = 0;
  for (const b of boxes) {
    const p = { x: Math.round(b.x - minX), y: Math.round(b.y - minY), w: b.w, h: b.h };
    positions.set(b.id, p);
    width = Math.max(width, p.x + p.w);
    height = Math.max(height, p.y + p.h);
  }
  return { positions, width, height };
}
function tableRecord(t, status, keyColumns = /* @__PURE__ */ new Set()) {
  const parts = [...t.partitions.values()];
  const calculated = parts.some((p) => p.type === "calculated");
  const fieldParameter = parts.some((p) => p.type === "calculated" && /NAMEOF\s*\(/i.test(p.sourceExpression || ""));
  const modes = [...new Set(parts.map((p) => storageMode(p.mode)))];
  return {
    id: t.name,
    name: t.name,
    status,
    kind: t.isCalculationGroup ? "calculationGroup" : fieldParameter ? "fieldParameter" : calculated ? "calculated" : "table",
    storageMode: calculated ? "" : modes.join(", "),
    source: parts.map((p) => p.source).filter(Boolean)[0] || "",
    columns: [...t.columns.values()].map((c) => ({
      name: c.name,
      dataType: c.dataType,
      isHidden: c.isHidden,
      isCalculated: !!c.expression,
      isKey: keyColumns.has(c.name)
    })),
    measureCount: t.measures.size,
    measures: [...t.measures.keys()],
    keyColumns: [...keyColumns],
    columnChanges: [],
    measureChanges: { added: [], removed: [], changed: [] },
    otherChanges: [],
    removedColumns: []
  };
}
function relRecord(r, status) {
  return {
    id: r.name,
    name: r.name,
    status,
    fromTable: r.fromTable,
    fromColumn: r.fromColumn,
    toTable: r.toTable,
    toColumn: r.toColumn,
    isActive: r.isActive,
    crossFilter: r.crossFilter,
    fromCardinality: r.fromCardinality,
    toCardinality: r.toCardinality,
    securityFilter: r.securityFilter,
    relyOnReferentialIntegrity: r.relyOnReferentialIntegrity,
    changes: []
  };
}
function relationshipChanges(br, ar) {
  const out = [];
  const add = (label, b, a) => {
    if (b !== a) out.push({ label, before: b, after: a });
  };
  add("From", `${br.fromTable}[${br.fromColumn}]`, `${ar.fromTable}[${ar.fromColumn}]`);
  add("To", `${br.toTable}[${br.toColumn}]`, `${ar.toTable}[${ar.toColumn}]`);
  add("Active", br.isActive ? "Yes" : "No", ar.isActive ? "Yes" : "No");
  add("Cross-filter direction", crossFilterLabel(br.crossFilter), crossFilterLabel(ar.crossFilter));
  add("Cardinality", cardinalityLabel(br), cardinalityLabel(ar));
  add("Security filter direction", crossFilterLabel(br.securityFilter), crossFilterLabel(ar.securityFilter));
  add("Assume referential integrity", br.relyOnReferentialIntegrity ? "Yes" : "No", ar.relyOnReferentialIntegrity ? "Yes" : "No");
  return out;
}
function cardinalityLabel(r) {
  const c = (x) => x === "one" ? "one" : "many";
  const text = `${c(r.fromCardinality)} to ${c(r.toCardinality)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function crossFilterLabel(v) {
  if (v === "bothDirections") return "Both";
  if (v === "automatic") return "Automatic";
  return "Single";
}
function keyColumnIndex(relationships) {
  const index = /* @__PURE__ */ new Map();
  const add = (t, c) => {
    if (!index.has(t)) index.set(t, /* @__PURE__ */ new Set());
    index.get(t).add(c);
  };
  for (const r of relationships) {
    add(r.fromTable, r.fromColumn);
    add(r.toTable, r.toColumn);
  }
  return index;
}
function storageMode(mode) {
  const m = (mode || "import").toLowerCase();
  return { import: "Import", directquery: "DirectQuery", dual: "Dual", directlake: "Direct Lake" }[m] || mode;
}
function endpoints(r) {
  return `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`;
}
function union(a, b) {
  return [.../* @__PURE__ */ new Set([...a, ...b])];
}
function norm2(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/compare/bookmarkEffect.js
var NONE = "No value applied";
function describeBookmarkEffect(report, bookmark) {
  if (!report || !bookmark) return null;
  const state = bookmark.state || {};
  const pageId = state.activeSection || bookmark.pageId || "";
  const page = report.pages.get(pageId);
  const section = state.sections?.[pageId] || {};
  const containers = section.visualContainers || {};
  const targets = bookmark.appliesToSelectedVisuals ? new Set(bookmark.targetVisualIds || []) : null;
  const inScope = (id) => !targets || targets.has(id);
  const pageVisuals = [...report.visuals.values()].filter((v) => v.pageId === pageId);
  const byId = new Map(pageVisuals.map((v) => [v.id, v]));
  const hidden = [];
  const shown = [];
  let notCaptured = 0;
  for (const v of pageVisuals) {
    if (v.type === "group" || !inScope(v.id)) continue;
    const captured = containers[v.id];
    if (!captured) {
      notCaptured++;
      continue;
    }
    const hiddenByBookmark = captured.singleVisual?.display?.mode === "hidden";
    if (hiddenByBookmark && !v.isHidden) hidden.push(visualLabel(v));
    else if (!hiddenByBookmark && v.isHidden) shown.push(visualLabel(v));
  }
  const groupsHidden = [];
  const groupsShown = [];
  (function walkGroups(groups) {
    for (const [id, g] of Object.entries(groups || {})) {
      const v = byId.get(id);
      if (v && inScope(id) && typeof g?.isHidden === "boolean") {
        if (g.isHidden && !v.isHidden) groupsHidden.push(visualLabel(v));
        else if (!g.isHidden && v.isHidden) groupsShown.push(visualLabel(v));
      }
      walkGroups(g?.children);
    }
  })(section.visualContainerGroups);
  const reportFilters = compareFilterStates(report.filters, state.filters?.byExpr);
  const pageFilters = page ? compareFilterStates(page.filters, section.filters?.byExpr) : [];
  const visualFilters = [];
  const slicers = [];
  for (const [id, captured] of Object.entries(containers)) {
    const v = byId.get(id);
    if (!v || !inScope(id)) continue;
    for (const change of compareFilterStates(v.filters, captured.filters?.byExpr)) {
      visualFilters.push({ visual: visualLabel(v), ...change });
    }
    const general = captured.singleVisual?.objects?.general;
    const props = Array.isArray(general) ? general[0]?.properties : general?.properties;
    if (props?.filter) {
      const selection = describeFilterCondition(props.filter.filter);
      if (selection !== (v.slicerSelection || "")) {
        slicers.push({ visual: visualLabel(v), default: v.slicerSelection || "Nothing selected", bookmark: selection || "Nothing selected" });
      }
    }
  }
  return {
    pageId,
    pageName: page?.name || pageId,
    captures: { data: bookmark.capturesData, display: bookmark.capturesDisplay, currentPage: bookmark.capturesCurrentPage },
    scope: targets ? `${targets.size} selected visual${targets.size !== 1 ? "s" : ""}` : "All visuals on the page",
    hidden,
    shown,
    groupsHidden,
    groupsShown,
    reportFilters,
    pageFilters,
    visualFilters,
    slicers,
    notCaptured
  };
}
function compareFilterStates(defaults, captured) {
  const out = [];
  for (const entry of captured || []) {
    const field = fieldLabel(entry.expression || entry.field) || "(unknown field)";
    const key = entry.name || `field:${field}`;
    const def = defaults?.get(key);
    const defCond = def?.condition || "";
    const bmCond = describeFilterCondition(entry.filter);
    if (defCond === bmCond) continue;
    out.push({
      field: def?.field || field,
      default: defCond || NONE,
      bookmark: bmCond || (defCond ? "Cleared" : NONE),
      notInPane: !def
      // captured by the bookmark but not in the object's filter pane
    });
  }
  return out;
}
function bookmarkEffectLines(effect) {
  if (!effect) return { hides: [], shows: [], filters: [], slicers: [] };
  return {
    hides: [...effect.hidden, ...effect.groupsHidden.map((g) => `Group ${g}`)],
    shows: [...effect.shown, ...effect.groupsShown.map((g) => `Group ${g}`)],
    filters: [
      ...effect.reportFilters.map((f) => `Report: ${f.field} = ${f.bookmark}`),
      ...effect.pageFilters.map((f) => `Page: ${f.field} = ${f.bookmark}`),
      ...effect.visualFilters.map((f) => `${f.visual}: ${f.field} = ${f.bookmark}`)
    ],
    slicers: effect.slicers.map((s) => `${s.visual}: ${s.bookmark}`)
  };
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/compare/compareSnapshots.js
var COMPARE_GROUPS = [
  { key: "role", label: "Security (RLS roles)" },
  { key: "relationship", label: "Relationships" },
  { key: "measure", label: "Measures" },
  { key: "calcItem", label: "Calculation items" },
  { key: "column", label: "Columns" },
  { key: "table", label: "Tables" },
  { key: "dataSource", label: "Data sources" },
  { key: "parameter", label: "Parameters" },
  { key: "expression", label: "Shared Power Query expressions" },
  { key: "semanticModel", label: "Semantic models" },
  { key: "report", label: "Reports" },
  { key: "page", label: "Pages" },
  { key: "visual", label: "Visuals" },
  { key: "filter", label: "Filters" },
  { key: "bookmark", label: "Bookmarks" }
];
function compareFileMaps(beforeFiles, afterFiles) {
  return compareSnapshots(buildSnapshot(beforeFiles), buildSnapshot(afterFiles));
}
function compareSnapshots(before, after) {
  const b = before || { models: /* @__PURE__ */ new Map(), reports: /* @__PURE__ */ new Map() };
  const a = after || { models: /* @__PURE__ */ new Map(), reports: /* @__PURE__ */ new Map() };
  const ctx = {
    records: [],
    showModelName: (/* @__PURE__ */ new Set([...b.models.keys(), ...a.models.keys()])).size > 1,
    deps: buildDependencyIndex(a),
    afterModels: [...a.models.values()]
  };
  for (const key of union2(b.models.keys(), a.models.keys())) {
    compareModel(ctx, key, b.models.get(key), a.models.get(key));
  }
  for (const key of union2(b.reports.keys(), a.reports.keys())) {
    compareReport(ctx, b.reports.get(key), a.reports.get(key));
  }
  const records = ctx.records;
  return { records, summary: summarize(records) };
}
function groupCompareRecords(records, section) {
  const inSection = records.filter((r) => !section || r.section === section);
  return COMPARE_GROUPS.map((g) => ({ ...g, records: inSection.filter((r) => r.group === g.key) })).filter((g) => g.records.length > 0);
}
function compareModel(ctx, modelKey, bm, am) {
  const modelName = (am || bm).name || "Semantic model";
  const loc = (extra = {}) => ({ ...ctx.showModelName ? { model: modelName } : {}, ...extra });
  ctx.modelKey = modelKey;
  if (!bm || !am) {
    const m = am || bm;
    push(ctx, {
      change: am ? "added" : "removed",
      group: "semanticModel",
      name: modelName,
      location: {},
      props: [
        side(am, "Tables", [...m.tables.keys()], "list"),
        side(am, "Measures", count([...m.tables.values()].reduce((n, t) => n + t.measures.size, 0)), "text"),
        side(am, "Relationships", count(m.relationships.size), "text"),
        side(am, "RLS roles", [...m.roles.keys()], "list")
      ].filter((p) => !isEmpty(p.before) || !isEmpty(p.after)),
      flags: { security: m.roles.size > 0 },
      diagram: { modelKey }
    });
    return;
  }
  for (const tName of union2(bm.tables.keys(), am.tables.keys())) {
    const bt = bm.tables.get(tName);
    const at = am.tables.get(tName);
    if (!bt || !at) {
      const t = at || bt;
      const impact = at ? null : describeImpact(ctx.deps, modelKey, {
        kind: "table",
        name: tName,
        columns: [...t.columns.keys()],
        measures: [...t.measures.keys()]
      }, "removed");
      push(ctx, {
        change: at ? "added" : "removed",
        group: "table",
        name: tName,
        location: loc(),
        impact,
        diagram: { modelKey, table: tName },
        props: [
          side(at, "Columns", [...t.columns.keys()], "list"),
          side(at, "Measures", [...t.measures.keys()], "list"),
          side(at, "Data source", [...t.partitions.values()].map((p) => p.source || p.mode || p.type).filter(Boolean), "list"),
          ...t.isCalculationGroup ? [side(at, "Calculation items", [...t.calcItems.keys()], "list")] : []
        ].filter((p) => !isEmpty(p.before) || !isEmpty(p.after)),
        flags: { broken: isBreaking(impact), security: rolesMentioning(ctx, tableMentionRegex(tName)).length > 0 || impactTouchesSecurity(impact) }
      });
      continue;
    }
    compareColumns(ctx, bt, at, loc);
    compareMeasures(ctx, bt, at, loc);
    compareCalcItems(ctx, bt, at, loc);
    compareDataSource(ctx, bt, at, loc);
  }
  compareRelationships(ctx, bm, am, loc);
  compareRoles(ctx, bm, am, loc);
  compareExpressions(ctx, bm, am, loc);
}
function compareColumns(ctx, bt, at, loc) {
  for (const name of union2(bt.columns.keys(), at.columns.keys())) {
    const bc = bt.columns.get(name);
    const ac = at.columns.get(name);
    const location = loc({ table: at.name });
    const colRegex = columnMentionRegex(at.name, name);
    const diagram = { modelKey: ctx.modelKey, table: at.name };
    if (!bc || !ac) {
      const c = ac || bc;
      const impact2 = ac ? null : describeImpact(ctx.deps, ctx.modelKey, { kind: "column", table: at.name, name }, "removed");
      push(ctx, {
        change: ac ? "added" : "removed",
        group: "column",
        name,
        location,
        impact: impact2,
        diagram,
        props: [
          side(ac, "Data type", c.dataType, "text"),
          c.expression ? side(ac, "Formula", c.expression, "dax") : side(ac, "Source column", c.sourceColumn, "text")
        ].filter((p) => !isEmpty(p.before) || !isEmpty(p.after)),
        flags: { broken: isBreaking(impact2), security: rolesMentioning(ctx, colRegex).length > 0 || impactTouchesSecurity(impact2) }
      });
      continue;
    }
    const props = [];
    diffProp(props, "Data type", bc.dataType, ac.dataType);
    diffProp(props, "Formula", bc.expression, ac.expression, "dax", normWs);
    diffProp(props, "Source column", bc.sourceColumn, ac.sourceColumn);
    diffProp(props, "Hidden", yesNo(bc.isHidden), yesNo(ac.isHidden));
    diffGenericProps(props, bc.props, ac.props, ["dataType", "sourceColumn", "isHidden", "expression"]);
    if (!props.length) continue;
    const meaningful = bc.dataType !== ac.dataType || normWs(bc.expression) !== normWs(ac.expression) || bc.sourceColumn !== ac.sourceColumn;
    const impact = meaningful ? describeImpact(ctx.deps, ctx.modelKey, { kind: "column", table: at.name, name }, "changed") : null;
    const roles = rolesMentioning(ctx, colRegex);
    push(ctx, {
      change: "changed",
      group: "column",
      name,
      location,
      props,
      impact,
      diagram,
      flags: { security: roles.length > 0 || impactTouchesSecurity(impact) }
    });
  }
}
function compareMeasures(ctx, bt, at, loc) {
  const removed = [...bt.measures.keys()].filter((n) => !at.measures.has(n));
  const added = [...at.measures.keys()].filter((n) => !bt.measures.has(n));
  const renames = /* @__PURE__ */ new Map();
  for (const r of removed) {
    const expr = normWs(bt.measures.get(r).expression);
    if (!expr) continue;
    const match = added.find((n) => !renames.has(n) && normWs(at.measures.get(n).expression) === expr);
    if (match) renames.set(match, r);
  }
  const renamedFrom = new Set(renames.values());
  const location = loc({ table: at.name });
  for (const [newName, oldName] of renames) {
    const regex = measureMentionRegex(newName);
    const impact = describeImpact(ctx.deps, ctx.modelKey, { kind: "measure", name: oldName }, "renamed");
    const roles = rolesMentioning(ctx, regex);
    const props = [{ label: "Name", before: oldName, after: newName, kind: "text" }];
    diffGenericProps(props, bt.measures.get(oldName).props, at.measures.get(newName).props);
    push(ctx, {
      change: "renamed",
      group: "measure",
      name: newName,
      location,
      props,
      impact,
      flags: { broken: isBreaking(impact), security: roles.length > 0 || impactTouchesSecurity(impact) }
    });
  }
  for (const name of added) {
    if (renames.has(name)) continue;
    const m = at.measures.get(name);
    push(ctx, {
      change: "added",
      group: "measure",
      name,
      location,
      props: [
        { label: "DAX", before: "", after: m.expression, kind: "dax" },
        ...propsAsList(m.props, false)
      ]
    });
  }
  for (const name of removed) {
    if (renamedFrom.has(name)) continue;
    const m = bt.measures.get(name);
    const regex = measureMentionRegex(name);
    const impact = describeImpact(ctx.deps, ctx.modelKey, { kind: "measure", name }, "removed");
    push(ctx, {
      change: "removed",
      group: "measure",
      name,
      location,
      impact,
      props: [{ label: "DAX", before: m.expression, after: "", kind: "dax" }],
      flags: { broken: isBreaking(impact), security: rolesMentioning(ctx, regex).length > 0 || impactTouchesSecurity(impact) }
    });
  }
  for (const [name, am] of at.measures) {
    const bmeas = bt.measures.get(name);
    if (!bmeas) continue;
    const props = [];
    diffProp(props, "DAX", bmeas.expression, am.expression, "dax", normWs);
    diffGenericProps(props, bmeas.props, am.props);
    if (!props.length) continue;
    const regex = measureMentionRegex(name);
    const roles = rolesMentioning(ctx, regex);
    const daxChanged = normWs(bmeas.expression) !== normWs(am.expression);
    const impact = daxChanged ? describeImpact(ctx.deps, ctx.modelKey, { kind: "measure", name }, "changed") : null;
    push(ctx, {
      change: "changed",
      group: "measure",
      name,
      location,
      props,
      impact,
      flags: { security: roles.length > 0 || impactTouchesSecurity(impact) }
    });
  }
}
function compareCalcItems(ctx, bt, at, loc) {
  for (const name of union2(bt.calcItems.keys(), at.calcItems.keys())) {
    const bi = bt.calcItems.get(name);
    const ai = at.calcItems.get(name);
    const location = loc({ table: at.name });
    if (!bi || !ai) {
      push(ctx, {
        change: ai ? "added" : "removed",
        group: "calcItem",
        name,
        location,
        props: [side(ai, "DAX", (ai || bi).expression, "dax")]
      });
      continue;
    }
    const props = [];
    diffProp(props, "DAX", bi.expression, ai.expression, "dax", normWs);
    if (props.length) push(ctx, { change: "changed", group: "calcItem", name, location, props });
  }
}
function compareDataSource(ctx, bt, at, loc) {
  const props = [];
  const bParts = [...bt.partitions.values()];
  const aParts = [...at.partitions.values()];
  const bNames = bParts.map((p) => p.name).sort();
  const aNames = aParts.map((p) => p.name).sort();
  if (bNames.join("|") !== aNames.join("|") && (bParts.length > 1 || aParts.length > 1)) {
    props.push({ label: "Partitions", before: bNames, after: aNames, kind: "list" });
  }
  const pairs = bParts.length === 1 && aParts.length === 1 ? [[bParts[0], aParts[0]]] : aParts.map((p) => [bt.partitions.get(p.name), p]).filter(([x]) => x);
  for (const [bp, ap] of pairs) {
    const suffix = pairs.length > 1 ? ` (${ap.name})` : "";
    diffProp(props, `Storage mode${suffix}`, storageMode2(bp.mode), storageMode2(ap.mode));
    diffProp(props, `Source${suffix}`, bp.source, ap.source);
    const kind = ap.type === "calculated" ? "dax" : "m";
    diffProp(props, `${kind === "dax" ? "Table expression" : "Power Query"}${suffix}`, bp.sourceExpression, ap.sourceExpression, kind, normWs);
  }
  if (props.length) push(ctx, { change: "changed", group: "dataSource", name: at.name, location: loc(), props, diagram: { modelKey: ctx.modelKey, table: at.name } });
}
function storageMode2(mode) {
  const m = (mode || "import").toLowerCase();
  return { import: "Import", directquery: "DirectQuery", dual: "Dual", directlake: "Direct Lake" }[m] || mode;
}
function compareRelationships(ctx, bm, am, loc) {
  const label = (r) => `${r.fromTable}[${r.fromColumn}] \u2192 ${r.toTable}[${r.toColumn}]`;
  const endpoints2 = (r) => `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`;
  const bRels = new Map(bm.relationships);
  const aRels = new Map(am.relationships);
  for (const [name, ar] of [...aRels]) {
    if (bRels.has(name)) continue;
    const match = [...bRels].find(([bn, br]) => !aRels.has(bn) && endpoints2(br) === endpoints2(ar));
    if (match) {
      bRels.delete(match[0]);
      bRels.set(name, match[1]);
    }
  }
  const describe = (r) => [
    { label: "Active", value: yesNo(r.isActive) },
    { label: "Cross-filter direction", value: r.crossFilter },
    { label: "Cardinality", value: `${r.fromCardinality} to ${r.toCardinality}` },
    { label: "Security filter direction", value: r.securityFilter }
  ];
  for (const name of union2(bRels.keys(), aRels.keys())) {
    const br = bRels.get(name);
    const ar = aRels.get(name);
    if (!br || !ar) {
      const r = ar || br;
      push(ctx, {
        change: ar ? "added" : "removed",
        group: "relationship",
        name: label(r),
        location: loc(),
        props: describe(r).map((d) => side(ar, d.label, d.value, "text")),
        diagram: { modelKey: ctx.modelKey, relationship: name }
      });
      continue;
    }
    const props = [];
    diffProp(props, "From", `${br.fromTable}[${br.fromColumn}]`, `${ar.fromTable}[${ar.fromColumn}]`);
    diffProp(props, "To", `${br.toTable}[${br.toColumn}]`, `${ar.toTable}[${ar.toColumn}]`);
    diffProp(props, "Active", yesNo(br.isActive), yesNo(ar.isActive));
    diffProp(props, "Cross-filter direction", br.crossFilter, ar.crossFilter);
    diffProp(props, "Cardinality", `${br.fromCardinality} to ${br.toCardinality}`, `${ar.fromCardinality} to ${ar.toCardinality}`);
    diffProp(props, "Security filter direction", br.securityFilter, ar.securityFilter);
    diffProp(props, "Assume referential integrity", yesNo(br.relyOnReferentialIntegrity), yesNo(ar.relyOnReferentialIntegrity));
    diffProp(props, "Join on date", br.joinOnDateBehavior, ar.joinOnDateBehavior);
    if (!props.length) continue;
    push(ctx, {
      change: "changed",
      group: "relationship",
      name: label(ar),
      location: loc(),
      props,
      diagram: { modelKey: ctx.modelKey, relationship: name },
      // Security filter direction controls how RLS propagates across the relationship.
      flags: { security: br.securityFilter !== ar.securityFilter }
    });
  }
}
function compareRoles(ctx, bm, am, loc) {
  for (const name of union2(bm.roles.keys(), am.roles.keys())) {
    const br = bm.roles.get(name);
    const ar = am.roles.get(name);
    if (!br || !ar) {
      const r = ar || br;
      push(ctx, {
        change: ar ? "added" : "removed",
        group: "role",
        name,
        location: loc(),
        props: [
          side(ar, "Model permission", r.modelPermission, "text"),
          side(ar, "Members", r.members, "list"),
          ...[...r.tablePermissions].map(([t, e]) => side(ar, `Filter on ${t}`, e || "(no filter)", "dax")),
          side(ar, "Column permissions", r.columnPermissions, "list")
        ].filter((p) => !isEmpty(p.before) || !isEmpty(p.after)),
        flags: { security: true }
      });
      continue;
    }
    const props = [];
    diffProp(props, "Model permission", br.modelPermission, ar.modelPermission);
    diffList(props, "Members", br.members, ar.members);
    for (const t of union2(br.tablePermissions.keys(), ar.tablePermissions.keys())) {
      const be = br.tablePermissions.has(t) ? br.tablePermissions.get(t) || "(no filter)" : "";
      const ae = ar.tablePermissions.has(t) ? ar.tablePermissions.get(t) || "(no filter)" : "";
      diffProp(props, `Filter on ${t}`, be, ae, "dax", normWs);
    }
    diffList(props, "Column permissions", br.columnPermissions, ar.columnPermissions);
    if (props.length) push(ctx, { change: "changed", group: "role", name, location: loc(), props, flags: { security: true } });
  }
}
function compareExpressions(ctx, bm, am, loc) {
  for (const name of union2(bm.expressions.keys(), am.expressions.keys())) {
    const be = bm.expressions.get(name);
    const ae = am.expressions.get(name);
    const e = ae || be;
    const group = e.kind === "parameter" ? "parameter" : "expression";
    const kind = e.kind === "parameter" && !String(e.value).includes("\n") ? "text" : "m";
    if (!be || !ae) {
      push(ctx, { change: ae ? "added" : "removed", group, name, location: loc(), props: [side(ae, "Value", e.value, kind)] });
      continue;
    }
    const props = [];
    diffProp(props, "Value", be.value, ae.value, kind, normWs);
    if (props.length) push(ctx, { change: "changed", group, name, location: loc(), props });
  }
}
function compareReport(ctx, br, ar) {
  const reportName = (ar || br).name || "Report";
  const pageName = (rep, id) => rep?.pages.get(id)?.name || id;
  if (!br || !ar) {
    const r = ar || br;
    push(ctx, {
      change: ar ? "added" : "removed",
      group: "report",
      name: reportName,
      location: {},
      props: [
        side(ar, "Pages", [...r.pages.values()].map((p) => p.name), "list"),
        side(ar, "Visuals", count(r.visuals.size), "text"),
        side(ar, "Bookmarks", count(r.bookmarks.size), "text"),
        side(ar, "Bound to model", r.modelRef, "text")
      ].filter((p) => !isEmpty(p.before) || !isEmpty(p.after))
    });
    return;
  }
  const props = [];
  diffProp(props, "Bound to model", br.modelRef, ar.modelRef);
  diffProp(props, "Default page", br.activePageId ? pageName(br, br.activePageId) : "", ar.activePageId ? pageName(ar, ar.activePageId) : "");
  diffProp(props, "Theme", br.theme, ar.theme);
  if (props.length) push(ctx, { change: "changed", group: "report", name: reportName, location: { report: reportName }, props });
  compareFilterMaps(ctx, br.filters, ar.filters, { report: reportName, scopeLabel: "All pages" });
  for (const id of union2(br.pages.keys(), ar.pages.keys())) {
    const bp = br.pages.get(id);
    const ap = ar.pages.get(id);
    if (!bp || !ap) {
      const p = ap || bp;
      const rep = ap ? ar : br;
      const visuals = [...rep.visuals.values()].filter((v) => v.pageId === id).map(visualLabel);
      push(ctx, {
        change: ap ? "added" : "removed",
        group: "page",
        name: p.name,
        location: { report: reportName },
        objectId: id,
        props: [
          side(ap, "Visuals", visuals, "list"),
          side(ap, "Page filters", [...p.filters.values()].map(filterSummary), "list"),
          ...p.hidden ? [side(ap, "Hidden", "Yes", "text")] : []
        ].filter((x) => !isEmpty(x.before) || !isEmpty(x.after))
      });
      continue;
    }
    const pprops = [];
    diffProp(pprops, "Name", bp.name, ap.name);
    diffProp(pprops, "Hidden", yesNo(bp.hidden), yesNo(ap.hidden));
    if (pprops.length) {
      push(ctx, {
        change: bp.name !== ap.name ? "renamed" : "changed",
        group: "page",
        name: ap.name,
        location: { report: reportName },
        props: pprops,
        objectId: id
      });
    }
    compareFilterMaps(ctx, bp.filters, ap.filters, { report: reportName, page: ap.name, scopeLabel: "Page" });
  }
  const findCopySource = copyFinder(br, ar);
  for (const key of union2(br.visuals.keys(), ar.visuals.keys())) {
    const bv = br.visuals.get(key);
    const av = ar.visuals.get(key);
    const pageId = (av || bv).pageId;
    if (!br.pages.has(pageId) || !ar.pages.has(pageId)) continue;
    const location = { report: reportName, page: pageName(ar, pageId) };
    if (!bv || !av) {
      const v = av || bv;
      const source = av ? findCopySource(av) : null;
      push(ctx, {
        change: av ? "added" : "removed",
        group: "visual",
        name: visualDisplayName(v),
        location,
        objectId: v.id,
        subtype: prettyVisualType(v.type),
        props: [
          side(av, "Type", prettyVisualType(v.type), "text"),
          side(av, "Fields", v.fields, "list"),
          ...v.filters.size ? [side(av, "Visual filters", [...v.filters.values()].map(filterSummary), "list")] : []
        ].filter((x) => !isEmpty(x.before) || !isEmpty(x.after)),
        context: source ? [{ label: source.label, value: [source.description], kind: "list" }] : [],
        flags: { copy: !!source }
      });
      continue;
    }
    const vprops = [];
    diffProp(vprops, "Title", bv.title, av.title);
    diffProp(vprops, "Type", prettyVisualType(bv.type), prettyVisualType(av.type));
    diffList(vprops, "Fields", bv.fields, av.fields);
    diffProp(vprops, "Hidden", yesNo(bv.isHidden), yesNo(av.isHidden));
    if (vprops.length) {
      push(ctx, { change: "changed", group: "visual", name: visualDisplayName(av), location, props: vprops, objectId: av.id, subtype: prettyVisualType(av.type) });
    }
    compareFilterMaps(ctx, bv.filters, av.filters, { ...location, visual: visualLabel(av), scopeLabel: "Visual" });
  }
  for (const id of union2(br.bookmarks.keys(), ar.bookmarks.keys())) {
    const bb = br.bookmarks.get(id);
    const ab = ar.bookmarks.get(id);
    const bookmarkProps = (bk, rep) => [
      { label: "Target page", value: bk.pageId ? pageName(rep, bk.pageId) : "" },
      { label: "Applies to", value: bk.appliesToSelectedVisuals ? `${bk.targetVisuals} selected visual(s)` : "All visuals" },
      { label: "Captures", value: ["data", "display", "current page"].filter((_, i) => [bk.capturesData, bk.capturesDisplay, bk.capturesCurrentPage][i]).join(", ") || "nothing" }
    ];
    if (!bb || !ab) {
      const bk = ab || bb;
      push(ctx, {
        change: ab ? "added" : "removed",
        group: "bookmark",
        name: bk.name,
        location: { report: reportName },
        objectId: id,
        props: bookmarkProps(bk, ab ? ar : br).filter((p) => p.value).map((p) => side(ab, p.label, p.value, "text")),
        effect: describeBookmarkEffect(ab ? ar : br, bk)
      });
      continue;
    }
    const bprops = [];
    diffProp(bprops, "Name", bb.name, ab.name);
    const before = bookmarkProps(bb, br);
    const after = bookmarkProps(ab, ar);
    before.forEach((p, i) => diffProp(bprops, p.label, p.value, after[i].value));
    const beforeEffect = describeBookmarkEffect(br, bb);
    const afterEffect = describeBookmarkEffect(ar, ab);
    const bl = bookmarkEffectLines(beforeEffect);
    const al = bookmarkEffectLines(afterEffect);
    const effectPropsBefore = bprops.length;
    diffList(bprops, "Hides", bl.hides, al.hides);
    diffList(bprops, "Shows", bl.shows, al.shows);
    diffList(bprops, "Filter changes", bl.filters, al.filters);
    diffList(bprops, "Slicer selections", bl.slicers, al.slicers);
    if (bb.capturedState !== ab.capturedState && bprops.length === effectPropsBefore) {
      bprops.push({ label: "Other captured state", before: "Previous state", after: "Updated (sort, drill or formatting)", kind: "text" });
    }
    if (bprops.length) {
      push(ctx, {
        change: bb.name !== ab.name ? "renamed" : "changed",
        group: "bookmark",
        name: ab.name,
        location: { report: reportName },
        props: bprops,
        objectId: id,
        effect: afterEffect
      });
    }
  }
}
function compareFilterMaps(ctx, bMap, aMap, where) {
  const { scopeLabel, ...location } = where;
  bMap = new Map(bMap);
  for (const [aKey, af] of aMap) {
    if (bMap.has(aKey)) continue;
    const match = [...bMap].find(([bKey, bf]) => !aMap.has(bKey) && bf.field === af.field);
    if (match) {
      bMap.delete(match[0]);
      bMap.set(aKey, match[1]);
    }
  }
  for (const key of union2(bMap.keys(), aMap.keys())) {
    const bf = bMap.get(key);
    const af = aMap.get(key);
    const f = af || bf;
    const name = `${f.field} (${scopeLabel.toLowerCase()} filter)`;
    if (!bf || !af) {
      push(ctx, {
        change: af ? "added" : "removed",
        group: "filter",
        name,
        location,
        idKey: key,
        props: [
          side(af, "Condition", f.condition || "No value applied", "text"),
          ...f.hidden ? [side(af, "Hidden from readers", "Yes", "text")] : [],
          ...f.locked ? [side(af, "Locked", "Yes", "text")] : []
        ]
      });
      continue;
    }
    const props = [];
    diffProp(props, "Field", bf.field, af.field);
    diffProp(props, "Condition", bf.condition || "No value applied", af.condition || "No value applied");
    diffProp(props, "Filter type", bf.type, af.type);
    diffProp(props, "Hidden from readers", yesNo(bf.hidden), yesNo(af.hidden));
    diffProp(props, "Locked", yesNo(bf.locked), yesNo(af.locked));
    if (props.length) push(ctx, { change: "changed", group: "filter", name, location, props, idKey: key });
  }
}
function copyFinder(br, ar) {
  const fieldSig = (v) => `${v.type}|${[...v.fields].sort().join("\n")}`;
  const titleSig = (v) => `${v.type}|${v.title.trim().toLowerCase()}`;
  const byFields = /* @__PURE__ */ new Map();
  const byTitle = /* @__PURE__ */ new Map();
  const index = (v, rep, status) => {
    if (v.type === "group") return;
    const entry = { v, rep, status };
    if (v.fields.length) {
      if (!byFields.has(fieldSig(v))) byFields.set(fieldSig(v), []);
      byFields.get(fieldSig(v)).push(entry);
    }
    if (v.title.trim()) {
      if (!byTitle.has(titleSig(v))) byTitle.set(titleSig(v), []);
      byTitle.get(titleSig(v)).push(entry);
    }
  };
  for (const [key, v] of br.visuals) index(v, br, ar.visuals.has(key) ? "existing" : "deleted");
  const describe = ({ v, rep, status }) => `${visualLabel(v)} on ${rep.pages.get(v.pageId)?.name || v.pageId}${status === "deleted" ? " (deleted in this commit, so this may be a move or re-creation)" : ""}`;
  return (added) => {
    if (added.type === "group" || !added.fields.length && !added.title.trim()) return null;
    const exact = added.fields.length ? byFields.get(fieldSig(added)) : null;
    if (exact?.length) return { label: "Looks like a copy of", description: describe(exact[0]) };
    const titled = added.title.trim() ? byTitle.get(titleSig(added)) : null;
    if (titled?.length) return { label: "Looks like an edited copy of", description: describe(titled[0]) };
    return null;
  };
}
function rolesMentioning(ctx, regex) {
  const out = [];
  for (const m of ctx.afterModels) {
    for (const role of m.roles.values()) {
      for (const [table, expr] of role.tablePermissions) {
        if (expr && regex.test(expr)) out.push(`RLS role "${role.name}" (filter on ${table})`);
      }
    }
  }
  return out;
}
function measureMentionRegex(name) {
  return new RegExp(`\\[${escapeRegex(name)}\\]`, "i");
}
function columnMentionRegex(table, column) {
  return new RegExp(`(?:'${escapeRegex(table)}'|\\b${escapeRegex(table)})\\s*\\[${escapeRegex(column)}\\]`, "i");
}
function tableMentionRegex(table) {
  return new RegExp(`(?:'${escapeRegex(table)}'|\\b${escapeRegex(table)}\\b)`, "i");
}
function push(ctx, r) {
  const section = r.change === "added" ? "additions" : "modified";
  const loc = r.location || {};
  const id = [r.group, loc.model, loc.report, loc.page, loc.visual, loc.table, r.name].filter(Boolean).join("|");
  const unique = r.objectId || r.idKey;
  const record = {
    id: unique ? `${id}|${unique}` : id,
    section,
    change: r.change,
    group: r.group,
    name: r.name,
    location: loc,
    props: r.props || [],
    context: r.context || [],
    flags: { security: !!r.flags?.security, broken: !!r.flags?.broken, copy: !!r.flags?.copy }
  };
  if (r.objectId) record.objectId = r.objectId;
  if (r.subtype) record.subtype = r.subtype;
  if (r.effect) record.effect = r.effect;
  if (r.impact) record.impact = r.impact;
  if (r.diagram) record.diagram = r.diagram;
  ctx.records.push(record);
}
function isBreaking(impact) {
  return impact?.severity === "breaks";
}
function side(isAfter, label, value, kind) {
  return isAfter ? { label, before: kind === "list" ? [] : "", after: value, kind } : { label, before: value, after: kind === "list" ? [] : "", kind };
}
function diffProp(props, label, before, after, kind = "text", normalize = (x) => x) {
  const b = before ?? "";
  const a = after ?? "";
  if (normalize(String(b)) === normalize(String(a))) return;
  props.push({ label, before: b, after: a, kind });
}
function diffList(props, label, before = [], after = []) {
  const b = [...before];
  const a = [...after];
  if (b.join("\0") === a.join("\0")) return;
  props.push({ label, before: b, after: a, kind: "list" });
}
function diffGenericProps(props, before = {}, after = {}, skip = []) {
  for (const key of union2(Object.keys(before), Object.keys(after))) {
    if (skip.includes(key)) continue;
    const label = humanize(key);
    const b = key === "isHidden" ? yesNo(before[key] === "true") : before[key] ?? "";
    const a = key === "isHidden" ? yesNo(after[key] === "true") : after[key] ?? "";
    diffProp(props, label, b, a);
  }
}
function propsAsList(obj = {}, isBefore) {
  return Object.entries(obj).map(([k, v]) => side(!isBefore, humanize(k), k === "isHidden" ? "Yes" : v, "text"));
}
function filterSummary(f) {
  return `${f.field}: ${f.condition || "no value applied"}`;
}
function summarize(records) {
  const s = { modified: 0, changed: 0, removed: 0, renamed: 0, added: 0, security: 0, broken: 0, byGroup: {} };
  for (const r of records) {
    if (r.section === "modified") s.modified++;
    s[r.change]++;
    if (r.flags.security) s.security++;
    if (r.flags.broken) s.broken++;
    s.byGroup[r.group] = (s.byGroup[r.group] || 0) + 1;
  }
  return s;
}
function union2(a, b) {
  return [.../* @__PURE__ */ new Set([...a, ...b])];
}
function count(n) {
  return String(n);
}
function yesNo(v) {
  return v ? "Yes" : "No";
}
function isEmpty(v) {
  return v === void 0 || v === null || v === "" || Array.isArray(v) && v.length === 0;
}
function normWs(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function humanize(key) {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ../GitHub/PBIP_Lineage_Explorer_Application_Databricks_Test/packages/core/src/index.js
function analyze({ modelStructure, reportStructure }) {
  const tmdlFiles = modelStructure?.tmdlFiles || [];
  const relationshipFiles = modelStructure?.relationshipFiles || [];
  const expressionFiles = modelStructure?.expressionFiles || [];
  const model = parseTmdlModel(tmdlFiles, relationshipFiles);
  const parsedExpressions = { expressions: [], parameters: /* @__PURE__ */ new Map() };
  for (const { content } of expressionFiles) {
    const result = parseExpressions(content);
    parsedExpressions.expressions.push(...result.expressions);
    for (const [k, v] of result.parameters) parsedExpressions.parameters.set(k, v);
  }
  model.expressions = parsedExpressions.expressions;
  model.parameters = parsedExpressions.parameters;
  for (const table of model.tables) {
    for (const measure of table.measures || []) {
      if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
    }
    for (const col of table.calculatedColumns || []) {
      if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
    }
  }
  const report = reportStructure ? parsePbirReport(reportStructure.visualFiles || [], reportStructure.pageFiles || []) : { visuals: [], pages: [] };
  const roles = parseRoles(modelStructure?.roleFiles || []);
  model.roles = roles;
  const enrichments = detectEnrichments(model.tables);
  let graph = buildGraph(model, report, enrichments, roles);
  graph = applyEnrichments(graph, enrichments);
  const stats = computeStats(graph);
  return { graph, stats, enrichments, model, report, roles };
}
function analyzeFromFiles({ modelFiles, reportFiles }) {
  const modelStructure = identifyProjectStructure(modelFiles);
  const reportStructure = reportFiles ? identifyProjectStructure(reportFiles) : null;
  return analyze({ modelStructure, reportStructure });
}
function analyzeWorkspace({ reports, modelStructureByKey, primaryModelKey }) {
  if (!primaryModelKey) {
    const counts = /* @__PURE__ */ new Map();
    for (const r of reports) counts.set(r.modelKey, (counts.get(r.modelKey) || 0) + 1);
    let best = null, bestCount = -1;
    for (const [key, count2] of counts) {
      if (count2 > bestCount) {
        best = key;
        bestCount = count2;
      }
    }
    primaryModelKey = best;
  }
  const modelGraphByKey = /* @__PURE__ */ new Map();
  for (const [modelKey, modelStructure] of modelStructureByKey) {
    const tmdlFiles = modelStructure?.tmdlFiles || [];
    const relationshipFiles = modelStructure?.relationshipFiles || [];
    const expressionFiles = modelStructure?.expressionFiles || [];
    const model = parseTmdlModel(tmdlFiles, relationshipFiles);
    const parsedExpressions = { expressions: [], parameters: /* @__PURE__ */ new Map() };
    for (const { content } of expressionFiles) {
      const result = parseExpressions(content);
      parsedExpressions.expressions.push(...result.expressions);
      for (const [k, v] of result.parameters) parsedExpressions.parameters.set(k, v);
    }
    model.expressions = parsedExpressions.expressions;
    model.parameters = parsedExpressions.parameters;
    for (const table of model.tables) {
      for (const measure of table.measures || []) {
        if (measure.expression) measure.daxDeps = parseDaxExpression(measure.expression);
      }
      for (const col of table.calculatedColumns || []) {
        if (col.expression) col.daxDeps = parseDaxExpression(col.expression);
      }
    }
    const roles = parseRoles(modelStructure?.roleFiles || []);
    model.roles = roles;
    const enrichments = detectEnrichments(model.tables);
    let modelGraph = buildGraph(model, null, enrichments, roles);
    modelGraph = applyEnrichments(modelGraph, enrichments);
    if (modelKey !== primaryModelKey) {
      modelGraph = namespaceGraph(modelGraph, `model:${modelKey}\xA7`);
    }
    modelGraphByKey.set(modelKey, modelGraph);
  }
  const combinedNodes = /* @__PURE__ */ new Map();
  const combinedEdges = [];
  const combinedRelColumnIds = /* @__PURE__ */ new Set();
  for (const modelGraph of modelGraphByKey.values()) {
    for (const [id, node] of modelGraph.nodes) combinedNodes.set(id, node);
    combinedEdges.push(...modelGraph.edges);
    for (const id of modelGraph.relationshipColumnIds || []) combinedRelColumnIds.add(id);
  }
  const reportMeta = [];
  for (const r of reports) {
    const parsedReport = parsePbirReport(r.reportStructure?.visualFiles || [], r.reportStructure?.pageFiles || []);
    let reportGraph = buildGraph(null, parsedReport, null);
    const isPrimary = r.modelKey === primaryModelKey;
    reportGraph = rescopeReportGraph(reportGraph, {
      reportKey: r.reportKey,
      reportName: r.reportName,
      fieldPrefix: isPrimary ? "" : `model:${r.modelKey}\xA7`
    });
    for (const [id, node] of reportGraph.nodes) {
      const existing = combinedNodes.get(id);
      if (existing && node.metadata?.placeholder) continue;
      combinedNodes.set(id, node);
    }
    combinedEdges.push(...reportGraph.edges);
    reportMeta.push({ reportKey: r.reportKey, reportName: r.reportName, modelKey: r.modelKey, isPrimaryModel: isPrimary });
  }
  const adjacency = buildAdjacency(combinedEdges);
  const graph = { nodes: combinedNodes, edges: combinedEdges, adjacency };
  graph.relationshipColumnIds = [...combinedRelColumnIds];
  const stats = computeStats(graph);
  graph.stats = stats;
  graph.workspace = {
    reports: reportMeta,
    primaryModelKey,
    multiModel: modelStructureByKey.size > 1
  };
  return { graph, stats };
}
export {
  CHANGE_SCOPES,
  CHANGE_TOPICS,
  CHANGE_TYPES,
  COMPARE_GROUPS,
  CONFIDENCE,
  EDGE_TYPES,
  ENRICHMENT_TYPES,
  IMPACT_GROUPS,
  LAYER_COLORS,
  M_CHANGE_LABELS,
  M_SHAPE,
  NODE_TYPES,
  ORPHAN_CATEGORIES,
  RELEVANT_EXTENSIONS,
  TERMINAL,
  UPSTREAM_FILE_PATH,
  analyze,
  analyzeFromFiles,
  analyzeImpact,
  analyzeMQuery,
  analyzeWorkspace,
  anchorForTable,
  applyEnrichments,
  buildAdjacency,
  buildDependencyIndex,
  buildDependencyStripData,
  buildGraph,
  buildMeasureSummaryRows,
  buildModelFromStructure,
  buildSnapshot,
  buildTypedDownstream,
  cardinalityLabel,
  changeAction,
  classifyMeasureUsage,
  collapseUnchanged,
  compareFileMaps,
  compareSnapshots,
  computeStats,
  createEdge,
  createNode,
  crossFilterLabel,
  describeBookmarkEffect,
  describeFilterCondition,
  describeImpact,
  detectChanges,
  detectEnrichments,
  diffLines,
  diffModelDiagram,
  exportImpactReport,
  extractColumnRefs,
  extractDatabricksSource,
  extractDataflowSource,
  extractMDataSource,
  extractMeasureRefs,
  extractNestedJoins,
  extractRenameColumns,
  extractTableRefs,
  extractUseRelationshipRefs,
  findColumnOrphans,
  findDefinitionPbir,
  findOrphans,
  findOrphansByCategory,
  getDirectDependencies,
  getDownstream,
  getFieldFilterUsage,
  getUpstream,
  groupChangesByTopic,
  groupCompareRecords,
  identifyProjectStructure,
  isMeasureOrphan,
  isRelevantFile,
  isUpstreamStale,
  layoutModelDiagram,
  letSteps,
  modelDiagramData,
  namespaceGraph,
  parseDaxExpression,
  parseExpressions,
  parseMashupDocument,
  parsePbirReport,
  parseRoles,
  parseSemanticModelReference,
  parseTmdlModel,
  parseUpstreamLineage,
  prettyVisualType,
  rescopeReportGraph,
  resolveImpact,
  sourceNodeIdForTable,
  sourcesIn,
  summarizeDiagramDiff,
  summarizeUpstream,
  systemLabel,
  systemsInUpstream,
  tablesInSql,
  terminalOf,
  topicForChange,
  traceMeasureLineage,
  traceVisualLineage,
  upstreamNeighbors,
  upstreamTree,
  visualFields,
  visualLabel
};
