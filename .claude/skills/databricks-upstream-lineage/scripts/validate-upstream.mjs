#!/usr/bin/env node
/**
 * validate-upstream.mjs — check an upstream lineage file before it's written to
 * .lineage/upstream.json, using the same parser the app uses.
 *
 *   node validate-upstream.mjs <upstream.json> [--pbip <folder>]
 *
 * Reports: errors (the app would ignore the file), warnings, counts of origins and
 * best-known ends, and, with --pbip, which model tables with a Databricks source
 * the file covers and which it doesn't. Exit 0 when the app can read the file, 1 if not.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadCore } from '../../pbip-lineage-analyst/scripts/lib/load-core.mjs';

const { core } = await loadCore();
const { parseUpstreamLineage, terminalOf, TERMINAL, anchorForTable } = core;

const [file, ...rest] = process.argv.slice(2);
if (!file) { process.stderr.write('Usage: node validate-upstream.mjs <upstream.json> [--pbip <folder>]\n'); process.exit(2); }
const pbip = rest[0] === '--pbip' ? rest[1] : null;

const { upstream, errors, warnings } = parseUpstreamLineage(readFileSync(file, 'utf8'));
const out = { readable: !!upstream, errors, warnings };
if (upstream) {
  let origins = 0, best = 0, inferred = 0;
  for (const n of upstream.nodes.values()) {
    const t = terminalOf(upstream, n);
    if (t === TERMINAL.ORIGIN) origins++; else if (t === TERMINAL.BEST_KNOWN) best++;
  }
  for (const e of upstream.edges) if (e.confidence === 'inferred') inferred++;
  const unexplained = [...upstream.nodes.values()].filter(n => terminalOf(upstream, n) === TERMINAL.BEST_KNOWN && !n.stopReason).map(n => n.id);
  Object.assign(out, {
    nodes: upstream.nodes.size, edges: upstream.edges.length, origins, bestKnown: best, inferredEdges: inferred,
    bestKnownWithoutReason: unexplained,
  });
  if (unexplained.length) out.warnings.push(`${unexplained.length} trail end(s) have no reason; add a "stops" entry saying why the trail ends there.`);

  if (pbip) {
    const lineage = join(dirname(fileURLToPath(import.meta.url)), '../../pbip-lineage-analyst/scripts/lineage.mjs');
    const sources = JSON.parse(execFileSync(process.execPath, [lineage, 'sources', pbip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }));
    const dbx = sources.tables.filter(t => t.type === 'Databricks');
    const covered = [], missing = [];
    for (const t of dbx) {
      const ds = { sourceType: 'Databricks', fqn: t.source };
      (anchorForTable(upstream, t.table, ds) ? covered : missing).push(`${t.table} <- ${t.source}`);
    }
    out.coverage = { databricksTables: dbx.length, covered, missing };
  }
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exit(upstream ? 0 : 1);
