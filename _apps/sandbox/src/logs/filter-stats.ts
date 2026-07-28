import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CleanerSavings } from "@intentic/sandbox-contract";
import { logsRoot } from "./log-files.js";

// The output-cleaner savings report, read from whichever backend is ACTUALLY compressing the agent's shell
// output (`filterBackend`) — because only that backend's ledger is being written:
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

const zeroed = (source: "native" | "rtk"): CleanerSavings => ({
    source,
    commands: 0,
    rawTokens: 0,
    emittedTokens: 0,
    savedPct: 0,
    perCleaner: [],
    holdout: { cleaned: 0, heldOut: 0 },
    gaps: [],
});

// `rtk gain --format json` — rtk's own ledger, the only record of what rtk saved (it runs the command, so the
// uncompressed output never reaches us to measure). Totals only: rtk attributes no per-command cleaner ids and
// keeps no held-out control, so perCleaner/holdout/gaps stay empty and the card simply omits those sections.
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

const readRtkSavings = async (): Promise<CleanerSavings> => {
    let gain: RtkGain;
    try {
        // Global scope (not --project): the agent's commands run all over the sandbox, not in one repo.
        const { stdout } = await execFileAsync("rtk", ["gain", "--format", "json"], { timeout: 5_000 });
        gain = JSON.parse(stdout) as RtkGain;
    } catch {
        // rtk absent from the image, or a version whose `gain` speaks a different dialect — report nothing
        // rather than a stale number from the other backend's ledger.
        return zeroed("rtk");
    }
    const commands = gain.summary?.total_commands ?? 0;
    const rawTokens = gain.summary?.total_input ?? 0;
    const emittedTokens = gain.summary?.total_output ?? 0;
    // Derived from the totals the card also shows, so its arithmetic reads consistently (rtk's own
    // avg_savings_pct is a mean over commands and disagrees with the totals line by a point or two).
    const savedPct = rawTokens === 0 ? 0 : Math.round(((rawTokens - emittedTokens) / rawTokens) * 100);
    const updatedAt = await rtkLedgerMtime();
    return { ...zeroed("rtk"), commands, rawTokens, emittedTokens, savedPct, ...(updatedAt !== undefined ? { updatedAt } : {}) };
};

const readLedgerSavings = async (historyRoot: string): Promise<CleanerSavings> => {
    const path = join(logsRoot(historyRoot), "filter-stats.jsonl");
    const rows = await readFile(path, "utf8").then(parseRows, () => []);

    // Held-out commands bypassed cleaning (the measurement control) — excluded from saved-% and gaps.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sumBytes(cleaned, "rawBytes");
    const cleanedEmitted = sumBytes(cleaned, "emittedBytes");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    const counts = new Map<string, number>();
    for (const row of cleaned) {
        for (const id of row.matched ?? []) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    const perCleaner = [...counts.entries()].map(([id, commands]) => ({ id, commands })).toSorted((a, b) => b.commands - a.commands);

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
// route it wrong and the card reports a ledger nobody is writing.
export const readCleanerSavings = async (historyRoot: string, backend: "native" | "rtk"): Promise<CleanerSavings> =>
    backend === "rtk" ? readRtkSavings() : readLedgerSavings(historyRoot);
