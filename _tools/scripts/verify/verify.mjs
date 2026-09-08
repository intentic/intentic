#!/usr/bin/env node
// Runs the whole repo the way CI's verify groups measure it, once each, since typecheck and test would otherwise both
// pay for the declarations emit. Runs after every land on the main tree, not from the turn-ending check
// (verify-turn.mjs, the affected closure only) or the push gate (build only). Records a green run for the push gate to
// replay.
// node _tools/checks/run.mjs the checkout gates
// node _tools/scripts/build/emit-declarations.mjs every emitted package's dist
// turbo run typecheck
// turbo run test --only
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { createSteps } from "../lib/steps.mjs";
import { treeHash, writeVerdict } from "../lib/tree-verdict.mjs";

const root = repoRoot(import.meta.url);
const { step, skip, finish } = createSteps("verify", root);

// `--tidy=warn`: a tidy rule red for an unrelated directory shouldn't fail this land's verdict and cost the next push
// ten minutes replaying typecheck and tests. What a tidy failure means: _tools/checks/manifest.mjs.
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs"), "--tidy=warn"]);

// `_tools/scripts` is plumbing, not a workspace package, so `turbo run test` can't reach its `*.test.mjs` files; run
// directly via node:test, which needs no install.
step("script self-tests", process.execPath, ["--test", "_tools/scripts/**/*.test.mjs"]);

// VITEST_MAX_WORKERS bounds a repo-wide run's memory; INDEXNOW_ENABLED=0 stops the site build from polling live.
const SUITE_ENV = { VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4", INDEXNOW_ENABLED: "0" };

// Typecheck and test both resolve imports through the emitted `.d.ts`, so both are skipped if the emit fails. They're
// independent of each other: vitest strips types, so a suite can mean something on a tree that doesn't type-check.
if (step("emit declarations", process.execPath, [join(root, "_tools/scripts/build/emit-declarations.mjs")])) {
    step("typecheck", "pnpm", ["turbo", "run", "typecheck", "--continue=dependencies-successful"]);
    step("test", "pnpm", ["turbo", "run", "test", "--only", "--continue=dependencies-successful"], { env: SUITE_ENV });
} else {
    for (const label of ["typecheck", "test"]) {
        skip(label, "the declarations it reads were not emitted");
    }
}

finish(() => {
    const recorded = writeVerdict(root, treeHash(root), "passed", "verify");
    return `checkout gates, declarations, typecheck and tests${recorded ? " (recorded for the push gate)" : ""}`;
});
