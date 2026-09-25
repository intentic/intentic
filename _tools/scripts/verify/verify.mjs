#!/usr/bin/env node
// Runs the whole repo the way CI's verify groups measure it, once each, since typecheck and test would otherwise both
// pay for the declarations emit. THE check work gets: the sandbox runs it on the main tree after every land, in the
// background, never inside a conversation and never holding anything (a land, a commit, a push). Records its verdict,
// green or red, for the push check to report and for `pnpm verify:turn` (a manual, optional check now) to subtract what
// main already fails (failure-units.mjs). Run after a land (INTENTIC_LAND_FROM set), it first writes what a machine
// decides (fixers.mjs), since no turn end does that any more.
// node _tools/checks/run.mjs the checkout gates
// node _tools/scripts/build/emit-declarations.mjs every emitted package's dist
// turbo run typecheck
// turbo run test --only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { git,changedSince } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { runInHeavySlot } from "../lib/heavy-slot.mjs";
import { treeHash, writeVerdict } from "../lib/tree-verdict.mjs";
import { checkVerdicts } from "./check-snapshot.mjs";
import { failedTasks, takeSummary, taskOf, unitsOf, verdictUnits } from "./failure-units.mjs";
import { fixChecks, formatCrates, regenerateContractLock, regenerateStateShapes, rustfmtAvailable, touchedCrates } from "./fixers.mjs";
import { recordFlakes, rerunFailures } from "./flakes.mjs";
import { landTiers } from "./land-tiers.mjs";
import { testConcurrency, testWorkers, typecheckConcurrency } from "./test-workers.mjs";

// Nothing below runs beside another heavy run: outside the sandbox's heavy slot this waits for it (heavy-slot.mjs).
runInHeavySlot("verify");

const root = repoRoot(import.meta.url);
const { say, step, skip, fail, failing, failedSteps, finish } = createSteps("verify", root);
const head = git(root, "rev-parse", "HEAD")?.trim();

// Set by the daemon to the main-line commit the land it verifies departed from; a run by hand measures no land.
const landFrom = process.env.INTENTIC_LAND_FROM;
const afterLand = landFrom !== undefined && landFrom !== "";
// What the land changed, for the fixers that act only on what changed; undefined (git could not say) widens them.
const landed = afterLand ? changedSince(root, landFrom) : undefined;

// What a machine decides is written before anything is judged, on the tree the land left: formatting, and each failing
// check's own fix. These used to run at every turn's end in the turn's own worktree; now they run once, here, and show
// up in the main tree as ordinary uncommitted changes for whoever commits it.
if (afterLand) {
    const formatted = rustfmtAvailable(root) ? formatCrates(root, touchedCrates(root, landed)) : [];
    const verdicts = checkVerdicts(root);
    const fixed = verdicts === undefined ? [] : fixChecks(root, verdicts);
    if (formatted.length + fixed.length > 0) {
        say(`fixed before judging: ${[...formatted.map((crate) => `${crate} (cargo fmt)`), ...fixed].join(", ")}`);
    }
}

// `--tidy=warn`: a tidy rule red for an unrelated directory shouldn't fail this land's verdict and cost the next push
// ten minutes replaying typecheck and tests. What a tidy failure means: _tools/checks/manifest.mjs.
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs"), "--tidy=warn"]);

// `_tools/scripts` is plumbing, not a workspace package, so `turbo run test` can't reach its `*.test.mjs` files; run
// directly via node:test, which needs no install.
step("script self-tests", process.execPath, ["--test", "_tools/scripts/**/*.test.mjs"]);

// The JUnit reports the test run leaves for failure-units.mjs; removed once read.
const junitDir = mkdtempSync(join(tmpdir(), "verify-junit-"));

// TEST_WORKERS bounds a repo-wide run's memory, sized to what is free when the tests start (test-workers.mjs), not when
// this script did; INDEXNOW_ENABLED=0 stops the site build from polling live.
const suiteEnv = () => ({ TEST_WORKERS: testWorkers(), INDEXNOW_ENABLED: "0", SUITES_JUNIT_DIR: junitDir });

// Tasks that failed and their units, less what passed when re-run alone (logged as a flake, never a red verdict).
const measured = [];
const units = [];
const turbo = (label, args, env) => {
    const since = Date.now();
    step(label, "pnpm", ["turbo", "run", ...args, "--continue=dependencies-successful", "--summarize"], {
        env,
        judge: () => {
            const tasks = failedTasks(takeSummary(root, since));
            const { flaky, still } = rerunFailures(root, tasks, unitsOf(root, tasks, junitDir));
            recordFlakes(root, flaky);
            measured.push(...tasks.filter(({ taskId }) => still.some((unit) => taskOf(unit) === taskId)));
            units.push(...still);
            return still.length === 0 && flaky.length > 0 ? { ok: true, note: `${flaky.length} failure(s) passed when re-run alone: flaky, logged` } : { ok: false };
        },
    });
    takeSummary(root, since);
};

// Typecheck and test both resolve imports through the emitted `.d.ts`, so both are skipped if the emit fails. They're
// independent of each other: bun strips types, so a suite can mean something on a tree that doesn't type-check.
if (step("emit declarations", process.execPath, [join(root, "_tools/scripts/build/emit-declarations.mjs")])) {
    // The wire contract's lock is written from the emitted dist, so only now; the land's contract change is then judged
    // against a lock that says what it changed, and the lock itself rides the owner's next commit.
    if (afterLand && regenerateContractLock(root, landed)) {
        say("contract.lock.json rewritten from the contract this land changed");
    }
    // Likewise every stored document's new shape, frozen before the typecheck that judges whether older ones still convert.
    if (afterLand && regenerateStateShapes(root, landed)) {
        say("state-shapes.json froze a new shape of a stored document this land changed");
    }
    // Each run's task count is sized to what is free as it starts: a vue-tsc heap per typecheck, a worker per test task.
    turbo("typecheck", ["typecheck", `--concurrency=${typecheckConcurrency()}`], {});
    turbo("test", ["test", "--only", `--concurrency=${testConcurrency()}`], suiteEnv());
} else {
    for (const label of ["typecheck", "test"]) {
        skip(label, "the declarations it reads were not emitted");
    }
}

rmSync(junitDir, { recursive: true, force: true });

if (afterLand) {
    const added = landTiers(root, landFrom);
    if (added.length > 0) {
        process.stderr.write(`\n✗ ${added.length} problem(s) this land added over ${landFrom.slice(0, 9)}:\n${added.map((unit) => `  ${unit}`).join("\n")}\n`);
        fail("what this land added", `${added.length} finding(s) the land added over the commit it left`);
        units.push(...added);
    }
}

// A step that failed without naming units (the checkout gates, the script self-tests, the declarations emit) is still a
// failure the router has to see: it becomes one unit named after the step, or a red report would read as nothing broke.
const unitless = failedSteps().filter(({ label }) => !["typecheck", "test", "what this land added"].includes(label));
const kept = verdictUnits([...unitless.map(({ label, why }) => `verify ${label}: ${why}`), ...units], measured);
if (failing()) {
    writeVerdict(root, treeHash(root), "failed", "verify", { head, ...kept });
}
// Where the daemon asked for this run's failures as data (verify-deps.ts), written whether or not the run was red. A red
// one names the command that re-runs only some of them in another tree (rerun-units.mjs), which the daemon uses to tell
// several suspect lands apart on their own trees (agents/land/land-bisect.ts).
const report = process.env.INTENTIC_VERIFY_REPORT;
if (report !== undefined && report !== "") {
    const rerun = failing() ? { rerun: `node ${join(root, "_tools/scripts/verify/rerun-units.mjs")}` } : {};
    writeFileSync(report, `${JSON.stringify({ status: failing() ? "failed" : "passed", ...kept, ...rerun })}\n`);
}

finish(() => {
    const recorded = writeVerdict(root, treeHash(root), "passed", "verify", { head });
    return `checkout gates, declarations, typecheck and tests${recorded ? " (recorded for the push gate)" : ""}`;
});
