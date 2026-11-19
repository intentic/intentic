#!/usr/bin/env node
// agent-output-filter <command> <exit-code> <duration-s> [pane-log-path] [pipeline-statuses]: filters an agent's Bash
// output before the model sees it, running ./cleaners.mjs on success, passing through non-ANSI content on failure.
// Fails open; copied into the image as /usr/local/bin/agent-output-filter with ./cleaners.mjs alongside it.
// `filterRun` is the whole pass with its inputs resolved; this file's `main` is the sandbox's adapter onto it (argv and
// the daemon's env), and the Claude Code plugin's PostToolUse hook is the other.

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
import { pointCutMarkers } from "./output-cap.mjs";
import { rustcStage } from "./rust-diagnostics.mjs";
import { testDigest } from "./test-digest.mjs";
import { OUTCOMES_DIR } from "./test-outcomes.mjs";

// Lines a trim must drop before the footer adds the retrieval handle, not just the counts.
const RETRIEVAL_MIN_DROPPED = 20;


// Pipelines: which stages only filter, and what the last pipeline's statuses say of the check.
// Which stages of a command's last pipeline only filter what an earlier stage printed. grep and its kin exit 1 when
// nothing matched: past the first stage that is the filter's answer, not a failure of the check before it. 2026-11-17,
// the shinobi-society audit: `cargo test 2>&1 | grep -E "FAILED|panicked" | head` with every test passing was footed
// "an earlier stage failed", and the verification ledger read the check as failing. The daemon's reader of this footer
// keeps the same set (_sandbox/sandbox/src/agent/verification/pipeline-filters.ts).

const FILTERS = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"]);

// Words in front of the program that matters.
const PREFIXES = new Set(["sudo", "env", "time", "command", "nice", "exec", "nohup"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const WRAPPER_DEPTH = 4;

// The operator at `index`: one that ends a stage (`|`, `|&`) or the whole pipeline (`&&`, `||`, `;`, `&`, a newline),
// with how many characters it spans. The `&` of `2>&1` belongs to its redirection.
const operatorAt = (command, index, word) => {
    const character = command[index];
    const next = command[index + 1];
    if (character === "|") {
        return next === "|" ? { ends: "pipeline", length: 2 } : { ends: "stage", length: next === "&" ? 2 : 1 };
    }
    if (character === ";" || character === "\n") {
        return { ends: "pipeline", length: 1 };
    }
    return character === "&" && !/[<>]$/.test(word) ? { ends: "pipeline", length: next === "&" ? 2 : 1 } : undefined;
};

// A quoted run from just past its opening quote: its text, and the index of the closing quote.
const quotedAt = (command, start, quote) => {
    let text = "";
    let index = start;
    for (; index < command.length && command[index] !== quote; index += 1) {
        const escaped = command[index] === "\\" && quote === '"' && index + 1 < command.length;
        index += escaped ? 1 : 0;
        text += command[index];
    }
    return { text, end: index };
};

// The command's pipelines, each a list of stages, each a list of words; quotes honoured, so a quoted `|` splits nothing.
const pipelinesOf = (command) => {
    const pipelines = [[]];
    let words = [];
    let word = "";
    const endWord = () => {
        if (word !== "") {
            words.push(word);
        }
        word = "";
    };
    const endStage = () => {
        endWord();
        if (words.length > 0) {
            pipelines.at(-1).push(words);
        }
        words = [];
    };
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        const operator = operatorAt(command, index, word);
        if (character === "'" || character === '"') {
            const quoted = quotedAt(command, index + 1, character);
            word += quoted.text;
            index = quoted.end;
        } else if (character === "\\") {
            word += command[index + 1] ?? "";
            index += 1;
        } else if (operator !== undefined) {
            endStage();
            pipelines.push(...(operator.ends === "pipeline" ? [[]] : []));
            index += operator.length - 1;
        } else if (/\s/.test(character)) {
            endWord();
        } else {
            word += character;
        }
    }
    endStage();
    return pipelines.filter((pipeline) => pipeline.length > 0);
};

// A stage's program, past env assignments and prefix words.
const programOf = (words) => {
    const program = words.find((word) => !PREFIXES.has(word) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
    return program.split("/").at(-1);
};

// The last pipeline: how many stages it has, and which of them past the first are filters. A lone `bash -c '…'` is read
// for the script it runs.
const lastPipelineOf = (command, depth = 0) => {
    const pipelines = pipelinesOf(command);
    const stages = pipelines.at(-1) ?? [];
    if (pipelines.length === 1 && stages.length === 1 && depth < WRAPPER_DEPTH && SHELLS.has(programOf(stages[0]))) {
        const words = stages[0];
        const flag = words.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
        if (flag !== -1 && words[flag + 1] !== undefined) {
            return lastPipelineOf(words[flag + 1], depth + 1);
        }
    }
    return { stages: stages.length, filters: new Set(stages.flatMap((words, index) => (index > 0 && FILTERS.has(programOf(words)) ? [index] : []))) };
};

// 128 + SIGPIPE: a writer cut off by the reader closing early (`| head`), which is the reader's choice, not a failure.
const SIGPIPE_STATUS = "141";

const statusesOf = (pipeline) => {
    const statuses = pipeline.trim() === "" ? [] : pipeline.trim().split(/\s+/);
    return statuses.length >= 2 && statuses.every((status) => /^\d+$/.test(status)) ? statuses : undefined;
};

// The stages known to be filters, when the statuses are this command's last pipeline's.
const filtersFor = (statuses, command) => {
    const read = lastPipelineOf(command);
    return read.stages === statuses.length ? read.filters : new Set();
};

// Whether the exit code says nothing about the check: 0, or a last-stage filter's 1 (it matched nothing).
const exitSaysNothing = (exitCode, statuses, filters) => exitCode === "0" || (exitCode === "1" && statuses.at(-1) === "1" && filters.has(statuses.length - 1));

// The last pipeline's statuses when a stage before the last failed while the exit code says nothing of it, else
// undefined. A filter's 1 before the last stage is not a failure.
export const maskedFailure = (exitCode, pipeline, command = "") => {
    const statuses = statusesOf(pipeline);
    if (statuses === undefined) {
        return undefined;
    }
    const filters = filtersFor(statuses, command);
    const failed = statuses.slice(0, -1).some((status, index) => status !== "0" && status !== SIGPIPE_STATUS && !(status === "1" && filters.has(index)));
    return failed && exitSaysNothing(exitCode, statuses, filters) ? statuses.join(" ") : undefined;
};

// The statuses when the exit code is 1 only because the last stage is a filter that matched nothing, every stage before
// it fine, else undefined.
const filterMissed = (exitCode, pipeline, command) => {
    const statuses = statusesOf(pipeline);
    if (exitCode !== "1" || statuses === undefined || maskedFailure(exitCode, pipeline, command) !== undefined) {
        return undefined;
    }
    return exitSaysNothing(exitCode, statuses, filtersFor(statuses, command)) ? statuses.join(" ") : undefined;
};

// The footer's exit clause, and whether it says more than the exit code alone (so it is worth a line of its own even
// when nothing was trimmed): an earlier stage that failed, or a last-stage filter that matched nothing.
export const exitClause = (exitCode, pipeline, command) => {
    const masked = maskedFailure(exitCode, pipeline, command);
    if (masked !== undefined) {
        return { exit: `exit ${exitCode} (pipeline: ${masked} — an earlier stage failed)`, telling: true };
    }
    const missed = filterMissed(exitCode, pipeline, command);
    return missed === undefined
        ? { exit: `exit ${exitCode}`, telling: false }
        : { exit: `exit ${exitCode} (pipeline: ${missed} — the filter matched nothing)`, telling: true };
};

// ripgrep's -r is --replace, not grep's recursive flag: in a cluster like `-rn` it rewrites every match to "n".
// The letters before the cluster's first `r` exclude `r`, so a run of them splits one way only.
const RG_REPLACE_CLUSTER = /(?<![\w.\-/])rg\s(?:[^;&|\n]*?\s)?(-[a-qs-zA-Z]*r[a-zA-Z]*)(?=[\s;&|]|$)/;

const commandNotes = (command, raw) => {
    const cluster = RG_REPLACE_CLUSTER.exec(command)?.[1];
    return cluster !== undefined && cluster.length > 2 && raw.trim() !== ""
        ? [`--- note: \`${cluster}\` is not recursive in rg: -r is --replace, so matched text above was rewritten (rg recurses by default)`]
        : [];
};

const bodyFromLines = (lines, raw, exitCode) => {
    const body = lines.join("\n");
    return exitCode === "0" && body.trim() === "" && raw.trim() !== "" ? "(no notable output)" : body;
};

const CONTENT_CUT_STAGES = new Set(["wide", "templates", "search", "cap", "failtail"]);
const contentCut = (stages) => stages.filter((stage) => CONTENT_CUT_STAGES.has(stage.id)).reduce((sum, stage) => sum + Math.max(0, stage.saved), 0);

const footerSummary = (dropped, rawCount, kept, stages) => {
    if (dropped > 0) {
        return `${rawCount} lines filtered to ${kept}`;
    }
    return stages.some((stage) => stage.id === "cap" && stage.saved > 0) ? "output truncated" : "long runs cut inside lines";
};

const mustSkipSummaries = (stages, retained, footerLength, rawLength) =>
    stages.some((stage) => (stage.id === "templates" || stage.id === "search") && stage.saved > 0) &&
    (retained === undefined || footerLength > rawLength);

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
    // cargo/rustc diagnostics folded before every other stage, on success and failure alike (rust-diagnostics.mjs).
    const rust = rustcStage(input, enabled);
    const cleaned = cleanLines(rust.lines, { command, exitCode, enabled, values });
    const lines = cleaned.lines;
    stages.push(...rust.stages, ...cleaned.stages);
    const body = bodyFromLines(lines, raw, exitCode);
    const { exit, telling } = exitClause(exitCode, pipeline, command);
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
        const extra = [...(!telling || (footed && out === text) ? [] : [`--- [${exit}, ${durationS}s]`]), ...commandNotes(command, raw)];
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
    // A JSON table can add lines before a later cap removes them; raw versus emitted line counts cannot see that cut.
    // Wide runs and template summaries also replace content within the surviving lines.
    const cut = contentCut(stages);
    if (dropped === 0 && cut <= 0) {
        // Nothing removed (ANSI/\r cleanup alone needs no raw-log pointer).
        return emitted(body === "" ? body : `${body}\n`, "footer", false);
    }
    // Retrieval pointer only appears once the trim is big enough to be worth its own bytes; the counts always appear.
    const retained = dropped >= RETRIEVAL_MIN_DROPPED || cut > 0 ? keep() : undefined;
    const handle = retained === undefined ? "" : ` · full: retrieve-output ${retained} [pattern]`;
    const summary = footerSummary(dropped, rawCount, kept, stages);
    const withFooter = `${pointCutMarkers(body, retained)}\n--- [${exit}, ${durationS}s] ${summary}${handle}\n`;
    // New lossy summaries must remain retrievable even below twenty dropped lines. If their pointer cannot be
    // kept or cannot pay for itself, rerun without those stages; the ordinary cleaners retain their own policy.
    if (mustSkipSummaries(stages, retained, withFooter.length, raw.length)) {
        return filterOutput(raw, {
            command,
            exitCode,
            durationS,
            retain,
            cacheStore,
            values,
            pipeline,
            enabled: new Set([...enabled].filter((id) => id !== "templates" && id !== "search")),
        });
    }
    // Below the payoff threshold, it's the pointer that is dropped, not the trim it would have explained.
    return withFooter.length <= raw.length ? emitted(withFooter, "footer", true) : emitted(`${body}\n`, "footer", false);
};

// Retained unfiltered outputs: the newest files survive, one run's text is kept to its tail past the char cap. One
// directory serves every conversation of the sandbox, so 30 files was a few minutes of a busy fleet's commands and a
// footer's retrieve-output path could be gone before it was followed (2026-11-17, the shinobi-society audit). 500 keeps
// far longer, and the byte budget keeps a run of huge build logs from filling the disk instead.
const RETAIN_FILES = 500;
const RETAIN_TOTAL_BYTES = 200_000_000;
const RETAIN_MAX_CHARS = 2_000_000;

// The files past the newest RETAIN_FILES, or past RETAIN_TOTAL_BYTES counted newest first; never the one just written.
const overRetention = (aged, written) => {
    let total = 0;
    return aged
        .toSorted((a, b) => b.at - a.at)
        .filter((file, index) => {
            total += file.size;
            return file.entry !== written && (index >= RETAIN_FILES || total > RETAIN_TOTAL_BYTES);
        })
        .map((file) => file.entry);
};

// Writes one run's unfiltered output where the footer can point at it, redacted like everything else that leaves
// here, then prunes the oldest. Undefined when it cannot be written, so no footer names a file that is not there.
export const retainIn =
    (dir, name, values, maxChars = RETAIN_MAX_CHARS) =>
    (text) => {
        try {
            mkdirSync(dir, { recursive: true });
            const file = join(dir, name);
            writeFileSync(file, redactText(text.length > maxChars ? text.slice(-maxChars) : text, values));
            const aged = readdirSync(dir).flatMap((entry) => {
                try {
                    const stats = statSync(join(dir, entry));
                    return [{ entry, at: stats.mtimeMs, size: stats.size }];
                } catch {
                    return []; // Pruned by a concurrent filter between the listing and the stat.
                }
            });
            for (const entry of overRetention(aged, name)) {
                rmSync(join(dir, entry), { force: true });
            }
            return file;
        } catch {
            return undefined;
        }
    };

// Programs that hand a test run's output on whole; any other stage after the first may have dropped some of it.
const WHOLE_STAGES = new Set(["tee", "cat"]);
const narrowedOutput = (command) => pipelinesOf(command).some((stages) => stages.slice(1).some((words) => !WHOLE_STAGES.has(programOf(words))));

// A test run's digest after everything the filter emitted (test-digest.mjs), weighed on the ledger as `tests`. `outcomes`
// names where runs are recorded (`dir`, absent to record none), the directory the command started in and who ran it;
// absent, no digest is made at all.
const withTestDigest = (raw, filtered, { command, outcomes, now }) => {
    let digest = "";
    try {
        const input = raw.replaceAll(ANSI, "").split("\n").map(collapseCr);
        digest = outcomes === undefined ? "" : testDigest(input, { ...outcomes, command, narrowed: narrowedOutput(command), now: now() });
    } catch {
        // allow(silent-catch): the digest is an addition to the trimmed output, so a digest that cannot be made costs
        // the digest alone; the trim and everything after it still run.
    }
    if (digest === "") {
        return filtered;
    }
    const out = `${filtered.out === "" || filtered.out.endsWith("\n") ? filtered.out : `${filtered.out}\n`}${digest}\n`;
    return { out, stages: [...filtered.stages, { id: "tests", saved: filtered.out.length - out.length }] };
};

// One command's whole pass, every input already resolved by the runtime calling it. `logsDir` holds what a pass keeps:
// `raw-output/` (the unfiltered text a footer points at), `output-cache/` (the per-session repeat detector) and
// `filter-stats.jsonl` (the savings ledger); undefined keeps none of them. `runName` names this run's raw-output file
// and must be unique per command; `sessionKey` scopes the cache; `tags` ride on the ledger row as they are (the plugin
// files each row under its project and session). Never throws: any failure answers with the raw text, and redaction
// runs on every path.
export const filterRun = (
    raw,
    {
        command = "",
        exitCode = "0",
        durationS = "0",
        pipeline = "",
        enabled = new Set(CLEANERS),
        holdout = 0,
        logsDir,
        runName,
        sessionKey,
        values = [],
        tags = {},
        outcomes,
        random = Math.random,
        now = Date.now,
    } = {},
) => {
    let out = raw;
    // Per-mechanism attribution for the stat line; empty on the held-out and fail-open paths.
    let stages = [];
    let heldOut = false;
    try {
        // Holdout: a random fraction of commands skip cleaning, giving the savings report a real raw baseline.
        heldOut = holdout > 0 && random() < holdout;
        // Held-out commands never open the cache: they must not teach it a body the model never saw collapsed.
        const cacheStore =
            !heldOut && enabled.has("cache") && logsDir !== undefined && sessionKey !== undefined ? openCacheStore(logsDir, sessionKey) : undefined;
        if (!heldOut) {
            const retain =
                logsDir !== undefined && runName !== undefined && runName !== "" ? retainIn(join(logsDir, "raw-output"), runName, values) : undefined;
            const filtered = withTestDigest(raw, filterOutput(raw, { command, exitCode, durationS, retain, enabled, cacheStore, values, pipeline }), {
                command,
                outcomes,
                now,
            });
            out = filtered.out;
            stages = filtered.stages;
        }
    } catch {
        out = raw;
        stages = [];
    }
    // One NDJSON telemetry line per command; cleaners/matched/heldOut attribute the saving to the active config,
    // stageBytes to the mechanism. Own try: a ledger that cannot be written costs the ledger, never the trim.
    if (logsDir !== undefined) {
        try {
            const matched = matchedCleaners(command, enabled);
            const stat = {
                ...tags,
                ts: now(),
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
            mkdirSync(logsDir, { recursive: true });
            appendFileSync(join(logsDir, "filter-stats.jsonl"), `${JSON.stringify(stat)}\n`);
            // allow(silent-catch): the tool result below is the product and the ledger only accounts for it, so a
            // full disk or a read-only data dir must cost the row, never the command's answer.
        } catch {
            // Best-effort by design, see above.
        }
    }
    // Runs outside every branch above: the holdout and fail-open paths both emit raw, and redaction is the one step
    // neither can skip. Guarded: if this throws too, the command still answers.
    try {
        out = redactText(out, values);
    } catch {
        // Keep `out` as it stands: a tool result must always come back.
    }
    return { out, heldOut, stages };
};

// Where the sandbox records test runs and who is running this one: beside the other logs, unless
// INTENTIC_TEST_OUTCOMES=0 turns digests off. A turn with no logs directory (an agent domain) still gets its digest.
const testOutcomesOf = (terminalsDir) => {
    if (process.env["INTENTIC_TEST_OUTCOMES"] === "0") {
        return undefined;
    }
    const dir = terminalsDir === undefined || terminalsDir === "" ? undefined : join(terminalsDir, "..", OUTCOMES_DIR);
    return { dir, cwd: process.cwd(), by: process.env["INTENTIC_TURN_OWNER"] };
};

const main = async () => {
    const [command = "", exitCode = "0", durationS = "0", logPath = "", pipeline = ""] = process.argv.slice(2);
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    // Loaded before the pass so its redaction can mask a held-out or thrown result too. Own try: an unreadable vault
    // falls back to name patterns, never fails the command.
    let values = [];
    try {
        values = secretValues();
    } catch {
        values = [];
    }
    const terminalsDir = process.env["INTENTIC_TERMINAL_LOGS_DIR"];
    const { out } = filterRun(raw, {
        command,
        exitCode,
        durationS,
        pipeline,
        enabled: parseCleaners(process.env["INTENTIC_OUTPUT_CLEANERS"]),
        holdout: Number(process.env["INTENTIC_OUTPUT_HOLDOUT"] ?? "0"),
        logsDir: terminalsDir !== undefined && terminalsDir !== "" ? join(terminalsDir, "..") : undefined,
        // Named after the pane log, which is unique per command: one window, one pane id.
        runName: logPath === "" ? undefined : basename(logPath),
        // Every command of a session runs in a new pane, so the session is the pane log's name minus the pane.
        sessionKey: sessionKeyFromLog(logPath),
        values,
        outcomes: testOutcomesOf(terminalsDir),
    });
    process.stdout.write(out);
};

// Importable for tests; executable as the bin.
if (process.argv[1]?.endsWith("agent-output-filter") || process.argv[1]?.endsWith("agent-output-filter.mjs")) {
    await main();
}
