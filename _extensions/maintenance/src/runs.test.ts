import { describe, expect, test } from "vitest";
import { ANY_RUN_PREFIX, conversationIdOf, parseManifest, parseResult, reportingClause, resultPath, runIdAt, summarySpans } from "./runs";

describe(`run identity`, () => {
    test(`a run's conversation id is derived from its run id and carries the fleet prefix`, () => {
        const runId = runIdAt(1_700_000_000_000);
        expect(conversationIdOf(runId).startsWith(ANY_RUN_PREFIX)).toBe(true);
        expect(conversationIdOf(runId)).toContain(runId);
        // Bounded at 64 chars: ids land in branch names and paths.
        expect(conversationIdOf(runId).length).toBeLessThanOrEqual(64);
    });

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

    test(`an absent, malformed or improvised outcome is no result at all`, () => {
        expect(parseResult(``)).toBeUndefined();
        expect(parseResult(`{"summary":"did some things"}`)).toBeUndefined();
        expect(parseResult(`{"outcome":"partially-done"}`)).toBeUndefined();
    });

    test(`a result with no summary is still a result`, () => {
        expect(parseResult(`{"outcome":"acted"}`)).toEqual({ outcome: `acted`, summary: `` });
    });
});

// Pins how backticked literals in an agent's prose summary are split into spans.
describe(`reading the agent's summary`, () => {
    test(`backticked literals come back as their own spans, and the prose between them as plain`, () => {
        expect(summarySpans("Added a `mysql2` override to `pnpm-workspace.yaml`.")).toEqual([
            { text: `Added a `, code: false },
            { text: `mysql2`, code: true },
            { text: ` override to `, code: false },
            { text: `pnpm-workspace.yaml`, code: true },
            { text: `.`, code: false },
        ]);
    });

    test(`an unbalanced mark leaves the sentence exactly as it was written`, () => {
        expect(summarySpans("The lockfile bump needs `pnpm install to land")).toEqual([
            { text: "The lockfile bump needs `pnpm install to land", code: false },
        ]);
    });

    test(`a summary with no marks at all is one plain span, and an empty one is not a chip`, () => {
        expect(summarySpans(`Deleted two unreferenced components.`)).toEqual([{ text: `Deleted two unreferenced components.`, code: false }]);
        expect(summarySpans(``)).toEqual([{ text: ``, code: false }]);
    });
});

describe(`what we ask the agent to write back`, () => {
    const clause = reportingClause(`r1`);

    test(`names the exact path, so the file lands where the panel reads it`, () => {
        expect(clause).toContain(resultPath(`r1`));
        expect(resultPath(`r1`).startsWith(`.intentic/records/chores/runs/`)).toBe(true);
    });

    // Load-bearing, not politeness: a model that reads 'clean' as failure will report 'reported' instead, and the chore
    // never goes quiet.
    test(`spells out all three outcomes and says that "clean" is a good one`, () => {
        for (const outcome of [`acted`, `reported`, `clean`]) {
            expect(clause).toContain(outcome);
        }
        expect(clause).toContain(`clean`);
        expect(clause).toContain(resultPath(`r1`));
    });
});
