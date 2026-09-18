#!/usr/bin/env node
// `pnpm verify:turn`: what a turn can answer for at Stop, scoped to what it actually touched, since a model can
// only act on its own diff (the full repository runs after the land, on main, in verify.mjs/verify-deps.ts). Three
// independent readers, each judged against what the turn did: (1) the checks, diffed against HEAD line by line
// (turn-findings.mjs), so a problem already standing before this turn is reported but not held against it and a new one
// is refused whatever its gate — which is the whole of what `tidy` means here, and why nothing coarser than a turn can
// enforce it; (2) the linter, over the turn's own changed files, falling back to the whole repo when the changed set
// isn't smaller; (3) typecheck+test over the affected closure (lib/workspace-graph.mjs), the packages holding a dirty
// file plus everything that transitively depends on one.
// The dirty set is the turn's own worktree diff (or, in the primary checkout, everyone's uncommitted work). All
// three readers report at once (lib/steps.mjs): the Stop sends a model back at most twice (MAX_FOLLOW_UPS,
// sandbox/src/rules/turn-ending.ts), so a gate that stopped at its first failure could only ever name two of a
// turn's problems.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { affectedBy, readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { repoRoot } from "../../constants/src/node.mjs";
import { changedPaths, git } from "../lib/git.mjs";
import { createSteps } from "../lib/steps.mjs";
import { blindAtHead, judgeAgainstHead, problemLines } from "./turn-findings.mjs";

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

// Every `node_modules` a checkout holds, repo-relative. A pnpm workspace puts one at the root and one in each member,
// and a check resolves its parser from the package that declares the dependency, so the member's own has to be there
// too or the resolution lands nowhere. Depth-bounded like the workspace walk (lib/workspace-graph.mjs): a member sits
// at most this deep, and below one lies a build output nobody here reads.
const MEMBER_DEPTH = 4;
const installedModules = (at) => {
    const found = [];
    const walk = (rel, depth) => {
        let entries;
        try {
            entries = readdirSync(join(at, rel), { withFileTypes: true });
        } catch {
            return; // a directory this process may not read is not one worth failing over
        }
        for (const entry of entries) {
            const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
            // A symlink counts here and nowhere else: an install is sometimes parked outside the checkout and linked in,
            // and node resolves through the chain either way. Descending through one would be a different matter, since
            // a link back up the tree is a walk that never ends.
            if (entry.name === "node_modules") {
                if (entry.isDirectory() || entry.isSymbolicLink()) {
                    found.push(child);
                }
            } else if (entry.isDirectory() && !entry.name.startsWith(".") && depth < MEMBER_DEPTH) {
                walk(child, depth + 1);
            }
        }
    };
    walk("", 0);
    return found;
};

// LENDS THE SNAPSHOT THE INSTALLED MODULES, so the two runs differ by this turn's diff and by nothing else. Without them
// a check that `needs: "node_modules"` measures a different thing at HEAD — i18n-literals and vue-templates read no
// template at all there and pass vouching for nothing — and then every line the real checkout prints reads as newly
// introduced, which is the opposite of what this comparison is for.
//
// Lent per package rather than once at the root, because pnpm hoists nothing there: a workspace member resolves out of
// its own node_modules, so a single root link would leave every member's check reading an empty tree.
//
// Linked, not installed: an install per turn costs minutes, and what these four load from node_modules is a parser for
// this repository's own source (vue/compiler-sfc, vue-i18n's compiler), not a dependency whose version is what any of
// their findings is about. The one thing this cannot reproduce is HEAD's own dependency set, so a turn that moves the
// lockfile is measured against what is installed now rather than what was; `lockfile` and `peer-deps` are the checks
// that read that, and they need no install.
//
// Returns the links so they can be taken back first: nothing that deletes a directory tree should be pointed at the
// live node_modules through one of them, however sure we are that it would not follow.
const lendModules = (from, to) => {
    const links = [];
    for (const rel of installedModules(from)) {
        const at = join(to, rel);
        // A package that exists only in the working tree has no counterpart at HEAD, and nothing there asks for its modules.
        if (!existsSync(dirname(at)) || existsSync(at)) {
            continue;
        }
        try {
            symlinkSync(join(from, rel), at, "junction"); // the one directory link Windows allows unprivileged; the type is ignored elsewhere
            links.push(at);
        } catch {
            return { links, lent: false };
        }
    }
    return { links, lent: links.includes(join(to, "node_modules")) };
};

// Checks out HEAD in its own worktree (not a stash, which would mutate the tree the turn is standing in) to ask what
// each failing check said BEFORE this turn. `--detach`: nothing here needs a branch. Returns `undefined` when the
// snapshot couldn't be taken, in which case every problem counts as the turn's own, the safe direction to be wrong in.
const reportsAtHead = (ids) => {
    if (ids.length === 0 || git(root, "rev-parse", "-q", "--verify", "HEAD") === undefined) {
        return undefined; // nothing askable, or a fresh repository with no commit: there is no "before" to compare against
    }
    const parent = mkdtempSync(join(tmpdir(), "verify-turn-head-"));
    const snapshot = join(parent, "head");
    let borrowed = { links: [], lent: false };
    try {
        if (git(root, "worktree", "add", "--detach", snapshot, "HEAD") === undefined) {
            return undefined;
        }
        borrowed = lendModules(root, snapshot);
        const verdicts = checkVerdicts(snapshot, ids);
        return verdicts === undefined
            ? undefined
            : new Map(verdicts.map((verdict) => [verdict.id, { ok: verdict.ok, lines: problemLines(verdict), blind: blindAtHead(verdict, borrowed.lent) }]));
    } finally {
        for (const link of borrowed.links) {
            rmSync(link, { force: true }); // unlinks the link itself: node's rm reads it with lstat and never walks through one
        }
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
        const judged = judgeAgainstHead(failed, before);
        const mine = judged.filter(({ added }) => added.length > 0);
        const unsure = judged.filter(({ added, unsure: lines }) => added.length === 0 && lines.length > 0);
        const theirs = judged.filter(({ added, unsure: lines }) => added.length === 0 && lines.length === 0);
        if (theirs.length > 0) {
            say(
                `${theirs.map(({ verdict }) => verdict.id).join(", ")}: failing at HEAD too and no worse for this turn, so not this turn's to fix — the land measures the tree it leaves behind`,
            );
        }
        // Reported in full and charged to nobody: the snapshot could not put these checks where the live run stands, so
        // whether a line is new is a question nothing here can answer. Printed rather than counted, because somebody has
        // to be told what was found even when there is no one to hold to it.
        for (const { verdict, unsure: lines } of unsure) {
            process.stderr.write(
                `\n? ${verdict.id} (${verdict.file}), ${lines.length} problem${lines.length === 1 ? "" : "s"} HEAD could not be asked about — reported, not laid at this turn's door\n${lines.join("\n")}\n`,
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
