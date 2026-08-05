/* The URL-query rules behind `api.route`, as pure functions — the same split `permissions.ts` uses: the host owns
 * the router, this owns the rule, and the rule is testable without one.
 *
 * A view's internal navigation lives in the QUERY because the path is already spoken for: `/ext/:ext/:key?` has
 * exactly one free segment and it means "which activation". So several views can be addressing the same query
 * string at once, and the one rule that matters is that none of them may clobber another's key. */

// What the router hands back for a query: vue-router yields `string | null` per key, or an array when a key repeats.
export type RawQuery = Readonly<Record<string, string | readonly (string | null)[] | null | undefined>>;

/* Flatten a router query to the scalar record extensions read. A repeated key takes its FIRST value rather than
 * its last: a view's state is singular, and the first occurrence is the one a hand-written or shared link means.
 * A valueless key (`?draft`) reads as the empty string, which is falsy-ish for the caller to test but never
 * `undefined` — absent and present-but-empty are different answers. */
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

/* Merge a patch into the live query. `undefined` REMOVES its key — that is how a view says "I am no longer on a
 * page" without leaving `?doc=` behind, so the tidy URL is the one you get by default rather than one you have to
 * construct. Every key the patch does not mention is carried through untouched, which is the whole invariant:
 * a documentation view setting `doc` must not drop the terminal's or another view's parameters. */
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
