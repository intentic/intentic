import type { DiagnosticsQuery } from "@intentic/sandbox-contract/schemas/diagnostics";
import { DIAGNOSTICS_MAX_MINUTES } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
import { opt } from "../opt.js";
import { logsRoot } from "../seams/logs-root.js";
import { type FiledPostMortem, readFiledPostMortems } from "../system/boot/restarts/post-mortem.js";
import { utcDay, type UsageStore } from "../usage/usage-store.js";
import { type LevelName, readLogLines, readMetricSeries, readSlowSpans } from "./diagnostics.js";
import { readRestarts, readTimeline } from "./diagnostics-history.js";
import { renderLines, renderRestarts, renderRollups, renderSeries, renderSpans, renderTimeline, type Window } from "./diagnostics-render.js";
import { readRollups } from "./diagnostics-rollups.js";
import { commandFailuresAnswer } from "./command-runs-log.js";

// THE DIAGNOSTICS QUERIES, answered: read-only questions over what the daemon already recorded, each worded as text to
// be read. One function behind every door that asks them (schemas/diagnostics.ts): the `diagnostics` tools a turn
// mounts (diagnostics-tools.ts), the `diagnostics` command (diagnostics.routes.ts), a linked sandbox reading this one's
// records (links/link-records.ts) and a conversation's bundle. None can write, delete, or reach outside historyRoot (its
// logs, activity.jsonl, boot-history.json) and the spend ledger. Secret masking happens in agent-redaction.ts, not here.

export interface DiagnosticsDeps {
    readonly historyRoot: string;
    // Turn-outcome ledger; kept as the store, not a bound `turns` call, so building a plan need not invoke it.
    readonly usage: Pick<UsageStore, "turns">;
    readonly now?: () => number;
}

// Rows an answer shows when the caller names no limit.
const DEFAULT_LINES = 40;

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
const workOf = (row: UsageTurn) => {
    const open = row.checklistOpen !== undefined && row.checklistOpen > 0;
    return {
        ...opt("verification", row.verification),
        ...opt("check", row.check),
        ...opt("filesEdited", row.filesEdited !== undefined && row.filesEdited > 0 ? row.filesEdited : undefined),
        // Shown only at zero: the count is noise beside filesEdited, but its absence is the whole signal.
        ...opt("toolCalls", row.toolCalls === 0 ? 0 : undefined),
        ...opt("checklistOpen", open ? row.checklistOpen : undefined),
        ...opt("checklistTotal", open ? row.checklistTotal : undefined),
    };
};

// How much room the turn had. contextPct is a percent of the window, the readable signal that a turn ran out of it.
const roomOf = (row: UsageTurn) => ({
    ...opt("compactions", row.compactions !== undefined && row.compactions > 0 ? row.compactions : undefined),
    ...opt(
        "contextPct",
        row.contextTokens !== undefined && row.contextWindow !== undefined && row.contextWindow > 0
            ? Math.round((row.contextTokens / row.contextWindow) * 100)
            : undefined,
    ),
});

// The ids a turn is followed by elsewhere (activity log, log lines, transcript rows, provider session); absent on rows
// written before they were recorded.
const idsOf = (row: UsageTurn) => ({ ...opt("turnId", row.turnId), ...opt("run", row.run), ...opt("sessionId", row.sessionId) });

// Which model actually served it. `asked` appears only when it differs from `model`; always printing it would bury the
// rows where it matters.
const ranOn = (row: UsageTurn) => ({
    provider: row.provider,
    ...opt("model", row.model),
    ...opt("asked", row.modelRequested !== row.model ? row.modelRequested : undefined),
    harness: row.harness,
    ...opt("conversation", row.conversationId),
    ...idsOf(row),
});

// One turn as a single JSON line. Absent `outcome` predates the field; distinct from success, so it reads `unrecorded`.
const turnRow = (row: UsageTurn): string =>
    JSON.stringify({
        at: new Date(row.at).toISOString(),
        outcome: row.outcome ?? "unrecorded",
        ...opt("errorCode", row.errorCode),
        ...opt("error", row.errorMessage),
        ...workOf(row),
        ...roomOf(row),
        ...ranOn(row),
        costUsd: row.costUsd,
        durationMs: row.durationMs,
    });

const sinceOf = (now: number, minutes: number | undefined): number | undefined =>
    minutes === undefined ? undefined : now - Math.min(minutes, DIAGNOSTICS_MAX_MINUTES) * 60_000;

const windowOf = (now: number, minutes: number | undefined): Window => ({ sinceMs: sinceOf(now, minutes), now });

// The post-mortems boot-marker.ts filed with each unclean restart (system/boot/restarts/post-mortem.ts), one line each:
// the named cause, its sentence, and the conversations whose own process was killed (their cut turns are held, not
// resumed). Listed beside the boots rather than folded into their lines, so a row from a build that did not know the
// named endings still reads, and the culprits stand out.
const postMortemLines = (filed: readonly FiledPostMortem[], limit: number): string[] =>
    filed.length === 0
        ? []
        : [
              "",
              `Post-mortems of the unclean stops among them, newest first (cause: memory, netd-stuck, oom-victim or unknown):`,
              ...filed
                  .slice(0, limit)
                  .map(
                      ({ at, ended, postMortem }) =>
                          `${new Date(at).toISOString()} ${postMortem.cause}${ended === undefined ? "" : ` (ended ${ended})`}: ${postMortem.summary}${postMortem.culprits.length === 0 ? "" : ` [held as culprits: ${postMortem.culprits.join(", ")}]`}`,
                  ),
          ];

type QueryOf<Name extends DiagnosticsQuery["query"]> = Extract<DiagnosticsQuery, { readonly query: Name }>;

// An absolute window when `from` or `until` names one, else the usual one reaching back from now.
const errorsWindow = (now: number, ask: QueryOf<"errors">): Window & { readonly untilMs?: number | undefined } => {
    const untilMs = ask.until === undefined ? undefined : Date.parse(ask.until);
    return {
        sinceMs: ask.from === undefined ? sinceOf(now, ask.sinceMinutes) : Date.parse(ask.from),
        now: untilMs ?? now,
        ...opt("untilMs", untilMs),
    };
};

const errors = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"errors">): Promise<string> => {
    const browser = ask.source === "browser";
    const file = browser ? "client.jsonl" : "daemon.log";
    const floor: LevelName = ask.level ?? "warn";
    const window = errorsWindow(now, ask);
    const shown = ask.limit ?? DEFAULT_LINES;
    const result = await readLogLines(deps.historyRoot, { file, level: floor, sinceMs: window.sinceMs, untilMs: window.untilMs, contains: ask.contains, limit: shown });
    // Labeled "browser reports" so a browser's self-account reads as distinct from the daemon's own.
    return renderLines(result, {
        what: browser ? "browser reports" : "lines",
        file,
        level: floor,
        window,
        group: ask.group,
        stacks: ask.stacks === true,
        limit: shown,
    });
};

const slow = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"slow">): Promise<string> => {
    const window = windowOf(now, ask.sinceMinutes);
    const shown = ask.limit ?? DEFAULT_LINES;
    if (ask.source === "rollups") {
        const grouping = ask.groupBy === "op" || ask.groupBy === undefined ? "op" : "op+path";
        return renderRollups(await readRollups(deps.historyRoot, { sinceMs: window.sinceMs, op: ask.op, groupBy: grouping }), { window, grouping, limit: shown });
    }
    const grouping = ask.groupBy === "op+path" ? "op+path" : "op";
    const result = await readSlowSpans(deps.historyRoot, { sinceMs: window.sinceMs, op: ask.op, groupBy: grouping, limit: shown });
    return renderSpans(result, {
        what: "slow spans",
        file: "perf.jsonl",
        window,
        group: ask.groupBy === undefined ? undefined : ask.groupBy !== "none",
        grouping,
        stacks: false,
        limit: shown,
    });
};

const turns = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"turns">): Promise<string> => {
    const since = sinceOf(now, ask.sinceMinutes);
    // Ledger windows by UTC day; fetch the day floor, then filter exactly on `at` for the minute-level window.
    const rows = await deps.usage.turns(since === undefined ? {} : { from: utcDay(since) });
    const matching = rows.filter(
        (row) =>
            (since === undefined || row.at >= since) &&
            (ask.conversationId === undefined || row.conversationId === ask.conversationId) &&
            matchesOnly(row, ask.only),
    );
    if (matching.length === 0) {
        return "No turns match. The ledger holds every turn since the sandbox was created, so an empty answer here means the filter, not the history.";
    }
    const shown = matching.slice(-(ask.limit ?? DEFAULT_LINES)).toReversed();
    const failed = matching.filter((row) => row.outcome === "error").length;
    const cut = matching.filter(interrupted).length;
    return [
        // Counted separately because each is invisible in the rows: unproven work and a turn that never acted both look
        // identical to a finished one.
        `${matching.length} turns, ${failed} failed, ${cut > 0 ? `${cut} interrupted, ` : ""}${matching.filter(unproven).length} finished with unproven code changes, ${matching.filter(silent).length} ran without calling a tool. Newest ${shown.length} below.`,
        "",
        ...shown.map(turnRow),
    ].join("\n");
};

const resources = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"resources">): Promise<string> => {
    const window = windowOf(now, ask.sinceMinutes);
    const series = await readMetricSeries(deps.historyRoot, { field: ask.field, sinceMs: window.sinceMs, limit: ask.limit ?? DEFAULT_LINES });
    return renderSeries(series, window);
};

const restarts = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"restarts">): Promise<string> => {
    const window = windowOf(now, ask.sinceMinutes);
    const shown = ask.limit ?? DEFAULT_LINES;
    const boots = renderRestarts(await readRestarts(deps.historyRoot, { sinceMs: window.sinceMs }), window, shown);
    return [boots, ...postMortemLines(readFiledPostMortems(logsRoot(deps.historyRoot), window.sinceMs), shown)].join("\n");
};

const timeline = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"timeline">): Promise<string> => {
    const window = windowOf(now, ask.sinceMinutes);
    const result = await readTimeline(deps.historyRoot, deps.usage, {
        conversationId: ask.conversationId,
        sinceMs: window.sinceMs,
        level: ask.level ?? "info",
        limit: ask.limit ?? 100,
    });
    return renderTimeline(result, ask.conversationId, window);
};

const failures = async (deps: DiagnosticsDeps, now: number, ask: QueryOf<"failures">): Promise<string> =>
    commandFailuresAnswer(deps.historyRoot, {
        window: windowOf(now, ask.sinceMinutes),
        sinceMs: sinceOf(now, ask.sinceMinutes),
        conversationId: ask.conversationId,
        contains: ask.contains,
        group: ask.group ?? ask.conversationId === undefined,
        limit: ask.limit,
    });

/** One diagnostics query, answered as text. */
export const runDiagnosticsQuery = async (deps: DiagnosticsDeps, ask: DiagnosticsQuery): Promise<string> => {
    const now = (deps.now ?? Date.now)();
    switch (ask.query) {
        case "errors":
            return errors(deps, now, ask);
        case "slow":
            return slow(deps, now, ask);
        case "turns":
            return turns(deps, now, ask);
        case "resources":
            return resources(deps, now, ask);
        case "restarts":
            return restarts(deps, now, ask);
        case "timeline":
            return timeline(deps, now, ask);
        case "failures":
            return failures(deps, now, ask);
    }
};
