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
 * SCOPING BY PACKAGE WAS ONLY HALF OF THAT, and the other half is why this file has a delta gate in it. The
 * typecheck and the tests were narrowed to the turn's own closure below, but the two cheap readers above them
 * were not: the checks read the WHOLE checkout by construction (a count of files in a directory, a registry of
 * subsystems, every relative link in the documentation) and the linter read every file in the repository. So
 * an agent that had touched one daemon file was still held for a fan-out count another conversation's land had
 * pushed over the line, and for an oxlint warning in a package it had never opened. Between 19:17 and 19:45 on
 * the day this was written, six unrelated conversations were held at their Stop that way; two of them proved
 * it by stashing their own diff and watching the gate stay red.
 *
 * SO EACH READER IS JUDGED AGAINST WHAT THE TURN ACTUALLY DID:
 *
 *   1. THE CHECKS, against HEAD. They run on the working tree (`--tidy=warn`, so a tidy rule is never what
 *      holds a turn — _tools/checks/manifest.mjs says what the two gates mean). If none refuses, that is the
 *      end of it and nothing else is spent. If one does, HEAD is checked out into a throwaway worktree and the
 *      SAME check is run there: one that was already failing at HEAD is the tree the turn INHERITED, reported
 *      by name and not held against it; one that passes at HEAD and fails here is this turn's, and refuses.
 *      The snapshot is on the red path only, so the ordinary green run pays nothing for it.
 *   2. THE LINTER, over the turn's own files. oxlint is per-file, so the delta needs no baseline run: linting
 *      the changed paths IS linting what the turn wrote. A changed root file or a very wide turn falls back to
 *      the whole repository, which is the honest answer when the turn's own set is not smaller.
 *   3. THE DECLARATIONS EMIT, then `turbo run typecheck test --only` over the AFFECTED CLOSURE: the packages
 *      holding a dirty file, plus every package that transitively depends on one (lib/workspace-graph.mjs, the
 *      same graph CI's `changes` job walks). That is exactly the set whose fixtures can name a shape this turn
 *      just changed, and nothing outside it can have been broken by this turn. A root file (the lockfile,
 *      turbo.json) widens it to everything, which is the honest answer for a change everything depends on.
 *
 * THE DIRTY SET IS THE TURN'S OWN. An isolated turn's worktree is clean when the turn starts (landing commits
 * the remainder), so `git status` there lists this turn's edits and nothing else, and HEAD is the tree the turn
 * began from. In the primary checkout the dirty set is everyone's landed, uncommitted work, so both the closure
 * and the linted set are wider there, which is still correct: it is the work that has not been measured.
 *
 * AND IT SAYS ALL OF IT AT ONCE (lib/steps.mjs). This is the moment where collecting matters most, because the
 * budget here is not time, it is TURNS: the Stop sends a model back at most twice (MAX_FOLLOW_UPS in
 * sandbox/src/rules/turn-ending.ts) and is silent afterwards whatever the tree says. A gate that stopped at its
 * first failing step could therefore name at most two of a turn's problems before the work was held, which is
 * what held 28 turns in the six days before this was written. The gates, the linter and the closure's
 * typecheck-and-test are three independent readers and all three get to speak. */
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

/* The checks as VERDICTS rather than as output: `--json` is what lets two runs be compared, `--tidy=warn` is
 * what keeps a tidy rule from ever being the thing that holds a turn.
 *
 * EACH CHECKOUT IS MEASURED BY ITS OWN RUNNER, which is what `at` is for: `${at}/_tools/checks/run.mjs`, not
 * this one pointed at another directory. A check finds the repository by walking up from ITSELF
 * (@intentic/constants/node's repoRoot), so the working tree's runner asked to measure a snapshot reads the
 * snapshot's cwd for some things and the working tree for others, and the answer is neither tree. It also
 * makes the comparison honest in the case that matters most: a turn that CHANGES a check is compared against
 * the check as it was, so a rule this turn tightened is this turn's to answer for, and a false positive this
 * turn removed does not read as a failure it introduced.
 *
 * `undefined` when the runner could not be run or did not answer in JSON — including a HEAD old enough not to
 * have these flags, which is the state of every checkout until this lands. The caller treats that as "cannot
 * say", and a failure it cannot attribute stays the turn's own. */
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

/* HEAD, checked out on its own, so a failing check can be asked whether it was already failing before this
 * turn. A worktree rather than a stash: a stash mutates the tree the turn is standing in, and a turn whose gate
 * crashed mid-stash would lose its work. `--detach` because nothing here needs a branch, and the temp dir is
 * removed either way. Returns the ids that fail at HEAD too, or `undefined` when the snapshot could not be
 * taken — in which case every failure is treated as the turn's own, which is the safe direction to be wrong in. */
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

/* ── 2. the linter, over the turn's own files ────────────────────────────────────────────────────────────────
 * Staged, unstaged and untracked alike, a rename by its new name (lib/git.mjs). `undefined` means git could not
 * answer, which widens both this and the closure below to everything rather than narrowing them to nothing. */
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
    /* NAMED FILES, so this is the turn's own lint and not the repository's — and run here rather than through
     * `step` because the answer needs reading. oxlint applies `ignorePatterns` to paths it is HANDED, not just
     * to the ones it discovers, and when every path it was given is ignored it exits 1 with "No files found to
     * lint": a turn that edited only an operator template or a vendored file would be held for having nothing
     * to lint. That is the one non-zero exit here that means success. */
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

// The emit is the one thing the closure's check genuinely reads; after a failed one it would report missing
// modules against files that are correct, which is why this pair is a dependency and the two above are not.
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
