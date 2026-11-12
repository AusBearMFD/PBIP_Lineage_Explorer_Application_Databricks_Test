import { describe, it, expect } from 'vitest';
import { extractDatabricksSource, tablesInSql } from '../src/parser/databricksSource.js';
import { extractMDataSource, parseExpressions } from '../src/parser/tmdlParser.js';
import { analyzeFromFiles } from '../src/index.js';

// Shapes taken from MFD PBIP models (pbiws_area_dashboards, pbiws_reccamps, pbiws_pf_maps_db_prod).
const LITERAL_TABLE = `let
    Source = Databricks.Catalogs("adb-1234567890123456.7.azuredatabricks.net", "/sql/1.0/warehouses/0123456789abcdef", [Catalog=null, Database=null, EnableAutomaticProxyDiscovery=null, Implementation=null]),
    #"facilities-prod_Database" = Source{[Name="facilities-prod",Kind="Database"]}[Data],
    publish_Schema = #"facilities-prod_Database"{[Name="publish",Kind="Schema"]}[Data],
    date_dim_Table = publish_Schema{[Name="date_dim",Kind="Table"]}[Data],
    #"Sorted Rows" = Table.Sort(date_dim_Table,{{"full_date", Order.Descending}})
in
    #"Sorted Rows"`;

const LITERAL_VIEW = `let
    Source = Databricks.Catalogs("adb-1234567890123456.7.azuredatabricks.net", "/sql/1.0/warehouses/0123456789abcdef", [Catalog=null, Database=null, QueryTags=null, EnableAutomaticProxyDiscovery=null, Implementation="2.0", Protocol=null]),
    mfd_Database = Source{[Name="mfd",Kind="Database"]}[Data],
    prd_Schema = mfd_Database{[Name="prd",Kind="Schema"]}[Data],
    area_dashboard_crv_view_v2_View = prd_Schema{[Name="area_dashboard_crv_view_v2",Kind="View"]}[Data]
in
    area_dashboard_crv_view_v2_View`;

const MULTICLOUD = `let
    Source = DatabricksMultiCloud.Catalogs("adb-1234567890123456.7.azuredatabricks.net", "/sql/1.0/warehouses/0123456789abcdef", [Catalog=null, Database=null, QueryTags=null, EnableAutomaticProxyDiscovery=null, Implementation="2.0"]),
    mfd_Database = Source{[Name="mfd",Kind="Database"]}[Data],
    dev_Schema = mfd_Database{[Name="dev",Kind="Schema"]}[Data],
    rec_camps_financial_page_Table = dev_Schema{[Name="rec_camps_financial_page",Kind="Table"]}[Data]
in
    rec_camps_financial_page_Table`;

const PARAMETERIZED = `let
    Source = Databricks.Catalogs(DBX_ServerHostname, DBX_HttpPath, [Catalog=DBX_Catalog, Database=null, QueryTags=null, EnableAutomaticProxyDiscovery=null, Implementation="2.0", Protocol=null]),
    #"facilities-dev_Database" = Source{[Name=DBX_Catalog,Kind="Database"]}[Data],
    pfmaps_Schema = #"facilities-dev_Database"{[Name=DBX_PFMapsSchema,Kind="Schema"]}[Data],
    bridgeareasummary_Table = pfmaps_Schema{[Name="bridgeareasummary",Kind="Table"]}[Data]
in
    bridgeareasummary_Table`;

describe('extractDatabricksSource', () => {
  it('reads catalog, schema and table from literal navigation', () => {
    const ds = extractDatabricksSource(LITERAL_TABLE);
    expect(ds).toMatchObject({
      type: 'Databricks',
      server: 'adb-1234567890123456.7.azuredatabricks.net',
      httpPath: '/sql/1.0/warehouses/0123456789abcdef',
      database: 'facilities-prod',
      schema: 'publish',
      sourceTable: 'date_dim',
      objectKind: 'Table',
      fqn: 'facilities-prod.publish.date_dim',
    });
    expect(ds.unresolved).toEqual([]);
  });

  it('recognizes views', () => {
    const ds = extractDatabricksSource(LITERAL_VIEW);
    expect(ds.objectKind).toBe('View');
    expect(ds.fqn).toBe('mfd.prd.area_dashboard_crv_view_v2');
  });

  it('handles the DatabricksMultiCloud connector', () => {
    const ds = extractDatabricksSource(MULTICLOUD);
    expect(ds.connector).toBe('DatabricksMultiCloud.Catalogs');
    expect(ds.fqn).toBe('mfd.dev.rec_camps_financial_page');
  });

  it('reports parameters it could not resolve instead of guessing', () => {
    const ds = extractDatabricksSource(PARAMETERIZED);
    expect(ds.sourceTable).toBe('bridgeareasummary');
    expect(ds.fqn).toBeNull();
    expect(ds.unresolved).toEqual(expect.arrayContaining(['DBX_ServerHostname', 'DBX_Catalog', 'DBX_PFMapsSchema']));
  });

  it('reads every table a native query uses', () => {
    const m = `let
      Source = Databricks.Catalogs("host", "/sql/1.0/warehouses/x", [Catalog=null]),
      q = Value.NativeQuery(Source{[Name="mfd",Kind="Database"]}[Data], "SELECT a.* FROM mfd.prd.facts a JOIN \`facilities-prod\`.publish.date_dim d ON a.d = d.d -- FROM ignored.x", null, [EnableFolding=true])
    in q`;
    const ds = extractDatabricksSource(m);
    expect(ds.nativeTables).toEqual(['mfd.prd.facts', 'facilities-prod.publish.date_dim']);
    expect(ds.fqn).toBe('mfd.prd.facts');
  });

  it('ignores expressions that do not use the Databricks connector', () => {
    expect(extractDatabricksSource('let Source = Sql.Database("s", "d") in Source')).toBeNull();
    expect(extractDatabricksSource(`/* Databricks.Catalogs("h","p") */ let x = 1 in x`)).toBeNull();
  });
});

describe('tablesInSql', () => {
  it('skips subqueries and string literals', () => {
    expect(tablesInSql("SELECT * FROM (SELECT 1) t JOIN cat.sch.tbl ON 'FROM fake.table' = x")).toEqual(['cat.sch.tbl']);
  });
});

describe('extractMDataSource with Databricks', () => {
  it('no longer reports the catalog name as the source table', () => {
    const ds = extractMDataSource(LITERAL_TABLE);
    expect(ds.sourceTable).toBe('date_dim');
    expect(ds.database).toBe('facilities-prod');
    expect(ds.schema).toBe('publish');
    expect(ds.type).toBe('Databricks');
  });

  it('still detects SQL Server sources', () => {
    const ds = extractMDataSource('let Source = Sql.Database("srv", "db"), t = Source{[Schema="dbo",Item="Sales"]}[Data] in t');
    expect(ds).toMatchObject({ type: 'SQL', server: 'srv', database: 'db', schema: 'dbo', sourceTable: 'Sales' });
  });
});

describe('Databricks sources through the full pipeline', () => {
  it('resolves model parameters and stores the full name on the table', () => {
    const expressions = [
      'expression DBX_ServerHostname = "adb-1.azuredatabricks.net" meta [IsParameterQuery = true, Type = "Text"]',
      'expression DBX_HttpPath = "/sql/1.0/warehouses/abc" meta [IsParameterQuery = true, Type = "Text"]',
      'expression DBX_Catalog = "facilities-prod" meta [IsParameterQuery = true, Type = "Text"]',
      'expression DBX_PFMapsSchema = "pfmaps" meta [IsParameterQuery=true, Type="Text"]',
    ].join('\n');
    expect(parseExpressions(expressions).parameters.get('DBX_Catalog')).toBe('facilities-prod');

    const table = [
      'table BridgeAreaSummary',
      '\tcolumn area_id',
      '\t\tdataType: string',
      '\t\tsourceColumn: area_id',
      '',
      "\tpartition 'BridgeAreaSummary-1' = m",
      '\t\tmode: import',
      '\t\tsource =',
      ...PARAMETERIZED.split('\n').map(l => '\t\t\t\t' + l),
    ].join('\n');

    const { graph } = analyzeFromFiles({
      modelFiles: new Map([
        ['definition/expressions.tmdl', expressions],
        ['definition/tables/BridgeAreaSummary.tmdl', table],
      ]),
      reportFiles: new Map(),
    });
    const ds = graph.nodes.get('table::BridgeAreaSummary').metadata.dataSource;
    expect(ds).toMatchObject({
      sourceType: 'Databricks',
      server: 'adb-1.azuredatabricks.net',
      database: 'facilities-prod',
      schema: 'pfmaps',
      sourceTable: 'bridgeareasummary',
      fqn: 'facilities-prod.pfmaps.bridgeareasummary',
      objectKind: 'Table',
    });
  });
});
