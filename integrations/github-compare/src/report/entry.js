/**
 * Report page — shows an embedded payload with the Lineage Explorer's own
 * Version Compare and Model Diagram views, imported unchanged.
 */

import { initVersionCompare, setVersionCompareData, renderVersionCompare } from '../../../../src/ui/versionCompareView.js';
import {
  initModelDiagram, setModelDiagramModels, setModelDiagramHistory, renderModelDiagram, showModelDiagramChange,
} from '../../../../src/ui/modelDiagramView.js';
import { parse, expandPayload } from '../payload.js';

/** The payload is gzipped JSON in base64; the browser's DecompressionStream unpacks it. */
async function readPayload() {
  const b64 = document.getElementById('pbip-compare-payload').textContent.trim();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return expandPayload(parse(await new Response(stream).text()));
}

const payload = await readPayload();

const text = (id, value) => { document.getElementById(id).textContent = value; };
text('rc-repo', payload.repo);
text('rc-range', `${payload.base.ref} → ${payload.head.ref}`);
text('rc-meta', `${payload.branchCommitCount} branch commit${payload.branchCommitCount === 1 ? '' : 's'} · source: ${payload.source} · ` +
  `tool ${payload.tool.version} · generated ${new Date(payload.generatedAt).toLocaleString()}`);
text('rc-why', `Head chosen by: ${payload.reason}. Compared tip to tip: ${payload.base.ref} ${payload.base.oid.slice(0, 7)} vs ${payload.head.ref} ${payload.head.oid.slice(0, 7)}.`);
const warnings = document.getElementById('rc-warnings');
for (const w of payload.warnings) {
  const div = document.createElement('div');
  div.className = 'rc-warn';
  div.textContent = w;
  warnings.append(div);
}
document.title = `${payload.repo.split('/').pop()} · ${payload.head.ref} vs ${payload.base.ref}`;

const containers = {
  compare: document.getElementById('version-compare-container'),
  diagram: document.getElementById('model-diagram-container'),
};
const tabs = {
  compare: document.getElementById('tab-compare'),
  diagram: document.getElementById('tab-diagram'),
};

function show(name) {
  for (const key of Object.keys(containers)) {
    containers[key].classList.toggle('hidden', key !== name);
    tabs[key].setAttribute('aria-selected', String(key === name));
  }
  if (name === 'compare') renderVersionCompare(containers.compare);
  else renderModelDiagram(containers.diagram);
}
tabs.compare.addEventListener('click', () => show('compare'));
tabs.diagram.addEventListener('click', () => show('diagram'));

initVersionCompare({
  onRequestScan: () => {},
  onShowInDiagram: (focus) => { showModelDiagramChange(focus); show('diagram'); },
});
initModelDiagram({ onRequestHistory: () => {} });

const data = { status: 'ready', hasRepo: true, pairs: payload.pairs };
setVersionCompareData(data);
setModelDiagramHistory(data);

// "Current model" mode shows the head version's semantic models.
const headModels = payload.pairs[0]?.models?.after || new Map();
setModelDiagramModels([...headModels].map(([key, model]) => ({
  key,
  name: key.split('/').pop().replace(/\.semanticmodel$/i, '') || key,
  structure: {},
  model,
})));

show('compare');
