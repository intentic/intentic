import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseStatsFile, summarizeStats } from "@intentic/output-cleaners/stats";
import type { DayWindowQuery } from "@intentic/sandbox-contract/schemas/providers/usage";
import type { InputSavings } from "@intentic/sandbox-contract/schemas/settings";
import { utcDay } from "../usage/usage-store.js";
import { logsRoot } from "./log-files.js";

// Input-side savings report off historyRoot/logs/filter-stats.jsonl (one row per Bash command, written by the output
// filter). The arithmetic is @intentic/output-cleaners' own summarizeStats, the same reading the Claude Code plugin's
// stats command prints; this module only windows the ledger and dates it. A missing, empty, or unreadable ledger reads as
// a zeroed report, not an error.

// Report for the ledger the cleaners write; the caller's window is applied on the ledger's own calendar (UTC day per
// row).
export const readInputSavings = async (historyRoot: string, window: DayWindowQuery): Promise<InputSavings> => {
    const logsDir = logsRoot(historyRoot);
    const path = join(logsDir, "filter-stats.jsonl");
    const all = await readFile(path, "utf8").then(parseStatsFile, () => []);
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
    // Retrieval log: same directory, sibling file. Missing is normal (no retrievals yet).
    const retrievalPath = join(logsDir, "retrieve-stats.jsonl");
    const retrievals = await readFile(retrievalPath, "utf8").then(parseStatsFile, () => []);
    // Newest row's own timestamp, not mtime: pruning (log-files.ts) touches mtime without a command running.
    const updatedAt = rows.reduce<number | undefined>(
        (newest, row) => (typeof row.ts === "number" && row.ts > (newest ?? 0) ? row.ts : newest),
        undefined,
    );
    return { ...(updatedAt !== undefined ? { updatedAt } : {}), ...summarizeStats(rows, retrievals) };
};
