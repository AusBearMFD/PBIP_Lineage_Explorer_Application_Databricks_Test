// Tree-building tests for the web app's lineage diagram (src/ui/lineageTree.js).
// They live here because vitest only collects packages/core/tests.
import { describe, it, expect } from 'vitest';
import { buildTreeData } from '../../../../src/ui/lineageTree.js';

function graphWith() {
  return { nodes: new Map(), edges: [], adjacency: { upstream: new Map(), downstream: new Map() } };
}

const chain = { id: 'measure::Sales.Total', name: 'Total', expression: 'SUM(Sales[Amount])', children: [], columns: [] };

describe('lineage diagram: visuals, pages and reports', () => {
  it('shows each visual\'s page on the node itself', () => {
    const tree = buildTreeData({
      visuals: [{ title: 'Revenue card', visualType: 'card', page: 'Overview', report: '' }],
      measureChain: chain, sourceTable: [],
    }, graphWith());
    const visual = tree.children.find(c => c.type === 'visual');
    expect(visual.subLabel).toBe('Page: Overview');
    expect(visual.layerLabel).toBe('Report Visual');
  });

  it('groups visuals under one node per report in a workspace', () => {
    const tree = buildTreeData({
      visuals: [
        { title: 'A', visualType: 'card', page: 'P1', report: 'Area' },
        { title: 'B', visualType: 'table', page: 'P2', report: 'Area' },
        { title: 'C', visualType: 'card', page: 'P1', report: 'Stake' },
      ],
      measureChain: chain, sourceTable: [],
    }, graphWith());
    const group = tree.children.find(c => c.type === 'visualGroup');
    expect(group.subLabel).toBe('in 2 reports');
    expect(group.children.map(r => [r.type, r.name, r.children.length])).toEqual([['report', 'Area', 2], ['report', 'Stake', 1]]);
    expect(group.children[0].subLabel).toBe('Report · 2 visuals · 2 pages');
  });

  it('keeps the original flat list when visuals have no report', () => {
    const tree = buildTreeData({
      visuals: [
        { title: 'A', visualType: 'card', page: 'P1' },
        { title: 'B', visualType: 'card', page: 'P2' },
      ],
      measureChain: chain, sourceTable: [],
    }, graphWith());
    const group = tree.children.find(c => c.type === 'visualGroup');
    expect(group.children.every(c => c.type === 'visual')).toBe(true);
  });
});
