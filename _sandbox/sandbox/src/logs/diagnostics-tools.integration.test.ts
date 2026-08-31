import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageTurn } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createDiagnosticsServer, type DiagnosticsToolDeps } from "./diagnostics-tools.js";

/* The tools as the model meets them: called by name, answered in text. What these pin is the WORDING as much as
 * the filtering, because the whole reason these exist rather than a documented file path is that the answer has
 * to be readable by whoever asked without a second call to work out what it meant. */

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

/* Call one tool by name and return the text it answered with, which is all the model ever sees.
 *
 * Through the SDK server's own registry rather than a hand-rolled seam: the registry is what the harness
 * actually dispatches on, so a tool renamed or dropped fails these tests instead of quietly disappearing from
 * the prompt. `_registeredTools` is private to McpServer, hence the one cast. */
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
    // The error is above the warning, and the routine line is not there at all.
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
    // The load rides along: it is what separates a real regression from a busy machine.
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
    // The divergence is the answer, so it is printed; a matching pair would only be noise on every row.
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

/* THE OTHER WAY A TURN GOES WRONG, and the one no status word could ever show: every row here is `ok`, so a
 * reader filtering on failure sees a clean day. Two of these three finished on code nothing stands behind. */
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
    // "verified" is only worth the word because the check that earned it is printed beside it.
    expect(all).toContain(`"check":"pnpm test src/parser.test.ts"`);
    // A plan the turn wrote itself and left open is the readable form of "it stopped talking".
    expect(all).toContain(`"checklistOpen":2`);

    const unproven = await call(deps, "turns", { only: "unproven" });
    expect(unproven).toContain("quiet");
    expect(unproven).toContain("broken");
    expect(unproven).not.toContain("proved");
});

/* A turn the provider never answered records no verdict, and the filter must not read that silence as a
 * finding: an unknown counted as a hit is how a filter comes to be distrusted. */
test("a turn with no recorded verdict is never counted as unproven", async () => {
    const deps = await setup({}, [turn({ outcome: "error", errorCode: "claude-not-entitled" }), turn({ outcome: "ok", verification: "no-code" })]);
    expect(await call(deps, "turns", {})).toContain("0 finished with unproven");
    expect(await call(deps, "turns", { only: "unproven" })).toMatch(/^No turns match/);
});

test("a turn with no recorded outcome is reported as unrecorded, never as a success", async () => {
    const deps = await setup({}, [turn({})]);
    // Absent means the row predates outcome being recorded. Printing "ok" here would be inventing a fact.
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
    // The failure mode this prevents: a confident "no data" that was really a typo.
    expect(text).toContain("daemon.memory.rssByttes");
    expect(text).toContain("1 samples");
});

/* THE BROWSER'S OWN ACCOUNT, read through the same tool. Its own source rather than folded into the daemon's
 * lines, because the two are different kinds of evidence: one is the daemon describing what it did, the other is
 * a page describing itself over a route anyone signed in can post to. */
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
    // The daemon's own log is a different question, so it is not mixed in.
    expect(text).not.toContain("turn failed");
    expect(await call(deps, "errors", {})).toContain("turn failed");
});

test("a self-heal wipe is findable by name, which is the report that used to be destroyed", async () => {
    const deps = await setup({
        "client.jsonl": [
            JSON.stringify({ time: at(1), level: "error", client: true, event: "self-heal.wipe", message: "TypeError: cannot read hydrated blob" }),
        ],
    });

    // The bug class that fixes itself by clearing storage and reloading, which is why it left no evidence at all.
    expect(await call(deps, "errors", { source: "browser", contains: "self-heal" })).toContain("cannot read hydrated blob");
});

test("no browser reports yet reads as quiet, not as an error", async () => {
    // client.jsonl does not exist until a browser has something to say.
    expect(await call(await setup({}), "errors", { source: "browser" })).toMatch(/^No browser reports/);
});
