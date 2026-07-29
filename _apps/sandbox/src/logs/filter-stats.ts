import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DayWindowQuery, InputSavings } from "@intentic/sandbox-contract";
import { utcDay } from "../usage/usage-store.js";
import { logsRoot } from "./log-files.js";

// The input-side savings report — shell output the cleaners trimmed before the model saw it — read from
// whichever backend is ACTUALLY compressing the agent's output (`filterBackend`), because only that backend's
// ledger is being written:
//
//   native — historyRoot/logs/filter-stats.jsonl, one row per agent Bash command written by
//            bin/agent-output-filter. Its aggregation mirrors bin/filter-stats.mjs `summarizeStats` — the
//            offline bench uses the .mjs, the daemon route uses this typed twin; same numbers, two runtimes
//            (the accepted pattern the bench already follows for estimateTokens). Only the numbers mirror:
//            the bench is handed a ledger path outright, so it needs neither backend choice nor provenance.
//   rtk    — `rtk gain`, rtk's own savings ledger. Under this backend agent.ts sets INTENTIC_RUN_FILTER=0, so
//            agent-output-filter never runs and the jsonl above is frozen at whatever last wrote it. Reading it
//            anyway is what made this card report a stale ledger — a test run's rows, in the case that surfaced
//            this — as though it were live agent traffic.
//
// A missing/empty/unreadable ledger reads as a zeroed report — the card hides itself at zero commands rather
// than inventing a number.

const execFileAsync = promisify(execFile);

// One telemetry row — loose, because an older row may predate a field and a corrupt line is skipped.
interface StatRow {
    readonly ts?: number;
    readonly rawBytes?: number;
    readonly emittedBytes?: number;
    readonly matched?: string[];
    readonly heldOut?: boolean;
    readonly command?: string;
    // Bytes each mechanism removed on this command, keyed by stage id (negative ⇒ added, i.e. the footer).
    readonly stageBytes?: Record<string, number>;
}

const tokens = (bytes: number): number => Math.round(bytes / 4);
const sumBytes = (rows: StatRow[], key: "rawBytes" | "emittedBytes"): number => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const avgBytes = (rows: StatRow[], key: "rawBytes" | "emittedBytes"): number => (rows.length === 0 ? 0 : sumBytes(rows, key) / rows.length);

const parseRows = (text: string): StatRow[] =>
    text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as StatRow];
            } catch {
                return [];
            }
        });

const zeroed = (source: "native" | "rtk", windowed: boolean): InputSavings => ({
    source,
    windowed,
    commands: 0,
    rawTokens: 0,
    emittedTokens: 0,
    savedPct: 0,
    perCleaner: [],
    holdout: { cleaned: 0, heldOut: 0 },
    gaps: [],
});

// `rtk gain --format json` — rtk's own ledger, the only record of what rtk saved (it runs the command, so the
// uncompressed output never reaches us to measure). Totals only: rtk attributes no per-command cleaner ids,
// keeps no held-out control, and stamps no timestamp on what it reports — so perCleaner/holdout/gaps stay
// empty, `windowed` is false, and the card says all-time instead of letting a 7-day filter mislabel it.
// input/output are already token counts, not bytes.
interface RtkGain {
    readonly summary?: {
        readonly total_commands?: number;
        readonly total_input?: number;
        readonly total_output?: number;
    };
}

// rtk's ledger is a sqlite file under the XDG data dir; its mtime is the closest thing to "when a command was
// last recorded", since `gain` reports no timestamp. Best-effort — an unknown age just goes unshown.
const rtkLedgerMtime = async (): Promise<number | undefined> => {
    const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
    return stat(join(dataHome, "rtk", "history.db")).then(
        (info) => Math.round(info.mtimeMs),
        () => undefined,
    );
};

const readRtkSavings = async (): Promise<InputSavings> => {
    let gain: RtkGain;
    try {
        // Global scope (not --project): the agent's commands run all over the sandbox, not in one repo.
        const { stdout } = await execFileAsync("rtk", ["gain", "--format", "json"], { timeout: 5_000 });
        gain = JSON.parse(stdout) as RtkGain;
    } catch {
        // rtk absent from the image, or a version whose `gain` speaks a different dialect — report nothing
        // rather than a stale number from the other backend's ledger.
        return zeroed("rtk", false);
    }
    const commands = gain.summary?.total_commands ?? 0;
    const rawTokens = gain.summary?.total_input ?? 0;
    const emittedTokens = gain.summary?.total_output ?? 0;
    // Derived from the totals the card also shows, so its arithmetic reads consistently (rtk's own
    // avg_savings_pct is a mean over commands and disagrees with the totals line by a point or two).
    const savedPct = rawTokens === 0 ? 0 : Math.round(((rawTokens - emittedTokens) / rawTokens) * 100);
    const updatedAt = await rtkLedgerMtime();
    return { ...zeroed("rtk", false), commands, rawTokens, emittedTokens, savedPct, ...(updatedAt !== undefined ? { updatedAt } : {}) };
};

const readLedgerSavings = async (historyRoot: string, window: DayWindowQuery): Promise<InputSavings> => {
    const path = join(logsRoot(historyRoot), "filter-stats.jsonl");
    const all = await readFile(path, "utf8").then(parseRows, () => []);
    // The reader's window, on the ledger's own calendar (the UTC day the command ran). A row with no timestamp
    // predates nothing this report can place in time, so a bounded window drops it rather than pool it in.
    const rows = all.filter((row) => {
        if (window.from === undefined && window.to === undefined) {
            return true;
        }
        if (typeof row.ts !== "number") {
            return false;
        }
        const day = utcDay(row.ts);
        return (window.from === undefined || day >= window.from) && (window.to === undefined || day <= window.to);
    });

    // Held-out commands bypassed cleaning (the measurement control) — excluded from saved-% and gaps.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sumBytes(cleaned, "rawBytes");
    const cleanedEmitted = sumBytes(cleaned, "emittedBytes");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    // Per-mechanism attribution: bytes removed, summed over the commands each stage ran on. Sequential — every
    // stage was weighed against what reached it — so these sum to raw − emitted and can be stacked. Commands
    // count the rows the stage RAN on, including the ones where it removed nothing: "fired and was worth
    // nothing" and "never ran" are different facts about a cleaner.
    const stages = new Map<string, { commands: number; bytes: number }>();
    for (const row of cleaned) {
        for (const [id, bytes] of Object.entries(row.stageBytes ?? {})) {
            const current = stages.get(id) ?? { commands: 0, bytes: 0 };
            stages.set(id, { commands: current.commands + 1, bytes: current.bytes + bytes });
        }
    }
    const perCleaner = [...stages.entries()]
        .map(([id, entry]) => ({ id, commands: entry.commands, savedTokens: tokens(entry.bytes) }))
        .toSorted((a, b) => b.savedTokens - a.savedTokens);

    // Measured saving: avg emitted tokens on cleaned commands vs avg raw tokens on the held-out control (a random
    // sample of the same command stream) — a real reduction, not a per-command estimate. Absent without a holdout.
    const avgRawHeld = avgBytes(held, "rawBytes");
    const avgEmittedCleaned = avgBytes(cleaned, "emittedBytes");
    const measuredSavedPct = held.length > 0 && avgRawHeld > 0 ? Math.round((1 - avgEmittedCleaned / avgRawHeld) * 100) : undefined;

    const gaps = cleaned
        .filter((row) => (row.matched === undefined || row.matched.length === 0) && (row.rawBytes ?? 0) > 2000)
        .toSorted((a, b) => (b.rawBytes ?? 0) - (a.rawBytes ?? 0))
        .slice(0, 15)
        .map((row) => ({ command: (row.command ?? "").slice(0, 80), tokens: tokens(row.rawBytes ?? 0) }));

    // The newest row's own timestamp, not the file's mtime — the ledger is pruned in place (log-files.ts
    // copy-truncates), which touches mtime without a command having run.
    const updatedAt = rows.reduce<number | undefined>(
        (newest, row) => (typeof row.ts === "number" && row.ts > (newest ?? 0) ? row.ts : newest),
        undefined,
    );

    return {
        source: "native",
        windowed: true,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        commands: rows.length,
        rawTokens: tokens(sumBytes(rows, "rawBytes")),
        emittedTokens: tokens(sumBytes(rows, "emittedBytes")),
        savedPct,
        perCleaner,
        holdout: { cleaned: cleaned.length, heldOut: held.length, ...(measuredSavedPct !== undefined ? { measuredSavedPct } : {}) },
        gaps,
    };
};

// The report for the backend that is actually compressing output. `backend` is the live `filterBackend` setting;
// route it wrong and the card reports a ledger nobody is writing. The window is ignored under rtk, which reports
// no timestamps — hence `windowed: false` on what comes back, so the screen can say which calendar it is on.
export const readInputSavings = async (historyRoot: string, backend: "native" | "rtk", window: DayWindowQuery): Promise<InputSavings> =>
    backend === "rtk" ? readRtkSavings() : readLedgerSavings(historyRoot, window);
