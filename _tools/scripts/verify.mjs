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
 * follows replays it and runs only the build. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { treeHash, writeVerdict } from "./lib/tree-verdict.mjs";

const root = repoRoot(import.meta.url);
const say = (line) => console.error(`verify: ${line}`);

const step = (label, command, args, env = {}) => {
    say(`${label} …`);
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
    if (result.error !== undefined) {
        say(`${label}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        say(`${label} failed`);
        process.exit(result.status ?? 1);
    }
};

const started = Date.now();
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs")]);
step("emit declarations", process.execPath, [join(root, "_tools/scripts/emit-declarations.mjs")]);
step("typecheck", "pnpm", ["turbo", "run", "typecheck", "--continue=dependencies-successful"]);
// VITEST_MAX_WORKERS is the ONLY thing bounding a repo-wide run's memory (turbo.json says why); the caller's
// own value wins. INDEXNOW_ENABLED=0 for the reason ci.yml gives: the site build otherwise polls the live site.
step("test", "pnpm", ["turbo", "run", "test", "--only", "--continue=dependencies-successful"], {
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4",
    INDEXNOW_ENABLED: "0",
});

const seconds = Math.round((Date.now() - started) / 1000);
const recorded = writeVerdict(root, treeHash(root), "passed", "verify");
say(`passed in ${seconds}s: checkout gates, declarations, typecheck and tests${recorded ? " (recorded for the push gate)" : ""}`);
