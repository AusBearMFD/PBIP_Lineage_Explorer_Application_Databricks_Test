import { describe, it, expect } from 'vitest';
import {
  parseUpstreamLineage, anchorForTable, upstreamTree, summarizeUpstream, terminalOf,
  sourceNodeIdForTable, systemsInUpstream, isUpstreamStale, TERMINAL,
} from '../src/upstream/upstreamLineage.js';

const FILE = {
  version: 1,
  generatedAt: '2026-11-06T15:20:00Z',
  generatedBy: 'test',
  pbipCommit: 'fe6ccf6',
  anchors: { 'Area Dashboard/area_dashboard_pemd': 'dbx:mfd.prd.area_dashboard_pemd' },
  nodes: [
    { id: 'dbx:mfd.prd.area_dashboard_pemd', system: 'databricks', kind: 'view' },
    { id: 'dbx:mfd.prd.property_entity_master_dim', system: 'databricks', kind: 'table' },
    { id: 'dbx:mfd.stg.property_entity_master', system: 'databricks', kind: 'table', freshness: { status: 'failed', lastRun: '2026-11-05' } },
    { id: 'sql:tririga.dbo.propertyentity', system: 'sqlserver', kind: 'table', terminal: 'origin' },
    { id: 'dbx:mfd.raw.manual_area_overrides', system: 'databricks', kind: 'table' },
  ],
  edges: [
    { from: 'dbx:mfd.prd.property_entity_master_dim', to: 'dbx:mfd.prd.area_dashboard_pemd', evidence: 'view definition' },
    { from: 'dbx:mfd.stg.property_entity_master', to: 'dbx:mfd.prd.property_entity_master_dim', via: 'job:area_refresh', confidence: 'recorded' },
    { from: 'sql:tririga.dbo.propertyentity', to: 'dbx:mfd.stg.property_entity_master', via: 'job:ingest' },
    { from: 'dbx:mfd.raw.manual_area_overrides', to: 'dbx:mfd.stg.property_entity_master', confidence: 'inferred', evidence: 'notebook cell 4' },
  ],
  stops: [{ node: 'dbx:mfd.raw.manual_area_overrides', terminal: 'best_known', reason: 'no upstream lineage recorded' }],
};

describe('parseUpstreamLineage', () => {
  it('reads a valid file', () => {
    const { upstream, errors, warnings } = parseUpstreamLineage(JSON.stringify(FILE));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(upstream.nodes.size).toBe(5);
    expect(upstream.edges).toHaveLength(4);
    expect(upstream.nodes.get('dbx:mfd.raw.manual_area_overrides').stopReason).toBe('no upstream lineage recorded');
  });

  it('rejects files it cannot use, with a reason', () => {
    expect(parseUpstreamLineage('{').errors[0]).toMatch(/Not valid JSON/);
    expect(parseUpstreamLineage({ version: 2, nodes: [], edges: [] }).errors[0]).toMatch(/version/);
    expect(parseUpstreamLineage({ version: 1 }).errors).toHaveLength(2);
  });

  it('adds nodes that only edges mention, with a warning', () => {
    const { upstream, warnings } = parseUpstreamLineage({ version: 1, nodes: [], edges: [{ from: 'dbx:a.b.c', to: 'dbx:a.b.d' }] });
    expect(upstream.nodes.has('dbx:a.b.c')).toBe(true);
    expect(warnings.length).toBe(2);
  });
});

describe('anchors and trees', () => {
  const { upstream } = parseUpstreamLineage(FILE);

  it('finds a table by explicit anchor, with or without the model name', () => {
    expect(anchorForTable(upstream, 'area_dashboard_pemd', null, 'Area Dashboard')).toBe('dbx:mfd.prd.area_dashboard_pemd');
    expect(anchorForTable(upstream, 'area_dashboard_pemd', null)).toBe('dbx:mfd.prd.area_dashboard_pemd');
  });

  it('finds a table by its own Databricks source when there is no anchor', () => {
    const ds = { sourceType: 'Databricks', database: 'mfd', schema: 'prd', sourceTable: 'property_entity_master_dim' };
    expect(sourceNodeIdForTable(ds)).toBe('dbx:mfd.prd.property_entity_master_dim');
    expect(anchorForTable(upstream, 'Property', ds)).toBe('dbx:mfd.prd.property_entity_master_dim');
  });

  it('walks upstream to the origin and the best-known end', () => {
    const tree = upstreamTree(upstream, 'dbx:mfd.prd.area_dashboard_pemd');
    const stg = tree.children[0].children[0];
    expect(stg.node.name).toBe('mfd.stg.property_entity_master');
    expect(stg.children.map(c => terminalOf(upstream, c.node)).sort()).toEqual([TERMINAL.BEST_KNOWN, TERMINAL.ORIGIN]);
  });

  it('can hide inferred edges and limit depth', () => {
    const noInferred = upstreamTree(upstream, 'dbx:mfd.prd.area_dashboard_pemd', { hideInferred: true });
    expect(noInferred.children[0].children[0].children).toHaveLength(1);
    const shallow = upstreamTree(upstream, 'dbx:mfd.prd.area_dashboard_pemd', { maxDepth: 1 });
    expect(shallow.children[0].children).toHaveLength(0);
    expect(shallow.children[0].truncated).toBe(true);
  });

  it('summarizes origins, best-known ends, stale jobs and inferred edges', () => {
    const s = summarizeUpstream(upstream, 'dbx:mfd.prd.area_dashboard_pemd');
    expect(s.depth).toBe(3);
    expect(s.origins.map(n => n.id)).toEqual(['sql:tririga.dbo.propertyentity']);
    expect(s.bestKnown.map(n => n.id)).toEqual(['dbx:mfd.raw.manual_area_overrides']);
    expect(s.inferredEdges).toBe(1);
    expect(s.stale.map(n => n.id)).toEqual(['dbx:mfd.stg.property_entity_master']);
    expect(s.systems).toEqual(expect.arrayContaining(['Databricks', 'SQL Server']));
  });

  it('survives cycles', () => {
    const { upstream: cyc } = parseUpstreamLineage({ version: 1, nodes: [], edges: [{ from: 'dbx:a', to: 'dbx:b' }, { from: 'dbx:b', to: 'dbx:a' }] });
    const tree = upstreamTree(cyc, 'dbx:a');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].children).toHaveLength(0);
  });

  it('lists systems and spots a file written for another commit', () => {
    expect(systemsInUpstream(upstream)).toEqual(['databricks', 'sqlserver']);
    expect(isUpstreamStale(upstream, 'fe6ccf6123')).toBe(false);
    expect(isUpstreamStale(upstream, 'abc1234')).toBe(true);
    expect(isUpstreamStale(upstream, null)).toBe(false);
  });
});
