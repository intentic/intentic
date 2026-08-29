import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import type { UsageTurn } from "@intentic/sandbox-contract";
import { z } from "zod";
import { utcDay, type UsageStore } from "../usage/usage-store.js";
import { type LevelName, type LogLineResult, readLogLines, readMetricSeries } from "./diagnostics.js";

/* THE DIAGNOSTIC TOOLS, the read side of everything the daemon writes down.
 *
 * Measured over 728 real sessions, 91,094 tool calls: agents took 1,545 screenshots against 65 reads of a
 * console, opened daemon.log 150 times, the resource series 69, and the /logs route ZERO times, while building
 * 1,679 of their own /tmp/*.log files and adding 178 console.log lines to find out what was happening. The
 * daemon was not short of records. It was short of a way to ask them anything, so the cheapest route to an
 * answer was always to re-instrument the code and reproduce the bug.
 *
 * These four tools are that route made cheaper, and the reason they are tools rather than a documented file
 * path is discoverability: a path in a README is something an agent has to already know; a tool with a
 * description arrives in the prompt.
 *
 * WHY FILTERS AND NOT A TAIL. `tail -n 200 daemon.log` was always available and is worse than a print
 * statement: oldest-first, unfiltered, and in a file that is mostly routine. Every tool here takes a window and
 * returns newest-first, because "what went wrong in the last ten minutes" is the question actually being asked
 * every time.
 *
 * WHAT THEY DELIBERATELY CANNOT DO: write, delete, or reach outside historyRoot/logs and the spend ledger. A
 * turn must not be able to edit the record of what it did, which is the same rule that puts these files on the
 * /history volume outside the agent's /work mount in the first place. Secret masking is not this module's job
 * either: agent-redaction.ts masks every MCP tool result before the model sees it, so it is a property of the
 * conversation rather than of each tool. */

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

// Wide enough for a real incident, bounded so one call cannot return a megabyte of JSON into the context that
// has to reason about it. A caller who hits the cap is told, and narrows.
const MAX_LINES = 200;
const DEFAULT_LINES = 40;
const MAX_MINUTES = 7 * 24 * 60;

export interface DiagnosticsToolDeps {
    readonly historyRoot: string;
    /* The spend + outcome ledger, read for turn outcomes. Same store the cost panels project from.
     *
     * The STORE, not its `turns` member: mounting a tool must not dereference the thing it reads. Taking the
     * method here binds it at plan time, so composing a turn would depend on a store the turn may never ask
     * anything of, and every caller that builds a plan would have to supply one. */
    readonly usage: Pick<UsageStore, "turns">;
    readonly now?: () => number;
}

/* A TURN THAT FINISHED ON WORK NOTHING CHECKED. Both states count, because both are a claim the record cannot
 * stand behind: "unproven" is nothing ran, "failing" is the last thing that ran did not pass, and a turn that
 * ended anyway on either has left something for a person to look at.
 *
 * "no-code" and absent are deliberately not here. The first is a turn a check could not have spoken to; the
 * second is a row from before this was recorded, or a turn the provider never answered, and counting an
 * unknown as a finding is how a filter comes to be distrusted. */
const unproven = (row: UsageTurn): boolean => row.verification === "unproven" || row.verification === "failing";

const sinceOf = (now: number, minutes: number | undefined): number | undefined =>
    minutes === undefined ? undefined : now - Math.min(minutes, MAX_MINUTES) * 60_000;

// One log line as a single readable line of JSON. Not pretty-printed: forty six-deep objects at two spaces of
// indent is most of a context window, and every field is already flat enough to scan.
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
    return createSdkMcpServer({
        name: "diagnostics",
        tools: [
            tool(
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
                    // Named differently on purpose: these lines are a browser's account of itself, and a reader
                    // who cannot tell that from the daemon's own account would eventually trust the wrong one.
                    return ok(render(result, browser ? "browser reports" : "lines"));
                },
            ),
            tool(
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
            tool(
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
                    // The ledger windows by UTC day, so a minute-level window needs the day floor first and then
                    // an exact filter on `at`. Reading the day whole and filtering is right: a day is at most a
                    // few hundred rows.
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
                            // Both counts, because they are different questions about the same rows and the
                            // second one has no other way to be asked: a turn that failed announced itself, and
                            // a turn that finished on work nothing checked looks exactly like a turn that
                            // finished.
                            `${matching.length} turns, ${failed} failed, ${matching.filter(unproven).length} finished with unproven code changes. Newest ${shown.length} below.`,
                            // `outcome` absent means the row predates outcome being recorded, which is not the
                            // same as a turn that succeeded; say so rather than printing a guess.
                            "",
                            ...shown.map((row) =>
                                JSON.stringify({
                                    at: new Date(row.at).toISOString(),
                                    outcome: row.outcome ?? "unrecorded",
                                    ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
                                    ...(row.errorMessage !== undefined ? { error: row.errorMessage } : {}),
                                    /* How the turn ENDED, past whether it failed. Absent on a row that predates
                                     * this being recorded and on a turn the provider never answered, which is
                                     * the honest reading: nothing was watched, so nothing is claimed. */
                                    ...(row.verification !== undefined ? { verification: row.verification } : {}),
                                    ...(row.check !== undefined ? { check: row.check } : {}),
                                    ...(row.filesEdited !== undefined && row.filesEdited > 0 ? { filesEdited: row.filesEdited } : {}),
                                    // Only when something is still open: a finished checklist is the ordinary
                                    // case and would be a column of zeroes on every row.
                                    ...(row.checklistOpen !== undefined && row.checklistOpen > 0
                                        ? { checklistOpen: row.checklistOpen, checklistTotal: row.checklistTotal }
                                        : {}),
                                    ...(row.compactions !== undefined && row.compactions > 0 ? { compactions: row.compactions } : {}),
                                    // As a fraction of the window, which is the readable form of the pair and
                                    // the one that says "this turn ended against the wall".
                                    ...(row.contextTokens !== undefined && row.contextWindow !== undefined && row.contextWindow > 0
                                        ? { contextPct: Math.round((row.contextTokens / row.contextWindow) * 100) }
                                        : {}),
                                    provider: row.provider,
                                    ...(row.model !== undefined ? { model: row.model } : {}),
                                    // Only when it differs: printing it on every row would bury the rows where
                                    // the difference is the answer.
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
            tool(
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
