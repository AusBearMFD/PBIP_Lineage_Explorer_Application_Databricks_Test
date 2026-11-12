/**
 * Power BI dataflow source detection for Power Query (M) expressions.
 *
 * A model (or another dataflow) reads a dataflow table through
 *
 *   Source = PowerPlatform.Dataflows(null),               // or PowerBI.Dataflows(null)
 *   Workspaces = Source{[Id="Workspaces"]}[Data],
 *   Ws = Workspaces{[workspaceId="<guid>"]}[Data],
 *   Df = Ws{[dataflowId="<guid>"]}[Data],
 *   Entity = Df{[entity="Table name",version=""]}[Data]
 *
 * The ids are stable; names aren't in the M, so the dataflow's name has to come
 * from the Power BI service (the upstream file carries it).
 */

const CONNECTOR_RE = /\b(PowerPlatform\.Dataflows|PowerBI\.Dataflows)\s*\(/i;

/**
 * @param {string} mExpression
 * @returns {null | { type: 'Dataflow', connector: string, workspaceId: string|null,
 *   dataflowId: string|null, entity: string|null, server: string|null,
 *   database: string|null, schema: null, sourceTable: string|null }}
 */
export function extractDataflowSource(mExpression) {
  if (!mExpression) return null;
  const expr = mExpression.replace(/\/\*[\s\S]*?\*\//g, '');
  const conn = expr.match(CONNECTOR_RE);
  if (!conn) return null;
  const pick = (re) => (expr.match(re) || [])[1] || null;
  const workspaceId = pick(/workspaceId\s*=\s*"([^"]+)"/i);
  const dataflowId = pick(/dataflowId\s*=\s*"([^"]+)"/i);
  const entity = pick(/\bentity\s*=\s*"((?:[^"]|"")+)"/i)?.replace(/""/g, '"') || null;
  return {
    type: 'Dataflow',
    connector: conn[1],
    workspaceId,
    dataflowId,
    entity,
    // The generic fields the rest of the engine uses for any source.
    server: workspaceId,
    database: dataflowId,
    schema: null,
    sourceTable: entity,
  };
}
