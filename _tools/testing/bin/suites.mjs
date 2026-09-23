#!/usr/bin/env node
// A package's test script: `suites [--watch] [filter...]`. Two `bun test` runs, since a run has one budget and the
// two kinds cannot share it: unit suites get a hang detector, `*.integration.test.*` and `*.e2e.test.*` get the
// machine's time. Both read the package's own bunfig.toml (preload, ignore patterns) from the working directory.
import { spawnSync } from "node:child_process";
import { standaloneWorkers } from "../../scripts/verify/test-workers.mjs";

// Purely a hang detector: nothing in a unit suite waits on anything, so 20s bounds a hang, not real latency.
const UNIT_TIMEOUT_MS = 20_000;

// Real work on a shared machine: 120s bounds a hang well clear of latency, room for two 30s waitFor SETTLES.
const INTEGRATION_TIMEOUT_MS = 120_000;

// The kind is in the file name; `bun test` matches a positional filter against the path, so these select the second
// run and the ignore globs exclude it from the first.
const INTEGRATION_FILTERS = [".integration.test.", ".e2e.test."];
const INTEGRATION_GLOBS = ["**/*.integration.test.*", "**/*.e2e.test.*"];

// Workspace packages resolve to their TypeScript through this export condition, as the build does; without it a
// suite would run against whatever dist a previous build left behind.
const SOURCE_CONDITION = "@intentic/src";

// Worker count per run: `TEST_WORKERS` is how a repo-wide fan-out bounds memory (test-workers.mjs sizes it to the
// cgroup); a lone run sizes itself to the box, since one worker per core on the web package is 2 GiB a core.
const parallel = `--parallel=${process.env.TEST_WORKERS || standaloneWorkers()}`;

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const filters = args.filter((arg) => arg !== "--watch");

// `--isolate`: a fresh module registry per file, so a `mock.module` one suite installs never reaches the next.
const run = (extra) => {
    const result = spawnSync("bun", ["test", `--conditions=${SOURCE_CONDITION}`, "--isolate", "--pass-with-no-tests", ...extra, ...filters], {
        stdio: "inherit",
    });
    return result.status ?? 1;
};

if (watch) {
    // One run: a watch never exits, so the second run would never start; the larger budget keeps a slow suite alive.
    process.exit(run(["--watch", `--timeout=${INTEGRATION_TIMEOUT_MS}`]));
}

const unit = run([parallel, `--timeout=${UNIT_TIMEOUT_MS}`, ...INTEGRATION_GLOBS.flatMap((glob) => ["--path-ignore-patterns", glob])]);
const integration = run([parallel, `--timeout=${INTEGRATION_TIMEOUT_MS}`, ...INTEGRATION_FILTERS]);
process.exit(unit === 0 && integration === 0 ? 0 : 1);
