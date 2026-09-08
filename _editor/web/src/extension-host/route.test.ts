import { flattenQuery, mergeQuery } from "@intentic/extension-api";
import { describe, expect, it } from "vitest";

// Tests the rules behind api.route, a pure function in @intentic/extension-api exercised here where the router lives.
// A view's navigation lives in the query string, since /ext/:ext/:key? has only one free path segment (the activation);
// patching your own key must never touch anyone else's.

describe(`flattenQuery`, () => {
    it(`reads scalars straight through`, () => {
        expect(flattenQuery({ doc: `_deploy/graph`, repo: `intentic` })).toEqual({ doc: `_deploy/graph`, repo: `intentic` });
    });

    it(`takes a repeated key's FIRST value, since a view's state is singular`, () => {
        // A shared link's first value should win; taking the last would prefer whatever a later append added.
        expect(flattenQuery({ doc: [`_deploy/graph`, `_editor/web`] })).toEqual({ doc: `_deploy/graph` });
    });

    it(`reads a valueless key as empty rather than dropping it`, () => {
        // ?draft is present-but-empty, a different answer from absent; the caller can tell them apart.
        expect(flattenQuery({ draft: null })).toEqual({ draft: `` });
        expect(flattenQuery({ draft: [null] })).toEqual({ draft: `` });
    });
});

describe(`mergeQuery`, () => {
    it(`leaves every key the patch does not mention alone`, () => {
        // Setting doc in the documentation view must not drop another surface's parameters.
        expect(mergeQuery({ doc: `a`, tab: `terminal`, other: `keep` }, { doc: `b` })).toEqual({ doc: `b`, tab: `terminal`, other: `keep` });
    });

    it(`removes a key set to undefined instead of writing an empty one`, () => {
        // Returning to the overview yields /ext/documentation, not /ext/documentation?doc=.
        expect(mergeQuery({ doc: `a`, repo: `intentic` }, { doc: undefined })).toEqual({ repo: `intentic` });
    });

    it(`adds a key that was not there`, () => {
        expect(mergeQuery({}, { doc: `_deploy/graph` })).toEqual({ doc: `_deploy/graph` });
    });

    it(`applies several keys at once, mixing sets and removals`, () => {
        // Changing repository sets repo and clears doc; a document path is only meaningful within its own repository.
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
