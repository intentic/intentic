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

// Lines a trim must drop before the footer carries the retrieval handle as well as the counts (see below).
const RETRIEVAL_MIN_DROPPED = 20;

/* Returns what the model sees AND what each mechanism removed to get there (`stages`, in pipeline order), so
 * the savings report can attribute tokens to mechanisms instead of counting how often each one fired.
 *
 * The accounting closes exactly: raw − Σ stage savings = the emitted result. Two of the stages are not
 * cleaners in the registry and are named anyway, because leaving them out is how a "89% saved" figure ends up
 * with an unexplained remainder:
 *   ansi   — terminal escapes and \r redraw frames, stripped before any cleaner sees a line.
 *   footer — the retrieval pointer, which ADDS bytes (a negative saving). It is the price of the trimming
 *            being reversible, and it belongs on the same ledger as what it bought.
 */
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
    // Everything below rewrites the body as a whole, so each step is weighed against the body it was handed —
    // the same rule the line stages follow.
    //
    // `guard` closes the pipeline: a filter that emits MORE than it was given has not filtered anything, so the
    // raw capture goes back out and the ledger reads zero for that command. It is the last line of defence, not
    // the first — the footer below already declines to add itself when it would not pay — but it is total, so no
    // future cleaner can make a result worse than not running.
    const emitted = (text, id) => {
        stages.push({ id, saved: bodyBytes(lines) - text.length });
        if (text.length <= raw.length) {
            return { out: text, stages };
        }
        stages.push({ id: "guard", saved: text.length - raw.length });
        return { out: raw, stages };
    };
    // `cache` (success only): if this command's cleaned body is byte-identical to an earlier run this session,
    // collapse it to the marker (which carries the retrieval handle) and skip the footer — nothing new to show.
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
    /* Point at the reversible retrieval command (lossy display, lossless storage) — a ready-to-run handle like
     * iq's `--after <cursor>` continuation. `retrieve-output` greps the full pane log, budget-capped.
     *
     * Gated on the trim being big enough that retrieval is a plausible thing to want. The handle is ~100 of the
     * footer's ~124 bytes, and it rode every trim however small: over one ledger window 551 pointers cost 17k
     * tokens — 15.7% of everything the cleaners saved on those same commands — while 289 of them explained a
     * trim of under 300 bytes, and across 10,446 agent commands `retrieve-output` was invoked exactly zero
     * times. Nobody retrieves three elided lines of pnpm progress.
     *
     * The COUNTS stay on every trim regardless. They are ~24 bytes and they are the part that carries meaning:
     * "you are not looking at all of it" is what stops a truncated result being read as a complete one. */
    const dropped = rawCount - kept;
    const log = dropped >= RETRIEVAL_MIN_DROPPED && logPath !== undefined && logPath !== "" ? ` · full: retrieve-output ${logPath} [pattern]` : "";
    const withFooter = `${body}\n--- [exit ${exitCode}, ${durationS}s] ${rawCount} lines filtered to ${kept}${log}\n`;
    // The pointer costs ~120 bytes and is only worth them when it explains a trim bigger than itself. Dropping
    // one `total 48` header buys ten bytes and used to buy a 122-byte footer with them, which is how `ls` came
    // to hand the model MORE than the raw listing. Under that line it is the pointer that goes, not the trim.
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
    // Per-mechanism attribution for the stat line; empty on the held-out and fail-open paths, where nothing
    // was cleaned and there is nothing to attribute.
    let stages = [];
    /* Loaded before the pipeline and OUTSIDE it, because the last line of this function masks with them
     * whatever happened above — a held-out command, a filter that threw. Own try: an unreadable vault is a
     * reason to fall back on the name patterns, never a reason to fail a Bash command. */
    let values = [];
    try {
        values = secretValues();
    } catch {
        values = [];
    }
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
        if (!heldOut) {
            const filtered = filterOutput(raw, command, exitCode, durationS, logPath, enabled, cacheStore, values);
            out = filtered.out;
            stages = filtered.stages;
        }
        // Token-savings telemetry, one NDJSON line per command under historyRoot/logs (same prune policy as the
        // terminal logs). `cleaners`/`matched`/`heldOut` attribute the saving to the active config for A/B, and
        // `stageBytes` says what each mechanism was worth on this command (bytes removed; negative = added).
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
                stageBytes: Object.fromEntries(stages.map((stage) => [stage.id, stage.saved])),
            };
            appendFileSync(join(terminalsDir, "..", "filter-stats.jsonl"), `${JSON.stringify(stat)}\n`);
        }
    } catch {
        out = raw;
    }
    /* THE FLOOR, outside every branch above. The holdout emits `raw` by design and the catch emits it on
     * failure, and both of those used to hand a credential straight to the model — the one cleaner whose
     * absence is not a measurement artifact or a degraded result but a leak. Guarded and idempotent: if this
     * throws too, the command still answers. */
    try {
        out = redactText(out, values);
    } catch {
        // Keep `out` as it stands — a tool result must always come back.
    }
    process.stdout.write(out);
};

// Importable for tests; executable as the bin.
if (process.argv[1]?.endsWith("agent-output-filter") || process.argv[1]?.endsWith("agent-output-filter.mjs")) {
    await main();
}
