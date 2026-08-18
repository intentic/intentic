import { describe, expect, it } from "vitest";
import { acknowledgement, findingKey, unseenFindings, type AcceptanceFinding } from "./attention";

const failed: AcceptanceFinding = { runId: `rabc`, slug: `login`, verdict: `fail` };

/* What the tile counts, as a pure function over "the findings" and "what has been acknowledged".
 *
 * The ledger's own reading and writing is the host's now (extension-api background.ts, and tested there) — what
 * is left here is the judgement this extension owns: which of the findings in front of it are NEWS. */

describe(`acceptance attention`, () => {
    it(`acknowledges completed findings rather than a run's start time`, () => {
        // Opening the view while the run is still live sees no completed result and therefore acknowledges none.
        const seenWhileRunning = acknowledgement([]);
        expect(unseenFindings([], seenWhileRunning)).toEqual([]);

        // The same run fails after the view has closed. Its completed finding was never acknowledged, so it is
        // news even though the run itself existed before the view was opened.
        expect(unseenFindings([failed], seenWhileRunning)).toEqual([failed]);
    });

    it(`keeps acknowledged findings quiet and treats a changed verdict as new information`, () => {
        const seen = acknowledgement([failed]);
        expect(unseenFindings([failed], seen)).toEqual([]);
        // The VERDICT is the mark, so a result corrected from fail to blocked is a fresh claim on attention
        // rather than something inheriting the acknowledgement of what it used to say.
        expect(unseenFindings([{ ...failed, verdict: `blocked` }], seen)).toEqual([{ ...failed, verdict: `blocked` }]);
    });

    it(`keys a story within its run, so the same story in a later run is news again`, () => {
        const seen = acknowledgement([failed]);
        const rerun: AcceptanceFinding = { ...failed, runId: `rdef` };
        expect(findingKey(rerun)).not.toBe(findingKey(failed));
        expect(unseenFindings([rerun], seen)).toEqual([rerun]);
    });

    it(`never lets an empty ledger hide a failure — the safe direction for bookkeeping that could not be read`, () => {
        expect(unseenFindings([failed], {})).toEqual([failed]);
    });
});
