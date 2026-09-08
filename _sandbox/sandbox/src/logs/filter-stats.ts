import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DayWindowQuery, InputSavings } from "@intentic/sandbox-contract";
import { utcDay } from "../usage/usage-store.js";
import { logsRoot } from "./log-files.js";

// Input-side savings report aggregated from historyRoot/logs/filter-stats.jsonl (one row per Bash command, written by
// bin/agent-output-filter). Mirrors bin/filter-stats.mjs's summarizeStats; same numbers, two runtimes. A missing,
// empty, or unreadable ledger reads as a zeroed report, not an error.

// One telemetry row; fields are optional since an older row may predate one, and a corrupt line is dropped.
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
const sortedBytes = (rows: StatRow[], key: "rawBytes" | "emittedBytes"): number[] => rows.map((row) => row[key] ?? 0).toSorted((a, b) => a - b);
const median = (sorted: number[]): number => sorted[sorted.length >> 1] ?? 0;

// Mann-Whitney U as a z-score, tie-corrected; both arms must already be sorted ascending. Gates the holdout comparison
// below since a heavy-tailed distribution cannot use t-test machinery.
const mannWhitneyZ = (first: number[], second: number[]): number => {
    const n1 = first.length;
    const n2 = second.length;
    const total = n1 + n2;
    if (n1 === 0 || n2 === 0) {
        return 0;
    }
    const merged = [...first.map((value) => ({ value, isFirst: true })), ...second.map((value) => ({ value, isFirst: false }))].toSorted(
        (left, right) => left.value - right.value,
    );
    // Ranks are 1-based, averaged within each tie group; tie correction keeps the variance honest since output sizes
    // (all-zero results) tie constantly. One forward scan: a group spans [start, end), sharing an average rank.
    let rankSum = 0;
    let tieCorrection = 0;
    let start = 0;
    let firstsInGroup = 0;
    let previous: number | undefined;
    const closeGroup = (end: number): void => {
        const tied = end - start;
        if (tied > 1) {
            tieCorrection += tied ** 3 - tied;
        }
        rankSum += firstsInGroup * ((start + end + 1) / 2);
    };
    merged.forEach((entry, position) => {
        if (previous !== undefined && entry.value !== previous) {
            closeGroup(position);
            start = position;
            firstsInGroup = 0;
        }
        previous = entry.value;
        if (entry.isFirst) {
            firstsInGroup++;
        }
    });
    closeGroup(total);
    const u = rankSum - (n1 * (n1 + 1)) / 2;
    const deviation = Math.sqrt(((n1 * n2) / 12) * (total + 1 - tieCorrection / (total * (total - 1))));
    return deviation === 0 ? 0 : (u - (n1 * n2) / 2) / deviation;
};

// Arms smaller than this cannot say anything statistically meaningful.
const MIN_HELD_COMMANDS = 30;
const Z_95 = 1.96;

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

// Commands that matched no cleaner and are still costly, grouped by command line and ranked by total bytes. The per-run
// floor (not per-group) excludes chatter that only adds up in volume.
const GAP_MIN_BYTES = 2000;
const summarizeGaps = (cleaned: StatRow[]): InputSavings["gaps"] => {
    const byCommand = new Map<string, { commands: number; bytes: number }>();
    for (const row of cleaned) {
        if ((row.matched !== undefined && row.matched.length > 0) || (row.rawBytes ?? 0) <= GAP_MIN_BYTES) {
            continue;
        }
        const command = row.command ?? "";
        const current = byCommand.get(command) ?? { commands: 0, bytes: 0 };
        byCommand.set(command, { commands: current.commands + 1, bytes: current.bytes + (row.rawBytes ?? 0) });
    }
    return [...byCommand.entries()]
        .map(([command, entry]) => ({ command, commands: entry.commands, tokens: tokens(entry.bytes) }))
        .toSorted((a, b) => b.tokens - a.tokens)
        .slice(0, 15);
};

// Report for the ledger the cleaners write; the caller's window is applied on the ledger's own calendar (UTC day per
// row).
export const readInputSavings = async (historyRoot: string, window: DayWindowQuery): Promise<InputSavings> => {
    const path = join(logsRoot(historyRoot), "filter-stats.jsonl");
    const all = await readFile(path, "utf8").then(parseRows, () => []);
    // A row with no timestamp is dropped once a window is set; it cannot be placed in time.
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

    // Held-out commands bypassed cleaning (the measurement control), excluded from saved-% and gaps.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sumBytes(cleaned, "rawBytes");
    const cleanedEmitted = sumBytes(cleaned, "emittedBytes");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    // Per-mechanism attribution: bytes removed per stage across the commands it ran on; sums to raw − emitted.
    // `commands` counts rows run on, even removing nothing: fired-but-useless differs from never-ran.
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

    // Median cleaned-vs-held-out ratio, gated by Mann-Whitney significance; the one estimated figure here (`savedPct`
    // above is exact, no control needed). Undefined, not published, below the significance bar.
    const heldRaw = sortedBytes(held, "rawBytes");
    const cleanedEmittedSorted = sortedBytes(cleaned, "emittedBytes");
    const measurable = held.length >= MIN_HELD_COMMANDS && median(heldRaw) > 0 && Math.abs(mannWhitneyZ(cleanedEmittedSorted, heldRaw)) > Z_95;
    const measuredSavedPct = measurable ? Math.round((1 - median(cleanedEmittedSorted) / median(heldRaw)) * 100) : undefined;

    const gaps = summarizeGaps(cleaned);

    // Newest row's own timestamp, not mtime: pruning (log-files.ts) touches mtime without a command running.
    const updatedAt = rows.reduce<number | undefined>(
        (newest, row) => (typeof row.ts === "number" && row.ts > (newest ?? 0) ? row.ts : newest),
        undefined,
    );

    return {
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
