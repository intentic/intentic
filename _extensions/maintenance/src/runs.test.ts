import { describe, expect, test } from "vitest";
import { ANY_RUN_PREFIX, conversationIdOf, parseManifest, parseResult, reportingClause, resultPath, runIdAt } from "./runs";

describe(`run identity`, () => {
    // The conversation id is the JOIN to the fleet: `GET /agents` filtered by prefix is how a run finds its
    // agent, so this is a wire contract, not a naming convention.
    test(`a run's conversation id is derived from its run id and carries the fleet prefix`, () => {
        const runId = runIdAt(1_700_000_000_000);
        expect(conversationIdOf(runId).startsWith(ANY_RUN_PREFIX)).toBe(true);
        expect(conversationIdOf(runId)).toContain(runId);
        // The contract's ConversationIdSchema bounds ids at 64 characters: they land in branch names and paths.
        expect(conversationIdOf(runId).length).toBeLessThanOrEqual(64);
    });

    /* "Run this chore in every repository" starts several within the same millisecond. Acceptance can get away
     * without a counter because its runs fan out over slugs that differ; here one run IS one chore, so a
     * collision would put two turns in one conversation and lose one of them. */
    test(`two runs minted in the same millisecond do not collide`, () => {
        expect(runIdAt(1_700_000_000_000)).not.toBe(runIdAt(1_700_000_000_000));
    });

    test(`run ids sort newest-last lexically, which is what lets the history read directory names instead of files`, () => {
        expect(runIdAt(1_700_000_000_000) < runIdAt(1_800_000_000_000)).toBe(true);
    });
});

describe(`reading what is on disk`, () => {
    const manifest = { runId: `r1`, createdAt: 5, repo: `app`, chore: `dead-code`, digest: `abc`, conversationId: `mt-r1`, headline: `3 files` };

    test(`a manifest round-trips`, () => {
        expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    });

    // One bad directory must not blank the whole history: a manifest half-written, or written by a build whose
    // shape has since changed, is skipped rather than thrown on.
    test(`a manifest missing its identity is skipped, and a partial one defaults`, () => {
        expect(parseManifest(`{"createdAt":5}`)).toBeUndefined();
        expect(parseManifest(`not json`)).toBeUndefined();
        expect(parseManifest(`{"runId":"r1","repo":"app","chore":"dead-code"}`)).toMatchObject({ createdAt: 0, digest: ``, conversationId: `mt-r1` });
    });

    test(`a result carries the outcome and the agent's own summary`, () => {
        expect(parseResult(`{"outcome":"clean","summary":"knip was wrong about the entry points"}`)).toEqual({
            outcome: `clean`,
            summary: `knip was wrong about the entry points`,
        });
    });

    /* A result the agent never wrote reads as undefined rather than as an outcome: the panel shows the fleet's
     * live status for those instead of inventing one. An outcome outside the three we know is treated the same
     * way: guessing which of ours the agent meant would be putting words in its mouth. */
    test(`an absent, malformed or improvised outcome is no result at all`, () => {
        expect(parseResult(``)).toBeUndefined();
        expect(parseResult(`{"summary":"did some things"}`)).toBeUndefined();
        expect(parseResult(`{"outcome":"partially-done"}`)).toBeUndefined();
    });

    test(`a result with no summary is still a result`, () => {
        expect(parseResult(`{"outcome":"acted"}`)).toEqual({ outcome: `acted`, summary: `` });
    });
});

describe(`what we ask the agent to write back`, () => {
    const clause = reportingClause(`r1`);

    test(`names the exact path, so the file lands where the panel reads it`, () => {
        expect(clause).toContain(resultPath(`r1`));
        expect(resultPath(`r1`).startsWith(`.intentic/records/chores/runs/`)).toBe(true);
    });

    /* `clean` is the outcome that makes the ledger a debounce rather than a nag, and a model that reads it as an
     * admission of having done nothing useful will avoid it and report `reported` instead: after which the chore
     * never goes quiet. Saying it is a good outcome is load-bearing, not politeness. */
    test(`spells out all three outcomes and says that "clean" is a good one`, () => {
        for (const outcome of [`acted`, `reported`, `clean`]) {
            expect(clause).toContain(outcome);
        }
        expect(clause).toContain(`"clean" is a good outcome`);
        expect(clause).toContain(`even if you conclude there was nothing to do`);
    });
});
