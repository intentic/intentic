import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { opt } from "../opt.js";
import { logsRoot } from "../seams/logs-root.js";
import { capLines } from "./diagnostics-shape.js";
import { MAX_ANSWER_CHARS, reachText, type Window, windowText } from "./diagnostics-render.js";
import { logPaths, LOG_BUDGET_BYTES } from "./diagnostics.js";
import { COMMAND_RUNS_FILE } from "./log-files.js";
import { parseRecord, type ScanCoverage, scanNewestFirst } from "./log-read.js";

/* THE COMMANDS AGENTS RAN THAT FAILED, KEPT ACROSS CONVERSATIONS (historyRoot/logs/command-runs.jsonl).

   Two kinds of line, appended when a turn settles (agent/run/frames/command-runs.ts folds them from its frames):
   - `failure`: one shell call that failed or never started, with the program it ran, the line that says why, and what
     the same agent ran clean right after it;
   - `turn`: what ran clean in that turn, program by program, so a failure that STOPPED can be told from one nobody ran
     again. A kind of failure reads as stopped once its program has run clean in other conversations since it last
     failed, as quiet once it has neither failed nor run clean for a while, and as ongoing otherwise.

   Kept a month (log-files.ts ARCHIVED), read back newest first by the `diagnostics failures` query. Nothing here is
   sent to a model unasked: the record is for whoever looks, a person or an agent. */

// A kind of failure is stopped once its program ran clean in this many other conversations since it last failed.
const STOPPED_AFTER_CONVERSATIONS = 2;
// And quiet once it has not failed for this long without being run clean enough to call it stopped.
const QUIET_AFTER_MS = 3 * 24 * 3_600_000;
const DEFAULT_ROWS = 40;
const COMMAND_SHOWN = 160;

const FailureLineSchema = z.object({
    at: z.number(),
    kind: z.literal("failure"),
    conversationId: z.string().optional(),
    turnId: z.string().optional(),
    runtime: z.string().optional(),
    model: z.string().optional(),
    program: z.string(),
    signature: z.string(),
    command: z.string(),
    exit: z.number().optional(),
    unstarted: z.literal(true).optional(),
    error: z.string(),
    tail: z.string(),
    subagent: z.literal(true).optional(),
    instead: z.string().optional(),
});
export type CommandFailureLine = z.infer<typeof FailureLineSchema>;

const TurnLineSchema = z.object({
    at: z.number(),
    kind: z.literal("turn"),
    conversationId: z.string().optional(),
    turnId: z.string().optional(),
    failed: z.number(),
    ran: z.record(z.string(), z.number()),
});
export type CommandTurnLine = z.infer<typeof TurnLineSchema>;

const LineSchema = z.discriminatedUnion("kind", [FailureLineSchema, TurnLineSchema]);
export type CommandRunLine = z.infer<typeof LineSchema>;

// What a failure says once the parts that differ between two runs of the same failure are taken out: ids, paths,
// quoted names, hashes and numbers.
const errorTemplate = (error: string): string =>
    error
        .slice(0, 200)
        .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
        .replaceAll(/`[^`]*`|"[^"]*"|'[^']*'/g, "<name>")
        .replaceAll(/(?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?/g, "<path>")
        .replaceAll(/\b[0-9a-f]{7,}\b/gi, "<hex>")
        .replaceAll(/\d+(?:\.\d+)?/g, "<n>");

/** What one kind of failure is grouped by: the program, and what it said once the varying parts are out. */
export const commandSignature = (program: string, error: string): string => `${program} · ${errorTemplate(error)}`;

// One failure as the turn folded it; structurally the agent's CommandFailure, named here so logs/ needs nothing of agent/.
export interface FailedCommand {
    readonly command: string;
    readonly program: string;
    readonly exit?: number;
    readonly unstarted?: true;
    readonly error: string;
    readonly tail: string;
    readonly subagent?: true;
    readonly instead?: string;
}

export interface TurnCommands {
    readonly failures: readonly FailedCommand[];
    readonly failed: number;
    readonly ran: Readonly<Record<string, number>>;
}

export interface CommandTurn {
    readonly at: number;
    readonly conversationId?: string | undefined;
    readonly turnId?: string | undefined;
    readonly runtime?: string | undefined;
    readonly model?: string | undefined;
}

/** The lines one settled turn adds: its failures, then what ran clean. None for a turn that ran no command. */
export const commandRunLines = (turn: CommandTurn, runs: TurnCommands): CommandRunLine[] => {
    if (runs.failed === 0 && Object.keys(runs.ran).length === 0) {
        return [];
    }
    // `at` first: the log reader takes a line's stamp from its first `at` key without parsing it (log-read.ts).
    const ids = { ...opt("conversationId", turn.conversationId), ...opt("turnId", turn.turnId) };
    const failures = runs.failures.map(
        (failure): CommandFailureLine => ({
            at: turn.at,
            kind: "failure",
            ...ids,
            ...opt("runtime", turn.runtime),
            ...opt("model", turn.model),
            ...failure,
            signature: commandSignature(failure.program, failure.error),
        }),
    );
    return [...failures, { at: turn.at, kind: "turn", ...ids, failed: runs.failed, ran: { ...runs.ran } }];
};

/** Appends a settled turn's lines; one write, so two turns settling together never interleave inside a line. */
export const appendCommandRuns = async (historyRoot: string, lines: readonly CommandRunLine[]): Promise<void> => {
    if (lines.length === 0 || historyRoot === "") {
        return;
    }
    const dir = logsRoot(historyRoot);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, COMMAND_RUNS_FILE), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
};

interface ReadQuery {
    readonly sinceMs?: number | undefined;
    readonly conversationId?: string | undefined;
    readonly contains?: string | undefined;
}

interface ReadResult {
    // Newest first.
    readonly failures: readonly CommandFailureLine[];
    readonly turns: readonly CommandTurnLine[];
    readonly coverage: ScanCoverage;
}

const readCommandRuns = async (historyRoot: string, query: ReadQuery): Promise<ReadResult> => {
    const failures: CommandFailureLine[] = [];
    const turns: CommandTurnLine[] = [];
    const needle = query.contains?.toLowerCase();
    const coverage = await scanNewestFirst(await logPaths(historyRoot, COMMAND_RUNS_FILE), { sinceMs: query.sinceMs, budgetBytes: LOG_BUDGET_BYTES }, (raw) => {
        const parsed = LineSchema.safeParse(parseRecord(raw));
        if (!parsed.success) {
            return;
        }
        const line = parsed.data;
        if (line.kind === "turn") {
            // Every conversation's clean runs, whatever the filter: they are what says a failure stopped.
            turns.push(line);
        } else if ((query.conversationId === undefined || line.conversationId === query.conversationId) && (needle === undefined || raw.toLowerCase().includes(needle))) {
            failures.push(line);
        }
    });
    return { failures, turns, coverage };
};

type Standing = "ongoing" | "stopped" | "quiet";

interface FailureKind {
    readonly signature: string;
    readonly program: string;
    readonly newest: CommandFailureLine;
    count: number;
    oldestAt: number;
    readonly conversations: Set<string>;
    unstarted: boolean;
}

const kindsOf = (failures: readonly CommandFailureLine[]): FailureKind[] => {
    const kinds = new Map<string, FailureKind>();
    for (const line of failures) {
        const known = kinds.get(line.signature);
        if (known === undefined) {
            kinds.set(line.signature, {
                signature: line.signature,
                program: line.program,
                newest: line,
                count: 1,
                oldestAt: line.at,
                conversations: new Set(line.conversationId === undefined ? [] : [line.conversationId]),
                unstarted: line.unstarted === true,
            });
            continue;
        }
        known.count += 1;
        known.oldestAt = line.at;
        known.unstarted ||= line.unstarted === true;
        if (line.conversationId !== undefined) {
            known.conversations.add(line.conversationId);
        }
    }
    return [...kinds.values()];
};

// Other conversations whose turns ran the program clean after the kind last failed.
const cleanSince = (kind: FailureKind, turns: readonly CommandTurnLine[]): number => {
    const since = new Set<string>();
    for (const turn of turns) {
        if (turn.at > kind.newest.at && turn.conversationId !== undefined && turn.conversationId !== kind.newest.conversationId && (turn.ran[kind.program] ?? 0) > 0) {
            since.add(turn.conversationId);
        }
    }
    return since.size;
};

const standingOf = (kind: FailureKind, clean: number, now: number): Standing => {
    if (clean >= STOPPED_AFTER_CONVERSATIONS) {
        return "stopped";
    }
    return now - kind.newest.at > QUIET_AFTER_MS ? "quiet" : "ongoing";
};

const STANDING_ORDER = { ongoing: 0, quiet: 1, stopped: 2 } as const satisfies Record<Standing, number>;

const ago = (now: number, at: number): string => {
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

const shown = (command: string): string => {
    const line = command.replaceAll(/\s+/g, " ").trim();
    return `\`${line.length > COMMAND_SHOWN ? `${line.slice(0, COMMAND_SHOWN)}…` : line}\``;
};

const exitText = (line: CommandFailureLine): string => (line.unstarted === true ? "never started" : line.exit === undefined ? "failed" : `exit ${line.exit}`);

interface Judged {
    readonly kind: FailureKind;
    readonly clean: number;
    readonly standing: Standing;
}

const kindRows = ({ kind, clean, standing }: Judged, now: number): string[] => {
    const conversations = kind.conversations.size;
    const facts = [
        `${conversations} conversation${conversations === 1 ? "" : "s"}, ${kind.count}×`,
        `last ${ago(now, kind.newest.at)}`,
        ...(kind.unstarted ? ["never started"] : []),
        ...(clean > 0 ? [`ran clean in ${clean} other conversation${clean === 1 ? "" : "s"} since`] : []),
    ];
    const example = kind.newest;
    return [
        `${standing} · ${facts.join(" · ")}`,
        `  ${kind.signature}`,
        `  e.g. ${shown(example.command)} (${exitText(example)})${example.instead === undefined ? "" : ` → then ${shown(example.instead)}`}`,
    ];
};

interface FailuresView {
    readonly window: Window;
    readonly group: boolean;
    readonly limit: number | undefined;
}

const capped = (head: readonly string[], rows: readonly string[]): string => {
    const { kept, dropped } = capLines(rows, MAX_ANSWER_CHARS - head.join("\n").length);
    return [...head, ...kept, ...(dropped > 0 ? [`… ${dropped} more lines not shown. Narrow the window, the conversation or \`contains\`.`] : [])].join("\n");
};

const groupedRows = (result: ReadResult, now: number, limit: number) => {
    const kinds = kindsOf(result.failures)
        .map((kind): Judged => {
            const clean = cleanSince(kind, result.turns);
            return { kind, clean, standing: standingOf(kind, clean, now) };
        })
        .toSorted(
            (a, b) =>
                b.kind.conversations.size - a.kind.conversations.size ||
                STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] ||
                b.kind.newest.at - a.kind.newest.at,
        );
    const recurring = kinds.filter(({ kind }) => kind.conversations.size >= 2).length;
    return {
        head:
            `${kinds.length} kinds, ${recurring} of them in two or more conversations; most widespread first. ` +
            `ongoing: failed lately and not run clean elsewhere since; stopped: ran clean in ${STOPPED_AFTER_CONVERSATIONS}+ other ` +
            `conversations since it last failed; quiet: no failure in ${QUIET_AFTER_MS / 86_400_000} days and too few clean runs to say.`,
        rows: kinds.slice(0, limit).flatMap((judged) => kindRows(judged, now)),
    };
};

const failureRow = (line: CommandFailureLine): string =>
    [
        `${new Date(line.at).toISOString()}  ${line.conversationId ?? "-"}${line.subagent === true ? " (subagent)" : ""}  ${exitText(line)}  ${shown(line.command)}`,
        `  ${line.error === "" ? "(printed nothing)" : line.error}`,
        ...(line.instead === undefined ? [] : [`  → then ${shown(line.instead)}`]),
    ].join("\n");

/** The `failures` query's answer: kinds of failure across conversations, or one by one, newest first. */
export const commandFailuresAnswer = async (historyRoot: string, query: ReadQuery & FailuresView): Promise<string> => {
    const result = await readCommandRuns(historyRoot, query);
    const reach = reachText(result.coverage, query.window, COMMAND_RUNS_FILE);
    if (result.failures.length === 0) {
        return [`No failed commands ${windowText(query.window)}${query.conversationId === undefined ? "" : ` in ${query.conversationId}`}.`, reach].join("\n");
    }
    const conversations = new Set(result.failures.flatMap((line) => (line.conversationId === undefined ? [] : [line.conversationId]))).size;
    const unstarted = result.failures.filter((line) => line.unstarted === true).length;
    const summary =
        `${result.failures.length} failed commands ${windowText(query.window)}` +
        `${unstarted > 0 ? ` (${unstarted} never started)` : ""}, in ${conversations} conversation${conversations === 1 ? "" : "s"}.`;
    const limit = query.limit ?? DEFAULT_ROWS;
    if (query.group) {
        const grouped = groupedRows(result, query.window.now, limit);
        return capped([summary, reach, grouped.head, ""], grouped.rows);
    }
    return capped([summary, reach, `Newest ${Math.min(limit, result.failures.length)} below.`, ""], result.failures.slice(0, limit).map(failureRow));
};
