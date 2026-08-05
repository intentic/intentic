import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DayWindowQuery, InputSavings } from "@intentic/sandbox-contract";
import { utcDay } from "../usage/usage-store.js";
import { logsRoot } from "./log-files.js";

// The input-side savings report — shell output the cleaners trimmed before the model saw it — aggregated from
// historyRoot/logs/filter-stats.jsonl, one row per agent Bash command written by bin/agent-output-filter.
//
// The aggregation mirrors bin/filter-stats.mjs `summarizeStats` — the offline bench uses the .mjs, the daemon
// route uses this typed twin; same numbers, two runtimes (the accepted pattern the bench already follows for
// estimateTokens). Only the numbers mirror: the bench is handed a ledger path outright, so it needs no window.
//
// A missing/empty/unreadable ledger reads as a zeroed report — the card hides itself at zero commands rather
// than inventing a number.

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
const sortedBytes = (rows: StatRow[], key: "rawBytes" | "emittedBytes"): number[] => rows.map((row) => row[key] ?? 0).toSorted((a, b) => a - b);
const median = (sorted: number[]): number => sorted[sorted.length >> 1] ?? 0;

/* Mann-Whitney U as a z-score, tie-corrected; both arms must already be sorted ascending. Distribution-free and
 * one merge over the two arms, which is what makes it affordable on a route the settings page polls.
 *
 * It is here because the holdout comparison needs a significance bar and a heavy-tailed one cannot borrow the
 * usual t-shaped machinery. See `measuredSavedPct` below for what it is gating and why. */
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
    /* Ranks are 1-based and averaged within each tie group, and the tie correction is what keeps the variance
     * honest — output sizes tie constantly (every empty result is 0 bytes), and an uncorrected variance would
     * report significance that is not there. One forward scan: a group spans [start, end) and its members all
     * take the same average rank. */
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

// Arms smaller than this cannot say anything, the same floor `terseHoldout` publishes under.
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

/* WHERE THE NEXT HANDLER IS WORTH WRITING: commands that matched no cleaner and still came back big, GROUPED
 * by the command line so the answer is "this costs 5k twenty times" rather than twenty rows of the same thing.
 * The floor is per-run, not per-group — a command that emits fifty bytes a thousand times is not a cleaner's
 * job — and 15 groups is what any reader of this list will look at.
 *
 * The command text is the agent's own line (tmux-run's `-c`), so grouping is meaningful in the first place:
 * while this read the daemon's wrapper, every row began with a per-turn `nsenter --mount=/proc/<pid>/…` and no
 * two rows could ever group. */
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

// The report for the ledger the cleaners write. The window is the reader's, applied on the ledger's own
// calendar (the UTC day each command ran).
export const readInputSavings = async (historyRoot: string, window: DayWindowQuery): Promise<InputSavings> => {
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

    /* Measured saving: emitted bytes on cleaned commands against raw bytes on the held-out control (a random
     * sample of the same command stream) — the whole-pipeline counterfactual, and the only figure in this
     * report that is an ESTIMATE. `savedPct` above is exact: it is each command's own raw against its own
     * emitted, so it needs no control and carries no sampling error.
     *
     * Two things this got wrong for a while, and both made it print an alarming number pointing the wrong way:
     *
     * - It compared MEANS of a heavy-tailed quantity. Output is median ~680 bytes with a p99 of 11 KB and a
     *   long tail past 200 KB, so a mean over a 10% arm is decided by which few huge captures happened to land
     *   in it. On one window the two arms' INPUTS differed by 9.5% — arms that are by construction the same
     *   command stream — and the estimator published −6% while the exact paired count said +3%.
     * - It published whatever it computed. A between-arm comparison this noisy has to clear a significance bar
     *   before it means anything, exactly as `terseHoldout` does; an interval straddling zero is not a
     *   measurement, and rendering it as a percentage invites someone to switch off a mechanism that works.
     *
     * So the median ratio is the figure (robust to the tail) and Mann-Whitney is the gate. Below the bar
     * nothing is published — and note that a 10% holdout over a two-day window does NOT clear it for an effect
     * this size (z ≈ −1.8, directionally right and short of significance), which is a fact about the sample,
     * not about the cleaners. `holdout.cleaned`/`heldOut` still go out so the reader can see the arms. */
    const heldRaw = sortedBytes(held, "rawBytes");
    const cleanedEmittedSorted = sortedBytes(cleaned, "emittedBytes");
    const measurable = held.length >= MIN_HELD_COMMANDS && median(heldRaw) > 0 && Math.abs(mannWhitneyZ(cleanedEmittedSorted, heldRaw)) > Z_95;
    const measuredSavedPct = measurable ? Math.round((1 - median(cleanedEmittedSorted) / median(heldRaw)) * 100) : undefined;

    const gaps = summarizeGaps(cleaned);

    // The newest row's own timestamp, not the file's mtime — the ledger is pruned in place (log-files.ts
    // copy-truncates), which touches mtime without a command having run.
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
