/**
 * Payload — the data embedded in report.html.
 *
 * Holds the computed comparison pairs rather than raw files: the views only
 * need records and semantic-model snapshots, and report files are the bulk
 * of a PBIP repo. Each model snapshot is stored once and pairs point at it
 * by index, since a commit's "after" is usually the next pair's "before".
 * Maps and Sets are tagged so they survive JSON.
 */

export const PAYLOAD_VERSION = 1;

export function buildPayload(history, meta) {
  const modelSets = [];
  const indexOf = new Map();
  const ref = (models) => {
    if (!models) return null;
    if (!indexOf.has(models)) {
      indexOf.set(models, modelSets.length);
      modelSets.push(models);
    }
    return indexOf.get(models);
  };
  const pairs = history.pairs.map(p => ({
    ...p,
    models: p.models ? { before: ref(p.models.before), after: ref(p.models.after) } : null,
  }));
  return {
    payloadVersion: PAYLOAD_VERSION,
    ...meta,
    base: history.base,
    head: history.head,
    branchCommitCount: history.branchCommitCount,
    baseAheadBy: history.baseAheadBy,
    warnings: history.warnings,
    modelSets,
    pairs,
  };
}

/** Undo buildPayload's model indexing, giving pairs the shape the views expect. */
export function expandPayload(payload) {
  const sets = payload.modelSets;
  return {
    ...payload,
    pairs: payload.pairs.map(p => ({
      ...p,
      models: p.models ? { before: sets[p.models.before], after: sets[p.models.after] } : null,
    })),
  };
}

export function stringify(value, space) {
  return JSON.stringify(value, (key, v) => {
    if (v instanceof Map) return { __map: [...v] };
    if (v instanceof Set) return { __set: [...v] };
    return v;
  }, space);
}

export function parse(text) {
  return JSON.parse(text, (key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('__map' in v) return new Map(v.__map);
      if ('__set' in v) return new Set(v.__set);
    }
    return v;
  });
}
