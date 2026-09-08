// Pure functions behind `api.route`'s URL-query rules; the host owns the router, this owns the rule. Navigation lives
// in the query since `/ext/:ext/:key?` has only one free segment (the activation); no view may clobber another's key.

// What the router hands back for a query: vue-router yields `string | null` per key, or an array when a key repeats.
export type RawQuery = Readonly<Record<string, string | readonly (string | null)[] | null | undefined>>;

// Flattens a router query to a scalar record. A repeated key keeps its first value (what a hand-written or shared link
// means); a valueless key (`?draft`) becomes `""`, never `undefined`.
export const flattenQuery = (query: RawQuery): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
            const first = value[0];
            out[key] = typeof first === `string` ? first : ``;
        } else {
            out[key] = typeof value === `string` ? value : ``;
        }
    }
    return out;
};

// Merges a patch into the live query; `undefined` removes that key rather than leaving `?doc=` behind. Every key the
// patch doesn't mention passes through untouched.
export const mergeQuery = (current: RawQuery, patch: Readonly<Record<string, string | undefined>>): Record<string, string> => {
    const next = flattenQuery(current);
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
            delete next[key];
        } else {
            next[key] = value;
        }
    }
    return next;
};
