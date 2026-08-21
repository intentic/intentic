#!/usr/bin/env node
// Offline output-cleaner benchmark: replay captured command outputs through named cleaner configs and report the
// output-token delta per config. Deterministic, no agent: the "few different setups" harness for the cleaners
// (the analogue of iq-bench's config sweep). Plain .mjs so it shares the exact filter code the sandbox ships.
//
//   pnpm --filter @intentic/sandbox bench:cleaners                                # sweep configs over fixtures
//   pnpm --filter @intentic/sandbox bench:cleaners corpus [~/.claude/projects]    # sweep over REAL transcripts
//   pnpm --filter @intentic/sandbox bench:cleaners discover <filter-stats.jsonl>  # live-run savings + gaps
//
// Fixtures are a unit-level sanity check: they say a cleaner still fires, not what the cleaners are worth. Only
// `corpus` answers the second question, and the two disagree by a factor of five when the fixture list drifts
// toward the outputs someone hoped to compress. Quote `corpus`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterOutput } from "../bin/agent-output-filter.mjs";
import { parseCleaners } from "../bin/cleaners.mjs";
import { parseStatsFile, summarizeStats } from "../bin/filter-stats.mjs";

// ~4 chars/token, the same heuristic iq-engine's estimateTokens uses: kept inline so the bench has no build dep.
const estimateTokens = (text) => Math.ceil(text.length / 4);
const pad = (value, width) => String(value).padEnd(width);
const percent = (part, whole) => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`);

// Captured representative raw outputs (combined stdout+stderr, as tmux-run tees them). Shapes and command
// spellings are taken from the session corpus, `cd …  &&` prefix included: that prefix is how four out of five
// agent commands are actually written, and a fixture list without it silently benchmarks a command style the
// agent does not use.
const FIXTURES = [
    {
        name: "find (path run)",
        command: "cd /work/intentic && find _sandbox/sandbox/src -name '*.ts'",
        exitCode: "0",
        raw: `${["agent", "agents", "logs", "sessions", "workspace", "acp", "usage"]
            .flatMap((dir) => Array.from({ length: 18 }, (_, i) => `_sandbox/sandbox/src/${dir}/${dir}-module-${i}.ts`))
            .join("\n")}\n`,
    },
    {
        name: "ls -la (long listing)",
        command: "cd /work/intentic/_sandbox/sandbox && ls -la src/agent",
        exitCode: "0",
        raw: `${[
            "total 628",
            "drwxr-xr-x  2 root root  4096 Jul 30 13:38 .",
            "drwxr-xr-x 41 root root  4096 Jul 30 13:38 ..",
            ...Array.from({ length: 24 }, (_, i) => `-rw-r--r--  1 root root  ${3801 + i * 97} Jul 30 13:38 agent-module-${i}.ts`),
            "lrwxrwxrwx  1 root root     7 Jul 30 13:38 latest -> agent.ts",
        ].join("\n")}\n`,
    },
    {
        name: "grep -rn (over cap)",
        command: "cd /work/intentic && grep -rn import _sandbox/sandbox/src",
        exitCode: "0",
        raw: `${Array.from(
            { length: 400 },
            (_, i) => `_sandbox/sandbox/src/mod-${i % 40}.ts:${i}:import { thing${i} } from "@intentic/sandbox-contract";`,
        ).join("\n")}\n`,
    },
    {
        name: "git status (tiny)",
        command: "cd /work/intentic && git status --short",
        exitCode: "0",
        // The never-worse case: nothing here is compressible, so the filter must hand it back byte for byte.
        raw: " M _sandbox/sandbox/bin/cleaners.mjs\n M _sandbox/sandbox/bin/agent-output-filter.mjs\n",
    },
    {
        name: "pnpm install",
        command: "cd /work/intentic && pnpm install",
        exitCode: "0",
        raw: `${["Progress: resolved 1, reused 0, downloaded 0, added 0", "Progress: resolved 812, reused 800, downloaded 12, added 0", "Packages: +240", "++++++++++++++++++++++++++++++++++++++++", "Downloading typescript@5.9.2: 2.1 MB/2.1 MB, done", "Virtual store is at node_modules/.pnpm", "Lockfile is up to date, resolution step is skipped", "dependencies:", "+ zod 4.4.3", "Done in 4.2s"].join("\n")}\n`,
    },
    {
        name: "vitest (green)",
        command: "cd /work/intentic/_sandbox/sandbox && ./node_modules/.bin/vitest run",
        exitCode: "0",
        raw: `${[...Array.from({ length: 40 }, (_, i) => `✓ src/mod-${i}.test.ts (${i % 5}) ${i}ms`), "", "Test Files  40 passed (40)", "Tests  180 passed (180)", "Duration  3.7s"].join("\n")}\n`,
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
        command: "cd /work/intentic && ./node_modules/.bin/tsgo --noEmit",
        exitCode: "1",
        raw: `${[...Array.from({ length: 20 }, (_, i) => `src/ok-${i}.ts building`), "src/broken.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.", "src/broken.ts(19,7): error TS2551: Property 'x' does not exist.", "Found 2 errors."].join("\n")}\n`,
    },
];

// Named configs, mirroring iq-bench: the "off" baseline (filter disabled ⇒ raw) plus cleaner subsets. The two
// shape cleaners get their own holdout row each, because they are the ones carrying the corpus.
const CONFIGS = [
    { name: "off (raw)", spec: "off" },
    { name: "all", spec: "" },
    { name: "no-cap", spec: "-cap" },
    { name: "no-files", spec: "-files" },
    { name: "no-ls", spec: "-ls" },
    { name: "no-dedup", spec: "-dedup" },
    { name: "strip-only", spec: "-cap,-dedup,-redact,-files,-ls" },
];

const cleanedFor = (raw, command, exitCode, spec) => (spec === "off" ? raw : filterOutput(raw, command, exitCode, "0", "", parseCleaners(spec)).out);

const sweep = (samples, label) => {
    const baseline = samples.reduce((sum, sample) => sum + estimateTokens(sample.raw), 0);
    process.stdout.write(`${label}\n`);
    process.stdout.write(`${pad("config", 14)}${pad("tokens", 10)}${pad("Δ vs raw", 12)}\n`);
    process.stdout.write(`${"-".repeat(36)}\n`);
    for (const config of CONFIGS) {
        const tokens = samples.reduce((sum, sample) => sum + estimateTokens(cleanedFor(sample.raw, sample.command, sample.exitCode, config.spec)), 0);
        const delta = baseline === 0 ? 0 : Math.round(((tokens - baseline) / baseline) * 100);
        process.stdout.write(`${pad(config.name, 14)}${pad(tokens, 10)}${pad(`${delta > 0 ? "+" : ""}${delta}%`, 12)}\n`);
    }
};

const bench = () => {
    sweep(FIXTURES, "fixtures (sanity check: see `corpus` for what the cleaners are worth)");
    process.stdout.write("\nper-fixture (config: all):\n");
    for (const fixture of FIXTURES) {
        const before = estimateTokens(fixture.raw);
        const after = estimateTokens(cleanedFor(fixture.raw, fixture.command, fixture.exitCode, ""));
        const delta = before === 0 ? 0 : Math.round(((after - before) / before) * 100);
        process.stdout.write(`  ${pad(fixture.name, 22)}${before} → ${after} tok (${delta}%)\n`);
    }
};

// ---- corpus: the same sweep over what the agent actually ran ------------------------------------------------
// Session transcripts are JSONL; a Bash command is a `tool_use` block and what the model saw is the `tool_result`
// block carrying its id. Results the live filter already processed are skipped: replaying them would count the
// same trim twice and report a saving the cleaners did not make on this run.

const resultText = (content) => {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(resultText).join("\n");
    }
    if (content !== null && typeof content === "object") {
        return typeof content.text === "string" ? content.text : "";
    }
    return "";
};

const FILTERED = /\n--- \[exit .*\] \d+ lines filtered to \d+/;
const TMUX_WRAPPED = /^\/?\S*tmux-run\s/;
// tmux-run's wrapper quotes the agent's own command line; the bench wants what the agent wrote, not the wrapper.
const unwrap = (command) => {
    if (!TMUX_WRAPPED.test(command)) {
        return command;
    }
    const quoted = command.match(/'((?:[^']|'\\'')*)'/);
    return quoted === null ? command : quoted[1].replaceAll(`'\\''`, "'");
};

const transcriptFiles = (root) => {
    const found = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
            } else if (entry.endsWith(".jsonl")) {
                found.push(path);
            }
        }
    };
    walk(root);
    return found;
};

const readCorpus = (root) => {
    const samples = [];
    for (const file of transcriptFiles(root)) {
        const pending = new Map();
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (line === "") {
                continue;
            }
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                continue;
            }
            const content = event?.message?.content;
            if (!Array.isArray(content)) {
                continue;
            }
            for (const block of content) {
                if (block?.type === "tool_use") {
                    pending.set(block.id, block);
                    continue;
                }
                if (block?.type !== "tool_result") {
                    continue;
                }
                const use = pending.get(block.tool_use_id);
                if (use?.name !== "Bash" || typeof use.input?.command !== "string") {
                    continue;
                }
                const body = resultText(block.content);
                if (body === "" || FILTERED.test(body)) {
                    continue;
                }
                samples.push({
                    command: unwrap(use.input.command),
                    exitCode: block.is_error === true ? "1" : "0",
                    raw: body.endsWith("\n") ? body : `${body}\n`,
                });
            }
        }
    }
    return samples;
};

const corpus = (root) => {
    const samples = readCorpus(root);
    if (samples.length === 0) {
        process.stderr.write(`no Bash results found under ${root}\n`);
        process.exit(1);
    }
    const rawBytes = samples.reduce((sum, sample) => sum + sample.raw.length, 0);
    sweep(samples, `corpus: ${samples.length} Bash results, ${(rawBytes / 1e6).toFixed(2)} MB raw, from ${root}`);

    // Which mechanism earned it, over the whole corpus: the same stage ledger the savings report reads, summed
    // offline. A stage at zero here is a cleaner with no payer, and the reason to delete it.
    const stageBytes = new Map();
    let emitted = 0;
    for (const sample of samples) {
        const result = filterOutput(sample.raw, sample.command, sample.exitCode, "0", "", parseCleaners(""));
        emitted += result.out.length;
        for (const stage of result.stages) {
            stageBytes.set(stage.id, (stageBytes.get(stage.id) ?? 0) + stage.saved);
        }
    }
    process.stdout.write(`\nraw ${rawBytes} B → emitted ${emitted} B (saved ${percent(rawBytes - emitted, rawBytes)})\n`);
    process.stdout.write("by mechanism (bytes removed; negative = added):\n");
    for (const [id, bytes] of [...stageBytes.entries()].toSorted((left, right) => right[1] - left[1])) {
        process.stdout.write(`  ${pad(id, 10)}${pad(bytes, 12)}${percent(bytes, rawBytes)}\n`);
    }
};

// Read a live sandbox's filter-stats.jsonl: report realized savings + high-volume commands no cleaner matched
// (candidates for a new registry handler: the rtk `discover` idea). Uses the shared summarizeStats so the CLI
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
        process.stdout.write("no high-volume un-cleaned commands: every noisy command matched a cleaner.\n");
        return;
    }
    process.stdout.write("high-volume commands with NO matching cleaner (add a handler for these):\n");
    for (const gap of report.gaps) {
        // ×N first: a command that costs this much ACROSS N runs is a handler worth writing, and one that did
        // it once is an outlier. Same grouping the settings page's list reads from.
        process.stdout.write(`  ~${gap.tokens} tok ×${gap.commands}  ${gap.command}\n`);
    }
};

const [subcommand, argument] = process.argv.slice(2);
if (subcommand === "discover") {
    if (argument === undefined) {
        process.stderr.write("usage: cleaner-bench discover <filter-stats.jsonl>\n");
        process.exit(1);
    }
    discover(argument);
} else if (subcommand === "corpus") {
    corpus(argument ?? join(homedir(), ".claude", "projects"));
} else {
    bench();
}
