import { flattenQuery, mergeQuery } from "@intentic/extension-api";
import { describe, expect, it } from "vitest";

/* The rules behind `api.route`. Tested from here for the same reason permissions.test.ts is: the rule is a pure
 * function in @intentic/extension-api and the host that owns the router is this app.
 *
 * Why the rule exists at all: a view's internal navigation has to live in the query, because `/ext/:ext/:key?` has
 * exactly one free path segment and it already means "which activation". So more than one thing can be writing to
 * the same query string, and the invariant below (patching your own key never touches anyone else's) is what
 * makes that safe. */

describe(`flattenQuery`, () => {
    it(`reads scalars straight through`, () => {
        expect(flattenQuery({ doc: `_deploy/graph`, repo: `intentic` })).toEqual({ doc: `_deploy/graph`, repo: `intentic` });
    });

    it(`takes a repeated key's FIRST value, since a view's state is singular`, () => {
        // A hand-written or shared link means the first one; taking the last would silently prefer whatever a
        // later append added.
        expect(flattenQuery({ doc: [`_deploy/graph`, `_editor/web`] })).toEqual({ doc: `_deploy/graph` });
    });

    it(`reads a valueless key as empty rather than dropping it`, () => {
        // `?draft` is present-but-empty, which is a different answer from absent: the caller can tell them apart.
        expect(flattenQuery({ draft: null })).toEqual({ draft: `` });
        expect(flattenQuery({ draft: [null] })).toEqual({ draft: `` });
    });
});

describe(`mergeQuery`, () => {
    it(`leaves every key the patch does not mention alone`, () => {
        // THE invariant: the documentation view setting `doc` must not drop another surface's parameters.
        expect(mergeQuery({ doc: `a`, tab: `terminal`, other: `keep` }, { doc: `b` })).toEqual({ doc: `b`, tab: `terminal`, other: `keep` });
    });

    it(`removes a key set to undefined instead of writing an empty one`, () => {
        // So returning to the overview yields `/ext/documentation`, not `/ext/documentation?doc=`.
        expect(mergeQuery({ doc: `a`, repo: `intentic` }, { doc: undefined })).toEqual({ repo: `intentic` });
    });

    it(`adds a key that was not there`, () => {
        expect(mergeQuery({}, { doc: `_deploy/graph` })).toEqual({ doc: `_deploy/graph` });
    });

    it(`applies several keys at once, mixing sets and removals`, () => {
        // Choosing another repository is exactly this: set `repo`, clear `doc`, because a document path only means
        // something inside its own repository.
        expect(mergeQuery({ repo: `a`, doc: `x`, keep: `1` }, { repo: `b`, doc: undefined })).toEqual({ repo: `b`, keep: `1` });
    });

    it(`does not mutate the query it was given`, () => {
        const current = { doc: `a` };
        mergeQuery(current, { doc: `b`, extra: `c` });
        expect(current).toEqual({ doc: `a` });
    });

    it(`flattens as it merges, so a repeated key does not survive as an array`, () => {
        expect(mergeQuery({ doc: [`a`, `b`], keep: [`x`] }, {})).toEqual({ doc: `a`, keep: `x` });
    });
});
