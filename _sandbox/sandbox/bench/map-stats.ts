#!/usr/bin/env node
// Recomputes what the project map did, off transcripts (map-corpus.ts does the scan, kept separate so its test can
// import it).
// pnpm --filter @intentic/sandbox bench:map
// pnpm --filter @intentic/sandbox bench:map --json
// `opening` compares mapped vs unmapped sessions (observational; `settings.workspaceMapHoldout` is what actually
// settles it); `payload` needs no control group, since a line nobody uses is waste regardless.

import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { DEFAULT_AGENT_ROOT, mapStats } from "./map-corpus.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};
const corpus = args.find((arg) => !arg.startsWith("--") && arg !== flag("root")) ?? join(homedir(), ".claude", "projects");

let stats: ReturnType<typeof mapStats>;
try {
    stats = mapStats(corpus, { agentRoot: flag("root") ?? DEFAULT_AGENT_ROOT });
} catch (error) {
    process.stderr.write(`cannot read a corpus at ${corpus}: ${errorMessage(error)}\n`);
    process.exit(1);
}

if (stats.corpus.sessions === 0) {
    process.stderr.write(`no sessions found under ${corpus}\n`);
    process.exit(1);
}

if (asJson) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    process.exit(0);
}

const { corpus: seen, opening, payload } = stats;
process.stdout.write(`corpus: ${seen.sessions} sessions, ${seen.mapped} with a map, ${seen.from} → ${seen.to}\n  from ${stats.root}\n`);

process.stdout.write(`\nopening turn  (observational: the holdout is what settles it)\n  ${opening.claimed}\n`);
const columns = ["openedWithListing", "searchesBeforeFirstFile", "searchesPerOpeningTurn", "callsBeforeTarget", "reached", "sessions"] as const;
for (const column of columns) {
    process.stdout.write(`  ${column.padEnd(24)}  mapped ${String(opening.mapped[column]).padEnd(10)}  unmapped ${opening.unmapped[column]}\n`);
}
for (const [arm, reading] of [
    ["mapped", opening.mapped],
    ["unmapped", opening.unmapped],
] as const) {
    const actions = Object.entries(reading.firstActions)
        .map(([name, count]) => `${name} ${count}`)
        .join(", ");
    process.stdout.write(`  first action, ${arm.padEnd(8)}  ${actions}\n`);
}

process.stdout.write(`\npayload  (no control group needed: a line nobody uses is waste either way)\n  ${payload.claimed}\n`);
for (const [key, value] of Object.entries(payload)) {
    if (key === "claimed" || key === "perArea" || key === "chars") {
        continue;
    }
    process.stdout.write(`  ${key.padEnd(28)}  ${String(value)}\n`);
}
process.stdout.write(`  ${"note size".padEnd(28)}  median ${payload.chars.median} chars, longest ${payload.chars.max}\n`);
process.stdout.write(`\n  area line                       listed   used\n`);
for (const area of payload.perArea) {
    process.stdout.write(`  ${area.area.padEnd(30)}  ${String(area.listed).padStart(6)}  ${String(area.used).padStart(5)}  (${area.share})\n`);
}
