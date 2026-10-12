import { join } from "node:path";
import { oneLine } from "@intentic/base/one-line";
import { type ActivityEvent, ActivityEventSchema, type UsageTurn } from "@intentic/sandbox-contract";
import { z } from "zod";
import { activityLogDocument } from "../activity/activity-store.js";
import { opt } from "../opt.js";
import { isJsonObject, type JsonObject } from "../store/evolution/conversions.js";
import { openDocument } from "../store/open-document.js";
import { bootHistoryDocument } from "../system/boot/restarts/boot-history.js";
import { describePreviousRun, type PreviousRun, RESTARTS_FILE, type RunEnding } from "../system/boot/restarts/restart-record.js";
import { utcDay, type UsageStore } from "../usage/usage-store.js";
import { compactRecord } from "./diagnostics-shape.js";
import { type LevelName, readLogLines } from "./diagnostics.js";
import { logsRoot } from "./log-files.js";
import { parseRecord, type ScanCoverage, scanNewestFirst } from "./log-read.js";

// The two questions agents used to answer by grepping /history by hand: when did the daemon restart and why, and what
// happened to one conversation, in order, across every record that names it.

const BUDGET_BYTES = 16_000_000;
const TEXT_CHARS = 240;
// Boots read off two records within this of each other are the same boot.
const SAME_BOOT_MS = 120_000;

// ---- restarts ----

export interface BootRow {
    readonly at: number;
    // What is known about the boot and the run before it, without its time.
    readonly text: string;
}

export interface RestartsResult {
    // Which record answered: the daemon's own restart log, or (on a daemon that predates it) bare boot times.
    readonly source: "restarts.jsonl" | "boot-history";
    // Newest first.
    readonly rows: readonly BootRow[];
}

// A field that may be missing or malformed on a row some other build wrote: read as absent rather than losing the row.
const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

// The row boot-marker.ts appends (RestartRecord in restart-record.ts), read leniently: rows from older and newer builds
// lack or add fields, and a diagnosis wants every boot even when its account of the run before is partial.
const RestartRowSchema = z.object({
    boot: z.object({ pid: loose(z.number()), version: loose(z.string()), commit: loose(z.string()) }).catch({}),
    previous: loose(
        z.object({
            ended: loose(z.enum(["stopped", "exited", "crashed", "killed", "unknown"])),
            graceful: loose(z.boolean()),
            uptimeSeconds: loose(z.number()),
            signal: loose(z.string()),
            exitCode: loose(z.number()),
            reason: loose(z.string()),
            intent: loose(
                z.object({
                    at: z.string().catch(""),
                    by: z.string().catch("someone"),
                    host: loose(z.string()),
                    side: loose(z.string()),
                    action: z.string().catch("restart"),
                    reason: z.string().catch(""),
                    checks: loose(z.array(z.string())),
                }),
            ),
            fatalReports: loose(z.array(z.string())),
            containerRestarted: loose(z.boolean()),
            tmpCleared: loose(z.boolean()),
        }),
    ),
});

type RestartRow = z.infer<typeof RestartRowSchema>;

// A row that predates `ended` still says whether the stop was graceful.
const endingOf = (previous: NonNullable<RestartRow["previous"]>): RunEnding =>
    previous.ended ?? (previous.graceful === true ? "stopped" : previous.graceful === false ? "killed" : "unknown");

const restartText = (row: RestartRow): string => {
    const build = [row.boot.version, row.boot.commit?.slice(0, 12)].filter((part) => part !== undefined).join(" ");
    const booted = `booted${row.boot.pid === undefined ? "" : ` pid ${row.boot.pid}`}${build === "" ? "" : ` (${build})`}`;
    const previous = row.previous;
    if (previous === undefined) {
        return `${booted}; nothing recorded about the run before.`;
    }
    const ended = endingOf(previous);
    const run: PreviousRun = {
        ended,
        graceful: ended === "stopped",
        ...opt("uptimeSeconds", previous.uptimeSeconds),
        ...opt("signal", previous.signal),
        ...opt("exitCode", previous.exitCode),
        ...opt("reason", previous.reason),
        ...opt("intent", previous.intent),
        ...opt("fatalReports", previous.fatalReports),
        ...opt("containerRestarted", previous.containerRestarted),
        ...opt("tmpCleared", previous.tmpCleared),
    };
    return `${booted}; the run before ${describePreviousRun(run)}.`;
};

// Boots where the resource series' uptime starts over: reaches back as far as the series (a week), where
// boot-history.json keeps a day.
const uptimeBoots = async (historyRoot: string, sinceMs: number | undefined): Promise<number[]> => {
    const boots: number[] = [];
    let newerUptime: number | undefined;
    const UPTIME = /"uptimeSeconds":(\d+(?:\.\d+)?)/;
    await scanNewestFirst([join(logsRoot(historyRoot), "resource-metrics.jsonl")], { sinceMs, budgetBytes: 48_000_000 }, (raw, at) => {
        const found = UPTIME.exec(raw);
        if (found === null || at === undefined) {
            return;
        }
        const uptime = Number(found[1]);
        // Read newest first: the newest sample, and any older one whose uptime exceeds the newer one's, belong to a run
        // that began `uptime` before it.
        if (newerUptime === undefined || uptime > newerUptime) {
            boots.push(at - uptime * 1000);
        }
        newerUptime = uptime;
    });
    return boots;
};

const bareBoots = async (historyRoot: string, sinceMs: number | undefined): Promise<BootRow[]> => {
    const recorded = await openDocument(bootHistoryDocument, join(historyRoot, bootHistoryDocument.path), { fallback: () => ({ boots: [] }) }).read();
    const all = [...recorded.boots, ...(await uptimeBoots(historyRoot, sinceMs))].toSorted((a, b) => b - a);
    const distinct = all.filter((at, index) => index === 0 || (all[index - 1] ?? at) - at > SAME_BOOT_MS);
    return distinct
        .filter((at) => sinceMs === undefined || at >= sinceMs)
        .map((at) => ({ at, text: `booted (why the run before ended is not recorded by this daemon version)` }));
};

export const readRestarts = async (historyRoot: string, query: { readonly sinceMs?: number | undefined }): Promise<RestartsResult> => {
    const rows: BootRow[] = [];
    const coverage = await scanNewestFirst([join(logsRoot(historyRoot), RESTARTS_FILE)], { sinceMs: query.sinceMs, budgetBytes: BUDGET_BYTES }, (raw, at) => {
        const row = RestartRowSchema.safeParse(parseRecord(raw));
        if (row.success && at !== undefined) {
            rows.push({ at, text: restartText(row.data) });
        }
    });
    if (coverage.files.length > 0) {
        return { source: "restarts.jsonl", rows };
    }
    return { source: "boot-history", rows: await bareBoots(historyRoot, query.sinceMs) };
};

// ---- one conversation's timeline ----

export interface TimelineEvent {
    readonly at: number;
    readonly source: "log" | "activity" | "turn" | "boot";
    readonly text: string;
}

export interface TimelineResult {
    // Oldest first, the newest `limit` of everything found.
    readonly events: readonly TimelineEvent[];
    readonly found: Readonly<Record<TimelineEvent["source"], number>>;
    readonly logCoverage: ScanCoverage;
}

// A log line is about the conversation when its context, one of its own fields, or its message names it; a line that
// only mentions it deep inside a list of others (the perf summary's `worst`) is not.
const namesConversation = (line: JsonObject, id: string): boolean => {
    const { ctx, message } = line;
    return (
        (isJsonObject(ctx) && ctx["conversationId"] === id) ||
        Object.values(line).some((value) => value === id || (Array.isArray(value) && value.includes(id))) ||
        String(message ?? "").includes(id)
    );
};

const logText = (line: JsonObject): string => {
    const { time: _time, level, message, ctx: _ctx, ...rest } = compactRecord(line, false);
    const fields = Object.keys(rest).length === 0 ? "" : ` ${JSON.stringify(rest)}`;
    return oneLine(`${String(level)} ${String(message ?? "")}${fields}`, TEXT_CHARS);
};

const isNumber = (value: unknown): value is number => typeof value === "number";

const activityText = (event: ActivityEvent): string => {
    const cost = event.extra?.["costUsd"];
    const duration = event.extra?.["durationMs"];
    const facts = [isNumber(cost) ? `$${cost.toFixed(2)}` : undefined, isNumber(duration) ? `${Math.round(duration / 1000)} s` : undefined]
        .filter((part) => part !== undefined)
        .join(", ");
    const said = event.error ?? event.content;
    return oneLine(
        `${event.type}${event.outcome === undefined ? "" : ` ${event.outcome}`}${event.turnId === undefined ? "" : ` turn ${event.turnId.slice(0, 8)}`}${facts === "" ? "" : ` (${facts})`}${said === undefined ? "" : `: ${said}`}`,
        TEXT_CHARS,
    );
};

const turnText = (row: UsageTurn): string => {
    const error = [row.errorCode, row.errorMessage].filter((part) => part !== undefined).join(": ");
    return oneLine(
        `turn ended ${row.outcome ?? "unrecorded"}${row.turnId === undefined ? "" : ` turn ${row.turnId.slice(0, 8)}`} on ${row.provider}${row.model === undefined ? "" : `/${row.model}`} after ${Math.round(row.durationMs / 1000)} s, $${row.costUsd.toFixed(2)}${row.verification === undefined ? "" : `, ${row.verification}`}${error === "" ? "" : `: ${error}`}`,
        TEXT_CHARS,
    );
};

// Read with the log's own schema (activity-store.ts), line by line, so one torn or foreign line costs only itself.
const activityEvents = async (historyRoot: string, id: string, sinceMs: number | undefined): Promise<TimelineEvent[]> => {
    const events: TimelineEvent[] = [];
    await scanNewestFirst([join(historyRoot, activityLogDocument.path)], { sinceMs, budgetBytes: BUDGET_BYTES }, (raw) => {
        if (!raw.includes(id)) {
            return;
        }
        const event = ActivityEventSchema.safeParse(parseRecord(raw));
        if (event.success && event.data.conversationId === id) {
            events.push({ at: event.data.at, source: "activity", text: activityText(event.data) });
        }
    });
    return events;
};

export const readTimeline = async (
    historyRoot: string,
    usage: Pick<UsageStore, "turns">,
    query: { readonly conversationId: string; readonly sinceMs?: number | undefined; readonly level: LevelName; readonly limit: number },
): Promise<TimelineResult> => {
    const id = query.conversationId;
    const [log, activity, ledger, restarts] = await Promise.all([
        readLogLines(historyRoot, {
            file: "daemon.log",
            level: query.level,
            sinceMs: query.sinceMs,
            contains: id,
            where: (line) => namesConversation(line, id),
            limit: 5_000,
        }),
        activityEvents(historyRoot, id, query.sinceMs),
        usage.turns(query.sinceMs === undefined ? {} : { from: utcDay(query.sinceMs) }),
        readRestarts(historyRoot, { sinceMs: query.sinceMs }),
    ]);
    const logEvents = log.lines.flatMap((line): TimelineEvent[] => {
        const at = Date.parse(String(line["time"] ?? ""));
        return Number.isNaN(at) ? [] : [{ at, source: "log", text: logText(line) }];
    });
    const turnEvents = ledger
        .filter((row) => row.conversationId === id && (query.sinceMs === undefined || row.at >= query.sinceMs))
        .map((row): TimelineEvent => ({ at: row.at, source: "turn", text: turnText(row) }));
    const all = [...logEvents, ...activity, ...turnEvents];
    // Restarts only inside the span the conversation's own events cover: a boot a week before it says nothing about it.
    const first = Math.min(...all.map((event) => event.at));
    const last = Math.max(...all.map((event) => event.at));
    const boots = restarts.rows.filter((row) => row.at >= first && row.at <= last).map((row): TimelineEvent => ({ at: row.at, source: "boot", text: row.text }));
    const merged = [...all, ...boots].toSorted((a, b) => a.at - b.at);
    return {
        events: merged.slice(-query.limit),
        found: { log: logEvents.length, activity: activity.length, turn: turnEvents.length, boot: boots.length },
        logCoverage: log.coverage,
    };
};
