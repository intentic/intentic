import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../engines/claude-sdk.js";
import type { UsageTurn } from "@intentic/sandbox-contract";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { opt } from "../opt.js";
import { utcDay, type UsageStore } from "../usage/usage-store.js";
import { type LevelName, readLogLines, readMetricSeries, readSlowSpans } from "./diagnostics.js";
import { readRestarts, readTimeline } from "./diagnostics-history.js";
import { renderLines, renderRestarts, renderSeries, renderSpans, renderTimeline, type Window } from "./diagnostics-render.js";

// Read-only tools over what the daemon already recorded: cannot write, delete, or reach outside historyRoot (its logs,
// activity.jsonl, boot-history.json) and the spend ledger. Every tool takes a window. Secret masking happens in
// agent-redaction.ts, not here.

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// Bounds one call's JSON payload; a caller that hits the cap is told and narrows.
const MAX_LINES = 200;
const DEFAULT_LINES = 40;
const MAX_MINUTES = 7 * 24 * 60;

export interface DiagnosticsToolDeps {
    readonly historyRoot: string;
    // Turn-outcome ledger; kept as the store, not a bound `turns` call, so building a plan need not invoke it.
    readonly usage: Pick<UsageStore, "turns">;
    readonly now?: () => number;
}

// Turn's changes are unverified when nothing checked them (`unproven`) or the last check failed (`failing`). Excludes
// `no-code` and absent verification: neither is evidence of a problem.
const unproven = (row: UsageTurn): boolean => row.verification === "unproven" || row.verification === "failing";

// A turn that ran, called nothing and changed nothing. Rows predating `toolCalls` can't answer, so they never match.
const silent = (row: UsageTurn): boolean => row.outcome === "ok" && row.toolCalls === 0 && (row.filesEdited ?? 0) === 0;

// A turn a daemon restart cut off mid-run: the ledger records it as cancelled with the code `interrupted`.
const interrupted = (row: UsageTurn): boolean => row.errorCode === "interrupted";

// The endings `only` can name, resolved in one place so the filter and the tool's own description cannot drift apart.
const matchesOnly = (row: UsageTurn, only: "failed" | "unproven" | "silent" | "interrupted" | undefined): boolean => {
    switch (only) {
        case "failed":
            return row.outcome === "error" || row.outcome === "cancelled";
        case "interrupted":
            return interrupted(row);
        case "unproven":
            return unproven(row);
        case "silent":
            return silent(row);
        default:
            return true;
    }
};

// What the turn did and what it left open. Verification is present only once something checked the turn; absent means
// nothing was watched, not that nothing was wrong. A finished checklist is the common case and would be a zero column.
const workOf = (row: UsageTurn): Record<string, unknown> => ({
    ...(row.verification !== undefined ? { verification: row.verification } : {}),
    ...(row.check !== undefined ? { check: row.check } : {}),
    ...(row.filesEdited !== undefined && row.filesEdited > 0 ? { filesEdited: row.filesEdited } : {}),
    // Shown only at zero: the count is noise beside filesEdited, but its absence is the whole signal.
    ...(row.toolCalls === 0 ? { toolCalls: 0 } : {}),
    ...(row.checklistOpen !== undefined && row.checklistOpen > 0
        ? { checklistOpen: row.checklistOpen, checklistTotal: row.checklistTotal }
        : {}),
});

// How much room the turn had. contextPct is a percent of the window, the readable signal that a turn ran out of it.
const roomOf = (row: UsageTurn): Record<string, unknown> => ({
    ...(row.compactions !== undefined && row.compactions > 0 ? { compactions: row.compactions } : {}),
    ...(row.contextTokens !== undefined && row.contextWindow !== undefined && row.contextWindow > 0
        ? { contextPct: Math.round((row.contextTokens / row.contextWindow) * 100) }
        : {}),
});

// The ids a turn is followed by elsewhere (activity log, log lines, transcript rows, provider session); absent on rows
// written before they were recorded.
const idsOf = (row: UsageTurn) => ({ ...opt("turnId", row.turnId), ...opt("run", row.run), ...opt("sessionId", row.sessionId) });

// Which model actually served it. `asked` appears only when it differs from `model`; always printing it would bury the
// rows where it matters.
const ranOn = (row: UsageTurn): Record<string, unknown> => ({
    provider: row.provider,
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.modelRequested !== undefined && row.modelRequested !== row.model ? { asked: row.modelRequested } : {}),
    harness: row.harness,
    ...(row.conversationId !== undefined ? { conversation: row.conversationId } : {}),
    ...idsOf(row),
});

// One turn as a single JSON line. Absent `outcome` predates the field; distinct from success, so it reads `unrecorded`.
const turnRow = (row: UsageTurn): string =>
    JSON.stringify({
        at: new Date(row.at).toISOString(),
        outcome: row.outcome ?? "unrecorded",
        ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
        ...(row.errorMessage !== undefined ? { error: row.errorMessage } : {}),
        ...workOf(row),
        ...roomOf(row),
        ...ranOn(row),
        costUsd: row.costUsd,
        durationMs: row.durationMs,
    });

const sinceOf = (now: number, minutes: number | undefined): number | undefined =>
    minutes === undefined ? undefined : now - Math.min(minutes, MAX_MINUTES) * 60_000;

const windowOf = (now: number, minutes: number | undefined): Window => ({ sinceMs: sinceOf(now, minutes), now });

// What every log line is, said once in each description that reads them: agents wrote jq against `.msg` and read blanks.
const LINE_SCHEMA =
    "Lines are pino JSON: `time` (ISO), `level` (a label), `message` (not `msg`), `ctx.conversationId` and `ctx.requestId`, " +
    "`err` for an exception; jq `.message` when reading /history/logs/daemon.log yourself.";

const minutes = () => z.number().int().min(1).max(MAX_MINUTES).optional();
const limitArg = () => z.number().int().min(1).max(MAX_LINES).optional();

const errorsTool = (deps: DiagnosticsToolDeps, now: () => number) =>
    sdk().tool(
        "errors",
        `What went wrong, newest first. Reach for this BEFORE re-instrumenting code or trying to reproduce a bug. ` +
            `\`source: "daemon"\` (the default) is the sandbox's own log (daemon.log, and daemon.log.1 when the window reaches ` +
            `back into it): failing turns, refused providers, crashed automations, unhandled rejections. ` +
            `\`source: "browser"\` is what the EDITOR reported about itself (client.jsonl): render errors, stalls the user felt, ` +
            `startup recoveries, each with the page the user was on. Many matches are grouped by message with a count and ` +
            `first/last time; stacks are left out unless asked for. ${ 
            LINE_SCHEMA}`,
        {
            source: z
                .enum(["daemon", "browser"])
                .optional()
                .describe("Whose account of it: the sandbox's own log, or what the editor sent about itself. Defaults to the daemon."),
            sinceMinutes: minutes().describe("How far back to look. Leave it out for everything the file still holds."),
            level: z
                .enum(["trace", "debug", "info", "warn", "error", "fatal"])
                .optional()
                .describe("Lowest level to include, and it includes worse ones. Defaults to `warn`, which is what went wrong."),
            contains: z
                .string()
                .max(200)
                .optional()
                .describe("Case-insensitive substring, matched anywhere in the line: a conversation id, an error code, a route, a message."),
            group: z
                .boolean()
                .optional()
                .describe("true: one row per kind of message, with its count and first and last time. false: every line. Left out, lines are grouped once there are more than `limit`."),
            stacks: z.boolean().optional().describe("Include each exception's stack. Off by default: stacks dwarf the line they belong to."),
            limit: limitArg(),
        },
        async ({ source, sinceMinutes, level, contains, group, stacks, limit }) => {
            const browser = source === "browser";
            const file = browser ? "client.jsonl" : "daemon.log";
            const floor: LevelName = level ?? "warn";
            const window = windowOf(now(), sinceMinutes);
            const shown = limit ?? DEFAULT_LINES;
            const result = await readLogLines(deps.historyRoot, { file, level: floor, sinceMs: window.sinceMs, contains, limit: shown });
            // Labeled "browser reports" so a browser's self-account reads as distinct from the daemon's own.
            return ok(renderLines(result, { what: browser ? "browser reports" : "lines", file, level: floor, window, group, stacks: stacks === true, limit: shown }));
        },
        { annotations: toolAnnotations("read") },
    );

const slowTool = (deps: DiagnosticsToolDeps, now: () => number) =>
    sdk().tool(
        "slow",
        "Operations the daemon measured as slower than their budget (perf.jsonl holds only the slow ones, not every span), " +
            "each with the machine's one-minute load at the time: the load separates a real regression from a busy machine. " +
            "Many matches are grouped (count, p50, p95, max and the worst one); `groupBy` chooses how.",
        {
            sinceMinutes: minutes(),
            op: z
                .string()
                .max(100)
                .optional()
                .describe("One operation by its exact name (`git.run` is not `git.run.wait`), or every one under a prefix ending in `.` or `*` (`git.`, `devices.*`)."),
            groupBy: z
                .enum(["op", "op+path", "none"])
                .optional()
                .describe("`op` one row per operation; `op+path` splits each by its subject (the route of a request, the git subcommand, the hook's tool); `none` every span. Left out, spans are grouped by op once there are more than `limit`."),
            limit: limitArg(),
        },
        async ({ sinceMinutes, op, groupBy, limit }) => {
            const window = windowOf(now(), sinceMinutes);
            const shown = limit ?? DEFAULT_LINES;
            const grouping = groupBy === "op+path" ? "op+path" : "op";
            const result = await readSlowSpans(deps.historyRoot, { sinceMs: window.sinceMs, op, groupBy: grouping, limit: shown });
            return ok(
                renderSpans(result, {
                    what: "slow spans",
                    file: "perf.jsonl",
                    window,
                    group: groupBy === undefined ? undefined : groupBy !== "none",
                    grouping,
                    stacks: false,
                    limit: shown,
                }),
            );
        },
        { annotations: toolAnnotations("read") },
    );

const turnsTool = (deps: DiagnosticsToolDeps, now: () => number) =>
    sdk().tool(
        "turns",
        "How recent agent turns ended: which model actually ran, what it cost, for a failed one its error code and the " +
            "provider's own sentence, and for one that ran, whether anything CHECKED the work it did. This is the durable " +
            "record, so it answers questions about turns nobody was watching, and it is the place to look when a session " +
            "died, a turn produced the wrong provider's error, or several conversations broke at once. " +
            '`verification` is the part a status word cannot give you: "verified" means a check passed after the last code ' +
            'edit and `check` names it, "unproven" means nothing ran, "failing" means the last one did not pass, "no-code" ' +
            "means nothing a check could speak to was edited. A turn ending with `checklistOpen` above zero abandoned a plan " +
            "it wrote itself, which is what a turn that stopped rather than finished looks like from here. `toolCalls` shows " +
            "only when it is zero: the turn produced words and acted on nothing, the shape of a model that announced a step " +
            "and then stopped. A turn that simply answered a question reads the same, so weigh it against what was asked.",
        {
            sinceMinutes: minutes(),
            conversationId: z.string().max(200).optional().describe("Narrow to one conversation."),
            only: z
                .enum(["failed", "unproven", "silent", "interrupted"])
                .optional()
                .describe(
                    'Narrow to one kind of ending: "failed" is turns that failed or were cancelled, "unproven" is turns that ' +
                        "changed code and finished with nothing having checked it (including ones whose last check broke), " +
                        '"silent" is turns that ran but called no tool and changed no file, "interrupted" is turns a restart or ' +
                        "a spent allowance cut off. Leave it out for every turn.",
                ),
            limit: limitArg(),
        },
        async ({ sinceMinutes, conversationId, only, limit }) => {
            const since = sinceOf(now(), sinceMinutes);
            // Ledger windows by UTC day; fetch the day floor, then filter exactly on `at` for the minute-level window.
            const rows = await deps.usage.turns(since === undefined ? {} : { from: utcDay(since) });
            const matching = rows.filter(
                (row) =>
                    (since === undefined || row.at >= since) &&
                    (conversationId === undefined || row.conversationId === conversationId) &&
                    matchesOnly(row, only),
            );
            if (matching.length === 0) {
                return ok(
                    "No turns match. The ledger holds every turn since the sandbox was created, so an empty answer here means the filter, not the history.",
                );
            }
            const shown = matching.slice(-(limit ?? DEFAULT_LINES)).toReversed();
            const failed = matching.filter((row) => row.outcome === "error").length;
            const cut = matching.filter(interrupted).length;
            return ok(
                [
                    // Counted separately because each is invisible in the rows: unproven work and a turn that never acted
                    // both look identical to a finished one.
                    `${matching.length} turns, ${failed} failed, ${cut > 0 ? `${cut} interrupted, ` : ""}${matching.filter(unproven).length} finished with unproven code changes, ${matching.filter(silent).length} ran without calling a tool. Newest ${shown.length} below.`,
                    "",
                    ...shown.map(turnRow),
                ].join("\n"),
            );
        },
        { annotations: toolAnnotations("read") },
    );

const resourcesTool = (deps: DiagnosticsToolDeps, now: () => number) =>
    sdk().tool(
        "resources",
        "One field of the sandbox's resource series over time, sampled once a minute and kept about a week. Answers what a " +
            "log cannot: was the machine out of memory, was the event loop stalling, who was holding the RAM, did the kernel " +
            "kill anything. min, mean and max cover every sample in the window; a long window is thinned to `limit` rows, each " +
            "the largest of its slice. A path naming an object or a list (`system`, `processes.top`) answers with its newest " +
            "value instead. Useful paths: `system.cgroup.event_oom_kill` (processes the kernel killed), " +
            "`processes.byRole.toolchain.rssBytes` (a build, test or typecheck fan-out; also browser, agentRuntime, localModel, " +
            "container, searchEngine, terminal, languageServer, git, extension), `processes.top` (the eight heaviest " +
            "processes), `window.eventLoop.delayP99Ms`, `window.cpu.utilizationPercent`, `daemon.memory.rssBytes`, " +
            "`system.pressure.memory.some`, `system.loadAverage`, `uptimeSeconds`, and `queue.heavy.longestHoldSeconds` " +
            "(with .held and .slots) for a heavy command that took a queue slot and did not give it back.",
        {
            field: z.string().min(1).max(200).describe("Dotted path into one sample, e.g. `system.cgroup.event_oom_kill`."),
            sinceMinutes: minutes(),
            limit: limitArg(),
        },
        async ({ field, sinceMinutes, limit }) => {
            const window = windowOf(now(), sinceMinutes);
            const series = await readMetricSeries(deps.historyRoot, { field, sinceMs: window.sinceMs, limit: limit ?? DEFAULT_LINES });
            return ok(renderSeries(series, window));
        },
        { annotations: toolAnnotations("read") },
    );

const restartsTool = (deps: DiagnosticsToolDeps, now: () => number) =>
    sdk().tool(
        "restarts",
        "The daemon's boots, newest first, and for each why the run before it ended: stopped cleanly or killed, on which " +
            "signal, after how long, and who asked for it (the owner, `ic`, the host's keeper, an update) with their reason. " +
            "Reach for it when turns were interrupted, a session vanished, or the editor reconnected by itself.",
        { sinceMinutes: minutes(), limit: limitArg() },
        async ({ sinceMinutes, limit }) => {
            const window = windowOf(now(), sinceMinutes);
            return ok(renderRestarts(await readRestarts(deps.historyRoot, { sinceMs: window.sinceMs }), window, limit ?? DEFAULT_LINES));
        },
        { annotations: toolAnnotations("read") },
    );

const timelineTool = (deps: DiagnosticsToolDeps, now: () => number) =>
    sdk().tool(
        "timeline",
        "Everything recorded about ONE conversation, oldest first, one line per event: the daemon.log lines that name it (in " +
            "`ctx.conversationId`, a field, or the message), its activity entries (turn started, completed or failed, " +
            "dependency checks, CI repairs, refused pushes), its turns from the spend ledger, and the daemon boots in between. " +
            "Use it instead of grepping /history for a conversation id. What was said is in `agents show <id> --transcript`.",
        {
            conversationId: z.string().min(1).max(200).describe("The conversation's id, e.g. `wise-fern-usz1`."),
            sinceMinutes: minutes(),
            level: z
                .enum(["trace", "debug", "info", "warn", "error", "fatal"])
                .optional()
                .describe("Lowest daemon.log level to include. Defaults to `info`, so the turn's own lifecycle lines are in."),
            limit: z.number().int().min(1).max(MAX_LINES).optional().describe("The newest this many events. Defaults to 100."),
        },
        async ({ conversationId, sinceMinutes, level, limit }) => {
            const window = windowOf(now(), sinceMinutes);
            const result = await readTimeline(deps.historyRoot, deps.usage, {
                conversationId,
                sinceMs: window.sinceMs,
                level: level ?? "info",
                limit: limit ?? 100,
            });
            return ok(renderTimeline(result, conversationId, window));
        },
        { annotations: toolAnnotations("read") },
    );

export const createDiagnosticsServer = (deps: DiagnosticsToolDeps): McpSdkServerConfigWithInstance => {
    const now = deps.now ?? Date.now;
    return sdk().createSdkMcpServer({
        name: "diagnostics",
        tools: [errorsTool(deps, now), slowTool(deps, now), turnsTool(deps, now), resourcesTool(deps, now), restartsTool(deps, now), timelineTool(deps, now)],
    });
};
