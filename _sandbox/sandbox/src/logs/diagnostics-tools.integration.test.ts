import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageTurn } from "@intentic/sandbox-contract";
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
    expect(text).toContain("2 warn-or-worse lines in daemon.log");
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

// "No lines in that window." alone was read as "nothing happened" when the window had rotated away.
test("an empty answer says what it searched and how far back the file reaches", async () => {
    const deps = await setup({ "daemon.log": [JSON.stringify({ time: at(500), level: "error", message: "old" })] });
    const text = await call(deps, "errors", { sinceMinutes: 5 });
    expect(text).toMatch(/^No warn-or-worse lines in daemon\.log between /);
    expect(text).toContain(`${at(5)} and ${at(0)}`);
    expect(text).toContain("back past the window's start");

    const before = await call(deps, "errors", { sinceMinutes: 900 });
    expect(before).toContain(`holds lines from ${at(500)}`);
    expect(before).toContain("rotated away");
});

// A DOMException serializes Node's whole code table, and a stack runs to dozens of lines; neither says what went wrong.
test("errors leave out stacks and error internals unless asked, and keep what the error says", async () => {
    const err = {
        type: "DOMException",
        message: "The operation was aborted due to timeout",
        stack: "TimeoutError: The operation was aborted\n    at new DOMException (node:internal)",
        name: "TimeoutError",
        code: 23,
        INDEX_SIZE_ERR: 1,
        DATA_CLONE_ERR: 25,
    };
    const deps = await setup({ "daemon.log": [JSON.stringify({ time: at(1), level: "warn", err, message: "hosts: heartbeat failed" })] });

    const text = await call(deps, "errors", {});
    expect(text).toContain("The operation was aborted due to timeout");
    expect(text).toContain(`"code":23`);
    expect(text).not.toContain("INDEX_SIZE_ERR");
    expect(text).not.toContain("node:internal");
    expect(await call(deps, "errors", { stacks: true })).toContain("node:internal");
});

test("more matches than the limit are grouped by message, so one loop cannot hide the line that matters", async () => {
    const deps = await setup({
        "daemon.log": [
            ...Array.from({ length: 30 }, (_, index) => JSON.stringify({ time: at(40 - index), level: "warn", message: `hosts: refused a socket from peer ${index}` })),
            JSON.stringify({ time: at(5), level: "error", message: "turn failed", code: "rate_limit" }),
        ],
    });

    const text = await call(deps, "errors", { limit: 5 });
    expect(text).toContain("31 warn-or-worse lines in daemon.log");
    expect(text).toContain("as 2 kinds of message");
    expect(text).toContain(`30× first ${at(40)} last ${at(11)}`);
    expect(text).toContain("rate_limit");
    // Asked for every line, it gives them, and still names what repeats.
    const raw = await call(deps, "errors", { limit: 5, group: false });
    expect(raw).toContain("newest 5 below");
    expect(raw).toContain('Most repeated: 30× "hosts: refused a socket from peer <n>"');
});

test("an answer is capped in size and says how much it left out", async () => {
    const deps = await setup({
        "daemon.log": Array.from({ length: 200 }, (_, index) =>
            JSON.stringify({ time: at(1), level: "error", message: `distinct ${"abcdefghij"[index % 10]} ${index}`, detail: "d".repeat(399) }),
        ),
    });

    const text = await call(deps, "errors", { limit: 200, group: false });
    expect(text.length).toBeLessThanOrEqual(31_000);
    expect(text).toMatch(/… \d+ more not shown: answers are capped at 30 KB/);
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

test("many slow spans come back as one row per operation with percentiles and the worst of each", async () => {
    const deps = await setup({
        "perf.jsonl": [
            ...Array.from({ length: 50 }, (_, index) =>
                JSON.stringify({ time: at(30 - index / 10), level: "warn", perf: "git.run", ms: 100 + index, git: "status", load1: 2, message: "slow git.run" }),
            ),
            JSON.stringify({ time: at(1), level: "warn", perf: "git.run.wait", ms: 9_000, git: "status", load1: 30, message: "slow git.run.wait" }),
        ],
    });

    const text = await call(deps, "slow", { limit: 10 });
    expect(text).toContain("51 slow spans in perf.jsonl");
    expect(text).toContain("git.run: 50×, p50 124 ms, p95 147 ms, max 149 ms");
    expect(text).toContain("git.run.wait: 1×");
    // An exact op is that op alone.
    expect(await call(deps, "slow", { op: "git.run", groupBy: "none", limit: 100 })).not.toContain("git.run.wait");
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

// The shape a model leaves when it announces a step and stops: it spoke, it called nothing, it changed nothing.
test("turns counts the ones that ran without calling a tool, and can isolate them", async () => {
    const deps = await setup({}, [
        turn({ outcome: "ok", conversationId: "worked", verification: "verified", filesEdited: 2, toolCalls: 9 }),
        turn({ outcome: "ok", conversationId: "spoke", verification: "no-code", filesEdited: 0, toolCalls: 0 }),
    ]);

    const all = await call(deps, "turns", {});
    expect(all).toContain("1 ran without calling a tool");
    expect(all).toContain(`"toolCalls":0`);
    // A turn that did act prints no count: the number is noise, only its absence carries a signal.
    expect(all).not.toContain(`"toolCalls":9`);

    const stalled = await call(deps, "turns", { only: "silent" });
    expect(stalled).toContain("spoke");
    expect(stalled).not.toContain("worked");
});

// A row written before the field cannot answer the question, so it must not be read as having called nothing.
test("a turn with no recorded tool count is never counted as one that called nothing", async () => {
    const deps = await setup({}, [turn({ outcome: "ok", conversationId: "older" })]);
    expect(await call(deps, "turns", {})).toContain("0 ran without calling a tool");
    expect(await call(deps, "turns", { only: "silent" })).toMatch(/^No turns match/);
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
    expect(text).toContain("`daemon.memory` exists; under it the keys are: rssBytes");
});

test("a metric path naming a list answers with its newest value", async () => {
    const deps = await setup({
        "resource-metrics.jsonl": [JSON.stringify({ at: at(1), processes: { top: [{ name: "node", role: "toolchain", rssBytes: 7 }] } })],
    });

    const text = await call(deps, "resources", { field: "processes.top" });
    expect(text).toContain("`processes.top` is a list");
    expect(text).toContain(`"role":"toolchain"`);
});

// The series file survives restarts, so "the series starts when the daemon does" was false; the file's own reach is said.
test("a metric window before the series begins says where it begins", async () => {
    const deps = await setup({ "resource-metrics.jsonl": [JSON.stringify({ at: at(10), daemon: { memory: { rssBytes: 5 } } })] });

    expect(await call(deps, "resources", { field: "daemon.memory.rssBytes", sinceMinutes: 5 })).toContain("No samples between");
    expect(await call(deps, "resources", { field: "daemon.memory.rssBytes", sinceMinutes: 600 })).toContain(`holds lines from ${at(10)}`);
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
    expect(text).toContain("2 warn-or-worse browser reports in client.jsonl");
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
    const text = await call(await setup({}), "errors", { source: "browser" });
    expect(text).toMatch(/^No warn-or-worse browser reports in client\.jsonl/);
    expect(text).toContain("client.jsonl does not exist yet.");
});

// A restart's cut turn is recorded as cancelled with the code `interrupted`; rows from before the ids were kept still read.
test("turns shows a turn's ids when the ledger has them and can isolate interrupted turns", async () => {
    const deps = await setup({}, [
        turn({ outcome: "ok", conversationId: "older" }),
        turn({ outcome: "cancelled", errorCode: "interrupted", conversationId: "cut", turnId: "t-123", run: "r-2", sessionId: "s-9" }),
    ]);

    const all = await call(deps, "turns", {});
    expect(all).toContain("1 interrupted");
    expect(all).toContain(`"turnId":"t-123","run":"r-2","sessionId":"s-9"`);
    const cut = await call(deps, "turns", { only: "interrupted" });
    expect(cut).toContain("cut");
    expect(cut).not.toContain("older");
});

test("restarts reads the restart log newest first and says why each run ended, whatever fields it lacks", async () => {
    const deps = await setup({
        "restarts.jsonl": [
            // A row from before `ended` was written, and with a malformed field: still one boot.
            JSON.stringify({ at: at(300), boot: { pid: 50, version: 7 }, previous: { graceful: false } }),
            JSON.stringify({
                at: at(60),
                boot: { pid: 55, version: "1.2.3", commit: "abcdef1234567890" },
                previous: {
                    ended: "stopped",
                    graceful: true,
                    signal: "SIGTERM",
                    uptimeSeconds: 14_400,
                    intent: { at: at(61), by: "keeper", host: "rog", action: "restart", reason: "health probe failed", checks: ["health"] },
                },
            }),
            JSON.stringify({ at: at(30), boot: { pid: 60, version: "1.2.3" } }),
        ],
    });

    const text = await call(deps, "restarts", {});
    expect(text).toContain("3 daemon boots");
    expect(text.indexOf("pid 55")).toBeLessThan(text.indexOf("pid 50"));
    expect(text).toContain("booted pid 55 (1.2.3 abcdef123456); the run before stopped gracefully on SIGTERM after 4h 0m; keeper on rog asked to restart: health probe failed [failed checks: health]");
    expect(text).toContain("booted pid 50; the run before was killed without warning");
    expect(text).toContain("booted pid 60 (1.2.3); nothing recorded about the run before.");
    expect(await call(deps, "restarts", { sinceMinutes: 120 })).toContain("2 daemon boots");
});

test("restarts falls back to bare boot times on a daemon that keeps no restart log", async () => {
    const deps = await setup({
        // Uptime starts over between these two samples: a boot 2 minutes before the second.
        "resource-metrics.jsonl": [
            JSON.stringify({ at: at(200), uptimeSeconds: 6_000 }),
            JSON.stringify({ at: at(100), uptimeSeconds: 120 }),
        ],
    });
    await writeFile(join(deps.historyRoot, "boot-history.json"), JSON.stringify({ boots: [NOW - 102 * 60_000 + 30_000] }));

    const text = await call(deps, "restarts", {});
    expect(text).toContain("keeps no restart log yet");
    // The boot both records name is one boot; the older run's own start comes from its uptime.
    expect(text).toContain("2 daemon boots");
    expect(text).toContain(new Date(NOW - 200 * 60_000 - 6_000_000).toISOString());
});

test("timeline puts one conversation's log lines, activity and turns in time order, and skips lines that only list it", async () => {
    const deps = await setup(
        {
            "daemon.log": [
                JSON.stringify({ time: at(30), level: "info", ctx: { conversationId: "wise-fern" }, message: "turn: accepted" }),
                JSON.stringify({ time: at(20), level: "info", message: "perf summary", worst: [{ conversation: "wise-fern" }] }),
                JSON.stringify({ time: at(10), level: "warn", conversationId: "wise-fern", message: "turn: interrupted by a restart" }),
                JSON.stringify({ time: at(9), level: "warn", conversationId: "other", message: "elsewhere" }),
            ],
        },
        [turn({ at: NOW - 15 * 60_000, outcome: "error", errorCode: "rate_limit", conversationId: "wise-fern" })],
    );
    await writeFile(
        join(deps.historyRoot, "activity.jsonl"),
        `${[
            JSON.stringify({ id: "1", at: NOW - 25 * 60_000, direction: "system", type: "turn.started", turnId: "abcdef123456", conversationId: "wise-fern", content: "fix\nthe bug" }),
            JSON.stringify({ id: "2", at: NOW - 5 * 60_000, direction: "system", type: "turn.started", conversationId: "other", content: "x" }),
        ].join("\n")}\n`,
    );

    const text = await call(deps, "timeline", { conversationId: "wise-fern" });
    expect(text).toContain("4 events (2 daemon.log lines, 1 activity entries, 1 turns, 0 daemon boots)");
    const order = ["turn: accepted", "turn.started turn abcdef12: fix the bug", "turn ended error", "interrupted by a restart"].map((part) => text.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(text).not.toContain("perf summary");
    expect(text).not.toContain("elsewhere");
    expect(await call(deps, "timeline", { conversationId: "nobody" })).toMatch(/^Nothing names nobody/);
});
