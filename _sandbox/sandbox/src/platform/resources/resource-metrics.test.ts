import { describe, expect, test } from "vitest";
import { classifyProcess, longHeldPools, parseProcStatus, type ResourceSnapshot } from "./resource-metrics.js";

describe("resource metric process attribution", () => {
    test("parses the memory and ownership fields from proc status", () => {
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
            name: "node",
            ppid: 41,
            rssBytes: 1_572_864,
            rssHighWaterBytes: 2_097_152,
            rssAnonymousBytes: 1_048_576,
            rssFileBytes: 393_216,
            rssSharedBytes: 131_072,
            swapBytes: 262_144,
            threads: 7,
        });
    });

    test.each([
        ["node /opt/typescript-language-server --stdio", "languageServer"],
        ["node /opt/node_modules/@intentic/lsp/dist/cli.js diag /work/src/a.ts", "languageServer"],
        ["/opt/node_modules/@typescript/native-preview-linux-x64/lib/tsgo --noEmit -p tsconfig.json", "languageServer"],
        ["node /opt/@playwright/mcp/cli.js", "browser"],
        ["/usr/bin/chromium --headless", "browser"],
        ["/usr/local/bin/codex app-server", "agentRuntime"],
        ["git-fork-broker --socket /run/git.sock", "git"],
        ["cli-proxy-api --port 8317", "translator"],
        ["node extension-backend-host.js", "extension"],
        ["tmux: server", "terminal"],
        // The real line, which fell into `other` and hid 1.64 GB of growth: pnpm encodes the path with `+`, so
        // nothing in it reads as a directory called iq-engine.
        [
            "MainThread /usr/local/bin/node /opt/sandbox/node_modules/.pnpm/@intentic+iq-engine@file++++work+_search+iq-engine/node_modules/@intentic/iq-engine/dist/host/child.js",
            "searchEngine",
        ],
        ["node /opt/sandbox/node_modules/@intentic/iq-engine/dist/host/child.js", "searchEngine"],
        ["node dist/main.js", "other"],
    ] as const)("classifies %s as %s", (command, role) => {
        expect(classifyProcess(command)).toBe(role);
    });
});

describe("queue slot alarm", () => {
    const snapshot = (queue: Record<string, unknown>): ResourceSnapshot => ({
        schema: 1,
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
        const busy = snapshot({ heavy: { slots: 2, held: 2, longestHoldSeconds: 120 } });
        const stuck = snapshot({ heavy: { slots: 2, held: 1, longestHoldSeconds: 1_800 } });
        // A pool at its limit with commands that are getting on with it is not an alarm.
        expect(longHeldPools(busy, 900)).toEqual([]);
        expect(longHeldPools(stuck, 900)).toEqual([{ pool: "heavy", heldSeconds: 1_800 }]);
    });

    test("pools are judged one at a time, and a pool with nothing held never reports", () => {
        const mixed = snapshot({
            heavy: { slots: 2, held: 1, longestHoldSeconds: 2_400 },
            quiet: { slots: 1, held: 0, longestHoldSeconds: 0 },
        });
        expect(longHeldPools(mixed, 900)).toEqual([{ pool: "heavy", heldSeconds: 2_400 }]);
    });

    test("a sample from a daemon that never measured the queue is not an alarm", () => {
        expect(longHeldPools(snapshot({}), 900)).toEqual([]);
        // A pool whose summary lost its field is unknown, not zero and not stuck.
        expect(longHeldPools(snapshot({ heavy: { slots: 2, held: 1 } }), 900)).toEqual([]);
    });
});
