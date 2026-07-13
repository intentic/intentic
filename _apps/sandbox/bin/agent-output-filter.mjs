#!/usr/bin/env node
// agent-output-filter <command> <exit-code> <duration-s> [pane-log-path]
//
// Boost/rtk-style noise filter between an agent Bash command and the model: stdin is the raw combined output
// captured by bin/tmux-run, stdout is what the SDK returns to the model as the tool result. The per-command
// cleaner registry + spec parser live in ./cleaners.mjs; which cleaners run is the INTENTIC_OUTPUT_CLEANERS spec
// (allow-list / default-minus, like iq's --features), so cleaners are individually toggle-able and A/B-benchmarkable.
// Deterministic and exit-code-asymmetric: on success, matching command cleaners + a head/tail cap compress the
// output; on failure (any non-"0" exit, incl. the wrapper's "running"/143 paths) everything except pure terminal
// noise (ANSI, \r frames) survives, capped only at a generous tail. When lines are dropped, a footer names the
// counts and the persistent pane log so the agent can grep the full output — lossy display, lossless storage.
//
// Fail open: any error emits the raw input unchanged. Copied into the image as /usr/local/bin/agent-output-filter
// (with ./cleaners.mjs alongside it at /usr/local/bin/cleaners.mjs).

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
    ANSI,
    CACHE_MARKER,
    CLEANERS,
    cleanLines,
    collapseCached,
    collapseCr,
    matchedCleaners,
    openCacheStore,
    parseCleaners,
    sessionKeyFromLog,
} from "./cleaners.mjs";

export const filterOutput = (raw, command, exitCode, durationS, logPath, enabled = new Set(CLEANERS), cacheStore = undefined) => {
    let lines = raw.replaceAll(ANSI, "").split("\n").map(collapseCr);
    // The trailing \n of the last output line is not an extra line.
    if (lines.at(-1) === "") {
        lines.pop();
    }
    const rawCount = lines.length;
    lines = cleanLines(lines, { command, exitCode, enabled });
    let body = lines.join("\n");
    if (exitCode === "0" && body.trim() === "" && raw.trim() !== "") {
        body = "(no notable output)";
    }
    // `cache` (success only): if this command's cleaned body is byte-identical to an earlier run this session,
    // collapse it to the marker (which carries the retrieval handle) and skip the footer — nothing new to show.
    if (exitCode === "0" && enabled.has("cache") && cacheStore !== undefined && body !== "" && body !== "(no notable output)") {
        const collapsed = collapseCached(body, command, cacheStore, logPath);
        if (collapsed.cached) {
            return `${collapsed.body}\n`;
        }
    }
    if (lines.length >= rawCount) {
        // Nothing dropped (ANSI/\r cleanup alone needs no raw-log pointer).
        return body === "" ? body : `${body}\n`;
    }
    const kept = body === "(no notable output)" ? 0 : lines.length;
    // Point at the reversible retrieval command (lossy display, lossless storage) — a ready-to-run handle like
    // iq's `--after <cursor>` continuation. `retrieve-output` greps the full pane log, budget-capped.
    const log = logPath !== undefined && logPath !== "" ? ` · full: retrieve-output ${logPath} [pattern]` : "";
    return `${body}\n--- [exit ${exitCode}, ${durationS}s] ${rawCount} lines filtered to ${kept}${log}\n`;
};

const main = async () => {
    const [command = "", exitCode = "0", durationS = "0", logPath = ""] = process.argv.slice(2);
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let out = raw;
    try {
        const enabled = parseCleaners(process.env["INTENTIC_OUTPUT_CLEANERS"]);
        const terminalsDir = process.env["INTENTIC_TERMINAL_LOGS_DIR"];
        // Holdout (measurement control): a random fraction of commands bypass cleaning entirely and are recorded
        // raw, so the savings report has a real cleaned-vs-raw baseline instead of a per-command estimate.
        const holdout = Number(process.env["INTENTIC_OUTPUT_HOLDOUT"] ?? "0");
        const heldOut = holdout > 0 && Math.random() < holdout;
        // The `cache` store is per-session, keyed from the pane-log path; only opened when cleaning runs and a
        // stable session key exists (held-out commands never touch it — the control must stay uncontaminated).
        let cacheStore;
        if (!heldOut && enabled.has("cache") && terminalsDir !== undefined && terminalsDir !== "") {
            const sessionKey = sessionKeyFromLog(logPath);
            if (sessionKey !== undefined) {
                cacheStore = openCacheStore(terminalsDir, sessionKey);
            }
        }
        out = heldOut ? raw : filterOutput(raw, command, exitCode, durationS, logPath, enabled, cacheStore);
        // Token-savings telemetry, one NDJSON line per command under historyRoot/logs (same prune policy as the
        // terminal logs). `cleaners`/`matched`/`heldOut` attribute the saving to the active config for A/B.
        // Best-effort — stats must never break the tool result.
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
            };
            appendFileSync(join(terminalsDir, "..", "filter-stats.jsonl"), `${JSON.stringify(stat)}\n`);
        }
    } catch {
        out = raw;
    }
    process.stdout.write(out);
};

// Importable for tests; executable as the bin.
if (process.argv[1]?.endsWith("agent-output-filter") || process.argv[1]?.endsWith("agent-output-filter.mjs")) {
    await main();
}
