import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { readPlanSteps, statusLabel, statusVariant } from "./reconcileStatus";

// The frames an `intentic deploy plan` stream yields through the typed client, one per line the CLI printed, ended by
// `failure` when the daemon reports its own failure mid-stream (the client throws it as the stream's error).
async function* planStream(frames: readonly IntenticLine[], failure?: Error): AsyncGenerator<IntenticLine> {
    yield* frames;
    if (failure !== undefined) {
        throw failure;
    }
}

describe(`statusLabel`, () => {
    it(`frames the gap on the live board and the intended change in a plan`, () => {
        expect(statusLabel(`update`)).not.toBe(statusLabel(`update`, `plan`));
        expect(statusLabel(`create`)).not.toBe(statusLabel(`delete`));
        expect(statusLabel(`noop`, `plan`)).not.toBe(statusLabel(`update`, `plan`));
        expect(statusLabel(`prune`, `plan`)).toBe(statusLabel(`delete`, `plan`));
    });
});

describe(`statusVariant`, () => {
    it(`maps in-sync to success and removals to danger`, () => {
        expect(statusVariant(`noop`)).toBe(`success`);
        expect(statusVariant(`delete`)).toBe(`danger`);
        expect(statusVariant(`create`)).toBe(`info`);
        expect(statusVariant(`unknown`)).toBe(`neutral`);
    });
});

describe(`readPlanSteps`, () => {
    it(`collects per-resource verdicts, narrates progress, and normalizes the orphan list`, async () => {
        const progress: (string | undefined)[] = [];
        const { steps, orphans } = await readPlanSteps(
            planStream([
                { kind: `node`, phase: `plan`, state: `start`, id: `shop.production` },
                { kind: `node`, phase: `plan`, state: `done`, id: `shop.production`, action: `create` },
                { kind: `node`, phase: `plan`, state: `done`, id: `db.production`, action: `update`, reason: `image changed` },
                { kind: `node`, phase: `plan`, state: `done`, id: `cache.production`, action: `noop` },
                { kind: `log`, message: `orphan scan: komodo` },
                { kind: `result`, orphans: [{ id: `old-svc`, type: `deployment` }, `legacy-route`] },
            ]),
            (update) => progress.push(update.node ?? update.log),
        );
        expect(steps).toEqual([
            { id: `shop.production`, action: `create` },
            { id: `db.production`, action: `update`, reason: `image changed` },
            { id: `cache.production`, action: `noop` },
        ]);
        // A start event narrates but never becomes a step; log lines narrate the orphan scan.
        expect(progress).toEqual([`shop.production`, `orphan scan: komodo`]);
        // Object orphans keep their type; a bare-string id is tolerated (fixes the old string-only filter).
        expect(orphans).toEqual([{ id: `old-svc`, type: `deployment` }, { id: `legacy-route` }]);
    });

    it(`throws on a terminal error frame instead of returning an empty plan`, async () => {
        await expect(readPlanSteps(planStream([{ kind: `error`, message: `SSH unreachable` }]))).rejects.toThrow(`SSH unreachable`);
    });

    // The daemon's own failure after the stream opened arrives as the stream's error; it ends the plan in its words.
    it(`throws the daemon's own words when it fails the stream midway`, async () => {
        const failure = new ORPCError(`INTERNAL_SERVER_ERROR`, { message: `The deploy engine stopped answering.` });
        await expect(readPlanSteps(planStream([{ kind: `log`, message: `reading` }], failure))).rejects.toThrow(
            `The deploy engine stopped answering.`,
        );
    });
});
