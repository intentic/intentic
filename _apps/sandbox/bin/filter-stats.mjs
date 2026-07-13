// Aggregation over agent-output-filter's telemetry rows (historyRoot/logs/filter-stats.jsonl, one row per agent
// Bash command). The single source of truth for the rtk-`gain`-style savings report — shared by the offline
// bench's `discover` and (mirrored in TS) the daemon's /settings/savings route. Pure + dependency-free so it
// rides the image next to the other bin cleaners and is unit-testable.
//
// Row shape (written by agent-output-filter): { rawBytes, emittedBytes, matched: string[], heldOut: boolean, command }.
// ~4 chars/token, the same heuristic iq-engine's estimateTokens uses.

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const avg = (rows, key) => (rows.length === 0 ? 0 : sum(rows, key) / rows.length);
const tokens = (bytes) => Math.round(bytes / 4);

export const summarizeStats = (rows) => {
    // Held-out commands bypassed cleaning (the measurement control) — exclude them from saved-% and gaps so the
    // cleaned population isn't diluted by rows that were deliberately left raw.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sum(cleaned, "rawBytes");
    const cleanedEmitted = sum(cleaned, "emittedBytes");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    // Which cleaner ids fired, across how many commands (the attribution the report's per-cleaner bars show).
    const counts = new Map();
    for (const row of cleaned) {
        for (const id of row.matched ?? []) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    const perCleaner = [...counts.entries()]
        .map(([id, commands]) => ({ id, commands }))
        .toSorted((a, b) => b.commands - a.commands);

    // Measured saving: avg emitted tokens on cleaned commands vs avg raw tokens on the held-out control. Because
    // holdout is a random sample of the same command stream, this is a real reduction, not a per-command estimate.
    const avgRawHeld = avg(held, "rawBytes");
    const avgEmittedCleaned = avg(cleaned, "emittedBytes");
    const measuredSavedPct = held.length > 0 && avgRawHeld > 0 ? Math.round((1 - avgEmittedCleaned / avgRawHeld) * 100) : undefined;

    // High-volume commands that matched no cleaner — the next handler to write (rtk's `discover` idea).
    const gaps = cleaned
        .filter((row) => (row.matched === undefined || row.matched.length === 0) && (row.rawBytes ?? 0) > 2000)
        .toSorted((a, b) => (b.rawBytes ?? 0) - (a.rawBytes ?? 0))
        .slice(0, 15)
        .map((row) => ({ command: String(row.command ?? "").slice(0, 80), tokens: tokens(row.rawBytes ?? 0) }));

    return {
        commands: rows.length,
        rawTokens: tokens(sum(rows, "rawBytes")),
        emittedTokens: tokens(sum(rows, "emittedBytes")),
        savedPct,
        perCleaner,
        holdout: { cleaned: cleaned.length, heldOut: held.length, ...(measuredSavedPct !== undefined ? { measuredSavedPct } : {}) },
        gaps,
    };
};

// Parse a filter-stats.jsonl file into rows (skipping blank/corrupt lines). Shared by the bench + tests.
export const parseStatsFile = (text) =>
    text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
