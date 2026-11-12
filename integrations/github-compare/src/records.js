/**
 * Records — one flat row per change, for records.json and DataFrames.
 * The overall comparison's rows have pair "Overall"; branch commits use their short hash.
 */

export function flatRecords(pairs) {
  const rows = [];
  for (const p of pairs) {
    for (const r of p.records) {
      rows.push({
        pair: p.commit.hash === 'Overall' ? 'Overall' : p.commit.hash.slice(0, 7),
        pair_message: p.commit.message,
        id: r.id,
        section: r.section,
        change: r.change,
        group: r.group,
        name: r.name,
        model: r.location?.model ?? null,
        table: r.location?.table ?? null,
        report: r.location?.report ?? null,
        page: r.location?.page ?? null,
        visual: r.location?.visual ?? null,
        security: !!r.flags?.security,
        broken: !!r.flags?.broken,
        copy: !!r.flags?.copy,
        props: (r.props || []).map(x => ({ label: x.label, before: x.before, after: x.after })),
        impact_breaks: r.impact?.breaks ?? null,
      });
    }
  }
  return rows;
}
