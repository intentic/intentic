#!/usr/bin/env node
/* `pnpm verify`: THE WHOLE REPOSITORY, THE WAY CI'S VERIFY GROUPS MEASURE IT, runnable everywhere the code is
 * written. Four steps, each once:
 *
 *     node _tools/checks/run.mjs                   the checkout gates (under two seconds)
 *     node _tools/scripts/emit-declarations.mjs    every emitted package's dist, with tsgo -b
 *     turbo run typecheck
 *     turbo run test --only                        off the `^build` edge, which the emit above replaces
 *
 * ONCE is the point of this being a script rather than `pnpm typecheck && pnpm test`: each of those runs the
 * emit for itself, so the pair paid for it twice (7s cold, 2s incremental) on every run of the gate.
 *
 * WHO RUNS IT. The daemon, after every land, on the main tree, serialized and off every model's clock
 * (workspace/verify-deps.ts): the one moment that legitimately needs the whole repository against a tree
 * nobody else is moving. An owner, by hand. Not the turn-ending check any more: at the Stop a model can only
 * act on its own diff, so that runs the affected closure instead (verify-turn.mjs). Not `pnpm build`, which
 * dies EXDEV under worktree isolation; the push gate (verify-push.mjs) runs build from the primary checkout.
 *
 * A GREEN RUN IS RECORDED against a hash of the tree it measured (lib/tree-verdict.mjs), so the push gate that
 * follows replays it and runs only the build.
 *
 * EVERY STEP THAT CAN STILL SAY SOMETHING RUNS (lib/steps.mjs). This is the whole repository, measured after a
 * land, on the main tree, off every model's clock: a run that stopped at the first failing step would be
 * spending that serialized slot to report a fraction of what it had already paid to find out. The one real
 * dependency is the declarations emit, which typecheck and the suites READ; those are skipped when it fails,
 * and the digest says so rather than letting an unmeasured package read as a green one. */
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { createSteps } from "./lib/steps.mjs";
import { treeHash, writeVerdict } from "./lib/tree-verdict.mjs";

const root = repoRoot(import.meta.url);
const { step, skip, finish } = createSteps("verify", root);

// Independent of everything below: it reads the checkout, not the build.
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs")]);

// VITEST_MAX_WORKERS is the ONLY thing bounding a repo-wide run's memory (turbo.json says why); the caller's
// own value wins. INDEXNOW_ENABLED=0 for the reason ci.yml gives: the site build otherwise polls the live site.
const SUITE_ENV = { VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4", INDEXNOW_ENABLED: "0" };

/* THE ONE EDGE. Both steps below resolve their workspace imports through the .d.ts this emits, so after a
 * failed emit they report missing modules and name files that are correct. Typecheck and test are independent
 * of EACH OTHER, though — vitest strips types, so a suite runs and means something on a tree that does not
 * type-check — which is exactly the pair that used to be reported one per run. */
if (step("emit declarations", process.execPath, [join(root, "_tools/scripts/emit-declarations.mjs")])) {
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
