import { describe, expect, it } from "vitest";
import { findingKey, seenResultKeys, unseenFindings, type AcceptanceFinding } from "./attention";

const failed: AcceptanceFinding = { runId: `rabc`, slug: `login`, verdict: `fail` };

describe(`acceptance attention`, () => {
    it(`acknowledges completed findings rather than a run's start time`, () => {
        // Opening the view while the run is still live sees no completed result and therefore acknowledges none.
        const seenWhileRunning = new Set<string>();
        expect(unseenFindings([], seenWhileRunning)).toEqual([]);

        // The same run fails after the view has closed. Its completed finding was never acknowledged, so it is
        // news even though the run itself existed before the view was opened.
        expect(unseenFindings([failed], seenWhileRunning)).toEqual([failed]);
    });

    it(`keeps acknowledged findings quiet and treats a changed verdict as new information`, () => {
        const seen = new Set([findingKey(failed)]);
        expect(unseenFindings([failed], seen)).toEqual([]);
        expect(unseenFindings([{ ...failed, verdict: `blocked` }], seen)).toEqual([{ ...failed, verdict: `blocked` }]);
    });

    it(`never lets malformed bookkeeping hide a failure`, () => {
        expect(seenResultKeys(`{"results":[7]}`)).toEqual(new Set());
        expect(seenResultKeys(`not json`)).toEqual(new Set());
        expect(seenResultKeys(JSON.stringify({ results: [findingKey(failed)] }))).toEqual(new Set([findingKey(failed)]));
    });
});
