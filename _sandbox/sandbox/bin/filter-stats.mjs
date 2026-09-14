// Aggregates agent-output-filter's telemetry (filter-stats.jsonl) for the savings report; mirrors
// src/logs/filter-stats.ts. Row shape: { rawBytes, emittedBytes, matched: string[], heldOut: boolean, command,
// stageBytes: { [id]: bytesRemoved } }; tokens are ~4 chars/token, matching iq-engine's estimateTokens.

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const tokens = (bytes) => Math.round(bytes / 4);

// Verbs that hand back the bytes the model named by name: nothing in them is for a handler to strip, and none will ever
// be written. Tested against the SIGNATURE and not the line, so `rg … | head -30` stays a gap in `rg` while `head -20
// file` reads as what it is. Git's read verbs are deliberately absent: `git diff` prints what git decides to print,
// including a generated lock file nobody asked to see, which is exactly a handler's job.
const READ_VERBS = new Set(["cat", "bat", "sed", "awk", "head", "tail", "less", "more"]);

// Words before the command: an env assignment, a privilege or scheduling wrapper, and that wrapper's own argument.
const isPrefixWord = (word, previous) =>
    /^[A-Za-z_]\w*=/.test(word) || word === "sudo" || word === "timeout" || (previous === "timeout" && /^\d+[smhd]?$/.test(word));
// Verbs that are never the point of the command; the signature moves on to the next pipeline segment.
const SHELL_NOISE = new Set(["cd", "echo", "true", "set", "export", "source", "time", "for", "do", "while", "if", "then"]);
// Only these keep their second word. For anything else it is an argument — `rg displayName` and `rg fastModel` are one
// gap in `rg`, and folding the argument in would scatter it over as many one-run groups as the agent had questions.
const SUBCOMMAND_VERBS = new Set(["git", "pnpm", "npm", "npx", "yarn", "docker", "cargo", "go", "gh", "kubectl", "systemctl", "apt", "apt-get", "pip", "poetry"]);

// One pipeline segment's verb, or "" when the segment carries none (only prefix words, or a shell keyword).
const segmentVerb = (segment) => {
    const words = segment.trim().split(/\s+/);
    let index = 0;
    while (index < words.length && isPrefixWord(words[index], words[index - 1])) {
        index++;
    }
    const word = (words[index] ?? "").replace(/^[({]+/, "");
    const verb = word.slice(word.lastIndexOf("/") + 1);
    if (verb === "" || SHELL_NOISE.has(verb)) {
        return "";
    }
    const next = words[index + 1];
    return SUBCOMMAND_VERBS.has(verb) && next !== undefined && /^[a-z][\w-]*$/.test(next) ? `${verb} ${next}` : verb;
};

// The verb a cleaner would match on, recovered from the line the agent wrote. Grouping by the whole line cannot work:
// ad-hoc commands are unique by construction (their paths and patterns differ every time), so every group is one run and
// the ranking degenerates into "biggest single output".
export const commandSignature = (command) => {
    for (const segment of String(command).split(/[|;&]+/)) {
        const verb = segmentVerb(segment);
        if (verb !== "") {
            return verb;
        }
    }
    return "";
};
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

// Commands no cleaner claimed, grouped by the verb a handler would match on and weighed by what the model was actually
// handed. EMITTED, never raw: a command whose 480 KB the cap already removed has no handler opportunity left in it, and
// ranking by raw put four such commands in the top five of one live report while the one still costing 36k tokens ranked
// fourth. Floored per-run so frequent small emitters don't count as a gap.
const GAP_MIN_BYTES = 2000;
const summarizeGaps = (cleaned) => {
    const byCommand = new Map();
    for (const row of cleaned) {
        if ((row.matched !== undefined && row.matched.length > 0) || (row.emittedBytes ?? 0) <= GAP_MIN_BYTES) {
            continue;
        }
        const signature = commandSignature(String(row.command ?? ""));
        if (READ_VERBS.has(signature)) {
            continue;
        }
        const current = byCommand.get(signature) ?? { commands: 0, bytes: 0 };
        byCommand.set(signature, { commands: current.commands + 1, bytes: current.bytes + (row.emittedBytes ?? 0) });
    }
    return [...byCommand.entries()]
        .map(([command, entry]) => ({ command, commands: entry.commands, tokens: tokens(entry.bytes) }))
        .toSorted((a, b) => b.tokens - a.tokens)
        .slice(0, 15);
};

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

    return {
        commands: rows.length,
        rawTokens: tokens(sum(rows, "rawBytes")),
        emittedTokens: tokens(sum(rows, "emittedBytes")),
        savedPct,
        perCleaner,
        holdout: { cleaned: cleaned.length, heldOut: held.length, ...(measuredSavedPct !== undefined ? { measuredSavedPct } : {}) },
        gaps: summarizeGaps(cleaned),
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
