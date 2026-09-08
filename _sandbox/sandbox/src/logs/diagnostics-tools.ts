import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../runtimes/claude/claude-sdk.js";
import type { UsageTurn } from "@intentic/sandbox-contract";
import { z } from "zod";
import { utcDay, type UsageStore } from "../usage/usage-store.js";
import { type LevelName, type LogLineResult, readLogLines, readMetricSeries } from "./diagnostics.js";

// Read-only tools over what the daemon already recorded: cannot write, delete, or reach outside historyRoot/logs and
// the spend ledger. Every tool takes a window and answers newest-first. Secret masking happens in agent-redaction.ts,
// not here.

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

const sinceOf = (now: number, minutes: number | undefined): number | undefined =>
    minutes === undefined ? undefined : now - Math.min(minutes, MAX_MINUTES) * 60_000;

// Renders lines as single-line JSON, not pretty-printed: deep indentation would cost most of a context window and every
// field is already flat enough to scan.
const render = (result: LogLineResult, what: string): string => {
    if (result.lines.length === 0) {
        return result.windowTruncated
            ? `No ${what} in that window, but the read started mid-file: there may be older ones this could not see. Narrow the window or widen the filter.`
            : `No ${what} in that window.`;
    }
    const head =
        result.matched > result.lines.length
            ? `${result.matched} ${what} matched; newest ${result.lines.length} below (raise \`limit\` or narrow the window for the rest).`
            : `${result.matched} ${what}, newest first.`;
    return [
        head,
        ...(result.windowTruncated ? ["Note: the read started mid-file, so older matches may exist."] : []),
        "",
        ...result.lines.map((line) => JSON.stringify(line)),
    ].join("\n");
};

export const createDiagnosticsServer = (deps: DiagnosticsToolDeps): McpSdkServerConfigWithInstance => {
    const now = deps.now ?? Date.now;
    return sdk().createSdkMcpServer({
        name: "diagnostics",
        tools: [
            sdk().tool(
                "errors",
                "What went wrong, newest first. Reach for this BEFORE re-instrumenting code or trying to reproduce a bug. " +
                    '`source: "daemon"` (the default) is the sandbox\'s own log: failing turns, refused providers, crashed ' +
                    "automations, unhandled rejections, each with the conversation and session ids to join on. " +
                    '`source: "browser"` is what the EDITOR reported about itself: render errors, stalls the user felt, and ' +
                    "startup recoveries, each with the page the user was on. Reach for the browser source whenever the " +
                    "complaint is about the interface rather than about a turn, and note that a report can only be there if " +
                    "the app was running a build that sends them.",
                {
                    source: z
                        .enum(["daemon", "browser"])
                        .optional()
                        .describe("Whose account of it: the sandbox's own log, or what the editor sent about itself. Defaults to the daemon."),
                    sinceMinutes: z
                        .number()
                        .int()
                        .min(1)
                        .max(MAX_MINUTES)
                        .optional()
                        .describe("How far back to look. Leave it out for everything the file still holds."),
                    level: z
                        .enum(["trace", "debug", "info", "warn", "error", "fatal"])
                        .optional()
                        .describe("Lowest level to include, and it includes worse ones. Defaults to `warn`, which is what went wrong."),
                    contains: z
                        .string()
                        .max(200)
                        .optional()
                        .describe("Case-insensitive substring, matched anywhere in the line: a conversation id, an error code, a route, a message."),
                    limit: z.number().int().min(1).max(MAX_LINES).optional(),
                },
                async ({ source, sinceMinutes, level, contains, limit }) => {
                    const browser = source === "browser";
                    const result = await readLogLines(deps.historyRoot, {
                        file: browser ? "client.jsonl" : "daemon.log",
                        level: (level ?? "warn") as LevelName,
                        ...(sinceOf(now(), sinceMinutes) !== undefined ? { sinceMs: sinceOf(now(), sinceMinutes) } : {}),
                        ...(contains !== undefined ? { contains } : {}),
                        limit: limit ?? DEFAULT_LINES,
                    });
                    // Labeled "browser reports" so a browser's self-account reads as distinct from the daemon's own.
                    return ok(render(result, browser ? "browser reports" : "lines"));
                },
            ),
            sdk().tool(
                "slow",
                "Operations the daemon measured as slower than their budget, newest first, each with the machine's one-minute " +
                    "load at the time. Use it when something felt slow: the load field is what separates a real regression from " +
                    "a busy machine, which is the distinction that has cost this project a red pipeline more than once. Lives in " +
                    "its own file, so it is not in `errors`.",
                {
                    sinceMinutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
                    op: z
                        .string()
                        .max(100)
                        .optional()
                        .describe("Narrow to one operation, e.g. `git.run`, `http.request`, `git.scan`. Substring, so `git.` catches all of them."),
                    limit: z.number().int().min(1).max(MAX_LINES).optional(),
                },
                async ({ sinceMinutes, op, limit }) => {
                    const result = await readLogLines(deps.historyRoot, {
                        file: "perf.jsonl",
                        ...(sinceOf(now(), sinceMinutes) !== undefined ? { sinceMs: sinceOf(now(), sinceMinutes) } : {}),
                        ...(op !== undefined ? { contains: op } : {}),
                        limit: limit ?? DEFAULT_LINES,
                    });
                    return ok(render(result, "slow spans"));
                },
            ),
            sdk().tool(
                "turns",
                "How recent agent turns ended: which model actually ran, what it cost, for a failed one its error code and the " +
                    "provider's own sentence, and for one that ran, whether anything CHECKED the work it did. This is the durable " +
                    "record, so it answers questions about turns nobody was watching, and it is the place to look when a session " +
                    "died, a turn produced the wrong provider's error, or several conversations broke at once. " +
                    '`verification` is the part a status word cannot give you: "verified" means a check passed after the last code ' +
                    'edit and `check` names it, "unproven" means nothing ran, "failing" means the last one did not pass, "no-code" ' +
                    "means nothing a check could speak to was edited. A turn ending with `checklistOpen` above zero abandoned a plan " +
                    "it wrote itself, which is what a turn that stopped rather than finished looks like from here.",
                {
                    sinceMinutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
                    conversationId: z.string().max(200).optional().describe("Narrow to one conversation."),
                    only: z
                        .enum(["failed", "unproven"])
                        .optional()
                        .describe(
                            'Narrow to one kind of ending: "failed" is turns that failed or were cancelled, "unproven" is turns that ' +
                                "changed code and finished with nothing having checked it (including ones whose last check broke). " +
                                "Leave it out for every turn.",
                        ),
                    limit: z.number().int().min(1).max(MAX_LINES).optional(),
                },
                async ({ sinceMinutes, conversationId, only, limit }) => {
                    const at = now();
                    const since = sinceOf(at, sinceMinutes);
                    // Ledger windows by UTC day; fetch the day floor, then filter exactly on `at` for the minute-level
                    // window.
                    const rows = await deps.usage.turns(since === undefined ? {} : { from: utcDay(since) });
                    const matching = rows.filter(
                        (row) =>
                            (since === undefined || row.at >= since) &&
                            (conversationId === undefined || row.conversationId === conversationId) &&
                            (only !== "failed" || row.outcome === "error" || row.outcome === "cancelled") &&
                            (only !== "unproven" || unproven(row)),
                    );
                    if (matching.length === 0) {
                        return ok(
                            "No turns match. The ledger holds every turn since the sandbox was created, so an empty answer here means the filter, not the history.",
                        );
                    }
                    const shown = matching.slice(-(limit ?? DEFAULT_LINES)).toReversed();
                    const failed = matching.filter((row) => row.outcome === "error").length;
                    return ok(
                        [
                            // Both counts needed: unproven work looks identical to a finished turn unless counted
                            // separately.
                            `${matching.length} turns, ${failed} failed, ${matching.filter(unproven).length} finished with unproven code changes. Newest ${shown.length} below.`,
                            // Absent `outcome` predates the field; distinct from success, so it renders as
                            // `unrecorded`.
                            "",
                            ...shown.map((row) =>
                                JSON.stringify({
                                    at: new Date(row.at).toISOString(),
                                    outcome: row.outcome ?? "unrecorded",
                                    ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
                                    ...(row.errorMessage !== undefined ? { error: row.errorMessage } : {}),
                                    // Present only once something checked the turn; absent means nothing was watched,
                                    // not that nothing was wrong.
                                    ...(row.verification !== undefined ? { verification: row.verification } : {}),
                                    ...(row.check !== undefined ? { check: row.check } : {}),
                                    ...(row.filesEdited !== undefined && row.filesEdited > 0 ? { filesEdited: row.filesEdited } : {}),
                                    // Included only when nonzero; a finished checklist is the common case and would
                                    // just be a zero column.
                                    ...(row.checklistOpen !== undefined && row.checklistOpen > 0
                                        ? { checklistOpen: row.checklistOpen, checklistTotal: row.checklistTotal }
                                        : {}),
                                    ...(row.compactions !== undefined && row.compactions > 0 ? { compactions: row.compactions } : {}),
                                    // Reported as a percent of the context window, the readable signal that a turn ran
                                    // out of room.
                                    ...(row.contextTokens !== undefined && row.contextWindow !== undefined && row.contextWindow > 0
                                        ? { contextPct: Math.round((row.contextTokens / row.contextWindow) * 100) }
                                        : {}),
                                    provider: row.provider,
                                    ...(row.model !== undefined ? { model: row.model } : {}),
                                    // Included only when it differs from `model`; printing it always would bury the
                                    // rows where it matters.
                                    ...(row.modelRequested !== undefined && row.modelRequested !== row.model ? { asked: row.modelRequested } : {}),
                                    harness: row.harness,
                                    ...(row.conversationId !== undefined ? { conversation: row.conversationId } : {}),
                                    costUsd: row.costUsd,
                                    durationMs: row.durationMs,
                                }),
                            ),
                        ].join("\n"),
                    );
                },
            ),
            sdk().tool(
                "resources",
                "One field of the sandbox's resource series over time, sampled once a minute. Answers what a log cannot: was the " +
                    "machine out of memory, was the event loop stalling, who was holding the RAM, did the kernel kill anything. " +
                    "Useful paths: `system.cgroup.event_oom_kill` (processes the kernel killed), " +
                    "`processes.byRole.browser.rssBytes` (and agentRuntime, terminal, languageServer, git, extension), " +
                    "`window.eventLoop.delayP99Ms`, `window.cpu.utilizationPercent`, `daemon.memory.rssBytes`, " +
                    "`system.pressure.memory.some`, `system.loadAverage`.",
                {
                    field: z.string().min(1).max(200).describe("Dotted path into one sample, e.g. `system.cgroup.event_oom_kill`."),
                    sinceMinutes: z.number().int().min(1).max(MAX_MINUTES).optional(),
                    limit: z.number().int().min(1).max(MAX_LINES).optional(),
                },
                async ({ field, sinceMinutes, limit }) => {
                    const since = sinceOf(now(), sinceMinutes);
                    const series = await readMetricSeries(deps.historyRoot, {
                        field,
                        ...(since !== undefined ? { sinceMs: since } : {}),
                        limit: limit ?? DEFAULT_LINES,
                    });
                    if (series.points.length === 0) {
                        return ok(
                            series.missing > 0
                                ? `No numeric values at \`${field}\` in ${series.missing} samples. Either the path is wrong or it names an object rather than a number; read one whole sample with \`tail -n 1 /history/logs/resource-metrics.jsonl\` to see the shape.`
                                : `No samples in that window. The series starts when the daemon does, so a window before the last restart is empty.`,
                        );
                    }
                    return ok(
                        [
                            `${field}: ${series.points.length} samples, min ${series.min}, mean ${series.mean}, max ${series.max}.`,
                            "",
                            ...series.points.map((point) => `${point.at} ${point.value}`),
                        ].join("\n"),
                    );
                },
            ),
        ],
    });
};
