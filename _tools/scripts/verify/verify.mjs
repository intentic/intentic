#!/usr/bin/env node
// Runs the whole repo the way CI's verify groups measure it, once each, since typecheck and test would otherwise both
// pay for the declarations emit. Runs after every land on the main tree, not from the turn-ending check
// (verify-turn.mjs, the affected closure only) or the push gate (build only). Records its verdict, green or red, for the
// push gate to replay and for verify-turn to subtract what main already fails (failure-units.mjs).
// node _tools/checks/run.mjs the checkout gates
// node _tools/scripts/build/emit-declarations.mjs every emitted package's dist
// turbo run typecheck
// turbo run test --only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { git } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { treeHash, writeVerdict } from "../lib/tree-verdict.mjs";
import { failedTasks, takeSummary, taskOf, unitsOf, verdictUnits } from "./failure-units.mjs";
import { recordFlakes, rerunFailures } from "./flakes.mjs";
import { landTiers } from "./land-tiers.mjs";
import { testWorkers } from "./test-workers.mjs";

const root = repoRoot(import.meta.url);
const { step, skip, fail, failing, finish } = createSteps("verify", root);
const head = git(root, "rev-parse", "HEAD")?.trim();

// `--tidy=warn`: a tidy rule red for an unrelated directory shouldn't fail this land's verdict and cost the next push
// ten minutes replaying typecheck and tests. What a tidy failure means: _tools/checks/manifest.mjs.
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs"), "--tidy=warn"]);

// `_tools/scripts` is plumbing, not a workspace package, so `turbo run test` can't reach its `*.test.mjs` files; run
// directly via node:test, which needs no install.
step("script self-tests", process.execPath, ["--test", "_tools/scripts/**/*.test.mjs"]);

// The JUnit reports the test run leaves for failure-units.mjs; removed once read.
const junitDir = mkdtempSync(join(tmpdir(), "verify-junit-"));

// TEST_WORKERS bounds a repo-wide run's memory, sized to the cgroup; INDEXNOW_ENABLED=0 stops the site build from
// polling live.
const SUITE_ENV = { TEST_WORKERS: testWorkers(), INDEXNOW_ENABLED: "0", SUITES_JUNIT_DIR: junitDir };

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
    turbo("typecheck", ["typecheck"], {});
    turbo("test", ["test", "--only"], SUITE_ENV);
} else {
    for (const label of ["typecheck", "test"]) {
        skip(label, "the declarations it reads were not emitted");
    }
}

rmSync(junitDir, { recursive: true, force: true });

// Set by the daemon to the main-line commit the land it verifies departed from; a run by hand measures no land.
const landFrom = process.env.INTENTIC_LAND_FROM;
if (landFrom !== undefined && landFrom !== "") {
    const added = landTiers(root, landFrom);
    if (added.length > 0) {
        process.stderr.write(`\n✗ ${added.length} problem(s) this land added over ${landFrom.slice(0, 9)}:\n${added.map((unit) => `  ${unit}`).join("\n")}\n`);
        fail("what this land added", `${added.length} finding(s) the push gate would refuse`);
        units.push(...added);
    }
}

const kept = verdictUnits(units, measured);
if (failing()) {
    writeVerdict(root, treeHash(root), "failed", "verify", { head, ...kept });
}
// Where the daemon asked for this run's failures as data (verify-deps.ts), written whether or not the run was red.
const report = process.env.INTENTIC_VERIFY_REPORT;
if (report !== undefined && report !== "") {
    writeFileSync(report, `${JSON.stringify({ status: failing() ? "failed" : "passed", ...kept })}\n`);
}

finish(() => {
    const recorded = writeVerdict(root, treeHash(root), "passed", "verify", { head });
    return `checkout gates, declarations, typecheck and tests${recorded ? " (recorded for the push gate)" : ""}`;
});
