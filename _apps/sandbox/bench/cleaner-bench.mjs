#!/usr/bin/env node
// Offline output-cleaner benchmark: replay captured command outputs through named cleaner configs and report the
// output-token delta per config. Deterministic, no agent — the "few different setups" harness for the cleaners
// (the analogue of iq-bench's config sweep). Plain .mjs so it shares the exact filter code the sandbox ships.
//
//   pnpm --filter @intentic/sandbox bench:cleaners              # sweep configs over the fixture corpus
//   pnpm --filter @intentic/sandbox bench:cleaners discover <filter-stats.jsonl>   # live-run savings + gaps

import { readFileSync } from "node:fs";
import { filterOutput } from "../bin/agent-output-filter.mjs";
import { parseCleaners } from "../bin/cleaners.mjs";

// ~4 chars/token, the same heuristic iq-engine's estimateTokens uses — kept inline so the bench has no build dep.
const estimateTokens = (text) => Math.ceil(text.length / 4);

// Captured representative raw outputs (combined stdout+stderr, as tmux-run tees them). Extend as real commands
// surface via `discover`.
const FIXTURES = [
    {
        name: "pnpm install",
        command: "pnpm install",
        exitCode: "0",
        raw: `${["Progress: resolved 1, reused 0, downloaded 0, added 0", "Progress: resolved 812, reused 800, downloaded 12, added 0", "Packages: +240", "++++++++++++++++++++++++++++++++++++++++", "Downloading typescript@5.9.2: 2.1 MB/2.1 MB, done", "Virtual store is at node_modules/.pnpm", "Lockfile is up to date, resolution step is skipped", "dependencies:", "+ zod 4.4.3", "Done in 4.2s"].join("\n")}\n`,
    },
    {
        name: "vitest (green)",
        command: "pnpm exec vitest run",
        exitCode: "0",
        raw: `${[...Array.from({ length: 40 }, (_, i) => `✓ src/mod-${i}.test.ts (${i % 5}) ${i}ms`), "", "Test Files  40 passed (40)", "Tests  180 passed (180)", "Duration  3.7s"].join("\n")}\n`,
    },
    {
        name: "docker build",
        command: "docker build -t app .",
        exitCode: "0",
        raw: `${["#5 [2/6] RUN apt-get update", "#5 sha256:abc extracting", "#5 resolve docker.io/library/node:24", "#5 DONE 1.2s", "#8 Pulling fs layer", "#8 Downloading", "#8 Extracting", "#8 Pull complete", "#12 exporting to image", "#12 DONE 0.4s", "Successfully built image app:latest"].join("\n")}\n`,
    },
    {
        name: "noisy retries (dedup)",
        command: "node scripts/poll.js",
        exitCode: "0",
        raw: `${["connecting…", ...Array.from({ length: 30 }, () => "warn: retry in 1s"), "connected", "done"].join("\n")}\n`,
    },
    {
        name: "env dump (redact)",
        command: "env | sort",
        exitCode: "0",
        raw: `${["HOME=/root", "GITHUB_TOKEN=ghp_0123456789abcdef", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "DATABASE_URL=postgres://user:s3cr3t@db:5432/app", "PATH=/usr/bin"].join("\n")}\n`,
    },
    {
        name: "tsc failure",
        command: "pnpm exec tsc --noEmit",
        exitCode: "1",
        raw: `${[...Array.from({ length: 20 }, (_, i) => `src/ok-${i}.ts building`), "src/broken.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.", "src/broken.ts(19,7): error TS2551: Property 'x' does not exist.", "Found 2 errors."].join("\n")}\n`,
    },
];

// Named configs, mirroring iq-bench: the "off" baseline (filter disabled ⇒ raw) plus cleaner subsets.
const CONFIGS = [
    { name: "off (raw)", spec: "off" },
    { name: "all", spec: "" },
    { name: "no-cap", spec: "-cap" },
    { name: "no-dedup", spec: "-dedup" },
    { name: "no-redact", spec: "-redact" },
    { name: "strip-only", spec: "-cap,-dedup,-redact" },
];

const cleanedFor = (fixture, spec) =>
    spec === "off" ? fixture.raw : filterOutput(fixture.raw, fixture.command, fixture.exitCode, "0", "", parseCleaners(spec));

const bench = () => {
    const baseline = FIXTURES.reduce((sum, fixture) => sum + estimateTokens(fixture.raw), 0);
    const pad = (value, width) => String(value).padEnd(width);
    process.stdout.write(`${pad("config", 14)}${pad("tokens", 10)}${pad("Δ vs raw", 12)}\n`);
    process.stdout.write(`${"-".repeat(36)}\n`);
    for (const config of CONFIGS) {
        const tokens = FIXTURES.reduce((sum, fixture) => sum + estimateTokens(cleanedFor(fixture, config.spec)), 0);
        const delta = baseline === 0 ? 0 : Math.round(((tokens - baseline) / baseline) * 100);
        process.stdout.write(`${pad(config.name, 14)}${pad(tokens, 10)}${pad(`${delta > 0 ? "+" : ""}${delta}%`, 12)}\n`);
    }
    process.stdout.write("\nper-fixture (config: all):\n");
    for (const fixture of FIXTURES) {
        const before = estimateTokens(fixture.raw);
        const after = estimateTokens(cleanedFor(fixture, ""));
        const delta = before === 0 ? 0 : Math.round(((after - before) / before) * 100);
        process.stdout.write(`  ${pad(fixture.name, 22)}${before} → ${after} tok (${delta}%)\n`);
    }
};

// Read a live sandbox's filter-stats.jsonl: report realized savings + high-volume commands no cleaner matched
// (candidates for a new registry handler — the rtk `discover` idea).
const discover = (file) => {
    const rows = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    const rawBytes = rows.reduce((sum, row) => sum + (row.rawBytes ?? 0), 0);
    const emittedBytes = rows.reduce((sum, row) => sum + (row.emittedBytes ?? 0), 0);
    const savedPct = rawBytes === 0 ? 0 : Math.round(((rawBytes - emittedBytes) / rawBytes) * 100);
    process.stdout.write(`commands: ${rows.length} · raw ~${Math.round(rawBytes / 4)} tok → emitted ~${Math.round(emittedBytes / 4)} tok · saved ${savedPct}%\n\n`);
    const gaps = rows
        .filter((row) => (row.matched === undefined || row.matched.length === 0) && (row.rawBytes ?? 0) > 2000)
        .sort((a, b) => (b.rawBytes ?? 0) - (a.rawBytes ?? 0))
        .slice(0, 15);
    if (gaps.length === 0) {
        process.stdout.write("no high-volume un-cleaned commands — every noisy command matched a cleaner.\n");
        return;
    }
    process.stdout.write("high-volume commands with NO matching cleaner (add a handler for these):\n");
    for (const row of gaps) {
        process.stdout.write(`  ~${Math.round((row.rawBytes ?? 0) / 4)} tok  ${String(row.command).slice(0, 80)}\n`);
    }
};

const [subcommand, file] = process.argv.slice(2);
if (subcommand === "discover") {
    if (file === undefined) {
        process.stderr.write("usage: cleaner-bench discover <filter-stats.jsonl>\n");
        process.exit(1);
    }
    discover(file);
} else {
    bench();
}
