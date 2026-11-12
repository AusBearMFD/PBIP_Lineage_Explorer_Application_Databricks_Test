/**
 * Builds dist/pbip-compare.mjs: one Node file containing the CLI, the
 * Lineage Explorer core, and the report template (page shell + the app's CSS
 * + a bundle of the two existing views). Also writes its .sha256 for releases.
 *
 * Reads packages/core, src/ui and styles/main.css of this repository in place;
 * nothing outside this folder is changed.
 */

import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: repo }).toString().trim();
  } catch {
    return 'local';
  }
}

// The views import the core by its workspace name; point that at the source.
const coreAlias = {
  name: 'core-alias',
  setup(build) {
    build.onResolve({ filter: /^@pbip-lineage\/core$/ }, () => ({ path: join(repo, 'packages/core/src/index.js') }));
    build.onResolve({ filter: /^@pbip-lineage\/core\// }, (args) => ({ path: join(repo, 'packages/core/src', args.path.slice('@pbip-lineage/core/'.length)) }));
  },
};

/**
 * versionCompareView.js imports only highlightDax from lineageView.js, but
 * lineageView.js pulls in the whole lineage UI, including lineageTree.js,
 * which esbuild rejects (a const is reassigned near line 521). Instead, build
 * a small module from the original highlightDax source, read from the file at
 * build time so there is no copy to keep in sync. The build fails loudly if
 * those functions are ever restructured.
 */
const highlightDaxOnly = {
  name: 'highlight-dax-only',
  setup(build) {
    build.onResolve({ filter: /^\.\/lineageView\.js$/ }, (args) =>
      args.importer.endsWith('versionCompareView.js') ? { path: 'highlightDax', namespace: 'lineage-view-subset' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'lineage-view-subset' }, () => {
      const src = readFileSync(join(repo, 'src/ui/lineageView.js'), 'utf8');
      const block = (start, end) => {
        const i = src.indexOf(start);
        const j = i < 0 ? -1 : src.indexOf(end, i);
        if (j < 0) throw new Error(`src/ui/lineageView.js no longer contains "${start}"; update build/build.mjs`);
        return src.slice(i, j + end.length);
      };
      return {
        contents: [
          block('const DAX_FUNCTIONS = new Set([', '\n]);\n'),
          block('function esc(str) {', '\n}\n'),
          block('export function highlightDax(expression) {', '\n}\n'),
        ].join('\n'),
        loader: 'js',
      };
    });
  },
};

// 1. Browser bundle of the report page. d3 comes from this folder's
//    node_modules when the repository root has no install.
const app = await esbuild.build({
  entryPoints: [join(root, 'src/report/entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  nodePaths: [join(root, 'node_modules')],
  plugins: [highlightDaxOnly, coreAlias],
  logLevel: 'warning',
});
const appJs = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(repo, 'styles/main.css'), 'utf8');
const template = readFileSync(join(root, 'src/report/report.html'), 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__APP__*/', () => appJs);

// 2. Node bundle of the CLI, with the template embedded.
mkdirSync(join(root, 'dist'), { recursive: true });
const outfile = join(root, 'dist/pbip-compare.mjs');
await esbuild.build({
  entryPoints: [join(root, 'cli/pbip-compare.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile,
  define: {
    __TOOL_VERSION__: JSON.stringify(pkg.version),
    __TOOL_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [
    coreAlias,
    {
      name: 'report-template',
      setup(build) {
        build.onResolve({ filter: /^virtual:report-template$/ }, () => ({ path: 'report-template', namespace: 'virtual' }));
        build.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: template, loader: 'text' }));
      },
    },
  ],
  logLevel: 'warning',
});
const built = readFileSync(outfile);
const sha = createHash('sha256').update(built).digest('hex');
writeFileSync(`${outfile}.sha256`, `${sha}  pbip-compare.mjs\n`);
console.log(`Built dist/pbip-compare.mjs ${pkg.version} (${Math.round(built.length / 1024)} KB, sha256 ${sha.slice(0, 12)})`);
