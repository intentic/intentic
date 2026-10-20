import { recordingLogger } from "../../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../../harness/route-services.testing.js";
import { answeringFetch } from "../../../http/fetch.testing.js";
import { readSettledUsage } from "./settled-usage.js";

type SettledTurn = Parameters<typeof readSettledUsage>[1];

const recorded = () => {
    const stores = recordingTurnStores();
    const { lines, logger } = recordingLogger();
    return { deps: services({ ...stores.overrides, logger }), writes: stores.writes, lines };
};

// Fakes the OAuth usage endpoint with a real Response, so the reader takes the body however it reads it.
const usageEndpoint = (body: unknown, ok = true): typeof fetch => answeringFetch(() => new Response(JSON.stringify(body), { status: ok ? 200 : 401 }));

const failing = (message: string): typeof fetch =>
    answeringFetch(() => {
        throw new Error(message);
    });

const oauth: SettledTurn["request"] = { credential: { kind: "claude-oauth", token: "oat-1" }, policy: {} };
const settled: SettledTurn = { provider: "claude", account: "acct", request: oauth, aborted: false };

describe("a settled turn's allowance re-read", () => {
    test("files EVERY plan-limit pool under the turn's account, not just whichever one was binding", async () => {
        const { deps, writes } = recorded();
        await readSettledUsage(
            deps,
            settled,
            usageEndpoint({
                five_hour: { utilization: 12.4, resets_at: "2026-07-27T18:00:00.000Z" },
                seven_day: { utilization: 98, resets_at: "2026-07-29T09:00:00.000Z" },
                // A pool the plan has but the provider has no reading for: dropped, not shown at 0%.
                seven_day_opus: { utilization: null, resets_at: null },
            }),
        );
        expect(writes.headroomRecords).toStrictEqual([
            {
                provider: "claude",
                account: "acct",
                usage: {
                    windows: [
                        { kind: "five_hour", utilization: 12.4, resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000, gates: "all", rounded: true },
                        { kind: "seven_day", utilization: 98, resetsAt: Date.parse("2026-07-29T09:00:00.000Z") / 1000, gates: "all", rounded: true },
                    ],
                    measuredAt: expect.any(Number),
                },
            },
        ]);
    });

    test("files nothing when the endpoint refuses, since an empty list would read as 'no limits'", async () => {
        const { deps, writes } = recorded();
        await readSettledUsage(deps, settled, usageEndpoint({}, false));
        expect(writes.headroomRecords).toStrictEqual([]);
    });

    test("a failed read is a warning, never a rejection", async () => {
        const { deps, writes } = recorded();
        await readSettledUsage(deps, settled, failing("usage endpoint timed out"));
        expect(writes.headroomRecords).toStrictEqual([]);
    });

    const unasked: [string, SettledTurn][] = [
        ["a container-env turn, which has no account pools", { ...settled, request: { credential: { kind: "container" }, policy: {} } }],
        ["a sealed request, which is not a turn", { ...settled, request: { ...oauth, policy: { sealed: true } } }],
        ["a stopped turn, which the provider never settled", { ...settled, aborted: true }],
        ["a turn with no account to file under", { ...settled, account: undefined }],
    ];
    test.each(unasked)("never asks the endpoint for %s", (_case, turn) => {
        const { deps } = recorded();
        expect(readSettledUsage(deps, turn, failing("the usage endpoint was asked"))).toBeUndefined();
    });
});
