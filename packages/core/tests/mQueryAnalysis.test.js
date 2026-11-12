import { describe, it, expect } from 'vitest';
import {
  parseMashupDocument, letSteps, analyzeMQuery, extractDataflowSource, extractMDataSource,
  sourceNodeIdForTable, parseUpstreamLineage, upstreamNeighbors,
} from '../src/index.js';

const DOC = `section Section1;
shared Plain = let
  Source = Sql.Database("srv\\s01", "Warehouse"),
  Nav = Source{[Schema = "Common", Item = "Property"]}[Data],
  Typed = Table.TransformColumnTypes(Nav, {{"Id", Int64.Type}})
in
  Typed;
shared #"Trimmed Units" = let
  Source = Plain,
  Kept = Table.SelectColumns(Source, {"Id", "Name"}),
  Renamed = Table.RenameColumns(Kept, {{"Name", "Unit name"}}),
  Active = Table.SelectRows(Renamed, each [Id] <> null)
in
  Active;
shared Joined = let
  Source = Table.NestedJoin(Plain, {"Id"}, #"Trimmed Units", {"Id"}, "U", JoinKind.LeftOuter),
  Expanded = Table.ExpandTableColumn(Source, "U", {"Unit name"}),
  Year = Table.AddColumn(Expanded, "Year", each let d = [Date], y = Date.Year(d) in y, Int64.Type),
  Grouped = Table.Group(Year, {"Year"}, {{"Count", each Table.RowCount(_), Int64.Type}})
in
  Grouped;
shared Typed = Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText("i45W", BinaryEncoding.Base64), Compression.Deflate)), {"A"});`;

describe('parseMashupDocument', () => {
  it('splits a section document into its shared queries', () => {
    const qs = parseMashupDocument(DOC);
    expect(qs.map(q => q.name)).toEqual(['Plain', 'Trimmed Units', 'Joined', 'Typed']);
  });
});

describe('letSteps', () => {
  it('keeps a nested each-let in one step', () => {
    const joined = parseMashupDocument(DOC).find(q => q.name === 'Joined');
    const { steps, result } = letSteps(joined.expression);
    expect(steps.map(s => s.name)).toEqual(['Source', 'Expanded', 'Year', 'Grouped']);
    expect(result).toBe('Grouped');
  });
});

describe('analyzeMQuery', () => {
  const qs = parseMashupDocument(DOC);
  const names = qs.map(q => q.name);
  const run = (name) => analyzeMQuery(qs.find(q => q.name === name).expression, { queryNames: names, name });

  it('calls a source with only type changes direct', () => {
    const a = run('Plain');
    expect(a.shape).toBe('direct');
    expect(a.sources[0]).toMatchObject({ type: 'sqlserver', id: 'sql:warehouse.common.property' });
    expect(a.changes).toEqual([]);
  });

  it('calls filtering, renaming and column selection shaped, and records the query it reads', () => {
    const a = run('Trimmed Units');
    expect(a.shape).toBe('shaped');
    expect(a.references).toEqual(['Plain']);
    expect(a.changes.map(c => c.category)).toEqual(['columns', 'rename', 'filter']);
  });

  it('flags joins, new columns and grouping as transformed', () => {
    const a = run('Joined');
    expect(a.shape).toBe('transformed');
    expect(a.flags).toEqual(expect.arrayContaining(['Joins tables', 'Adds columns', 'Groups or pivots rows']));
    expect(a.changes.find(c => c.category === 'join').detail).toContain('Trimmed Units');
    expect(a.changes.find(c => c.category === 'newColumn').detail).toContain('"Year"');
    expect(a.references).toEqual(expect.arrayContaining(['Plain', 'Trimmed Units']));
  });

  it('flags typed-in data', () => {
    const a = run('Typed');
    expect(a.shape).toBe('transformed');
    expect(a.changes[0].detail).toMatch(/Enter data/);
  });

  it('reads custom SQL even when the connector call has commas, and flags joins in it', () => {
    const m = `let
      Source = Value.NativeQuery(Databricks.Catalogs("h", "/sql/1.0/warehouses/x", [Catalog="c"]){[Name="c",Kind="Database"]}[Data], "SELECT a.* FROM c.s.a JOIN c.s.b ON a.k = b.k", null, [EnableFolding=true])
    in Source`;
    const a = analyzeMQuery(m);
    expect(a.nativeSql).toContain('JOIN');
    expect(a.shape).toBe('transformed');
    const simple = analyzeMQuery(m.replace(' JOIN c.s.b ON a.k = b.k', ''));
    expect(simple.shape).toBe('shaped');
  });

  it('does not call converting a source records "typed-in data"', () => {
    const a = analyzeMQuery('let S = Json.Document(Web.Contents("https://x.example/api")), T = Table.FromRecords(S[value]) in T');
    expect(a.shape).toBe('direct');
    expect(analyzeMQuery('let T = Table.FromRecords({[a=1],[a=2]}) in T').shape).toBe('transformed');
  });

  it('treats a type-only TransformColumns as a type step', () => {
    const a = analyzeMQuery('let S = Sql.Database("s","d"), T = Table.TransformColumns(S, {{"A", Number.From, type number}}) in T');
    expect(a.shape).toBe('direct');
  });
});

describe('dataflow sources', () => {
  const m = `let
    Source = PowerPlatform.Dataflows(null),
    Workspaces = Source{[Id="Workspaces"]}[Data],
    Ws = Workspaces{[workspaceId="11111111-aaaa"]}[Data],
    Df = Ws{[dataflowId="22222222-bbbb"]}[Data],
    T = Df{[entity="Unit Look Up",version=""]}[Data]
  in T`;

  it('reads workspace, dataflow and table ids', () => {
    expect(extractDataflowSource(m)).toMatchObject({ type: 'Dataflow', workspaceId: '11111111-aaaa', dataflowId: '22222222-bbbb', entity: 'Unit Look Up' });
    expect(extractMDataSource(m)).toMatchObject({ type: 'Dataflow', database: '22222222-bbbb', sourceTable: 'Unit Look Up' });
  });

  it('anchors a model table to its dataflow table node', () => {
    const ds = { sourceType: 'Dataflow', database: '22222222-bbbb', sourceTable: 'Unit Look Up' };
    expect(sourceNodeIdForTable(ds)).toBe('pbi-df:22222222-bbbb/Unit Look Up');
  });
});

describe('upstream node details', () => {
  it('keeps details and lists neighbours both ways', () => {
    const { upstream } = parseUpstreamLineage({
      version: 1,
      nodes: [
        { id: 'dbx:c.s.a', details: { sql: 'SELECT 1', runs: [{ time: 't', status: 'Succeeded' }] } },
        { id: 'dbx:c.s.b' }, { id: 'dbx:c.s.c' },
      ],
      edges: [{ from: 'dbx:c.s.b', to: 'dbx:c.s.a' }, { from: 'dbx:c.s.a', to: 'dbx:c.s.c' }],
    });
    const n = upstreamNeighbors(upstream, 'dbx:c.s.a');
    expect(n.node.details.sql).toBe('SELECT 1');
    expect(n.fedBy.map(x => x.node.id)).toEqual(['dbx:c.s.b']);
    expect(n.feeds.map(x => x.node.id)).toEqual(['dbx:c.s.c']);
  });
});
