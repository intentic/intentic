// Aggregation over agent-output-filter's telemetry rows (historyRoot/logs/filter-stats.jsonl, one row per agent
// Bash command). The single source of truth for the savings report: shared by the offline bench's `discover`
// and (mirrored in TS) the daemon's /settings/savings route. Pure + dependency-free so it rides the image next
// to the other bin cleaners and is unit-testable.
//
// Row shape (written by agent-output-filter): { rawBytes, emittedBytes, matched: string[], heldOut: boolean,
// command, stageBytes: { [id]: bytesRemoved } }. ~4 chars/token, the same heuristic iq-engine's estimateTokens uses.

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const tokens = (bytes) => Math.round(bytes / 4);
const sortedBytes = (rows, key) => rows.map((row) => row[key] ?? 0).toSorted((a, b) => a - b);
const median = (sorted) => sorted[sorted.length >> 1] ?? 0;

// Mann-Whitney U as a tie-corrected z-score over two already-sorted arms. Mirrors src/logs/filter-stats.ts:
// see the comment on `measuredSavedPct` there for why the holdout comparison is gated at all.
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
    // Ranks are 1-based, averaged within each tie group; the tie correction keeps the variance honest, because
    // output sizes tie constantly (every empty result is 0 bytes).
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
    // Held-out commands bypassed cleaning (the measurement control): exclude them from saved-% and gaps so the
    // cleaned population isn't diluted by rows that were deliberately left raw.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sum(cleaned, "rawBytes");
    const cleanedEmitted = sum(cleaned, "emittedBytes");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    // What each mechanism was worth: bytes removed, summed over the commands it ran on. Sequential attribution
    // (every stage was weighed against what reached it), so these sum to raw − emitted and stack cleanly. A
    // stage that ran and removed nothing is still counted in `commands`: that is a different fact from a
    // cleaner that never fired at all, and it is the one that says a handler has stopped matching.
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

    /* Measured saving: the whole-pipeline counterfactual, and the only ESTIMATE here, `savedPct` above is each
     * command's own raw against its own emitted, so it needs no control. Median ratio for the figure (output
     * size is heavy-tailed enough that a mean over a 10% arm reports which few huge captures landed in it:
     * that is how this once published −6% while the exact count said +3%), Mann-Whitney for the gate, and
     * nothing published below it. Mirrors src/logs/filter-stats.ts. */
    const heldRaw = sortedBytes(held, "rawBytes");
    const cleanedEmittedSorted = sortedBytes(cleaned, "emittedBytes");
    const measurable = held.length >= MIN_HELD_COMMANDS && median(heldRaw) > 0 && Math.abs(mannWhitneyZ(cleanedEmittedSorted, heldRaw)) > Z_95;
    const measuredSavedPct = measurable ? Math.round((1 - median(cleanedEmittedSorted) / median(heldRaw)) * 100) : undefined;

    /* High-volume commands that matched no cleaner: the next handler to write. GROUPED by the command line,
     * because a handler is worth writing for what costs 5k twenty times, not for the one 60k outlier that
     * sorted first. The floor is per-run: a command that emits fifty bytes a thousand times is not a cleaner's
     * job. Grouping only means anything because the row records the agent's own line (tmux-run's `-c`), while
     * it held the daemon's wrapper, a per-turn pid in `nsenter --mount=/proc/<pid>/…` made every row unique. */
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
