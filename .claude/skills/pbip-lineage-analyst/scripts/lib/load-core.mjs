/**
 * Load the PBIP Lineage Explorer engine (packages/core) for the skill scripts.
 *
 * Order:
 *   1. PBIP_LINEAGE_CORE environment variable: path to a core index.js (or a bundle).
 *   2. The app's live source, when these skills sit inside the app repo
 *      (<repo>/.claude/skills/...): <repo>/packages/core/src/index.js.
 *   3. The bundled copy next to this file (pbip-lineage-core.mjs), so the skills also
 *      work from ~/.claude/skills in any project.
 * A candidate that lacks an export the skills need (an older app version) is skipped.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED = ['identifyProjectStructure', 'analyzeWorkspace', 'traceMeasureLineage', 'findOrphansByCategory',
  'compareFileMaps', 'parseUpstreamLineage', 'anchorForTable', 'summarizeUpstream',
  'upstreamNeighbors', 'analyzeMQuery', 'parseMashupDocument', 'extractDataflowSource'];

export async function loadCore() {
  const skipped = [];
  const candidates = [];
  if (process.env.PBIP_LINEAGE_CORE) candidates.push(['env', pathToFileURL(resolve(process.env.PBIP_LINEAGE_CORE))]);
  candidates.push(['repo', new URL('../../../../../packages/core/src/index.js', import.meta.url)]);
  candidates.push(['bundled', new URL('./pbip-lineage-core.mjs', import.meta.url)]);
  for (const [source, url] of candidates) {
    if (existsSync(fileURLToPath(url))) {
      const core = await import(url.href);
      const missing = REQUIRED.filter(name => typeof core[name] === 'undefined');
      if (missing.length) { skipped.push(`${source} engine lacks ${missing.join(', ')}`); continue; }
      return { core, source, path: fileURLToPath(url), skipped };
    }
  }
  throw new Error('PBIP Lineage Explorer engine not found. Set PBIP_LINEAGE_CORE to packages/core/src/index.js.');
}
