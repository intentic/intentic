// Aggregates agent-output-filter's telemetry (filter-stats.jsonl) for the savings report; mirrors
// src/logs/filter-stats.ts. Row shape: { rawBytes, emittedBytes, matched: string[], heldOut: boolean, command,
// stageBytes: { [id]: bytesRemoved } }; tokens are ~4 chars/token, matching iq-engine's estimateTokens.

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const tokens = (bytes) => Math.round(bytes / 4);
const sortedBytes = (rows, key) => rows.map((row) => row[key] ?? 0).toSorted((a, b) => a - b);
const median = (sorted) => sorted[sorted.length >> 1] ?? 0;

// Mann-Whitney U as a tie-corrected z-score over two already-sorted arms; mirrors src/logs/filter-stats.ts.
const mannWhitneyZ = (first, second) => {
    const n1 = first.length;
    const n2 = second.length;
    const total = n1 + n2;
    if (n1 === 0 || n2 === 0) {
        return 0;
    }
    const merged = [...first.map((value) => ({ value, isFirst: true })), ...second.map((value) => ({ value, isFirst: false }))].toSorted(
        (left, right) => left.value - right.value,
    );
    // Ranks are 1-based, averaged within each tie group, with a tie correction: output sizes tie often (every empty
    // result is 0 bytes).
    let rankSum = 0;
    let tieCorrection = 0;
    let start = 0;
    let firstsInGroup = 0;
    let previous;
    const closeGroup = (end) => {
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

const MIN_HELD_COMMANDS = 30;
const Z_95 = 1.96;

export const summarizeStats = (rows) => {
    // Held-out commands bypassed cleaning (the measurement control); excluded from saved-% and gaps.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sum(cleaned, "rawBytes");
    const cleanedEmitted = sum(cleaned, "emittedBytes");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    // Per-stage bytes removed, summed over commands it ran on; sequential, so these sum to raw − emitted. A stage
    // counted in `commands` but removing nothing differs from one that never ran, flagging a handler that stopped
    // matching.
    const stages = new Map();
    for (const row of cleaned) {
        for (const [id, bytes] of Object.entries(row.stageBytes ?? {})) {
            const current = stages.get(id) ?? { commands: 0, bytes: 0 };
            stages.set(id, { commands: current.commands + 1, bytes: current.bytes + bytes });
        }
    }
    const perCleaner = [...stages.entries()]
        .map(([id, entry]) => ({ id, commands: entry.commands, savedTokens: tokens(entry.bytes) }))
        .toSorted((a, b) => b.savedTokens - a.savedTokens);

    // The only estimate here (`savedPct` above is each command's own exact raw vs emitted): median ratio (means are
    // skewed by heavy-tailed sizes), gated by Mann-Whitney, mirrors src/logs/filter-stats.ts.
    const heldRaw = sortedBytes(held, "rawBytes");
    const cleanedEmittedSorted = sortedBytes(cleaned, "emittedBytes");
    const measurable = held.length >= MIN_HELD_COMMANDS && median(heldRaw) > 0 && Math.abs(mannWhitneyZ(cleanedEmittedSorted, heldRaw)) > Z_95;
    const measuredSavedPct = measurable ? Math.round((1 - median(cleanedEmittedSorted) / median(heldRaw)) * 100) : undefined;

    // Groups high-volume, unmatched commands by command line, floored per-run (row bytes > 2000) so frequent small
    // emitters don't count as a gap. Grouping only works because rows record the agent's own launcher line, not a
    // wrapper with a per-turn pid.
    const byCommand = new Map();
    for (const row of cleaned) {
        if ((row.matched !== undefined && row.matched.length > 0) || (row.rawBytes ?? 0) <= 2000) {
            continue;
        }
        const command = String(row.command ?? "");
        const current = byCommand.get(command) ?? { commands: 0, bytes: 0 };
        byCommand.set(command, { commands: current.commands + 1, bytes: current.bytes + (row.rawBytes ?? 0) });
    }
    const gaps = [...byCommand.entries()]
        .map(([command, entry]) => ({ command, commands: entry.commands, tokens: tokens(entry.bytes) }))
        .toSorted((a, b) => b.tokens - a.tokens)
        .slice(0, 15);

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

// Parses a filter-stats.jsonl file into rows, skipping blank or corrupt lines.
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
