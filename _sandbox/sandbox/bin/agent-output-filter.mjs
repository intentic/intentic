#!/usr/bin/env node
// agent-output-filter <command> <exit-code> <duration-s> [pane-log-path]: filters an agent's Bash output before the
// model sees it, running ./cleaners.mjs on success, passing through non-ANSI content on failure. Fails open; copied
// into the image as /usr/local/bin/agent-output-filter with ./cleaners.mjs alongside it.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
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

// Returns emitted text plus `stages` (pipeline order): raw minus the sum of stage.saved equals the result. `ansi` and
// `footer` are named too, though not registry cleaners, so the accounting has no unexplained remainder.
export const filterOutput = (raw, command, exitCode, durationS, logPath, enabled = new Set(CLEANERS), cacheStore = undefined, values = []) => {
    let lines = raw.replaceAll(ANSI, "").split("\n").map(collapseCr);
    // The trailing \n of the last output line is not an extra line.
    if (lines.at(-1) === "") {
        lines.pop();
    }
    const rawCount = lines.length;
    const stages = [{ id: "ansi", saved: raw.length - bodyBytes(lines) }];
    const cleaned = cleanLines(lines, { command, exitCode, enabled, values });
    lines = cleaned.lines;
    stages.push(...cleaned.stages);
    let body = lines.join("\n");
    if (exitCode === "0" && body.trim() === "" && raw.trim() !== "") {
        body = "(no notable output)";
    }
    // Below rewrites the whole body, weighed the same way the line stages are. `guard`: if the result is longer than
    // raw, filtering failed, so raw goes back out and the ledger reads zero — the last line of defence, not the first.
    const emitted = (text, id) => {
        stages.push({ id, saved: bodyBytes(lines) - text.length });
        if (text.length <= raw.length) {
            return { out: text, stages };
        }
        stages.push({ id: "guard", saved: text.length - raw.length });
        return { out: raw, stages };
    };
    // cache, success only: a body identical to an earlier run this session collapses to the marker, no footer.
    if (exitCode === "0" && enabled.has("cache") && cacheStore !== undefined && body !== "" && body !== "(no notable output)") {
        const collapsed = collapseCached(body, command, cacheStore, logPath);
        if (collapsed.cached) {
            return emitted(`${collapsed.body}\n`, "cache");
        }
    }
    if (lines.length >= rawCount) {
        // Nothing dropped (ANSI/\r cleanup alone needs no raw-log pointer).
        return emitted(body === "" ? body : `${body}\n`, "footer");
    }
    const kept = body === "(no notable output)" ? 0 : lines.length;
    // Retrieval pointer only appears once the trim is big enough to be worth its own bytes; the line counts always
    // appear regardless.
    const dropped = rawCount - kept;
    const log = dropped >= RETRIEVAL_MIN_DROPPED && logPath !== undefined && logPath !== "" ? ` · full: retrieve-output ${logPath} [pattern]` : "";
    const withFooter = `${body}\n--- [exit ${exitCode}, ${durationS}s] ${rawCount} lines filtered to ${kept}${log}\n`;
    // Below the payoff threshold, it's the pointer that is dropped, not the trim it would have explained.
    return emitted(withFooter.length <= raw.length ? withFooter : `${body}\n`, "footer");
};

const main = async () => {
    const [command = "", exitCode = "0", durationS = "0", logPath = ""] = process.argv.slice(2);
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
        // Holdout: a random fraction of commands skip cleaning, giving the savings report a real raw baseline.
        const holdout = Number(process.env["INTENTIC_OUTPUT_HOLDOUT"] ?? "0");
        const heldOut = holdout > 0 && Math.random() < holdout;
        // Cache store is per-session (keyed from the pane-log path); held-out commands never open it.
        let cacheStore;
        if (!heldOut && enabled.has("cache") && terminalsDir !== undefined && terminalsDir !== "") {
            const sessionKey = sessionKeyFromLog(logPath);
            if (sessionKey !== undefined) {
                cacheStore = openCacheStore(terminalsDir, sessionKey);
            }
        }
        if (!heldOut) {
            const filtered = filterOutput(raw, command, exitCode, durationS, logPath, enabled, cacheStore, values);
            out = filtered.out;
            stages = filtered.stages;
        }
        // One NDJSON telemetry line per command; cleaners/matched/heldOut attribute the saving to the active config,
        // stageBytes to the mechanism. Best-effort: must never break the tool result.
        if (terminalsDir !== undefined && terminalsDir !== "") {
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
            appendFileSync(join(terminalsDir, "..", "filter-stats.jsonl"), `${JSON.stringify(stat)}\n`);
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
