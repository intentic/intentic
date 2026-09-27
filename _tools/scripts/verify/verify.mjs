#!/usr/bin/env node
// Runs the whole repo the way CI's verify groups measure it, once each, since typecheck and test would otherwise both
// pay for the declarations emit. Run by hand: nothing runs it unasked, and it applies no fixer (fixers.mjs runs before
// a land, in the conversation's own worktree). The checks' runner is asked once, and that one answer serves the
// checkout gates and the measurement of every check it leaves where the sandbox files push findings (push-report.mjs).
// Records its verdict per tree, green or red (lib/tree-verdict.mjs), for the push check to replay.
// node _tools/checks/run.mjs the checkout gates (once, as data)
// node _tools/scripts/build/emit-declarations.mjs every emitted package's dist
// turbo run typecheck
// turbo run test --only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { git } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { runInHeavySlot } from "../lib/heavy-slot.mjs";
import { treeHash, writeVerdict } from "../lib/tree-verdict.mjs";
import { checkVerdicts } from "./check-snapshot.mjs";
import { brokenFindings, measureEntry, writeReport } from "./push-report.mjs";
import { failedTasks, takeSummary, taskOf, unitsOf, verdictUnits } from "./failure-units.mjs";
import { recordFlakes, rerunFailures } from "./flakes.mjs";
import { testConcurrency, testWorkers, typecheckConcurrency } from "./test-workers.mjs";

// Nothing below runs beside another heavy run: outside the sandbox's heavy slot this waits for it (heavy-slot.mjs).
runInHeavySlot("verify");

const root = repoRoot(import.meta.url);
const { say, step, skip, fail, failing, failedSteps, finish } = createSteps("verify", root);
const head = git(root, "rev-parse", "HEAD")?.trim();
const verdicts = checkVerdicts(root);

// Only a `code` failure fails the gates: a tidy rule red for an unrelated directory shouldn't fail the tree's verdict
// and cost the next push ten minutes replaying typecheck and tests (what a tidy failure means: _tools/checks/manifest.mjs);
// the push judges tidiness against its own range. Each broken check's lines become units of a red verdict.
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
    // Each run's task count is sized to what is free as it starts: a vue-tsc heap per typecheck, a worker per test task.
    turbo("typecheck", ["typecheck", `--concurrency=${typecheckConcurrency()}`], {});
    turbo("test", ["test", "--only", `--concurrency=${testConcurrency()}`], suiteEnv());
} else {
    for (const label of ["typecheck", "test"]) {
        skip(label, "the declarations it reads were not emitted");
    }
}

rmSync(junitDir, { recursive: true, force: true });

// A step that failed without naming units (the checkout gates, the script self-tests, the declarations emit) is still a
// failure: it becomes one unit named after the step, or a red verdict would read as nothing broke.
const unitless = failedSteps().filter(({ label }) => !["typecheck", "test"].includes(label) && !(label === "checkout gates" && checkoutUnits.length > 0));
const kept = verdictUnits([...unitless.map(({ label, why }) => `verify ${label}: ${why}`), ...checkoutUnits, ...units], measured);
if (failing()) {
    writeVerdict(root, treeHash(root), "failed", "verify", { head, ...kept });
}

// What the checks measured of the tree, with the one answer the gates were judged by, left where the sandbox files push
// findings (push-report.mjs): a finding an earlier push left that this tree no longer prints is resolved by it. The
// linter is not measured here, so a lint finding waits for a later push or a recheck (push-report.mjs --recheck).
if (verdicts !== undefined) {
    const written = writeReport(root, measureEntry(verdicts, undefined));
    if (!written.ok) {
        say(`the push findings' measurement could not be kept: ${written.why}`);
    }
}

finish(() => {
    const recorded = writeVerdict(root, treeHash(root), "passed", "verify", { head });
    return `checkout gates, declarations, typecheck and tests${recorded ? " (recorded for the push check)" : ""}`;
});
