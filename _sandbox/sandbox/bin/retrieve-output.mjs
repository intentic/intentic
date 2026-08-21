#!/usr/bin/env node
// retrieve-output <log-file> [pattern]: fetch back output that agent-output-filter elided. Reads the persistent
// pane log (lossless, VT-cleaned by pane-log-clean), optionally greps it for <pattern> (case-insensitive regex,
// falling back to a literal substring), and caps the result to a token budget so retrieval never re-floods
// context. This is the reversible half of lossy display / lossless storage: the filter footer prints the exact
// command to run. Copied into the image as /usr/local/bin/retrieve-output.

import { readFileSync } from "node:fs";

const BUDGET_TOKENS = 2000; // ~4 chars/token; keep a retrieval bounded: the agent narrows further with a pattern.
const MAX_CHARS = BUDGET_TOKENS * 4;

const [logPath, pattern] = process.argv.slice(2);
if (logPath === undefined) {
    process.stderr.write("usage: retrieve-output <log-file> [pattern]\n");
    process.exit(1);
}

let text;
try {
    text = readFileSync(logPath, "utf8");
} catch (error) {
    process.stderr.write(`retrieve-output: cannot read ${logPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}

let lines = text.split("\n");
if (pattern !== undefined && pattern !== "") {
    let regex;
    try {
        regex = new RegExp(pattern, "i");
    } catch {
        regex = undefined; // not a valid regex: fall back to a literal, case-insensitive substring match below.
    }
    const needle = pattern.toLowerCase();
    lines = lines.filter((line) => (regex !== undefined ? regex.test(line) : line.toLowerCase().includes(needle)));
}

let out = lines.join("\n");
if (out.length > MAX_CHARS) {
    // Keep the tail (retrievals usually want the relevant end) and say so: the agent narrows with a pattern.
    out = `… (truncated to the last ~${BUDGET_TOKENS} tokens; pass a pattern to narrow)\n${out.slice(-MAX_CHARS)}`;
}
process.stdout.write(`${out}\n`);
