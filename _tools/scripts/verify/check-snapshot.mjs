#!/usr/bin/env node
// ASKING THE CHECKS WHAT THEY SAID BEFORE. A run that holds an actor to its OWN findings (verify-push, against the commit
// the push is built on) needs two things: a check's verdicts as data rather than output, and a throwaway worktree at
// that earlier commit to run them in again. This is that pair.
// turn-findings.mjs reads the two answers against each other; nothing here interprets them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { git } from "../lib/git.mjs";
import { blindAtBase, findingCounts, problemLines } from "./turn-findings.mjs";

// Checks as verdicts, not output: `--json` lets two runs be compared, `--tidy=warn` keeps a tidy rule from ever holding
// the run itself — which of its findings refuses is the caller's question, asked after the comparison. Each checkout is
// measured by its own runner (`${at}/_tools/checks/run.mjs`), since a check finds the repository by walking up from
// itself; this also means a change to a check is compared against the check as it was, so a rule it tightened is its own
// to answer for. `undefined` when the runner couldn't run or answer in JSON; the caller treats that as "cannot say".
// `env` is the checks' environment, for a caller that points their git at an index of its own (verify-turn.mjs).
export const checkVerdicts = (at, only, env = process.env) => {
    const runner = join(at, "_tools/checks/run.mjs");
    if (!existsSync(runner)) {
        return undefined;
    }
    const result = spawnSync(process.execPath, [runner, "--tidy=warn", "--json", ...(only === undefined ? [] : ["--only", only.join(",")])], {
        cwd: at,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env,
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

// Lend installed node_modules per package (pnpm does not hoist) so snapshot checks load the same parsers and measure comparable coverage.
// Link rather than install; lockfile changes still use current parser dependencies, while lockfile/peer-deps checks judge versions separately.
// Return links for removal before snapshot cleanup, keeping recursive deletion away from live dependency directories.
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

// LENDS THE SNAPSHOT THE CHECKOUT'S NEIGHBOURS, for the same reason: a check that reads past the repository (extension-kit
// and extension-siblings read the workspace's `../extensions`, standalone repositories beside this one) found nothing
// beside a snapshot under the temp dir, so every finding there read as the change's own. Those neighbours are no part
// of the diff under test, so both runs read the same ones. Linked beside the snapshot, never into it; returned so they
// are taken back before the directory holding them is removed.
const lendNeighbours = (root, snapshot) => {
    const links = [];
    const beside = dirname(root);
    let entries;
    try {
        entries = readdirSync(beside);
    } catch {
        return links; // a parent this process may not list has nothing it can lend
    }
    for (const name of entries) {
        const at = join(dirname(snapshot), name);
        if (name === basename(root) || existsSync(at)) {
            continue;
        }
        try {
            symlinkSync(join(beside, name), at, "junction");
            links.push(at);
        } catch {
            // allow(silent-catch): a neighbour that cannot be linked is read as absent, as it was before any were lent
        }
    }
    return links;
};

const SNAPSHOT_PREFIX = "verify-snapshot-";
// Longer than any run is allowed to take, so a worktree this old belongs to a run that is gone.
const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Takes back the snapshots a run that was killed left behind: worktrees registered in this repository whose throwaway
 * directory (`verify-snapshot-*` under the temp dir) is older than `maxAgeMs`. A run that is killed (a turn's check
 * that ran out of time, a CI job cancelled) never reaches its `finally`; the next run to take a snapshot clears what it
 * left, in every conversation's checkout, since they share one repository. Returns how many it removed.
 */
export const sweepSnapshots = (root, now = Date.now(), maxAgeMs = STALE_AFTER_MS) => {
    const listed = git(root, "worktree", "list", "--porcelain") ?? "";
    let removed = 0;
    for (const line of listed.split("\n")) {
        const path = line.startsWith("worktree ") ? line.slice("worktree ".length) : undefined;
        const parent = path === undefined ? undefined : dirname(path);
        if (path === undefined || parent === undefined || basename(path) !== "before" || !basename(parent).startsWith(SNAPSHOT_PREFIX)) {
            continue;
        }
        let age;
        try {
            age = now - statSync(parent).mtimeMs;
        } catch {
            // allow(silent-catch): a directory already gone is taken back by the prune below
            age = Infinity;
        }
        if (age > maxAgeMs) {
            git(root, "worktree", "remove", "--force", "--force", path);
            rmSync(parent, { recursive: true, force: true });
            removed += 1;
        }
    }
    if (removed > 0) {
        git(root, "worktree", "prune");
    }
    return removed;
};

// The snapshots this process holds right now, each by the function that takes it back. A termination signal ends the
// process through `exit`, whose handler takes back whatever its `finally` did not get to.
const held = new Set();
let guarding = false;
const guardSnapshots = () => {
    if (guarding) {
        return;
    }
    guarding = true;
    process.on("exit", () => {
        // Each release deletes its own entry, which a Set's walk takes in its stride: the next one is still visited.
        for (const release of held) {
            release();
        }
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
        process.once(signal, () => process.exit(128 + osConstants.signals[signal]));
    }
};

/* BASE CHECKOUTS ARE KEPT AND MOVED, NOT MADE AND THROWN AWAY (2026-11-24). Every turn that ended with a check failing
   (one main already fails counts) checked the whole base commit out under the temp dir and deleted it again, and the
   reach typecheck could take a second: 14,107 files and 202 MB for this repository, about 237 MB written per run as
   measured on rog, and as much again trimmed when it went, for a base that is main's tip and moves a few files at a
   time. So each repository keeps POOL_SLOTS checkouts under the temp dir, one per run at once, each held by a lock file
   while a run uses it; a run moves its slot to its base with a forced detached checkout, which writes only the files
   that differ, and `clean -ffdx` takes away whatever the last run's checks left. The neighbours and node_modules lent to
   it are taken back as before. With every slot held, or a slot git cannot move or make, the run takes a throwaway
   snapshot the old way. */
const POOL_PREFIX = "verify-base-";
const POOL_SLOTS = 3;
const LOCK_SUFFIX = ".lock";

/** Where `root`'s repository keeps its base checkouts: one folder per repository, named by its git common dir, which every
 *  conversation's checkout of it shares. `undefined` when git cannot name that dir. */
export const snapshotPoolOf = (root) => {
    const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    // A common dir that is not there has nothing to keep checkouts for.
    if (common === undefined || common === "" || !existsSync(common)) {
        return undefined;
    }
    return join(tmpdir(), `${POOL_PREFIX}${createHash("sha256").update(realpathSync(common)).digest("hex").slice(0, 12)}`);
};

// A free slot's lock, made exclusively so two runs never share a checkout; `undefined` when every slot is held. A lock
// older than STALE_AFTER_MS belongs to a run killed outright (SIGKILL, which no exit handler sees) and is taken over.
const claimSlot = (pool, now = Date.now()) => {
    try {
        mkdirSync(pool, { recursive: true });
    } catch {
        // allow(silent-catch): a temp dir that takes no folder means no pool; the throwaway snapshot is tried next and fails visibly
        return undefined;
    }
    for (let slot = 0; slot < POOL_SLOTS; slot += 1) {
        const lock = join(pool, `slot-${slot}${LOCK_SUFFIX}`);
        for (const retry of [false, true]) {
            try {
                closeSync(openSync(lock, "wx"));
                return lock;
            } catch (error) {
                if (error?.code !== "EEXIST" || retry || !isStale(lock, now)) {
                    break;
                }
                rmSync(lock, { force: true });
            }
        }
    }
    return undefined;
};

// A lock gone since it was found held is free to take.
const isStale = (lock, now) => {
    const stats = statSync(lock, { throwIfNoEntry: false });
    return stats === undefined || now - stats.mtimeMs > STALE_AFTER_MS;
};

// The slot's checkout moved to `rev` and put back to exactly what git holds there: forced, so a file the last run's
// checks changed is restored, and cleaned of every untracked and ignored file they left. Only the files that differ
// between the two commits are written. False when there is no checkout there or git could not move it.
const moveCheckout = (snapshot, rev) =>
    existsSync(join(snapshot, ".git")) &&
    git(snapshot, "checkout", "--detach", "--force", "-q", rev) !== undefined &&
    git(snapshot, "clean", "-ffdxq") !== undefined;

// The slot's checkout made anew. Whatever stood there goes first, its registration too, even when its folder is gone
// (a container made again empties the temp dir but not the repository's list): git would otherwise add a second entry
// for the same path beside the stale one. Forced twice for one a killed `worktree add` left locked "initializing".
const makeCheckout = (root, snapshot, rev) => {
    git(root, "worktree", "remove", "--force", "--force", snapshot);
    rmSync(snapshot, { recursive: true, force: true });
    return git(root, "worktree", "add", "--detach", snapshot, rev) !== undefined;
};

// A pooled checkout of `rev`, its path, with `holding` told at once how to give the slot back; `undefined` when no
// slot is free or neither moving nor making its checkout worked, the slot given back already. Not on Windows: a run
// killed outright leaves its node_modules lent as junctions in the slot, and whether `git clean` deletes a junction or
// walks into the checkout it points at is Git for Windows' to decide; there every run takes a throwaway snapshot.
const pooledSnapshot = (root, rev, holding) => {
    if (process.platform === "win32") {
        return undefined;
    }
    const pool = snapshotPoolOf(root);
    const lock = pool === undefined ? undefined : claimSlot(pool);
    if (lock === undefined) {
        return undefined;
    }
    const giveBack = () => rmSync(lock, { force: true });
    holding(giveBack);
    const snapshot = join(lock.slice(0, -LOCK_SUFFIX.length), "before");
    if (moveCheckout(snapshot, rev) || makeCheckout(root, snapshot, rev)) {
        return snapshot;
    }
    giveBack();
    holding(() => undefined);
    return undefined;
};

// A checkout of `rev` made for this run alone and removed with it, as every run took before the pool.
const throwawaySnapshot = (root, rev, holding) => {
    const parent = mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX));
    const snapshot = join(parent, "before");
    holding(() => {
        // Forced twice: a `worktree add` killed between its checkout and its last step leaves the worktree locked
        // ("initializing"), which one --force refuses to remove and `worktree prune` never takes back.
        git(root, "worktree", "remove", "--force", "--force", snapshot);
        rmSync(parent, { recursive: true, force: true });
    });
    return git(root, "worktree", "add", "--detach", snapshot, rev) === undefined ? undefined : snapshot;
};

/**
 * `use(snapshot, lent)` run in a worktree of `rev` (not a stash, which would mutate the tree the caller is standing in) —
 * `--detach`, since nothing here needs a branch — with this checkout's node_modules lent to it, `lent` saying whether
 * they were. The worktree is one of the repository's kept base checkouts, moved to `rev`, or a throwaway one when none is
 * free. `undefined` when the snapshot couldn't be taken. What the run borrowed is given back however it ends: after
 * `use`, on a termination signal, or, for a throwaway worktree of a process killed outright, by the next run's sweep.
 */
export const withSnapshot = (root, rev, use) => {
    // Named here, in the caller's checkout: inside a kept checkout `HEAD` (and `HEAD~3`) is that checkout's own.
    const commit = git(root, "rev-parse", "-q", "--verify", `${rev}^{commit}`)?.trim();
    if (commit === undefined || commit === "") {
        return undefined; // a rev this checkout does not have: there is no "before" to look at
    }
    sweepSnapshots(root);
    guardSnapshots();
    let borrowed = { links: [], lent: false };
    let giveBack = () => undefined;
    const holding = (back) => {
        giveBack = back;
    };
    const release = () => {
        held.delete(release);
        for (const link of borrowed.links) {
            rmSync(link, { force: true }); // unlinks the link itself: node's rm reads it with lstat and never walks through one
        }
        giveBack();
    };
    held.add(release);
    try {
        const snapshot = pooledSnapshot(root, commit, holding) ?? throwawaySnapshot(root, commit, holding);
        if (snapshot === undefined) {
            return undefined;
        }
        borrowed = lendModules(root, snapshot);
        borrowed.links.push(...lendNeighbours(root, snapshot));
        return use(snapshot, borrowed.lent);
    } finally {
        release();
    }
};

/**
 * What each of `ids` said at `rev`, keyed by check id, for turn-findings.mjs to read the live run against, from a
 * snapshot of `rev` (withSnapshot). `undefined` when the snapshot couldn't be taken, in which case the caller counts
 * every problem as its own: the safe direction to be wrong in.
 */
export const reportsAt = (root, rev, ids) => {
    if (ids.length === 0) {
        return undefined; // nothing askable
    }
    return withSnapshot(root, rev, (snapshot, lent) => {
        const verdicts = checkVerdicts(snapshot, ids);
        return verdicts === undefined
            ? undefined
            : new Map(
                  verdicts.map((verdict) => [
                      verdict.id,
                      // `findings` keys each line with the source it anchors to in the snapshot, read before it is removed.
                      { ok: verdict.ok, lines: problemLines(verdict), findings: findingCounts(verdict, snapshot), blind: blindAtBase(verdict, lent) },
                  ]),
              );
    });
};
