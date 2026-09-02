#!/usr/bin/env node
/* THE FIGURES THE SYSTEM PROMPT IS ARGUED FROM, RECOMPUTED.
 *
 *   pnpm --filter @intentic/sandbox bench:guidance                        # against ~/.claude/projects
 *   pnpm --filter @intentic/sandbox bench:guidance /path/to/projects      # against a corpus you carried in
 *   pnpm --filter @intentic/sandbox bench:guidance --json                 # machine-readable, for a diff over time
 *
 * WHY THIS EXISTS. Nearly every block in src/agent/system-prompt.ts is justified by a measurement written into
 * the comment above it: 23.9% of Reads re-read a path, 42% of Bash calls shell out to grep, sleep costs 35.2h,
 * TaskCreate was called zero times. Those numbers were computed by hand, once, and nothing recomputes them. A
 * steer whose number has gone to zero is indistinguishable, from the file, from one still earning its tokens,
 * and the corpus only grows.
 *
 * It has already happened. The checklist block is argued from "TaskCreate was called zero times"; today that
 * figure is in the thousands, because the block worked. Which is the good outcome, and also the one that makes
 * the sentence's stated reason false.
 *
 * WHAT IT IS NOT. It cannot tell you whether a steer is WORKING, only what the world it describes looks like
 * now. A figure that moved is an invitation to go and read the block, not a verdict on it, and for a steer that
 * changed the behaviour it measures, "the number collapsed" and "the number never mattered" leave the same
 * trace here. Only the holdout arms (UsageTurn) separate those two, and they are not in this corpus.
 *
 * READ THE CLAIMED COLUMN AS A DATE, NOT A TARGET. It is what the comment said when someone last looked, kept
 * here so drift is visible at a glance; it is not a threshold and nothing fails when it moves.
 *
 * SCOPE. Claude Code transcripts only. Codex, Grok, Gemini, Cursor, Pi and ACP turns keep their own history
 * elsewhere and are invisible here, so every share below is a share OF THE CLAUDE ARM, which is also the arm
 * these particular guidance blocks were written from.
 *
 * The measuring lives in guidance-corpus.ts, which this only prints: that half is imported by its test, and a
 * module that scanned a corpus on import could not be.
 */

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
        process.stdout.write(`\n${block}  (src/agent/system-prompt.ts)\n`);
        for (const [key, value] of Object.entries(values)) {
            const rendered = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
            process.stdout.write(`  ${key === "claimed" ? "claimed" : key.padEnd(24)}  ${rendered}\n`);
        }
    }
}
