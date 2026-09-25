#!/usr/bin/env node
// ASKING THE CHECKS WHAT THEY SAID BEFORE. Every run that holds an actor to its OWN findings (the check after a land
// against the commit the land departed from, land-tiers.mjs; verify-push against the commit the push is built on;
// verify-turn, run by hand, against the branch's main-line base) needs the same two things: a check's verdicts as data
// rather than output, and a throwaway worktree at some earlier commit to run them in again. This is that pair.
// turn-findings.mjs reads the two answers against each other; nothing here interprets them.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../lib/git.mjs";
import { blindAtBase, problemLines } from "./turn-findings.mjs";

// Checks as verdicts, not output: `--json` lets two runs be compared, `--tidy=warn` keeps a tidy rule from ever holding
// the run itself — which of its findings refuses is the caller's question, asked after the comparison. Each checkout is
// measured by its own runner (`${at}/_tools/checks/run.mjs`), since a check finds the repository by walking up from
// itself; this also means a change to a check is compared against the check as it was, so a rule it tightened is its own
// to answer for. `undefined` when the runner couldn't run or answer in JSON; the caller treats that as "cannot say".
export const checkVerdicts = (at, only) => {
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

// LENDS THE SNAPSHOT THE INSTALLED MODULES, so the two runs differ by the diff under test and by nothing else. Without
// them a check that `needs: "node_modules"` measures a different thing in the snapshot — i18n-literals and vue-templates
// read no template at all there and pass vouching for nothing — and then every line the real checkout prints reads as
// newly introduced, which is the opposite of what this comparison is for.
//
// Lent per package rather than once at the root, because pnpm hoists nothing there: a workspace member resolves out of
// its own node_modules, so a single root link would leave every member's check reading an empty tree.
//
// Linked, not installed: an install per run costs minutes, and what these four load from node_modules is a parser for
// this repository's own source (vue/compiler-sfc, vue-i18n's compiler), not a dependency whose version is what any of
// their findings is about. The one thing this cannot reproduce is the snapshot's own dependency set, so a diff that
// moves the lockfile is measured against what is installed now rather than what was; `lockfile` and `peer-deps` are the
// checks that read that, and they need no install.
//
// Returns the links so they can be taken back first: nothing that deletes a directory tree should be pointed at the
// live node_modules through one of them, however sure we are that it would not follow.
const lendModules = (from, to) => {
    const links = [];
    for (const rel of installedModules(from)) {
        const at = join(to, rel);
        // A package that exists only in the working tree has no counterpart in the snapshot, and nothing there asks for
        // its modules.
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

/**
 * What each of `ids` said at `rev`, keyed by check id, for turn-findings.mjs to read the live run against.
 *
 * Checks out `rev` in its own worktree (not a stash, which would mutate the tree the caller is standing in) — `--detach`,
 * since nothing here needs a branch. `undefined` when the snapshot couldn't be taken, in which case the caller counts
 * every problem as its own: the safe direction to be wrong in.
 */
export const reportsAt = (root, rev, ids) => {
    if (ids.length === 0 || git(root, "rev-parse", "-q", "--verify", rev) === undefined) {
        return undefined; // nothing askable, or a rev this checkout does not have: there is no "before" to compare against
    }
    const parent = mkdtempSync(join(tmpdir(), "verify-snapshot-"));
    const snapshot = join(parent, "before");
    let borrowed = { links: [], lent: false };
    try {
        if (git(root, "worktree", "add", "--detach", snapshot, rev) === undefined) {
            return undefined;
        }
        borrowed = lendModules(root, snapshot);
        const verdicts = checkVerdicts(snapshot, ids);
        return verdicts === undefined
            ? undefined
            : new Map(verdicts.map((verdict) => [verdict.id, { ok: verdict.ok, lines: problemLines(verdict), blind: blindAtBase(verdict, borrowed.lent) }]));
    } finally {
        for (const link of borrowed.links) {
            rmSync(link, { force: true }); // unlinks the link itself: node's rm reads it with lstat and never walks through one
        }
        git(root, "worktree", "remove", "--force", snapshot);
        rmSync(parent, { recursive: true, force: true });
    }
};
