// Aggregates agent-output-filter's telemetry (filter-stats.jsonl) into the savings report: the one implementation, read by
// the sandbox daemon's savings route and the cleaner bench alike. Row shape:
// { rawBytes, emittedBytes, rawTokens, emittedTokens, matched: string[], heldOut: boolean, command, stageBytes: { [id]:
// bytesRemoved }, conversationHash?, runName? }. Tokens are what the filter estimated (@intentic/base's estimate,
// src/token-estimate.mjs); a row from before 2026-11-26 has none and counts four bytes a token.
// Retrieval rows (retrieve-stats.jsonl): { ts, runName, conversationId?, pattern? }.

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
// A row's tokens: what the filter recorded, else four bytes a token.
const rowTokens = (row, side) => row[`${side}Tokens`] ?? (row[`${side}Bytes`] ?? 0) / 4;
const sumTokens = (rows, side) => rows.reduce((total, row) => total + rowTokens(row, side), 0);
// Bytes some stage removed from a row, in tokens at that row's own raw rate, so a stage that strips padding is credited
// with the few tokens padding costs; four bytes a token without a row or its counts.
const tokens = (bytes, row) => {
    const rate = row === undefined || !(row.rawBytes > 0) || row.rawTokens === undefined ? 1 / 4 : row.rawTokens / row.rawBytes;
    return bytes * rate;
};

// Verbs that hand back the bytes the model named by name: nothing in them is for a handler to strip, and none will ever
// be written. Tested against the SIGNATURE and not the line, so `rg … | head -30` stays a gap in `rg` while `head -20
// file` reads as what it is. Git's read verbs are deliberately absent: `git diff` prints what git decides to print,
// including a generated lock file nobody asked to see, which is exactly a handler's job.
const READ_VERBS = new Set(["cat", "bat", "sed", "awk", "head", "tail", "less", "more"]);

// Words before the command: an env assignment, a privilege or scheduling wrapper, and that wrapper's own argument.
const isPrefixWord = (word, previous) =>
    /^[A-Za-z_]\w*=/.test(word) || word === "sudo" || word === "timeout" || (previous === "timeout" && /^\d+[smhd]?$/.test(word));
// Verbs that are never the point of the command; the signature moves on to the next pipeline segment.
// A loop's or a conditional's closing word ends a segment of its own (`…; done; seq 1 9`), so it is noise like its opener.
const SHELL_NOISE = new Set(["cd", "echo", "true", "set", "export", "source", "time", "for", "do", "done", "while", "until", "if", "then", "else", "elif", "fi", "case", "esac"]);
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

// Mann-Whitney U as a tie-corrected z-score over two already-sorted arms.
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
        const current = byCommand.get(signature) ?? { commands: 0, tokens: 0 };
        byCommand.set(signature, { commands: current.commands + 1, tokens: current.tokens + rowTokens(row, "emitted") });
    }
    return [...byCommand.entries()]
        .map(([command, entry]) => ({ command, commands: entry.commands, tokens: Math.round(entry.tokens) }))
        .toSorted((a, b) => b.tokens - a.tokens)
        .slice(0, 15);
};

// Harm metric: per stage, of the outputs that stage trimmed, the share the model came back for: (a) a retrieve-output of
// that run's raw file, at any later point (an explicit "I needed what was cut"), or (b) the same command run again within
// K of the conversation's next commands. headroom's idea (toin.py ~460: a retrieval rate past 0.5 means compress less),
// written from scratch. A re-run is matched on the whole command, not on `commandSignature`: the signature folds the
// argument away on purpose (`rg a` and `rg b` are one gap), which would count every next search as a re-run. Agents re-run
// commands for their own reasons too (tests after a fix), so the held-out conversations' own re-run rate is reported
// next to it as the baseline a stage's re-run share has to beat before it means anything.
const DEFAULT_FOLLOWUP_WINDOW = 5;
const MIN_HARM_COMMANDS = 5;
const SMALL_N = 30;

// The command as the model would retype it: whitespace runs folded, so a re-run with other spacing still matches.
const sameCommand = (command) => String(command ?? "").trim().replaceAll(/\s+/g, " ");

// Each conversation's rows in the order they ran; rows without a conversation cannot be placed and are left out.
const byConversationOf = (rows) => {
    const byConversation = new Map();
    for (const row of rows) {
        if (row.conversationHash === undefined) {
            continue;
        }
        const list = byConversation.get(row.conversationHash) ?? [];
        list.push(row);
        byConversation.set(row.conversationHash, list);
    }
    for (const list of byConversation.values()) {
        list.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    }
    return byConversation;
};

// Whether the command at `index` runs again, word for word, within the next K commands of its conversation.
const reRunWithin = (conversationRows, index, K) => {
    const command = sameCommand(conversationRows[index].command);
    if (command === "") {
        return false;
    }
    const end = Math.min(index + K + 1, conversationRows.length);
    for (let next = index + 1; next < end; next++) {
        if (sameCommand(conversationRows[next].command) === command) {
            return true;
        }
    }
    return false;
};

// The held-out conversations' own re-run share: what (b) reads when no cleaner touched anything.
const heldOutReRunRate = (byConversation, K) => {
    let held = 0;
    let reRun = 0;
    for (const conversationRows of byConversation.values()) {
        for (let index = 0; index < conversationRows.length; index++) {
            if (conversationRows[index].heldOut !== true) {
                continue;
            }
            held++;
            if (reRunWithin(conversationRows, index, K)) {
                reRun++;
            }
        }
    }
    return held >= MIN_HARM_COMMANDS ? { commands: held, reRunRate: Math.round((reRun / held) * 1000) / 1000 } : undefined;
};

// Adds one cleaned command's outcome to every stage that trimmed it.
const tallyStages = (stageHarm, row, retrieved, reRun) => {
    for (const [stageId, bytes] of Object.entries(row.stageBytes ?? {})) {
        if (bytes <= 0) {
            continue;
        }
        const entry = stageHarm.get(stageId) ?? { trimmed: 0, retrieved: 0, reRun: 0, followedUp: 0 };
        entry.trimmed++;
        entry.retrieved += retrieved ? 1 : 0;
        entry.reRun += reRun ? 1 : 0;
        entry.followedUp += retrieved || reRun ? 1 : 0;
        stageHarm.set(stageId, entry);
    }
};

export const summarizeHarm = (rows, retrievals = [], K = DEFAULT_FOLLOWUP_WINDOW) => {
    const byConversation = byConversationOf(rows);
    if (byConversation.size === 0) {
        return undefined;
    }
    const retrievedRuns = new Set(retrievals.map((retrieval) => retrieval.runName).filter((name) => name !== undefined && name !== ""));
    const stageHarm = new Map();
    for (const conversationRows of byConversation.values()) {
        conversationRows.forEach((row, index) => {
            if (row.heldOut !== true) {
                tallyStages(stageHarm, row, row.runName !== undefined && retrievedRuns.has(row.runName), reRunWithin(conversationRows, index, K));
            }
        });
    }
    const perStage = [...stageHarm.entries()]
        .filter(([, entry]) => entry.trimmed >= MIN_HARM_COMMANDS)
        .map(([id, entry]) => ({ id, ...entry, harmRate: Math.round((entry.followedUp / entry.trimmed) * 1000) / 1000 }))
        .toSorted((a, b) => b.harmRate - a.harmRate);
    if (perStage.length === 0) {
        return undefined;
    }
    const summary = { K, perStage };
    const baseline = heldOutReRunRate(byConversation, K);
    if (baseline !== undefined) {
        summary.heldOutReRun = baseline;
    }
    if (perStage.some((stage) => stage.trimmed < SMALL_N)) {
        summary.caveat = `fewer than ${SMALL_N} trimmed commands behind some stages' rates`;
    }
    return summary;
};

// Arm comparison: per-conversation tool calls and emitted bytes, medians for cleaned vs held-out conversations.
// A "cleaned" conversation has at least one non-held-out command; a "held-out" conversation has all commands held out.
const MIN_ARM_CONVERSATIONS = 5;

export const summarizeArms = (rows) => {
    const byConversation = byConversationOf(rows);
    if (byConversation.size === 0) {
        return undefined;
    }

    const cleanedConversations = [];
    const heldOutConversations = [];
    for (const [, conversationRows] of byConversation) {
        const allHeldOut = conversationRows.every((r) => r.heldOut === true);
        const summary = {
            commands: conversationRows.length,
            emittedBytes: sum(conversationRows, "emittedBytes"),
        };
        if (allHeldOut) {
            heldOutConversations.push(summary);
        } else {
            cleanedConversations.push(summary);
        }
    }

    if (cleanedConversations.length < MIN_ARM_CONVERSATIONS || heldOutConversations.length < MIN_ARM_CONVERSATIONS) {
        return undefined;
    }

    const cleanedCommands = cleanedConversations.map((c) => c.commands).toSorted((a, b) => a - b);
    const heldOutCommands = heldOutConversations.map((c) => c.commands).toSorted((a, b) => a - b);
    const cleanedBytes = cleanedConversations.map((c) => c.emittedBytes).toSorted((a, b) => a - b);
    const heldOutBytes = heldOutConversations.map((c) => c.emittedBytes).toSorted((a, b) => a - b);

    const result = {
        cleaned: { conversations: cleanedConversations.length, medianCommands: median(cleanedCommands), medianEmittedBytes: median(cleanedBytes) },
        heldOut: { conversations: heldOutConversations.length, medianCommands: median(heldOutCommands), medianEmittedBytes: median(heldOutBytes) },
    };

    // Apply Mann-Whitney to emitted bytes per conversation if both arms are large enough.
    if (cleanedConversations.length >= MIN_HELD_COMMANDS && heldOutConversations.length >= MIN_HELD_COMMANDS) {
        const z = mannWhitneyZ(cleanedBytes, heldOutBytes);
        if (Math.abs(z) > Z_95) {
            result.emittedBytesDeltaPct = Math.round((1 - median(cleanedBytes) / median(heldOutBytes)) * 100);
        }
    }

    return result;
};

export const summarizeStats = (rows, retrievals = []) => {
    // Held-out commands bypassed cleaning (the measurement control); excluded from saved-% and gaps.
    const cleaned = rows.filter((row) => row.heldOut !== true);
    const held = rows.filter((row) => row.heldOut === true);

    const cleanedRaw = sumTokens(cleaned, "raw");
    const cleanedEmitted = sumTokens(cleaned, "emitted");
    const savedPct = cleanedRaw === 0 ? 0 : Math.round(((cleanedRaw - cleanedEmitted) / cleanedRaw) * 100);

    // Per-stage bytes removed, in tokens at each row's raw rate, summed over commands it ran on; sequential, so these sum
    // to about raw − emitted. A stage counted in `commands` but removing nothing differs from one that never ran,
    // flagging a handler that stopped matching.
    const stages = new Map();
    for (const row of cleaned) {
        for (const [id, bytes] of Object.entries(row.stageBytes ?? {})) {
            const current = stages.get(id) ?? { commands: 0, tokens: 0 };
            stages.set(id, { commands: current.commands + 1, tokens: current.tokens + tokens(bytes, row) });
        }
    }
    const perCleaner = [...stages.entries()]
        .map(([id, entry]) => ({ id, commands: entry.commands, savedTokens: Math.round(entry.tokens) }))
        .toSorted((a, b) => b.savedTokens - a.savedTokens);

    // The holdout's measure (`savedPct` above is each command's own raw vs emitted tokens), in bytes: median ratio (means
    // are skewed by heavy-tailed sizes), gated by Mann-Whitney.
    const heldRaw = sortedBytes(held, "rawBytes");
    const cleanedEmittedSorted = sortedBytes(cleaned, "emittedBytes");
    const measurable = held.length >= MIN_HELD_COMMANDS && median(heldRaw) > 0 && Math.abs(mannWhitneyZ(cleanedEmittedSorted, heldRaw)) > Z_95;
    const measuredSavedPct = measurable ? Math.round((1 - median(cleanedEmittedSorted) / median(heldRaw)) * 100) : undefined;

    // `measuredSavedPct` is absent, not undefined, while the holdout is too small or too close to call.
    const holdout = { cleaned: cleaned.length, heldOut: held.length };
    if (measuredSavedPct !== undefined) {
        holdout.measuredSavedPct = measuredSavedPct;
    }

    const result = {
        commands: rows.length,
        rawTokens: Math.round(sumTokens(rows, "raw")),
        emittedTokens: Math.round(sumTokens(rows, "emitted")),
        savedPct,
        perCleaner,
        holdout,
        gaps: summarizeGaps(cleaned),
    };

    // Harm metric: per stage, the share of trimmed commands followed by a retrieval or re-run. Only present when
    // enough rows carry conversationHash to be meaningful.
    const harm = summarizeHarm(rows, retrievals);
    if (harm !== undefined) {
        result.harm = harm;
    }

    // Arm comparison: per-conversation tool calls and emitted bytes, cleaned vs held-out conversations.
    const arms = summarizeArms(rows);
    if (arms !== undefined) {
        result.arms = arms;
    }

    return result;
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
