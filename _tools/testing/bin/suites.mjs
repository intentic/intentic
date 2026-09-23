#!/usr/bin/env node
// A package's test script: `suites [--watch] [filter...]`. Two `bun test` runs, since a run has one budget and the
// two kinds cannot share it: unit suites get a hang detector, `*.integration.test.*` and `*.e2e.test.*` get the
// machine's time. Both read the package's own bunfig.toml (preload, ignore patterns) from the working directory.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { INTEGRATION_MARKERS, SUITE_TIMEOUTS } from "../../constants/src/test-suites.mjs";
import { junitFile, SOURCE_CONDITION } from "../../scripts/verify/failure-units.mjs";
import { standaloneWorkers } from "../../scripts/verify/test-workers.mjs";

// Unit: purely a hang detector, since nothing in a unit suite waits on anything. Integration: real work on a shared
// machine, room for two 30s waitFor SETTLES.
const { unit: UNIT_TIMEOUT_MS, integration: INTEGRATION_TIMEOUT_MS } = SUITE_TIMEOUTS;

// The kind is in the file name; `bun test` matches a positional filter against the path, so these select the second
// run and the ignore globs exclude it from the first.
const INTEGRATION_FILTERS = INTEGRATION_MARKERS.map((marker) => `.${marker}.test.`);
const INTEGRATION_GLOBS = INTEGRATION_MARKERS.map((marker) => `**/*.${marker}.test.*`);

// Worker count per run: `TEST_WORKERS` is how a repo-wide fan-out bounds memory (test-workers.mjs sizes it to the
// cgroup); a lone run sizes itself to the box, since one worker per core on the web package is 2 GiB a core.
const parallel = `--parallel=${process.env.TEST_WORKERS || standaloneWorkers()}`;

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const filters = args.filter((arg) => arg !== "--watch");

// Set by a gate that reads failures back as units (failure-units.mjs); each run then also writes a JUnit report there.
const junitDir = process.env.SUITES_JUNIT_DIR;
const report = (kind) =>
    junitDir === undefined || junitDir === ""
        ? []
        : ["--reporter=junit", `--reporter-outfile=${junitFile(junitDir, JSON.parse(readFileSync("package.json", "utf8")).name, kind)}`];

// `--isolate`: a fresh module registry per file, so a `jest.mock` one suite installs never reaches the next.
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

const unit = run([parallel, `--timeout=${UNIT_TIMEOUT_MS}`, ...report("unit"), ...INTEGRATION_GLOBS.flatMap((glob) => ["--path-ignore-patterns", glob])]);
const integration = run([parallel, `--timeout=${INTEGRATION_TIMEOUT_MS}`, ...report("integration"), ...INTEGRATION_FILTERS]);
process.exit(unit === 0 && integration === 0 ? 0 : 1);
