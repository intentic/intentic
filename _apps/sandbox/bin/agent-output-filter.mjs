#!/usr/bin/env node
// agent-output-filter <command> <exit-code> <duration-s> [pane-log-path]
//
// Boost-style noise filter between an agent Bash command and the model: stdin is the raw combined output
// captured by bin/tmux-run, stdout is what the SDK returns to the model as the tool result.
// Deterministic and exit-code-asymmetric: on success, per-command noise rules + a head/tail cap compress
// the output; on failure (any non-"0" exit, incl. the wrapper's "running"/143 paths) everything except
// pure terminal noise (ANSI codes, \r progress frames) survives, only capped at a generous tail. When
// lines were dropped, a footer names the counts and the persistent pane log (piped by the tmux hooks in
// src/logs/log-files.ts, VT-rendered to clean text by pane-log-clean) so the agent can grep the full output — lossy display, lossless storage.
//
// Fail open: any error emits the raw input unchanged. Copied into the image as /usr/local/bin/agent-output-filter.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

// CSI sequences, OSC sequences (title sets, hyperlinks), and lone two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// A spinner/progress bar redraws one line with \r — keep only the final frame.
const collapseCr = (line) => {
    const frames = line.split("\r");
    for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i] !== "") {
            return frames[i];
        }
    }
    return "";
};

// Success-path noise rules; the first `match` against the original command wins. Patterns are narrow
// enough that a false command match strips nothing real. Extend here as filter-stats.jsonl surfaces
// new noisy commands.
const RULES = [
    { match: /\b(npm|npx)\b/, strip: [/^npm (?:warn|notice)\b/i] },
    {
        match: /\bpnpm\b/,
        strip: [/^\s*Progress: /, /^Packages: [+-]/, /^Downloading /, /^\s*[.+]+\s*$/, /^Virtual store is at/, /^Lockfile is up to date/],
    },
    { match: /\byarn\b/, strip: [/^warning /] },
    {
        match: /\bdocker\b/,
        strip: [
            /^#\d+ (?:sha256:|extracting|transferring|resolve|DONE|CACHED)/,
            /(?:Pulling fs layer|Waiting|Downloading|Download complete|Verifying Checksum|Extracting|Pull complete)\s*$/,
        ],
    },
    {
        match: /\bgit\b/,
        strip: [/^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Unpacking|Writing) (?:objects|deltas)[: ]/, /^remote: Total /],
    },
    { match: /\bpip3?\b/, strip: [/^\s*(?:Downloading|Using cached|Collecting|Requirement already satisfied)/] },
    { match: /\bapt(?:-get)?\b/, strip: [/^(?:Get:|Hit:|Ign:|Fetched |Selecting |Preparing to unpack|Unpacking |Setting up |Processing triggers)/] },
];

// Generic success cap (rule or not): outputs past MAX keep the first HEAD + last TAIL lines. Failures
// keep everything up to FAIL_TAIL — errors usually live at the end.
const HEAD = 30;
const TAIL = 50;
const MAX = 100;
const FAIL_TAIL = 500;

export const filterOutput = (raw, command, exitCode, durationS, logPath) => {
    let lines = raw.replaceAll(ANSI, "").split("\n").map(collapseCr);
    // The trailing \n of the last output line is not an extra line.
    if (lines.at(-1) === "") {
        lines.pop();
    }
    const rawCount = lines.length;
    if (exitCode === "0") {
        const rule = RULES.find((r) => r.match.test(command));
        if (rule !== undefined) {
            lines = lines.filter((line) => !rule.strip.some((re) => re.test(line)));
        }
        if (lines.length > MAX) {
            lines = [...lines.slice(0, HEAD), `… ${lines.length - HEAD - TAIL} lines elided …`, ...lines.slice(-TAIL)];
        }
    } else if (lines.length > FAIL_TAIL) {
        lines = [`… ${lines.length - FAIL_TAIL} earlier lines elided …`, ...lines.slice(-FAIL_TAIL)];
    }
    let body = lines.join("\n");
    if (exitCode === "0" && body.trim() === "" && raw.trim() !== "") {
        body = "(no notable output)";
    }
    if (lines.length >= rawCount) {
        // Nothing dropped (ANSI/\r cleanup alone needs no raw-log pointer).
        return body === "" ? body : `${body}\n`;
    }
    const kept = body === "(no notable output)" ? 0 : lines.length;
    const log = logPath !== undefined && logPath !== "" ? ` · full log: ${logPath}` : "";
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
        out = filterOutput(raw, command, exitCode, durationS, logPath);
        // Token-savings telemetry, one NDJSON line per command under historyRoot/logs (same prune policy
        // as the terminal logs). Best-effort — stats must never break the tool result.
        const terminalsDir = process.env["INTENTIC_TERMINAL_LOGS_DIR"];
        if (terminalsDir !== undefined && terminalsDir !== "") {
            const stat = {
                ts: Date.now(),
                command: command.slice(0, 200),
                exit: exitCode,
                durationS: Number(durationS),
                rawBytes: raw.length,
                emittedBytes: out.length,
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
