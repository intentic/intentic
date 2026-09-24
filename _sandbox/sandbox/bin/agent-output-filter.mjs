#!/usr/bin/env node
// agent-output-filter <command> <exit-code> <duration-s> [pane-log-path] [pipeline-statuses]: filters an agent's Bash
// output before the model sees it, running ./cleaners.mjs on success, passing through non-ANSI content on failure.
// Fails open; copied into the image as /usr/local/bin/agent-output-filter with ./cleaners.mjs alongside it.

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
    ANSI,
    bodyBytes,
    CACHE_MARKER,
    CLEANERS,
    cleanLines,
    collapseCached,
    collapseCr,
    matchedCleaners,
    openCacheStore,
    parseCleaners,
    redactText,
    secretValues,
    sessionKeyFromLog,
} from "./cleaners.mjs";

// Lines a trim must drop before the footer adds the retrieval handle, not just the counts.
const RETRIEVAL_MIN_DROPPED = 20;

// 128 + SIGPIPE: a writer cut off by the reader closing early (`| head`), which is the reader's choice, not a failure.
const SIGPIPE_STATUS = "141";

// The last pipeline's statuses when a stage before the last failed and the exit code still reads 0, else undefined.
export const maskedFailure = (exitCode, pipeline) => {
    const statuses = pipeline.trim() === "" ? [] : pipeline.trim().split(/\s+/);
    if (exitCode !== "0" || statuses.length < 2 || !statuses.every((status) => /^\d+$/.test(status))) {
        return undefined;
    }
    return statuses.slice(0, -1).some((status) => status !== "0" && status !== SIGPIPE_STATUS) ? statuses.join(" ") : undefined;
};

// ripgrep's -r is --replace, not grep's recursive flag: in a cluster like `-rn` it rewrites every match to "n".
const RG_REPLACE_CLUSTER = /(?<![\w.\-/])rg\s(?:[^;&|\n]*?\s)?(-[a-zA-Z]*r[a-zA-Z]*)(?=[\s;&|]|$)/;

const commandNotes = (command, raw) => {
    const cluster = RG_REPLACE_CLUSTER.exec(command)?.[1];
    return cluster !== undefined && cluster.length > 2 && raw.trim() !== ""
        ? [`--- note: \`${cluster}\` is not recursive in rg: -r is --replace, so matched text above was rewritten (rg recurses by default)`]
        : [];
};

// Returns emitted text plus `stages` (pipeline order): raw minus the sum of stage.saved equals the result. `ansi`,
// `footer` and `notes` are named too, though not registry cleaners, so the accounting has no unexplained remainder.
// `retain(text)` keeps the unfiltered text and returns the path it can be retrieved from; called only when the footer
// is about to name it.
export const filterOutput = (
    raw,
    { command = "", exitCode = "0", durationS = "0", retain, enabled = new Set(CLEANERS), cacheStore, values = [], pipeline = "" },
) => {
    const input = raw.replaceAll(ANSI, "").split("\n").map(collapseCr);
    // The trailing \n of the last output line is not an extra line.
    if (input.at(-1) === "") {
        input.pop();
    }
    const keep = () => retain?.(input.join("\n"));
    const rawCount = input.length;
    const stages = [{ id: "ansi", saved: raw.length - bodyBytes(input) }];
    const cleaned = cleanLines(input, { command, exitCode, enabled, values });
    const lines = cleaned.lines;
    stages.push(...cleaned.stages);
    let body = lines.join("\n");
    if (exitCode === "0" && body.trim() === "" && raw.trim() !== "") {
        body = "(no notable output)";
    }
    const masked = maskedFailure(exitCode, pipeline);
    const exit = masked === undefined ? `exit ${exitCode}` : `exit ${exitCode} (pipeline: ${masked} — an earlier stage failed)`;
    // Below rewrites the whole body, weighed the same way the line stages are. `guard`: if the result is longer than
    // raw, filtering failed, so raw goes back out — the last line of defence, not the first. What the command's own
    // exit and words say (`notes`) is appended after it: the guard judges filtering, and these are not filtering.
    const emitted = (text, id, footed) => {
        stages.push({ id, saved: bodyBytes(lines) - text.length });
        let out = text;
        if (text.length > raw.length) {
            stages.push({ id: "guard", saved: text.length - raw.length });
            out = raw;
        }
        const extra = [...(masked === undefined || (footed && out === text) ? [] : [`--- [${exit}, ${durationS}s]`]), ...commandNotes(command, raw)];
        if (extra.length === 0) {
            return { out, stages };
        }
        const noted = `${out === "" || out.endsWith("\n") ? out : `${out}\n`}${extra.join("\n")}\n`;
        stages.push({ id: "notes", saved: out.length - noted.length });
        return { out: noted, stages };
    };
    // cache, success only: a body identical to an earlier run this session collapses to the marker, no footer.
    if (exitCode === "0" && enabled.has("cache") && cacheStore !== undefined && body !== "" && body !== "(no notable output)") {
        const collapsed = collapseCached(body, command, cacheStore, keep);
        if (collapsed.cached) {
            return emitted(`${collapsed.body}\n`, "cache", false);
        }
    }
    const kept = body === "(no notable output)" ? 0 : lines.length;
    const dropped = Math.max(0, rawCount - kept);
    // `wide` keeps every line and cuts inside them, so a line count alone would call its output complete.
    const cut = stages.find((stage) => stage.id === "wide")?.saved ?? 0;
    if (dropped === 0 && cut <= 0) {
        // Nothing removed (ANSI/\r cleanup alone needs no raw-log pointer).
        return emitted(body === "" ? body : `${body}\n`, "footer", false);
    }
    // Retrieval pointer only appears once the trim is big enough to be worth its own bytes; the counts always appear.
    const retained = dropped >= RETRIEVAL_MIN_DROPPED || cut > 0 ? keep() : undefined;
    const handle = retained === undefined ? "" : ` · full: retrieve-output ${retained} [pattern]`;
    const summary = dropped > 0 ? `${rawCount} lines filtered to ${kept}` : "long runs cut inside lines";
    const withFooter = `${body}\n--- [${exit}, ${durationS}s] ${summary}${handle}\n`;
    // Below the payoff threshold, it's the pointer that is dropped, not the trim it would have explained.
    return withFooter.length <= raw.length ? emitted(withFooter, "footer", true) : emitted(`${body}\n`, "footer", false);
};

// Retained unfiltered outputs: the newest files survive, one run's text is kept to its tail past the char cap.
const RETAIN_FILES = 30;
const RETAIN_MAX_CHARS = 2_000_000;

// Writes one run's unfiltered output where the footer can point at it, redacted like everything else that leaves
// here, then prunes the oldest. Undefined when it cannot be written, so no footer names a file that is not there.
const retainIn = (dir, name, values) => (text) => {
    try {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name);
        writeFileSync(file, redactText(text.length > RETAIN_MAX_CHARS ? text.slice(-RETAIN_MAX_CHARS) : text, values));
        const aged = readdirSync(dir).flatMap((entry) => {
            try {
                return [{ entry, at: statSync(join(dir, entry)).mtimeMs }];
            } catch {
                return []; // Pruned by a concurrent filter between the listing and the stat.
            }
        });
        for (const { entry } of aged.toSorted((a, b) => b.at - a.at).slice(RETAIN_FILES)) {
            rmSync(join(dir, entry), { force: true });
        }
        return file;
    } catch {
        return undefined;
    }
};

const main = async () => {
    const [command = "", exitCode = "0", durationS = "0", logPath = "", pipeline = ""] = process.argv.slice(2);
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let out = raw;
    // Per-mechanism attribution for the stat line; empty on the held-out and fail-open paths.
    let stages = [];
    // Loaded before the pipeline so the redaction at the end of this function can mask a held-out or thrown result too.
    // Own try: an unreadable vault falls back to name patterns, never fails the command.
    let values = [];
    try {
        values = secretValues();
    } catch {
        values = [];
    }
    try {
        const enabled = parseCleaners(process.env["INTENTIC_OUTPUT_CLEANERS"]);
        const terminalsDir = process.env["INTENTIC_TERMINAL_LOGS_DIR"];
        const logsDir = terminalsDir !== undefined && terminalsDir !== "" ? join(terminalsDir, "..") : undefined;
        // Holdout: a random fraction of commands skip cleaning, giving the savings report a real raw baseline.
        const holdout = Number(process.env["INTENTIC_OUTPUT_HOLDOUT"] ?? "0");
        const heldOut = holdout > 0 && Math.random() < holdout;
        // Cache store is per-session (keyed from the pane-log path); held-out commands never open it.
        let cacheStore;
        if (!heldOut && enabled.has("cache") && logsDir !== undefined) {
            const sessionKey = sessionKeyFromLog(logPath);
            if (sessionKey !== undefined) {
                cacheStore = openCacheStore(terminalsDir, sessionKey);
            }
        }
        if (!heldOut) {
            // Named after the pane log, which is unique per command: one window, one pane id.
            const retain = logsDir !== undefined && logPath !== "" ? retainIn(join(logsDir, "raw-output"), basename(logPath), values) : undefined;
            const filtered = filterOutput(raw, { command, exitCode, durationS, retain, enabled, cacheStore, values, pipeline });
            out = filtered.out;
            stages = filtered.stages;
        }
        // One NDJSON telemetry line per command; cleaners/matched/heldOut attribute the saving to the active config,
        // stageBytes to the mechanism. Best-effort: must never break the tool result.
        if (logsDir !== undefined) {
            const matched = matchedCleaners(command, enabled);
            const stat = {
                ts: Date.now(),
                command: command.slice(0, 200),
                exit: exitCode,
                durationS: Number(durationS),
                rawBytes: raw.length,
                emittedBytes: out.length,
                cleaners: [...enabled],
                matched: out.startsWith(CACHE_MARKER) ? [...matched, "cache"] : matched,
                heldOut,
                stageBytes: Object.fromEntries(stages.map((stage) => [stage.id, stage.saved])),
            };
            appendFileSync(join(logsDir, "filter-stats.jsonl"), `${JSON.stringify(stat)}\n`);
        }
    } catch {
        out = raw;
    }
    // Runs outside every branch above: the holdout and fail-open paths both emit raw, and redaction is the one step
    // neither can skip. Guarded: if this throws too, the command still answers.
    try {
        out = redactText(out, values);
    } catch {
        // Keep `out` as it stands: a tool result must always come back.
    }
    process.stdout.write(out);
};

// Importable for tests; executable as the bin.
if (process.argv[1]?.endsWith("agent-output-filter") || process.argv[1]?.endsWith("agent-output-filter.mjs")) {
    await main();
}
