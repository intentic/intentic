#!/usr/bin/env node
// Recomputes the measurements cited in system-prompt.ts's comments (Claude Code transcripts only); a moved number is an
// invitation to read that block, not a verdict on it, since only the holdout arms separate a steer that stopped
// mattering from one that worked.
// pnpm --filter @intentic/sandbox bench:guidance
// pnpm --filter @intentic/sandbox bench:guidance --json
// The scan itself lives in guidance-corpus.ts, kept separate so it can be imported by its own test.

import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { guidanceStats } from "./guidance-corpus.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = args.find((a) => !a.startsWith("--")) ?? join(homedir(), ".claude", "projects");

let stats: ReturnType<typeof guidanceStats>;
try {
    stats = guidanceStats(root);
} catch (error) {
    process.stderr.write(`cannot read a corpus at ${root}: ${errorMessage(error)}\n`);
    process.exit(1);
}

if (stats.corpus.calls === 0) {
    process.stderr.write(`no tool calls found under ${root}\n`);
    process.exit(1);
}

if (asJson) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
} else {
    const { root: from, corpus, ...blocks } = stats;
    process.stdout.write(
        `corpus: ${corpus.sessions} sessions, ${corpus.calls.toLocaleString()} calls in ${corpus.responses.toLocaleString()} responses, `,
    );
    process.stdout.write(`${corpus.errorRate} errored, ${corpus.toolTime} of tool time\n`);
    process.stdout.write(`  from ${from}\n`);
    const byUse = Object.entries(corpus.models).toSorted((a, b) => b[1] - a[1]);
    process.stdout.write(`  models: ${byUse.map(([name, n]) => `${name} ${n.toLocaleString()}`).join(", ")}\n`);
    for (const [block, values] of Object.entries(blocks)) {
        process.stdout.write(`\n${block}  (src/agent/prompt/system-prompt.ts)\n`);
        for (const [key, value] of Object.entries(values)) {
            const rendered = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
            process.stdout.write(`  ${key === "claimed" ? "claimed" : key.padEnd(24)}  ${rendered}\n`);
        }
    }
}
