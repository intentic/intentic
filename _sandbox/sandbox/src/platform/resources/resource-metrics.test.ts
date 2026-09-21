import { describe, expect, test } from "vitest";
import {
    classifyProcess,
    longHeldPools,
    parseProcStatus,
    type ProcessRow,
    programOf,
    type ResourceSnapshot,
    topProcesses,
} from "./resource-metrics.js";

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
        // Serving the protocol it is a language server; the same binary run once over a project is a typecheck.
        ["/opt/node_modules/@typescript/native-preview-linux-x64/lib/tsgo --lsp --stdio", "languageServer"],
        ["/opt/node_modules/@typescript/native-preview-linux-x64/lib/tsgo --noEmit -p tsconfig.json", "toolchain"],
        // The fan-out, as its members read from /proc: pnpm's `+`/`@` path encoding, a vitest fork, a heap-sized vue-tsc.
        [
            "MainThread /usr/local/bin/node /work/intentic/node_modules/.pnpm/vitest@4.0.9_@types+node@24.1.0/node_modules/vitest/dist/workers/forks.js",
            "toolchain",
        ],
        ["MainThread node --max-old-space-size=4096 ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.app.json", "toolchain"],
        ["turbo turbo run typecheck test --only --continue=dependencies-successful", "toolchain"],
        ["MainThread /usr/local/bin/node /usr/local/share/pnpm/pnpm.cjs verify:turn", "toolchain"],
        ["MainThread node /work/intentic/_site/demo/node_modules/vite/bin/vite.js", "toolchain"],
        ["llama-server llama-server -m /work/.intentic/local/cache/models/Qwen3.5-2B-Q4_K_M.gguf --host 127.0.0.1", "localModel"],
        ["dockerd dockerd", "container"],
        ["containerd-shim /usr/bin/containerd-shim-runc-v2 -namespace moby", "container"],
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

    test("a nested container's process is the container's whatever it runs, by the cgroup it sits in", () => {
        const nested = "0::/docker/bbf2a98871409a5a18ce9cf5f8bd958cec0d0a76164292f04bea9b6341a238d1";
        expect(classifyProcess("nginx nginx: worker process", nested)).toBe("container");
        expect(classifyProcess("postgres postgres: checkpointer", nested)).toBe("container");
        // The sandbox's own processes sit at the root of their namespace and keep their own roles.
        expect(classifyProcess("nginx nginx: worker process", "0::/")).toBe("other");
        expect(classifyProcess("MainThread node /opt/vitest/dist/workers/forks.js", "0::/")).toBe("toolchain");
    });

    test.each([
        ["MainThread node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit", "vue-tsc"],
        ["MainThread node /x/.pnpm/vitest@4.0.9/node_modules/vitest/dist/workers/forks.js", "vitest"],
        ["MainThread node /work/intentic/_site/demo/node_modules/vite/bin/vite.js", "vite"],
        [
            "claude /history/engines/claude/versions/0.3.278/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json",
            "claude",
        ],
        ["chrome /opt/google/chrome/google-chrome --headless", "chrome"],
        ["containerd-shim /usr/bin/containerd-shim-runc-v2", "containerd"],
        ["MainThread /usr/local/bin/node /opt/sandbox/dist/main.js", "node"],
        // `node_modules` is not the program node: `_` closes nothing.
        ["docservice /var/www/onlyoffice/documentserver/server/DocService/docservice", undefined],
    ] as const)("labels %s as %s", (command, program) => {
        expect(programOf(command)).toBe(program);
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
