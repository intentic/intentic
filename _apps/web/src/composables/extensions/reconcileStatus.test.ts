import { describe, expect, it } from "vitest";
import { readPlanSteps, statusLabel, statusVariant } from "./reconcileStatus";

// Build the SSE body the daemon emits for an `intentic plan` stream: one `data: <json>\n\n` frame per line.
const sseStream = (frames: Record<string, unknown>[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const frame of frames) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            }
            controller.close();
        },
    });
};

describe(`statusLabel`, () => {
    it(`frames the gap on the live board and the intended change in a plan`, () => {
        expect(statusLabel(`update`)).toBe(`Drift`);
        expect(statusLabel(`update`, `plan`)).toBe(`Update`);
        expect(statusLabel(`create`)).toBe(`To create`);
        expect(statusLabel(`create`, `plan`)).toBe(`Create`);
        expect(statusLabel(`delete`)).toBe(`To remove`);
        expect(statusLabel(`prune`, `plan`)).toBe(`Remove`);
        expect(statusLabel(`noop`, `plan`)).toBe(`No change`);
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
            sseStream([
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
        await expect(readPlanSteps(sseStream([{ kind: `error`, message: `SSH unreachable` }]))).rejects.toThrow(`SSH unreachable`);
    });
});
