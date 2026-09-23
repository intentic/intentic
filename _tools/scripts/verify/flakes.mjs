// A failing test is re-run once, alone, before anyone is charged with it; one that passes then is a flake, logged here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";
import { git } from "../lib/git.mjs";
import { SUITE_TIMEOUTS, suiteKindOf } from "../../constants/src/test-suites.mjs";
import { junitCases, SOURCE_CONDITION, taskOf, unhandledErrors } from "./failure-units.mjs";

// Entries the ledger keeps, newest first.
export const FLAKES_KEPT = 300;

const UNHANDLED = "unhandled ";
// What bun names a failure in a before/after hook: no test owns it, so a clean re-run never lists it.
const HOOK_FAILURE = "(unnamed)";

// A test unit's parts, or undefined for any other unit; a failure no test owns (between tests, in a hook) is its whole file's.
export const testUnitParts = (unit, task) => {
    const at = unit.indexOf(" › ");
    if (task?.task !== "test" || at === -1) {
        return undefined;
    }
    const file = posix.relative(task.directory ?? "", unit.slice(task.taskId.length + 1, at));
    const rest = unit.slice(at + 3);
    return rest.startsWith(UNHANDLED) || rest === HOOK_FAILURE ? { file, unhandled: true } : { file, name: rest, unhandled: false };
};

// Whether a unit passed its re-run: its case ran and passed, or its whole file ran with nothing failing this time.
export const passedAgain = (parts, cases, errors) =>
    parts.unhandled
        ? cases.some(({ file }) => file === parts.file) &&
          !cases.some(({ file, failed }) => file === parts.file && failed) &&
          !errors.some(({ file }) => file === parts.file)
        : cases.some(({ file, name, failed }) => file === parts.file && name === parts.name && !failed);

const readOr = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
};

// One `bun test` of exact files in one package and one budget; answers its cases and the errors between tests.
const rerun = (root, directory, kind, files) => {
    const scratch = mkdtempSync(join(tmpdir(), "flake-rerun-"));
    try {
        const report = join(scratch, "report.xml");
        const run = spawnSync(
            "bun",
            ["test", `--conditions=${SOURCE_CONDITION}`, "--isolate", `--timeout=${SUITE_TIMEOUTS[kind]}`, "--reporter=junit", `--reporter-outfile=${report}`, ...files.map((file) => `./${file}`)],
            { cwd: join(root, directory), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        return { cases: junitCases(readOr(report)), errors: unhandledErrors(`${run.stdout ?? ""}${run.stderr ?? ""}`) };
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

// Splits `units` into those that passed a second, lone run (`flaky`) and the rest (`still`); only test units re-run.
export const rerunFailures = (root, tasks, units) => {
    const byTask = new Map(tasks.map((task) => [task.taskId, task]));
    const groups = new Map();
    for (const unit of units) {
        const task = byTask.get(taskOf(unit));
        const parts = testUnitParts(unit, task);
        if (parts !== undefined) {
            const key = `${task.taskId}\n${suiteKindOf(parts.file)}`;
            groups.set(key, [...(groups.get(key) ?? []), { unit, parts, task }]);
        }
    }
    const flaky = new Set();
    for (const [key, members] of groups) {
        const kind = key.split("\n")[1];
        const { cases, errors } = rerun(root, members[0].task.directory ?? "", kind, [...new Set(members.map(({ parts }) => parts.file))]);
        for (const { unit, parts } of members) {
            if (passedAgain(parts, cases, errors)) {
                flaky.add(unit);
            }
        }
    }
    return { flaky: units.filter((unit) => flaky.has(unit)), still: units.filter((unit) => !flaky.has(unit)) };
};

const ledgerPath = (root) => {
    const dir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return dir === undefined ? undefined : join(dir, "intentic-flakes.json");
};

// Every logged flake `{ unit, at, load, cores }`, newest first; `load` is the one-minute load average when it failed.
export const readFlakes = (root) => {
    const path = ledgerPath(root);
    try {
        const parsed = path === undefined ? [] : JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.unit === "string") : [];
    } catch {
        return [];
    }
};

// Logs `units` as flakes that happened now, shared by every worktree of the repository.
export const recordFlakes = (root, units) => {
    const path = ledgerPath(root);
    if (path === undefined || units.length === 0) {
        return;
    }
    const at = Date.now();
    const entries = units.map((unit) => ({ unit, at, load: Math.round(loadavg()[0] * 10) / 10, cores: availableParallelism() }));
    try {
        writeFileSync(path, `${JSON.stringify([...entries, ...readFlakes(root)].slice(0, FLAKES_KEPT))}\n`);
    } catch {
        // A ledger that cannot be written loses a count, never a verdict.
    }
};

// Units ranked by how often they flaked, most first: what a repair should look at before anything else.
export const flakeCounts = (entries) =>
    [...entries.reduce((counts, { unit }) => counts.set(unit, (counts.get(unit) ?? 0) + 1), new Map())].sort((left, right) => right[1] - left[1]);

// `--worst [--min N] [--days D]`: exits 0 printing the flake that recurred at least N times in D days, else exits 1 (a guard).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv.includes("--worst")) {
    const number = (flag, fallback) => (process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback);
    const min = number("--min", 3);
    const since = Date.now() - number("--days", 7) * 86_400_000;
    const recent = readFlakes(repoRoot(import.meta.url)).filter(({ at }) => at >= since);
    const [worst] = flakeCounts(recent);
    if (worst === undefined || worst[1] < min) {
        console.error(`no test flaked ${min} times in the window (${recent.length} flake(s) logged in it)`);
        process.exit(1);
    }
    const loads = recent.filter(({ unit }) => unit === worst[0]).map(({ load, cores }) => `${load}/${cores}`);
    console.log(`${worst[0]}\n  flaked ${worst[1]} times; one-minute load / cores each time: ${loads.join(", ")}`);
}
