#!/usr/bin/env node
/* `pnpm verify:turn`: WHAT A TURN CAN ANSWER FOR, at the moment it tries to end.
 *
 * The turn-ending check used to run the whole repository (`pnpm lint && pnpm verify`): 2.5 minutes on a warm
 * cache when only the daemon changed, a 15-minute ceiling, and a verdict that could not tell "this turn broke
 * it" from "main is red". On a day main was red every turn under the repo was sent back twice and then held,
 * for a file none of them had touched, and each spent its two follow-ups either fixing someone else's test or
 * arguing. The rationale ("main moves under you, so this is the only moment the check means anything") is
 * right about the LAND and wrong about the Stop: at the Stop a model can only act on its own diff. The whole
 * repository now runs after the land, on the main tree, off every model's clock (verify.mjs, verify-deps.ts).
 *
 * So this measures the turn's own work, cheapest first:
 *
 *   1. the checkout gates (_tools/checks/run.mjs, ~1s) and the linter (~1s): the two readers that find a
 *      syntax error in a second where a typecheck finds it after fifty;
 *   2. the declarations emit (incremental, ~2s);
 *   3. `turbo run typecheck test --only` over the AFFECTED CLOSURE: the packages holding a dirty file, plus
 *      every package that transitively depends on one (lib/workspace-graph.mjs, the same graph CI's `changes`
 *      job walks). That is exactly the set whose fixtures can name a shape this turn just changed, and nothing
 *      outside it can have been broken by this turn. A root file (the lockfile, turbo.json) widens it to
 *      everything, which is the honest answer for a change everything depends on.
 *
 * THE DIRTY SET IS THE TURN'S OWN. An isolated turn's worktree is clean when the turn starts (landing commits
 * the remainder), so `git status` there lists this turn's edits and nothing else. In the primary checkout the
 * dirty set is everyone's landed, uncommitted work, so the closure is wider there, which is still correct: it
 * is the work that has not been measured. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { affectedBy, readWorkspaceGraph } from "../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);
const say = (line) => console.error(`verify:turn: ${line}`);

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

// Every path the tree says changed: staged, unstaged, untracked; a rename by its new name.
const changedPaths = () => {
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    if (status.status !== 0) {
        return undefined;
    }
    return status.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim().split(" -> ").at(-1));
};

const started = Date.now();
step("checkout gates", process.execPath, [join(root, "_tools/checks/run.mjs")]);
step("lint", "pnpm", ["lint"]);

const changed = changedPaths();
const graph = readWorkspaceGraph(root);
const { global, seeds, affected } = affectedBy(graph, changed ?? [...graph.packages.values()].map(({ dir }) => dir));
if (changed === undefined) {
    say("git could not list the tree's changes, so every package is measured");
}
if (global !== undefined) {
    say(`${global} changed, which every package depends on: measuring all ${affected.size}`);
} else if (affected.size === 0) {
    say(`no workspace package holds a changed file (${(changed ?? []).length} changed paths); nothing to type-check or test`);
} else {
    say(`${seeds.size} changed package${seeds.size === 1 ? "" : "s"}, ${affected.size} in the closure: ${[...affected].sort().join(", ")}`);
}

if (affected.size > 0) {
    step("emit declarations", process.execPath, [join(root, "_tools/scripts/emit-declarations.mjs")]);
    const filters = global !== undefined ? [] : [...affected].flatMap((name) => ["--filter", name]);
    step("typecheck and test", "pnpm", ["turbo", "run", "typecheck", "test", "--only", "--continue=dependencies-successful", ...filters], {
        VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4",
        INDEXNOW_ENABLED: "0",
    });
}

say(`passed in ${Math.round((Date.now() - started) / 1000)}s`);
