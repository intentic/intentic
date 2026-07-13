import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CleanerSavings } from "@intentic/sandbox-contract";
import { logsRoot } from "./log-files.js";

// The output-cleaner savings report, aggregated from historyRoot/logs/filter-stats.jsonl (one row per agent Bash
// command, written by bin/agent-output-filter). Mirrors bin/filter-stats.mjs `summarizeStats` — the offline bench
// uses the .mjs, the daemon route uses this typed twin; same numbers, two runtimes (the accepted pattern the bench
// already follows for estimateTokens). A missing/empty ledger reads as a zeroed report.

// One telemetry row — loose, because an older row may predate a field and a corrupt line is skipped.
interface StatRow {
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

export const readCleanerSavings = async (historyRoot: string): Promise<CleanerSavings> => {
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

    return {
        commands: rows.length,
        rawTokens: tokens(sumBytes(rows, "rawBytes")),
        emittedTokens: tokens(sumBytes(rows, "emittedBytes")),
        savedPct,
        perCleaner,
        holdout: { cleaned: cleaned.length, heldOut: held.length, ...(measuredSavedPct !== undefined ? { measuredSavedPct } : {}) },
        gaps,
    };
};
