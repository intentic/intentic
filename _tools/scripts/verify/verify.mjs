#!/usr/bin/env node
// Runs the whole repo the way CI's verify groups measure it, once each, since typecheck and test would otherwise both
// pay for the declarations emit. Run by hand: nothing runs it unasked, and it applies no fixer (fixers.mjs runs before
// a land, in the conversation's own worktree).
// node _tools/checks/run.mjs the checkout gates (once, as data)
// node _tools/scripts/build/emit-declarations.mjs every emitted package's dist
// turbo run typecheck
// turbo run test --only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { createSteps } from "../lib/steps.mjs";
import { runInHeavySlot } from "../lib/heavy-slot.mjs";
import { checkVerdicts } from "./check-snapshot.mjs";
import { failedTasks, takeSummary, unitsOf } from "./failure-units.mjs";
import { recordFlakes, rerunFailures } from "./flakes.mjs";
import { testConcurrency, testWorkers, typecheckConcurrency } from "./test-workers.mjs";

// Nothing below runs beside another heavy run: outside the sandbox's heavy slot this waits for it (heavy-slot.mjs).
runInHeavySlot("verify");

const root = repoRoot(import.meta.url);
const { say, step, skip, fail, finish } = createSteps("verify", root);
const verdicts = checkVerdicts(root);

// Only a `code` failure fails the gates: a tidy rule failing for an unrelated directory says nothing about whether the tree
// works (what a tidy failure means: _tools/checks/manifest.mjs), and the push check judges tidiness against its own
// range (verify-push.mjs).
if (verdicts === undefined) {
    fail("checkout gates", "could not be measured", [], { spelling: "node _tools/checks/run.mjs" });
} else {
    const broken = verdicts.filter((verdict) => !verdict.ok && verdict.measured && verdict.gate === "code");
    const untidy = verdicts.filter((verdict) => !verdict.ok && verdict.gate === "tidy");
    for (const verdict of broken) {
        process.stderr.write(`\n✗ ${verdict.id} (${verdict.file})\n${`${verdict.stderr}${verdict.stdout}`.trimEnd()}\n`);
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

// A failed task's units are re-run alone first: what passes then is logged as a flake and fails nothing.
const turbo = (label, args, env) => {
    const since = Date.now();
    step(label, "pnpm", ["turbo", "run", ...args, "--continue=dependencies-successful", "--summarize"], {
        env,
        judge: () => {
            const tasks = failedTasks(takeSummary(root, since));
            const { flaky, still } = rerunFailures(root, tasks, unitsOf(root, tasks, junitDir));
            recordFlakes(root, flaky);
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

finish(() => "checkout gates, declarations, typecheck and tests");
