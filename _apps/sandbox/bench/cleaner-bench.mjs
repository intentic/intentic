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
import { parseStatsFile, summarizeStats } from "../bin/filter-stats.mjs";

// ~4 chars/token, the same heuristic iq-engine's estimateTokens uses — kept inline so the bench has no build dep.
const estimateTokens = (text) => Math.ceil(text.length / 4);
const pad = (value, width) => String(value).padEnd(width);

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
    {
        name: "tsc --diagnostics (green)",
        command: "tsc --noEmit --diagnostics",
        exitCode: "0",
        raw: `${["(node:4210) ExperimentalWarning: Type Stripping is an experimental feature", "Files:              412", "Lines:            84213", "Check time:         3.10s", "Total time:         4.82s"].join("\n")}\n`,
    },
    {
        name: "ls -lR",
        command: "ls -lR src",
        exitCode: "0",
        // A realistic recursive listing: several dirs, each with a `total N` header and many entries — the size
        // where stripping the headers + the global head/tail cap actually pays (tiny listings are net-neutral).
        raw: `${["node_modules:", "total 0", ...Array.from({ length: 40 }, (_, i) => `drwxr-xr-x 3 u u 4096 dep-${i}`), "", "node_modules/.pnpm:", "total 0", ...Array.from({ length: 80 }, (_, i) => `drwxr-xr-x 3 u u 4096 pkg-${i}@1.0.${i}`)].join("\n")}\n`,
    },
    {
        name: "cargo build",
        command: "cargo build",
        exitCode: "0",
        raw: `${[...Array.from({ length: 25 }, (_, i) => `   Compiling crate-${i} v0.1.${i}`), "   Updating crates.io index", "    Finished dev [unoptimized] target(s) in 12.4s"].join("\n")}\n`,
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
    spec === "off" ? fixture.raw : filterOutput(fixture.raw, fixture.command, fixture.exitCode, "0", "", parseCleaners(spec)).out;

const bench = () => {
    const baseline = FIXTURES.reduce((sum, fixture) => sum + estimateTokens(fixture.raw), 0);
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
// (candidates for a new registry handler — the rtk `discover` idea). Uses the shared summarizeStats so the CLI
// and the daemon's /settings/savings route report the same numbers.
const discover = (file) => {
    const report = summarizeStats(parseStatsFile(readFileSync(file, "utf8")));
    const measured = report.holdout.measuredSavedPct !== undefined ? ` · holdout-measured ${report.holdout.measuredSavedPct}%` : "";
    process.stdout.write(
        `commands: ${report.commands} · raw ~${report.rawTokens} tok → emitted ~${report.emittedTokens} tok · saved ${report.savedPct}%${measured}\n`,
    );
    if (report.perCleaner.length > 0) {
        // Tokens first: which handler is WORTH the most is the question this list is read for, and a count of
        // how often one fired answers a different one (a cleaner can fire constantly and save nothing).
        process.stdout.write(
            `by mechanism: ${report.perCleaner.map((entry) => `${entry.id} ~${entry.savedTokens} tok ×${entry.commands}`).join(", ")}\n`,
        );
    }
    process.stdout.write("\n");
    if (report.gaps.length === 0) {
        process.stdout.write("no high-volume un-cleaned commands — every noisy command matched a cleaner.\n");
        return;
    }
    process.stdout.write("high-volume commands with NO matching cleaner (add a handler for these):\n");
    for (const gap of report.gaps) {
        process.stdout.write(`  ~${gap.tokens} tok  ${gap.command}\n`);
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
