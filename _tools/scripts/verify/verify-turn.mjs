#!/usr/bin/env node
// `pnpm verify:turn`: what a turn can answer for at Stop, scoped to what it actually touched, since a model can
// only act on its own diff (the full repository runs after the land, on main, in verify.mjs/verify-deps.ts). Three
// independent readers, each judged against what the turn did: (1) the checks, diffed against HEAD line by line, so a
// problem already standing before this turn is reported but not held against it and a new one is refused whatever its
// gate — which is the whole of what `tidy` means here, and why nothing coarser than a turn can enforce it; (2) the
// linter, over the turn's own changed files,
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
import { CHECKS } from "../../checks/manifest.mjs";
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

// WHAT A CHECK SAID, FINDING BY FINDING, so a turn can be held to its own problems rather than to the tree's.
//
// A finding names a location, and that is what tells it apart from the prose around it: either a `- ` bullet (every
// check that reports through lib/report.mjs's `finish`) or a `path.ext:12` anchor (the ones that print their own, like
// path-literals and the UI tiers). Headings and explanatory epilogues name no location and are dropped — which is not
// cosmetic: a turn that rewords a check's own failure message would otherwise be accused of every finding that message
// introduces, and rewording a message is not tightening a rule.
//
// Line numbers are flattened in the KEY: inserting a line above a standing finding moves it from `:180` to `:181`,
// which is the same problem. The key maps to the line as written, so what gets reported is the real anchor.
const FINDING = /^\s*-\s|[\w.-]+\.[a-z]+:\d+/;
const LINE_NUMBER = /:\d+/g;
const problemLines = (verdict) =>
    new Map(
        `${verdict.stderr}${verdict.stdout}`
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => FINDING.test(line))
            .map((line) => [line.replace(LINE_NUMBER, ":#"), line]),
    );

// Checks out HEAD in its own worktree (not a stash, which would mutate the tree the turn is standing in) to ask what
// each failing check said BEFORE this turn. `--detach`: nothing here needs a branch. Returns `undefined` when the
// snapshot couldn't be taken, in which case every problem counts as the turn's own, the safe direction to be wrong in.
//
// A `node_modules` check is never asked: the snapshot has none, so it would report a different thing there for a reason
// that has nothing to do with the turn, and every line it prints would read as newly introduced.
const reportsAtHead = (ids) => {
    const readable = ids.filter((id) => CHECKS.find((check) => check.id === id)?.needs !== "node_modules");
    if (readable.length === 0 || git(root, "rev-parse", "-q", "--verify", "HEAD") === undefined) {
        return undefined; // nothing askable, or a fresh repository with no commit: there is no "before" to compare against
    }
    const parent = mkdtempSync(join(tmpdir(), "verify-turn-head-"));
    const snapshot = join(parent, "head");
    try {
        if (git(root, "worktree", "add", "--detach", snapshot, "HEAD") === undefined) {
            return undefined;
        }
        const verdicts = checkVerdicts(snapshot, readable);
        return verdicts === undefined ? undefined : new Map(verdicts.map((verdict) => [verdict.id, { ok: verdict.ok, lines: problemLines(verdict) }]));
    } finally {
        git(root, "worktree", "remove", "--force", snapshot);
        rmSync(parent, { recursive: true, force: true });
    }
};

/* 1. the checks, judged against HEAD */
say("checkout gates …");
const verdicts = checkVerdicts(root);
if (verdicts === undefined) {
    fail("checkout gates", "could not be measured · node _tools/checks/run.mjs --tidy=warn");
} else {
    // A check that could not measure judged nothing, so it has no problems to attribute and must never hold a turn: its
    // tool moved, which is not something this turn's diff can answer for and not something a model should be sent back
    // to fix at random.
    const unmeasured = verdicts.filter((verdict) => !verdict.measured);
    if (unmeasured.length > 0) {
        say(`${unmeasured.map(({ id }) => id).join(", ")}: could not measure, so nothing here is vouched for — the check needs a look, the tree is not accused`);
    }
    const failed = verdicts.filter((verdict) => !verdict.ok && verdict.measured);
    if (failed.length === 0) {
        say(`checkout gates: ${verdicts.filter(({ ok }) => ok).length} passed`);
    } else {
        // THE ONE QUESTION THIS SECTION ASKS: which of these lines were not here before. A `tidy` rule is a real cost
        // with a measurement behind it, and the reason it cannot refuse a push is that the tree is moved by many hands
        // at once — a directory somebody else filled, a baseline somebody else's deletion left stale. None of that is
        // true of a line THIS turn wrote, which is why the refusal belongs here and at no coarser moment: it is the
        // only gate that can tell the two apart, and the only one still holding the model that wrote the line.
        const before = reportsAtHead(failed.map(({ id }) => id));
        const judged = failed.map((verdict) => {
            const standing = before?.get(verdict.id);
            const added = [...problemLines(verdict)].filter(([key]) => standing === undefined || !standing.lines.has(key)).map(([, line]) => line);
            // A check that PASSED at HEAD and fails now is this turn's whatever its lines look like: `added` being
            // empty there would mean the check reports in a shape `FINDING` does not recognise, and the safe way to be
            // wrong about a new shape is to name the turn that made it red, not to wave it through.
            const wholeCheck = standing?.ok === true && added.length === 0;
            return { verdict, added: wholeCheck ? [`${verdict.id} passed at HEAD and fails now`] : added };
        });
        const mine = judged.filter(({ added }) => added.length > 0);
        const theirs = judged.filter(({ added }) => added.length === 0);
        if (theirs.length > 0) {
            say(
                `${theirs.map(({ verdict }) => verdict.id).join(", ")}: failing at HEAD too and no worse for this turn, so not this turn's to fix — the land measures the tree it leaves behind`,
            );
        }
        for (const { verdict, added } of mine) {
            process.stderr.write(`\n✗ ${verdict.id} (${verdict.file}), ${added.length} problem${added.length === 1 ? "" : "s"} this turn introduced\n${added.join("\n")}\n`);
        }
        if (mine.length > 0) {
            const ids = mine.map(({ verdict }) => verdict.id);
            fail("checkout gates", `${ids.length} check(s) this turn broke: ${ids.join(", ")} · node _tools/checks/run.mjs --only ${ids.join(",")}`);
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

/* 3. the affected closure */
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
