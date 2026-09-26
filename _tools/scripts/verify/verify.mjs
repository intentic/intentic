#!/usr/bin/env node
// Runs the whole repo the way CI's verify groups measure it, once each, since typecheck and test would otherwise both
// pay for the declarations emit. The checks' runner is asked once for the tree it judges (twice when a fixer changed
// it), and that one answer serves the checkout gates, what the land added (measure-change.mjs) and the push findings'
// measurement it leaves for the sandbox (push-report.mjs), which is why the sandbox no longer runs a recheck of its own. THE check work gets: the sandbox runs it on the main tree after every land, in the
// background, never inside a conversation and never holding anything (a land, a commit, a push). Records its verdict,
// green or red, for the push check to report. Run after a land (INTENTIC_LAND_FROM set), it first writes what a machine
// decides (fixers.mjs), the backstop for what the land's own worktree run of them left.
// node _tools/checks/run.mjs the checkout gates (once, as data)
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
import { brokenFindings, measureEntry, writeReport } from "./push-report.mjs";
import { failedTasks, takeSummary, taskOf, unitsOf, verdictUnits } from "./failure-units.mjs";
import { fixChecks, formatCrates, regenerateContractLock, regenerateStateShapes, rustfmtAvailable, tightenBaselines, touchedCrates } from "./fixers.mjs";
import { recordFlakes, rerunFailures } from "./flakes.mjs";
import { landTiers } from "./land-tiers.mjs";
import { testConcurrency, testWorkers, typecheckConcurrency } from "./test-workers.mjs";

// Nothing below runs beside another heavy run: outside the sandbox's heavy slot this waits for it (heavy-slot.mjs).
runInHeavySlot("verify");

const root = repoRoot(import.meta.url);
const { say, step, skip, fail, failing, failedSteps, finish } = createSteps("verify", root);
const head = git(root, "rev-parse", "HEAD")?.trim();

// Set by the daemon to the main-line commit the land it verifies departed from; a run by hand measures no land. One the
// tree's HEAD does not descend from (a branch tip a rebase by hand orphaned) is no such commit: measured from, it charges
// the land with everything main gained since, so the land is measured from HEAD instead, over what is not committed yet.
const askedFrom = process.env.INTENTIC_LAND_FROM;
const landFrom =
    askedFrom === undefined || askedFrom === "" || head === undefined || git(root, "merge-base", "--is-ancestor", askedFrom, "HEAD") !== undefined
        ? askedFrom
        : head;
if (landFrom !== askedFrom) {
    say(`the land's base ${askedFrom.slice(0, 9)} is not on this tree's history; what it added is measured from HEAD ${head.slice(0, 9)}`);
}
const afterLand = landFrom !== undefined && landFrom !== "";
// What the land changed, for the fixers that act only on what changed. Undefined (git could not say) widens only
// rustfmt, to every crate; the baseline tightening, the contract lock and the state shapes then write nothing, since
// they cannot tell this land's change from any other's.
const landed = afterLand ? changedSince(root, landFrom) : undefined;

// What a machine decides is written before anything is judged, on the tree the land left: formatting, and each failing
// check's own fix. A conversation's worktree runs the change's fixers before its land (the sandbox's
// worktree-fixers.ts), so what they write rides that land; this is the backstop, and what it still writes shows up in
// the main tree as ordinary uncommitted changes for whoever commits it.
// The checks' answer for the tree as it will be judged: asked again only when a fixer wrote the tree.
let verdicts = checkVerdicts(root);
if (afterLand) {
    const formatted = rustfmtAvailable(root) ? formatCrates(root, touchedCrates(root, landed)) : [];
    // A ratcheted baseline is lowered only where this land's own paths beat it; no check run writes one (lib/ratchet.mjs).
    const fixed = [...(verdicts === undefined ? [] : fixChecks(root, verdicts)), ...tightenBaselines(root, landed)];
    if (formatted.length + fixed.length > 0) {
        say(`fixed before judging: ${[...formatted.map((crate) => `${crate} (cargo fmt)`), ...fixed].join(", ")}`);
        verdicts = checkVerdicts(root);
    }
}

// Only a `code` failure fails the gates: a tidy rule red for an unrelated directory shouldn't fail this land's verdict
// and cost the next push ten minutes replaying typecheck and tests (what a tidy failure means: _tools/checks/manifest.mjs);
// what a land adds to one is its own finding below (what this land added). Each broken check's lines are units the
// router can lay at a land by the paths they name.
const checkoutUnits = [];
if (verdicts === undefined) {
    fail("checkout gates", "could not be measured", [], { spelling: "node _tools/checks/run.mjs" });
} else {
    const broken = verdicts.filter((verdict) => !verdict.ok && verdict.measured && verdict.gate === "code");
    const untidy = verdicts.filter((verdict) => !verdict.ok && verdict.gate === "tidy");
    for (const verdict of broken) {
        process.stderr.write(`\n✗ ${verdict.id} (${verdict.file})\n${`${verdict.stderr}${verdict.stdout}`.trimEnd()}\n`);
        checkoutUnits.push(...brokenFindings(verdict).map(({ text }) => `check ${verdict.id}: ${text.replace(/:\d+/g, ":#")}`));
    }
    if (untidy.length > 0) {
        say(`tidy, reported and not failed: ${untidy.map(({ id }) => id).join(", ")}`);
    }
    if (broken.length > 0) {
        const ids = broken.map(({ id }) => id);
        fail("checkout gates", `${ids.length} check(s) the tree fails: ${ids.join(", ")}`, [], { spelling: `node _tools/checks/run.mjs --only ${ids.join(",")}` });
    } else {
        say(`checkout gates: ${verdicts.filter(({ ok }) => ok).length} passed`);
    }
}

// `_tools/scripts` and `_tools/checks` are plumbing, not workspace packages, so `turbo run test` can't reach their
// `*.test.mjs` files; run directly via node:test, which needs no install.
step("script self-tests", process.execPath, ["--test", "_tools/scripts/**/*.test.mjs", "_tools/checks/**/*.test.mjs"]);

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
    const added = landTiers(root, landFrom, { verdicts });
    if (added.length > 0) {
        process.stderr.write(`\n✗ ${added.length} problem(s) this land added over ${landFrom.slice(0, 9)}:\n${added.map((unit) => `  ${unit}`).join("\n")}\n`);
        fail("what this land added", `${added.length} finding(s) the land added over the commit it left`);
        units.push(...added);
    }
}

// A step that failed without naming units (the checkout gates, the script self-tests, the declarations emit) is still a
// failure the router has to see: it becomes one unit named after the step, or a red report would read as nothing broke.
const unitless = failedSteps().filter(({ label }) => !["typecheck", "test", "what this land added"].includes(label) && !(label === "checkout gates" && checkoutUnits.length > 0));
const kept = verdictUnits([...unitless.map(({ label, why }) => `verify ${label}: ${why}`), ...checkoutUnits, ...units], measured);
if (failing()) {
    writeVerdict(root, treeHash(root), "failed", "verify", { head, ...kept });
}
// Where the daemon asked for this run's failures as data (verify-deps.ts), written whether or not the run was red.
const report = process.env.INTENTIC_VERIFY_REPORT;
if (report !== undefined && report !== "") {
    writeFileSync(report, `${JSON.stringify({ status: failing() ? "failed" : "passed", ...kept })}\n`);
}

// What the checks measured of the tree, left where the sandbox files push findings (push-report.mjs): it clears what
// pushes left that this land fixed, with the one answer the gates were judged by. The linter is not measured here; the
// sandbox asks for it only where an open lint finding waits (workspace/deps/push-checks.ts).
if (verdicts !== undefined) {
    const written = writeReport(root, measureEntry(verdicts, undefined));
    if (!written.ok) {
        say(`the push findings' measurement could not be kept: ${written.why}`);
    }
}

finish(() => {
    const recorded = writeVerdict(root, treeHash(root), "passed", "verify", { head });
    return `checkout gates, declarations, typecheck and tests${recorded ? " (recorded for the push gate)" : ""}`;
});
