#!/usr/bin/env node
// A package's test script: `suites [--watch] [filter...]`. Two `bun test` runs, since a run has one budget and the
// two kinds cannot share it: unit suites get a hang detector, `*.integration.test.*` and `*.e2e.test.*` get the
// machine's time. Both read the package's own bunfig.toml (preload, ignore patterns) from the working directory.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_MARKERS, INTEGRATION_NAME, STOOD_DOWN_FILE, SUITE_TIMEOUTS } from "../../constants/src/test-suites.mjs";
import { junitFile, SOURCE_CONDITION } from "../../scripts/verify/failure-units.mjs";
import { ceilingBytes, formatGiB, processTree, watchMemory } from "../../scripts/lib/memory-ceiling.mjs";
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

// WHAT NO RUN EVER DISCOVERS: build output and installs, whatever the package's bunfig says. On 2026-09-26 a CI
// runner's leftover `deploy/` (a pruned production copy of the api, gitignored, kept by a workspace that outlives
// the commit) put dozens of test files into verify-platform whose imports a --prod tree cannot resolve. The api's
// bunfig already ignored `**/deploy/**`, and it did not help: a `--path-ignore-patterns` on the command line
// REPLACES bunfig's `pathIgnorePatterns` rather than adding to it, and the unit run passes the integration globs
// there. So every run is handed the whole list: this fixed one, the package's own bunfig patterns, and every
// directory git ignores under the package (one `git ls-files --directory` call, a few milliseconds), which covers
// output nobody thought to name here.
const BUILD_OUTPUT_GLOBS = ["**/node_modules/**", "**/dist/**", "**/deploy/**", "**/.cache/**", "**/.turbo/**", "**/out-tsc/**"];

const bunfigIgnores = () => {
    if (!existsSync("bunfig.toml")) {
        return [];
    }
    const list = /^\s*pathIgnorePatterns\s*=\s*\[([^\]]*)\]/mu.exec(readFileSync("bunfig.toml", "utf8"))?.[1] ?? "";
    return [...list.matchAll(/"([^"]*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2]);
};

const gitIgnoredDirs = () => {
    try {
        const listed = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", "."], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 16 * 1024 * 1024,
        });
        return listed
            .split("\0")
            .filter((path) => path.endsWith("/"))
            .map((dir) => `${dir}**`);
    } catch {
        // allow(silent-catch): no git or no repository (an unpacked tarball) leaves the fixed list and the bunfig's own patterns
        return [];
    }
};

const IGNORES = [...new Set([...BUILD_OUTPUT_GLOBS, ...bunfigIgnores(), ...gitIgnoredDirs()])];
const ignoreArgs = (globs) => globs.flatMap((glob) => ["--path-ignore-patterns", glob]);

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const flags = args.filter((arg) => arg !== "--watch" && arg !== "--" && arg.startsWith("-"));
// bun matches a positional filter as a substring of the file's path, which it spells without a leading "./".
const filters = args.filter((arg) => !arg.startsWith("-")).map((arg) => arg.replace(/^\.\//u, ""));

// bun ORs positional filters, so a path filter beside the integration markers would still run every integration
// file; with filters, the files are chosen here and each run is handed only its own kind, as explicit paths.
const chosen = (() => {
    if (filters.length === 0 || watch) {
        return undefined;
    }
    const files = globSync("**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", { exclude: IGNORES }).filter((file) =>
        filters.some((filter) => file.includes(filter)),
    );
    if (files.length === 0) {
        process.stderr.write(`suites: no test file's path contains ${filters.map((filter) => `"${filter}"`).join(" or ")}\n`);
        process.exit(1);
    }
    const paths = (integration) => files.filter((file) => INTEGRATION_NAME.test(file) === integration).map((file) => `./${file}`);
    return { unit: paths(false), integration: paths(true) };
})();

// Set by a gate that reads failures back as units (failure-units.mjs); each run then also writes a JUnit report there.
const junitDir = process.env.SUITES_JUNIT_DIR;
const report = (kind) =>
    junitDir === undefined || junitDir === ""
        ? []
        : ["--reporter=junit", `--reporter-outfile=${junitFile(junitDir, JSON.parse(readFileSync("package.json", "utf8")).name, kind)}`];

// A throwaway home per run: Bun fixes os.homedir() at startup, so a suite's own `process.env.HOME = …` cannot redirect it,
// and a test writing under ~ would otherwise write the real one (~/.ssh, ~/.git-credentials). Only ~/.cache is shared.
const throwawayHome = () => {
    const home = mkdtempSync(join(tmpdir(), "suites-home-"));
    const cache = join(homedir(), ".cache");
    if (existsSync(cache)) {
        symlinkSync(cache, join(home, ".cache"));
    }
    return home;
};

// Where requires() (@intentic/testing/requires) records each test that stood down for a missing machine condition; read
// once both runs end, so a skip that no title scrolled past is still counted.
const stoodDownDir = mkdtempSync(join(tmpdir(), "suites-stood-down-"));
const stoodDown = join(stoodDownDir, "stood-down");
writeFileSync(stoodDown, "");

const reportStoodDown = () => {
    const lines = readFileSync(stoodDown, "utf8").split("\n").filter((line) => line !== "");
    rmSync(stoodDownDir, { recursive: true, force: true });
    if (lines.length === 0) {
        return;
    }
    const byWhy = new Map();
    for (const line of lines) {
        const why = line.slice(0, line.indexOf("\t"));
        byWhy.set(why, (byWhy.get(why) ?? 0) + 1);
    }
    const counted = [...byWhy].map(([why, count]) => `${count} for want of ${why}`).join(", ");
    process.stderr.write(`\nsuites: ${lines.length} stood down on this machine (${counted}); CI runs them, and fails where it cannot unless the test declares CI goes without it (absentOnCi)\n`);
};

// `--isolate`: a fresh module registry per file, so a `jest.mock` one suite installs never reaches the next.
// Every bun process of the run is held under a memory ceiling (memory-ceiling.mjs): one that passes it is a test
// holding memory it never gives back, and the run is killed there rather than left to swap the machine to a halt.
const run = async (extra, selection) => {
    const home = throwawayHome();
    try {
        const child = spawn("bun", ["test", `--conditions=${SOURCE_CONDITION}`, "--isolate", "--pass-with-no-tests", ...flags, ...extra, ...selection], {
            stdio: "inherit",
            env: { ...process.env, HOME: home, USERPROFILE: home, [STOOD_DOWN_FILE]: stoodDown },
        });
        const ceiling = ceilingBytes();
        const stop = watchMemory(child, {
            ceiling,
            onExceed: ({ pid, held }) =>
                process.stderr.write(
                    `\nsuites: bun process ${pid} held ${formatGiB(held)}, past the ${formatGiB(ceiling)} a test process may hold, so the run was killed. ` +
                        `A suite is keeping memory it never releases: the file it ran is among the last ones named above. ` +
                        `TEST_MEMORY_CEILING_MB moves the ceiling (0 turns it off).\n`,
                ),
        });
        // A stopped run stops its tests too: bun's workers sit in process groups of their own, which nothing that
        // ends this process by group would reach.
        const forward = (signal) => {
            for (const pid of processTree(child.pid ?? -1).toReversed()) {
                try {
                    process.kill(pid, signal);
                } catch {
                    // allow(silent-catch): a process already gone is what the signal was for
                }
            }
            process.exit(128 + (signal === "SIGINT" ? 2 : 15));
        };
        process.once("SIGTERM", forward);
        process.once("SIGINT", forward);
        const status = await new Promise((resolve) => {
            child.on("error", () => resolve(1));
            child.on("exit", (code) => resolve(code ?? 1));
        });
        stop();
        process.off("SIGTERM", forward);
        process.off("SIGINT", forward);
        return status;
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
};

if (watch) {
    // One run: a watch never exits, so the second run would never start; the larger budget keeps a slow suite alive.
    const status = await run(["--watch", `--timeout=${INTEGRATION_TIMEOUT_MS}`, ...ignoreArgs(IGNORES)], filters);
    reportStoodDown();
    process.exit(status);
}

// A kind the filters chose no file of is not run at all: an empty explicit list would mean "everything" to bun.
const unit =
    chosen?.unit.length === 0
        ? 0
        : await run([parallel, `--timeout=${UNIT_TIMEOUT_MS}`, ...report("unit"), ...ignoreArgs([...IGNORES, ...INTEGRATION_GLOBS])], chosen?.unit ?? []);
const integration =
    chosen?.integration.length === 0 ? 0 : await run([parallel, `--timeout=${INTEGRATION_TIMEOUT_MS}`, ...report("integration"), ...ignoreArgs(IGNORES)], chosen?.integration ?? INTEGRATION_FILTERS);
reportStoodDown();
process.exit(unit === 0 && integration === 0 ? 0 : 1);
