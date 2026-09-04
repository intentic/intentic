import { STATE_DIR } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import {
    type BatchRunKind,
    batchConversationId,
    batchItemDir,
    batchReportingClause,
    batchResultPath,
    batchRunDir,
    batchRunIdAt,
    batchRunManifestPath,
    batchRunPrefix,
    batchTurnBody,
    parseBatchFile,
} from "./batch-runs.js";
import { ConversationIdSchema } from "./schemas/agent.js";

// The two real layouts this substrate had to fit without moving anything already on disk: one that fans out
// over items under `records/artifacts`, and one where a run IS the item, under `records/chores`.
const FANNED: BatchRunKind = { runsDir: `records/artifacts/acceptance`, prefix: `xt`, scanRuns: 10 };
const SINGLE: BatchRunKind = { runsDir: `records/chores/runs`, prefix: `mt`, scanRuns: 30 };

describe(`batch run ids`, () => {
    it(`sorts by the moment it was minted`, () => {
        const earlier = batchRunIdAt(Date.parse(`2026-09-04T00:00:00Z`));
        const later = batchRunIdAt(Date.parse(`2026-09-05T00:00:00Z`));
        expect([earlier < later, earlier.startsWith(`r`)]).toEqual([true, true]);
    });

    /* Sorting has to survive a base-36 digit boundary, which is what an unpadded `toString(36)` gets wrong:
     * the smaller number is the shorter string, and the shorter string sorts first only by luck. */
    it(`still sorts when two moments straddle a digit boundary`, () => {
        const boundary = 36 ** 7;
        expect(batchRunIdAt(boundary - 1) < batchRunIdAt(boundary)).toBe(true);
    });

    /* The drift that made this shared. A surface where one run IS one item mints several inside a millisecond
     * ("run this chore in every repository"), and the copy without a counter handed them all the same id. */
    it(`does not repeat inside one millisecond`, () => {
        const minted = new Set(Array.from({ length: 50 }, () => batchRunIdAt(1_700_000_000_000)));
        expect(minted.size).toBe(50);
    });
});

describe(`batch conversation ids`, () => {
    it(`carries the kind's prefix, so a run joins the fleet by filtering GET /agents`, () => {
        const id = batchConversationId(FANNED, `r5k2`, `checkout-flow`);
        expect([id, id.startsWith(batchRunPrefix(FANNED))]).toEqual([`xt-r5k2-checkout-flow`, true]);
    });

    it(`names a single-item run by its run id alone`, () => {
        expect(batchConversationId(SINGLE, `r5k2a`)).toBe(`mt-r5k2a`);
    });

    /* The run id is how a finished card is attributed back to its run, so the ITEM is what gets cut. Measured
     * against the real schema rather than a copy of its regex: the cap exists because that schema enforces it. */
    it(`cuts the item, never the run id, and still satisfies ConversationIdSchema`, () => {
        const runId = batchRunIdAt(1_700_000_000_000);
        const id = batchConversationId(FANNED, runId, `x`.repeat(200));
        expect([id.startsWith(`xt-${runId}-`), ConversationIdSchema.safeParse(id).success]).toEqual([true, true]);
    });

    // A cut that lands on the separator would leave `xt-r5k2-`, which ConversationIdSchema refuses.
    it(`leaves no trailing separator when the cut lands on one`, () => {
        const runId = `r${`z`.repeat(58)}`;
        const id = batchConversationId(FANNED, runId, `story`);
        expect([id.endsWith(`-`), ConversationIdSchema.safeParse(id).success]).toEqual([false, true]);
    });
});

describe(`where a run keeps its files`, () => {
    it(`puts every run under the state dir, in the kind's own directory`, () => {
        expect(batchRunManifestPath(FANNED, `r5k2`)).toBe(`${STATE_DIR}/records/artifacts/acceptance/r5k2/run.json`);
    });

    it(`gives a fanned-out item a directory of its own`, () => {
        expect(batchResultPath(FANNED, `r5k2`, `checkout-flow`)).toBe(`${STATE_DIR}/records/artifacts/acceptance/r5k2/checkout-flow/result.json`);
    });

    // A run whose item is the run writes beside its manifest rather than one pointless level down: the layout
    // maintenance already has on disk.
    it(`writes a single-item run's result beside its manifest`, () => {
        expect([batchResultPath(SINGLE, `r5k2a`), batchItemDir(SINGLE, `r5k2a`)]).toEqual([
            `${STATE_DIR}/records/chores/runs/r5k2a/result.json`,
            batchRunDir(SINGLE, `r5k2a`),
        ]);
    });
});

describe(`reading a file an agent may still be writing`, () => {
    const shape = (value: Record<string, unknown>): { outcome: string } | undefined =>
        typeof value[`outcome`] === `string` ? { outcome: value[`outcome`] } : undefined;

    it(`reads a well-formed file through the caller's shape`, () => {
        expect(parseBatchFile(`{"outcome":"acted"}`, shape)).toEqual({ outcome: `acted` });
    });

    /* All three failures are the same answer — undefined — because one bad directory must not blank a whole
     * history, and a half-written file is ordinary here rather than exceptional. */
    it(`skips a file that is truncated, is not an object, or does not fit the shape`, () => {
        expect([parseBatchFile(`{"outcome":`, shape), parseBatchFile(`"acted"`, shape), parseBatchFile(`{"summary":"x"}`, shape)]).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
    });

    it(`does not read null as an object`, () => {
        expect(parseBatchFile(`null`, shape)).toBeUndefined();
    });
});

describe(`what the agent is told`, () => {
    const clause = batchReportingClause({
        path: batchResultPath(SINGLE, `r5k2a`),
        fields: `{"outcome": "acted" | "clean", "summary": "<one or two sentences>"}`,
        outcomes: `Use "clean" when the findings did not hold up.`,
    });

    it(`names the exact path the surface will read back`, () => {
        expect(clause).toContain(batchResultPath(SINGLE, `r5k2a`));
    });

    /* A turn that concludes there was nothing to do and writes no file is indistinguishable from a turn that
     * died, and the surface has to show the second as an unknown. */
    it(`asks for the file even when there was nothing to do`, () => {
        expect(clause).toContain(`even if you conclude there was nothing to do`);
    });

    it(`leaves the outcome vocabulary out when the kind has none`, () => {
        expect(batchReportingClause({ path: `p`, fields: `f` })).not.toContain(`clean`);
    });
});

describe(`the turn a run starts`, () => {
    it(`is always isolated and unattended, which is what registers the fleet entry`, () => {
        const body = batchTurnBody({ prompt: `do it`, title: `t`, conversationId: `mt-r5k2a` });
        expect([body[`isolated`], body[`unattended`]]).toEqual([true, true]);
    });

    it(`caps the title at what the fleet row can show`, () => {
        expect(String(batchTurnBody({ prompt: `p`, title: `t`.repeat(200), conversationId: `c` })[`title`])).toHaveLength(80);
    });

    it(`carries a pinned model and its tier when the row's caret chose one`, () => {
        const body = batchTurnBody({
            prompt: `p`,
            title: `t`,
            conversationId: `c`,
            pick: { provider: `claude`, model: `opus`, effort: `high` },
        });
        expect([body[`agent`], body[`model`], body[`effort`]]).toEqual([`claude`, `opus`, `high`]);
    });

    /* ABSENT rather than undefined: the body is serialized to JSON and the daemon's fill step reads a missing
     * key as "the owner's agentRunModels decide", which is not what an explicit null would say. */
    it(`omits the keys a pick did not pin, rather than sending them empty`, () => {
        const body = batchTurnBody({ prompt: `p`, title: `t`, conversationId: `c`, pick: { provider: `claude` } });
        expect(Object.keys(body)).not.toContain(`model`);
        expect(Object.keys(body)).not.toContain(`effort`);
    });

    it(`sends no model keys at all when nothing was pinned`, () => {
        const keys = Object.keys(batchTurnBody({ prompt: `p`, title: `t`, conversationId: `c` }));
        expect(keys.some((key) => [`agent`, `model`, `effort`].includes(key))).toBe(false);
    });
});
