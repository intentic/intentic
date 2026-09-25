import { WORKSPACE_ROOT } from "@intentic/constants";
import { longHeldPools, parseProcStatus, type ProcessRow, type ResourceSnapshot, topProcesses } from "./resource-metrics.js";

describe("resource metric process attribution", () => {
    test("parses the memory fields from proc status", () => {
        expect(
            parseProcStatus(`Name:\tnode
PPid:\t41
VmHWM:\t2048 kB
VmRSS:\t1536 kB
RssAnon:\t1024 kB
RssFile:\t384 kB
RssShmem:\t128 kB
VmSwap:\t256 kB
Threads:\t7
`),
        ).toEqual({
            rssBytes: 1_572_864,
            rssHighWaterBytes: 2_097_152,
            rssAnonymousBytes: 1_048_576,
            rssFileBytes: 393_216,
            rssSharedBytes: 131_072,
            swapBytes: 262_144,
            threads: 7,
        });
    });

    test("the top rows are the heaviest by resident plus swapped, and carry no argv", () => {
        const row = (pid: number, rssBytes: number, swapBytes: number, program: string | undefined): ProcessRow => ({
            pid,
            ppid: 1,
            name: "MainThread",
            program,
            role: program === undefined ? "other" : "toolchain",
            rssBytes,
            swapBytes,
            threads: 3,
            cpuTicks: 0,
        });
        const rows = [row(1, 100, 0, "vitest"), row(2, 50, 400, undefined), row(3, 300, 0, "vite"), row(4, 10, 10, "tsc")];
        expect(topProcesses(rows, 2)).toEqual([
            { pid: 2, name: "MainThread", program: undefined, role: "other", rssBytes: 50, swapBytes: 400, threads: 3 },
            { pid: 3, name: "MainThread", program: "vite", role: "toolchain", rssBytes: 300, swapBytes: 0, threads: 3 },
        ]);
        expect(topProcesses(rows).map((top) => top.pid)).toEqual([2, 3, 1, 4]);
    });
});

describe("queue slot alarm", () => {
    const snapshot = (queue: Record<string, unknown>): ResourceSnapshot => ({
        schema: 2,
        at: "2026-09-21T19:00:00.000Z",
        uptimeSeconds: 3_600,
        window: {},
        daemon: {},
        system: {},
        processes: {},
        queue,
        owners: {},
    });

    test("a pool is reported only once its oldest holder passes the threshold", () => {
        const holder = { pid: 7, command: "npx vue-tsc --noEmit", cwd: `${WORKSPACE_ROOT}/intentic` };
        const busy = snapshot({ heavy: { slots: 2, held: 2, longestHoldSeconds: 120, longestHolder: holder } });
        const stuck = snapshot({ heavy: { slots: 2, held: 1, longestHoldSeconds: 1_800, longestHolder: holder } });
        // A pool at its limit with commands that are getting on with it is not an alarm.
        expect(longHeldPools(busy)).toEqual([]);
        // The alarm names what is stuck, so a thirty-minute hold is attributable from the log line alone.
        expect(longHeldPools(stuck)).toStrictEqual([{ pool: "heavy", heldSeconds: 1_800, holder }]);
    });

    test("pools are judged one at a time, and a pool with nothing held never reports", () => {
        const mixed = snapshot({
            heavy: { slots: 2, held: 1, longestHoldSeconds: 2_400 },
            quiet: { slots: 1, held: 0, longestHoldSeconds: 0 },
        });
        expect(longHeldPools(mixed)).toStrictEqual([{ pool: "heavy", heldSeconds: 2_400, holder: undefined }]);
    });

    // The shipped rule's half hour is not every rule's: a hold is judged against what its own rule allows it.
    test("a holder is reported at half of its own rule's max-hold, and never when its rule lets it hold forever", () => {
        const holding = (seconds: number, maxHoldSeconds: number) =>
            snapshot({ tests: { slots: 4, held: 1, longestHoldSeconds: seconds, longestHolder: { pid: 9, command: "bun test", cwd: "/", maxHoldSeconds } } });
        expect(longHeldPools(holding(299, 600))).toEqual([]);
        expect(longHeldPools(holding(300, 600)).map((held) => held.heldSeconds)).toEqual([300]);
        expect(longHeldPools(holding(3_599, 7_200))).toEqual([]);
        expect(longHeldPools(holding(86_400, 0))).toEqual([]);
    });

    test("a sample from a daemon that never measured the queue is not an alarm", () => {
        expect(longHeldPools(snapshot({}))).toEqual([]);
        // A pool whose summary lost its field is unknown, not zero and not stuck.
        expect(longHeldPools(snapshot({ heavy: { slots: 2, held: 1 } }))).toEqual([]);
    });
});
