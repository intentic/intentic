#!/usr/bin/env node
// `pnpm verify:turn`: what a turn can answer for at Stop, scoped to what it actually touched, since a model can
// only act on its own diff (the full repository runs after the land, on main, in verify.mjs/verify-deps.ts). Three
// independent readers, each judged against what the turn did: (1) the checks, run against HEAD, so one already
// failing before this turn is reported but not held against it; (2) the linter, over the turn's own changed files,
// falling back to the whole repo when the changed set isn't smaller; (3) typecheck+test over the affected closure
// (lib/workspace-graph.mjs), the packages holding a dirty file plus everything that transitively depends on one.
// The dirty set is the turn's own worktree diff (or, in the primary checkout, everyone's uncommitted work). All
// three readers report at once (lib/steps.mjs): the Stop sends a model back at most twice (MAX_FOLLOW_UPS,
// sandbox/src/rules/turn-ending.ts), so a gate that stopped at its first failure could only ever name two of a
// turn's problems.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affectedBy, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { changedPaths, git } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";

const root = repoRoot(import.meta.url);
const { say, step, skip, fail, finish } = createSteps("verify:turn", root);
// Past this many changed paths the turn is not a delta any more (a rename, a generated bundle, a land in the
// primary checkout), and a command line naming each of them is worse than the one that names none.
const LINT_FILE_CEILING = 200;
// What oxlint reads. A changed .md or .json is not a lint subject, and passing it one makes it exit non-zero
// for the wrong reason.
const LINTABLE = /\.(m|c)?[jt]sx?$|\.vue$/;

// Checks as verdicts, not output: `--json` lets two runs be compared, `--tidy=warn` keeps a tidy rule from ever
// holding a turn. Each checkout is measured by its own runner (`${at}/_tools/checks/run.mjs`), since a check finds
// the repository by walking up from itself; this also means a turn that changes a check is compared against the
// check as it was, so a rule it tightened is its own to answer for. `undefined` when the runner couldn't run or
// answer in JSON; the caller treats that as "cannot say" and keeps the failure as the turn's own.
const checkVerdicts = (at, only) => {
    const runner = join(at, "_tools/checks/run.mjs");
    if (!existsSync(runner)) {
        return undefined;
    }
    const result = spawnSync(process.execPath, [runner, "--tidy=warn", "--json", ...(only === undefined ? [] : ["--only", only.join(",")])], {
        cwd: at,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    try {
        return JSON.parse(result.stdout);
    } catch {
        return undefined;
    }
};

// Checks out HEAD in its own worktree (not a stash, which would mutate the tree the turn is standing in) to ask
// whether a failing check was already failing before this turn. `--detach`: nothing here needs a branch. Returns
// `undefined` when the snapshot couldn't be taken, in which case every failure counts as the turn's own, the safe
// direction to be wrong in.
const alsoFailsAtHead = (ids) => {
    if (git(root, "rev-parse", "-q", "--verify", "HEAD") === undefined) {
        return undefined; // a fresh repository with no commit: there is no "before" to compare against
    }
    const parent = mkdtempSync(join(tmpdir(), "verify-turn-head-"));
    const snapshot = join(parent, "head");
    try {
        if (git(root, "worktree", "add", "--detach", snapshot, "HEAD") === undefined) {
            return undefined;
        }
        const verdicts = checkVerdicts(snapshot, ids);
        return verdicts === undefined ? undefined : new Set(verdicts.filter(({ ok }) => !ok).map(({ id }) => id));
    } finally {
        git(root, "worktree", "remove", "--force", snapshot);
        rmSync(parent, { recursive: true, force: true });
    }
};

/* ── 1. the checks, judged against HEAD ──────────────────────────────────────────────────────────────────── */
say("checkout gates …");
const verdicts = checkVerdicts(root);
if (verdicts === undefined) {
    fail("checkout gates", "could not be measured · node _tools/checks/run.mjs --tidy=warn");
} else {
    const warned = verdicts.filter((verdict) => !verdict.ok && verdict.gate === "tidy");
    const refused = verdicts.filter((verdict) => !verdict.ok && verdict.gate === "code");
    if (warned.length > 0) {
        say(`${warned.map(({ id }) => id).join(", ")}: tidy rules, worth fixing and not what holds a turn (\`pnpm checks:tidy\`)`);
    }
    if (refused.length === 0) {
        say(`checkout gates: ${verdicts.length - warned.length} passed`);
    } else {
        const inherited = alsoFailsAtHead(refused.map(({ id }) => id));
        const mine = refused.filter(({ id }) => inherited === undefined || !inherited.has(id));
        const theirs = refused.filter(({ id }) => inherited !== undefined && inherited.has(id));
        if (theirs.length > 0) {
            say(
                `${theirs.map(({ id }) => id).join(", ")}: already failing at HEAD, so not this turn's to fix — the tree it started from is red there, and the land will measure it`,
            );
        }
        for (const verdict of mine) {
            process.stderr.write(`\n✗ ${verdict.id} (${verdict.file})\n${verdict.stderr}${verdict.stdout}`);
        }
        if (mine.length > 0) {
            fail("checkout gates", `${mine.length} check(s) this turn broke: ${mine.map(({ id }) => id).join(", ")} · node _tools/checks/run.mjs --only ${mine.map(({ id }) => id).join(",")}`);
        }
    }
}

// Staged, unstaged and untracked alike, a rename by its new name (lib/git.mjs). `undefined` (git couldn't answer)
// widens this and the closure below to everything, rather than narrowing to nothing.
const changed = changedPaths(root);
const lintable = (changed ?? []).filter((path) => LINTABLE.test(path) && existsSync(join(root, path)));
if (changed === undefined || lintable.length > LINT_FILE_CEILING) {
    say(
        changed === undefined
            ? "git could not list the tree's changes, so the linter reads the whole repository"
            : `${lintable.length} changed files to lint, past the ${LINT_FILE_CEILING} this names one by one: linting the whole repository instead`,
    );
    step("lint", "pnpm", ["lint"]);
} else if (lintable.length === 0) {
    say("lint: no changed file the linter reads");
} else {
    // Run directly rather than through `step`, since the answer needs reading: oxlint applies `ignorePatterns` to the
    // paths it's handed, and exits 1 with "No files found to lint" when all of them are ignored, the one non-zero exit
    // here that means success.
    const label = `lint (${lintable.length} changed file${lintable.length === 1 ? "" : "s"})`;
    const lint = spawnSync("pnpm", ["lint", ...lintable], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
    const output = `${lint.stdout ?? ""}${lint.stderr ?? ""}`;
    if (lint.error !== undefined) {
        say(`lint skipped: ${lint.error.message}`);
    } else if (/No files found to lint/.test(output)) {
        say(`lint: all ${lintable.length} of this turn's files are ones the linter's config ignores`);
    } else if (lint.status !== 0) {
        process.stderr.write(output);
        fail(label, `exit ${lint.status ?? "signal"} · pnpm lint ${lintable.join(" ")}`);
    } else {
        say(`${label}: clean`);
    }
}

/* ── 3. the affected closure ─────────────────────────────────────────────────────────────────────────────── */
const graph = readWorkspaceGraph(root);
const { global, seeds, affected } = affectedBy(graph, changed ?? [...graph.packages.values()].map(({ dir }) => dir));
if (global !== undefined) {
    say(`${global} changed, which every package depends on: measuring all ${affected.size}`);
} else if (affected.size === 0) {
    say(`no workspace package holds a changed file (${(changed ?? []).length} changed paths); nothing to type-check or test`);
} else {
    say(`${seeds.size} changed package${seeds.size === 1 ? "" : "s"}, ${affected.size} in the closure: ${[...affected].sort().join(", ")}`);
}

// The emit is the one thing the closure's check reads; after a failed one, typecheck would report missing modules
// against correct files, which is why this pair is a dependency and the two steps above aren't.
if (affected.size > 0) {
    if (step("emit declarations", process.execPath, [join(root, "_tools/scripts/build/emit-declarations.mjs")])) {
        const filters = global !== undefined ? [] : [...affected].flatMap((name) => ["--filter", name]);
        step("typecheck and test", "pnpm", ["turbo", "run", "typecheck", "test", "--only", "--continue=dependencies-successful", ...filters], {
            env: { VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "4", INDEXNOW_ENABLED: "0" },
        });
    } else {
        skip("typecheck and test", "the declarations it reads were not emitted");
    }
}

finish(() =>
    affected.size === 0
        ? "the checkout gates and the linter; nothing in this turn's closure to measure"
        : `the turn's closure: ${affected.size} package${affected.size === 1 ? "" : "s"}`,
);
