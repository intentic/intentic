import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageTurn } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createDiagnosticsServer, type DiagnosticsToolDeps } from "./diagnostics-tools.js";

// Tools as the model meets them: called by name, answered in text. Pins the wording, not just the filtering: the answer
// must be readable without a second call.

const NOW = Date.UTC(2026, 7, 22, 12, 30, 0);
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const turn = (over: Partial<UsageTurn>): UsageTurn => ({
    at: NOW - 60_000,
    day: "2026-08-22",
    provider: "claude",
    harness: "native",
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.1,
    durationMs: 100,
    ...over,
});

const setup = async (files: Record<string, readonly string[]>, turns: readonly UsageTurn[] = []): Promise<DiagnosticsToolDeps> => {
    const historyRoot = mkdtempSync(join(tmpdir(), "diag-tools-"));
    await mkdir(join(historyRoot, "logs"), { recursive: true });
    for (const [name, lines] of Object.entries(files)) {
        await writeFile(join(historyRoot, "logs", name), `${lines.join("\n")}\n`);
    }
    return { historyRoot, usage: { turns: async () => [...turns] }, now: () => NOW };
};

// Calls a tool through the SDK server's own registry, not a hand-rolled seam, so a renamed or dropped tool fails here
// instead of vanishing from the prompt. `_registeredTools` is private to McpServer, hence the cast.
const call = async (deps: DiagnosticsToolDeps, name: string, args: Record<string, unknown>): Promise<string> => {
    const server = createDiagnosticsServer(deps);
    const registry = server.instance as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    };
    const registered = registry["_registeredTools"][name];
    const result = (await registered?.handler(args, {})) as { content: { text: string }[] };
    return result.content.map((part) => part.text).join("\n");
};

test("errors defaults to warn and worse, newest first", async () => {
    const deps = await setup({
        "daemon.log": [
            JSON.stringify({ time: at(5), level: "info", message: "chores: probe finished" }),
            JSON.stringify({ time: at(4), level: "warn", message: "host: heartbeat failed" }),
            JSON.stringify({ time: at(3), level: "error", message: "turn failed", code: "claude-not-entitled" }),
        ],
    });

    const text = await call(deps, "errors", {});
    expect(text).toContain("2 lines");
    expect(text).toContain("newest first");
    expect(text.indexOf("turn failed")).toBeLessThan(text.indexOf("heartbeat"));
    expect(text).not.toContain("probe finished");
});

test("errors narrows by window and by substring", async () => {
    const deps = await setup({
        "daemon.log": [
            JSON.stringify({ time: at(600), level: "error", message: "ancient", conversationId: "a" }),
            JSON.stringify({ time: at(2), level: "error", message: "recent", conversationId: "wise-condor" }),
        ],
    });

    expect(await call(deps, "errors", { sinceMinutes: 10 })).not.toContain("ancient");
    expect(await call(deps, "errors", { contains: "wise-condor" })).toContain("recent");
});

test("an empty window says so plainly, so nobody reads it as a crash", async () => {
    const deps = await setup({ "daemon.log": [JSON.stringify({ time: at(500), level: "error", message: "old" })] });
    expect(await call(deps, "errors", { sinceMinutes: 5 })).toMatch(/^No lines/);
});

test("slow reads its own file and can be narrowed to one operation", async () => {
    const deps = await setup({
        "perf.jsonl": [
            JSON.stringify({ time: at(3), level: "warn", perf: "git.run", ms: 500, load1: 19.2, message: "slow git.run" }),
            JSON.stringify({ time: at(2), level: "warn", perf: "http.request", ms: 2000, load1: 0.2, message: "slow http.request" }),
        ],
    });

    const all = await call(deps, "slow", {});
    expect(all).toContain("19.2");
    expect(await call(deps, "slow", { op: "git." })).not.toContain("http.request");
});

test("turns reports what ran and what failed, and names the asked-for model only when it differs", async () => {
    const deps = await setup({}, [
        turn({ outcome: "ok", model: "claude-opus-5", modelRequested: "claude-opus-5", conversationId: "c1" }),
        turn({
            outcome: "error",
            errorCode: "claude-not-entitled",
            errorMessage: "Claude Code is not enabled",
            model: "grok-4",
            modelRequested: "opus-4-6-thinking",
            conversationId: "c2",
            turns: 0,
            costUsd: 0,
        }),
    ]);

    const text = await call(deps, "turns", {});
    expect(text).toContain("2 turns");
    expect(text).toContain("1 failed");
    expect(text).toContain("claude-not-entitled");
    expect(text).toContain(`"asked":"opus-4-6-thinking"`);
    expect(text).not.toContain(`"asked":"claude-opus-5"`);
});

test("turns can be narrowed to failures and to one conversation", async () => {
    const deps = await setup({}, [
        turn({ outcome: "ok", conversationId: "c1" }),
        turn({ outcome: "error", errorCode: "rate_limit", conversationId: "c2" }),
        turn({ outcome: "cancelled", conversationId: "c3" }),
    ]);

    const failed = await call(deps, "turns", { only: "failed" });
    expect(failed).toContain("2 turns");
    expect(failed).not.toContain("c1");
    expect(await call(deps, "turns", { conversationId: "c2" })).toContain("1 turns");
});

// Every turn here has outcome `ok`; verification (verified/unproven/failing) is what actually distinguishes them.
test("turns separates the ones that finished from the ones that only stopped", async () => {
    const deps = await setup({}, [
        turn({ outcome: "ok", conversationId: "proved", verification: "verified", check: "pnpm test src/parser.test.ts", filesEdited: 2 }),
        turn({ outcome: "ok", conversationId: "quiet", verification: "unproven", filesEdited: 3, checklistTotal: 4, checklistOpen: 2 }),
        turn({ outcome: "ok", conversationId: "broken", verification: "failing", check: "pnpm test", filesEdited: 1 }),
    ]);

    const all = await call(deps, "turns", {});
    expect(all).toContain("3 turns");
    expect(all).toContain("0 failed");
    expect(all).toContain("2 finished with unproven");
    expect(all).toContain(`"check":"pnpm test src/parser.test.ts"`);
    expect(all).toContain(`"checklistOpen":2`);

    const unproven = await call(deps, "turns", { only: "unproven" });
    expect(unproven).toContain("quiet");
    expect(unproven).toContain("broken");
    expect(unproven).not.toContain("proved");
});

test("a turn with no recorded verdict is never counted as unproven", async () => {
    const deps = await setup({}, [turn({ outcome: "error", errorCode: "claude-not-entitled" }), turn({ outcome: "ok", verification: "no-code" })]);
    expect(await call(deps, "turns", {})).toContain("0 finished with unproven");
    expect(await call(deps, "turns", { only: "unproven" })).toMatch(/^No turns match/);
});

test("a turn with no recorded outcome is reported as unrecorded, never as a success", async () => {
    const deps = await setup({}, [turn({})]);
    expect(await call(deps, "turns", {})).toContain(`"outcome":"unrecorded"`);
});

test("resources turns a dotted path into a series with a summary", async () => {
    const deps = await setup({
        "resource-metrics.jsonl": [
            JSON.stringify({ at: at(3), system: { cgroup: { event_oom_kill: 0 } } }),
            JSON.stringify({ at: at(2), system: { cgroup: { event_oom_kill: 4 } } }),
        ],
    });

    const text = await call(deps, "resources", { field: "system.cgroup.event_oom_kill" });
    expect(text).toContain("min 0");
    expect(text).toContain("max 4");
    expect(text).toContain("2 samples");
});

test("a misspelled metric path is diagnosed rather than answered with an empty series", async () => {
    const deps = await setup({ "resource-metrics.jsonl": [JSON.stringify({ at: at(1), daemon: { memory: { rssBytes: 5 } } })] });

    const text = await call(deps, "resources", { field: "daemon.memory.rssByttes" });
    expect(text).toContain("daemon.memory.rssByttes");
    expect(text).toContain("1 samples");
});

// Fixture seeds both daemon.log and client.jsonl to prove the browser source reads only client.jsonl.
test("the browser source reads the client file and names itself as such", async () => {
    const deps = await setup({
        "daemon.log": [JSON.stringify({ time: at(2), level: "error", message: "turn failed" })],
        "client.jsonl": [
            JSON.stringify({
                time: at(3),
                level: "error",
                client: true,
                event: "vue.render-function",
                message: "TypeError: x is undefined",
                report: { route: "/agents" },
            }),
            JSON.stringify({
                time: at(1),
                level: "warn",
                client: true,
                event: "perf.slow",
                message: "slow chat.frame 48ms",
                report: { op: "chat.frame" },
            }),
        ],
    });

    const text = await call(deps, "errors", { source: "browser" });
    expect(text).toContain("2 browser reports");
    expect(text).toContain("/agents");
    expect(text).not.toContain("turn failed");
    expect(await call(deps, "errors", {})).toContain("turn failed");
});

test("a self-heal wipe is findable by name, which is the report that used to be destroyed", async () => {
    const deps = await setup({
        "client.jsonl": [
            JSON.stringify({ time: at(1), level: "error", client: true, event: "self-heal.wipe", message: "TypeError: cannot read hydrated blob" }),
        ],
    });

    expect(await call(deps, "errors", { source: "browser", contains: "self-heal" })).toContain("cannot read hydrated blob");
});

test("no browser reports yet reads as quiet, not as an error", async () => {
    // client.jsonl only exists once a browser has reported something.
    expect(await call(await setup({}), "errors", { source: "browser" })).toMatch(/^No browser reports/);
});
