#!/usr/bin/env node
// retrieve-output <log-file> [pattern]: fetch back output that agent-output-filter elided. Reads the file the filter
// footer names (the run's unfiltered output, retained under logs/raw-output/), optionally greps it for <pattern>
// (case-insensitive regex, falling back to a literal substring), and caps the result to a token budget so retrieval
// never re-floods context. This is the reversible half of lossy display / lossless storage: the footer prints the
// exact command to run. Copied into the image as /usr/local/bin/retrieve-output.
// The agent-CLI contract (@intentic/agent-cli's run.ts): everything, errors included, goes to stdout, since an agent
// drops stderr; exit 0 is output, 1 a pattern that matched no line, 2 anything else (usage, an unreadable log).

import { readFileSync } from "node:fs";

const BUDGET_TOKENS = 2000; // ~4 chars/token; keep a retrieval bounded: the agent narrows further with a pattern.
const MAX_CHARS = BUDGET_TOKENS * 4;

const [logPath, pattern] = process.argv.slice(2);
if (logPath === undefined) {
    process.stdout.write("usage: retrieve-output <log-file> [pattern]\n");
    process.exit(2);
}

let text;
try {
    text = readFileSync(logPath, "utf8");
} catch (error) {
    process.stdout.write(`retrieve-output: cannot read ${logPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
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
    if (lines.length === 0) {
        // Said in words: an empty answer would read the same as a log that never held the line.
        process.stdout.write(`retrieve-output: no line in ${logPath} matches ${JSON.stringify(pattern)}\n`);
        process.exit(1);
    }
}

let out = lines.join("\n");
if (out.length > MAX_CHARS) {
    // Keep the tail (retrievals usually want the relevant end) and say so: the agent narrows with a pattern.
    out = `… (truncated to the last ~${BUDGET_TOKENS} tokens; pass a pattern to narrow)\n${out.slice(-MAX_CHARS)}`;
}
process.stdout.write(`${out}\n`);
