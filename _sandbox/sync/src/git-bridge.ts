import { existsSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import type { Log } from "@intentic/local-agent";
import type { Pairing } from "./config.js";
import { runProcess } from "./exec.js";
import { sshAlias } from "./ssh.js";

/* THE GIT BRIDGE: how commits reach the desktop now that no .git file-syncs (ssh.ts IGNORES). File sync owns
 * the WORKTREES; git state moves by git's own protocol over the same SSH transport, a fetch straight from the
 * sandbox's real git dirs (/history/gits/<id>, where the daemon parks every repo's git dir) followed by a
 * fast-forward of the local clone. Atomic and lock-aware, where the file-level .git copy this replaces raced
 * live git operations on both ends and pinned the session on file-vs-directory conflicts.
 *
 * The bridge is strictly one-way and strictly fast-forward: the sandbox is where commits are made (the Changes
 * panel, agent lands), so the local clone FOLLOWS it. Local commits the sandbox doesn't have, or anything
 * staged locally, freeze the bridge for that repo rather than being rebased, reset or merged: the bridge must
 * never destroy local work, and ordinary git (push to origin, pull in the sandbox) is how the user reconciles.
 *
 * The fast-forward is a MIXED reset: branch ref + index move to the sandbox tip, the worktree is untouched,
 * the worktree is file sync's to converge, and once both have caught up `git status` here settles to exactly
 * the sandbox's own uncommitted set. In the window between a fetch and the worktree catching up, status can
 * transiently over- or under-report; it self-corrects within a sync cycle.
 *
 * That window is why a pass is built to be CHEAP. File sync is event-driven and lands a commit's FILES within
 * seconds, so between the commit and the bridge moving HEAD the local `git status` reports everything that just
 * landed as uncommitted, the lag is the whole user-visible symptom. So a pass runs on every watcher tick, and
 * the steady state costs ONE `ls-remote` per repo: that single listing carries both the sandbox's branch and
 * its tip, which is enough to answer "nothing moved" and stop. Only a tip that actually moved pays for a fetch. */

/* One seam for every effect the bridge has, so the fast-forward policy unit-tests without git, ssh or a disk.
 *
 * ASYNC, and that is not a style choice. Every command here reaches the sandbox over the SSH transport this same
 * process serves on loopback (tunnel.ts), so a blocking spawn would stop the event loop that has to carry the
 * bytes the command is waiting for, the bridge's own ssh, deadlocked against the bridge's own listener, until
 * the timeout below fired. See exec.ts for what that cost and how it read in the logs. */
export interface BridgeExec {
    // Run a command capturing stdout; undefined ⇒ it failed (non-zero exit, spawn error, timeout).
    readonly run: (command: string, args: readonly string[], cwd?: string) => Promise<string | undefined>;
    readonly exists: (path: string) => boolean;
}

// A hung tunnel must not wedge one pass for good, generous enough for a first fetch of a real repo.
const EXEC_TIMEOUT_MS = 120_000;

export const realBridgeExec: BridgeExec = {
    run: async (command, args, cwd) => {
        const result = await runProcess(command, args, { cwd, timeoutMs: EXEC_TIMEOUT_MS });
        return result.status === 0 ? result.stdout : undefined;
    },
    exists: existsSync,
};

// The repo-id shape the daemon's own discovery enforces (workspace/repo-discovery.ts): 1–4 segments, each
// starting alphanumeric. Re-checked HERE because these ids arrive as directory names listed off the sandbox,
// and joining an unvalidated name under localDir is a path escape waiting for a hostile sandbox.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const isSafeRepoId = (id: string): boolean => {
    const segments = id.split("/");
    return segments.length <= 4 && segments.every((segment) => SEGMENT.test(segment));
};

// Every repo the sandbox tracks, the git-dir entries under /history/gits, whose names are the URI-encoded repo
// ids. Read over ssh rather than the daemon API: the transport is already enrolled, and it is the same listing
// the daemon itself consults. undefined ⇒ the sandbox was unreachable (retry next pass).
export const listSandboxRepos = async (exec: BridgeExec, alias: string): Promise<string[] | undefined> => {
    const out = await exec.run("ssh", ["-o", "BatchMode=yes", alias, "ls", `${HISTORY_ROOT}/gits`]);
    if (out === undefined) {
        return undefined;
    }
    return out
        .split("\n")
        .map((line) => decodeURIComponent(line.trim()))
        .filter((id) => id !== "" && id !== "root" && isSafeRepoId(id));
};

// Bring one local repo up to the sandbox's history, fast-forward only. Every early return is a repo the bridge
// deliberately leaves alone this pass, either there is nothing to do yet, or doing anything would touch work
// that belongs to the user.
export const bridgeRepo = async (exec: BridgeExec, alias: string, localDir: string, repo: string, log: Log): Promise<void> => {
    const dir = join(localDir, repo);
    if (!exec.exists(dir)) {
        return; // the worktree hasn't synced down yet — a later pass catches it
    }
    const url = `${alias}:/history/gits/${encodeURIComponent(repo)}`;
    if (!exec.exists(join(dir, ".git"))) {
        // A repo born in the sandbox: file sync delivered its files, this delivers its git-ness. After the
        // reset below, status shows only what the sandbox itself has uncommitted.
        if ((await exec.run("git", ["init", "-q"], dir)) === undefined) {
            return;
        }
        log(`  ${repo}: initialized — this repo's history now follows the sandbox`);
    }
    // Read the worktree the way the SANDBOX reads it. The daemon runs EVERY git command with
    // core.fileMode=false (scaffold's GIT_GLOBAL_ARGS: workspace files arrive by browser upload, which cannot
    // carry a Unix permission, so an exec bit there is noise), local git defaults to true. One worktree, two
    // verdicts: a hook or script whose exec bit had drifted showed up as a modification in the desktop's SCM
    // view that the Changes panel does not list, that no local edit explains, and that neither end can clear,
    // the sandbox's git will not even record a mode, so committing it there is not an option either.
    // Converged on every pass rather than only at init: a machine paired before this shipped already has git's
    // own default written into its config, and the read is local and free next to the ls-remote below.
    if ((await exec.run("git", ["config", "--get", "core.fileMode"], dir))?.trim() !== "false") {
        await exec.run("git", ["config", "core.fileMode", "false"], dir);
    }
    const current = (await exec.run("git", ["remote", "get-url", "sandbox"], dir))?.trim();
    if (current === undefined) {
        if ((await exec.run("git", ["remote", "add", "sandbox", url], dir)) === undefined) {
            return;
        }
    } else if (current !== url) {
        await exec.run("git", ["remote", "set-url", "sandbox", url], dir);
    }
    // THE probe, and the only round trip a quiet repo pays for: one listing answers both which branch the
    // sandbox is on and where that branch's tip sits, and doubles as the reachability check for the rest.
    const symref = (await exec.run("git", ["ls-remote", "--symref", "sandbox", "HEAD"], dir)) ?? "";
    const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(symref)?.[1];
    // The sha line of that same listing. Deliberately not length-checked, so it reads a sha256 repo too; the
    // trailing anchor is what keeps it off the `<sha> refs/remotes/origin/HEAD` line further down the output.
    const remoteTip = /^([0-9a-f]+)\s+HEAD\s*$/m.exec(symref)?.[1];
    if (branch === undefined || remoteTip === undefined) {
        return; // unreachable, or an unborn HEAD in the sandbox — nothing to bridge yet
    }
    // Both local, both free. Read here rather than after the fetch so the quiet case can be decided without one.
    const head = (await exec.run("git", ["rev-parse", "-q", "--verify", "HEAD"], dir))?.trim();
    const localBranch = (await exec.run("git", ["symbolic-ref", "--short", "-q", "HEAD"], dir))?.trim();
    /* What this bridge itself last installed into this branch, the one fact that tells the user's own commits
     * apart from history the bridge put here, and therefore what makes a sandbox REWIND recoverable below.
     *
     * It is the bridge's OWN ref, written only where HEAD is written. Reading the remote-tracking ref for this
     * (as this did) conflates two different questions, because a FETCH advances that ref whether or not HEAD
     * followed: the answer stayed true for exactly one pass. Every path that returns between the fetch and the
     * reset, anything staged, a tip that won't resolve, the refusal itself, left the marker one commit ahead
     * of a HEAD that never moved, and the NEXT pass could no longer recognise its own history. So a rewind the
     * bridge missed even once (an agent too old to follow it, a sandbox unreachable for that one tick) became
     * permanent: HEAD pinned to discarded history, file sync still delivering every later commit's files, and a
     * local `git status` growing without bound until someone reset it by hand. This ref moves when, and only
     * when, HEAD moves, so the answer keeps for as long as it takes. */
    const bridged = `refs/intentic/bridged/${branch}`;
    const installed = (await exec.run("git", ["rev-parse", "-q", "--verify", bridged], dir))?.trim();
    if (head === remoteTip && localBranch === branch) {
        // Level with the sandbox: nothing moved since the last pass, the overwhelmingly common case, and it
        // ends here. The marker is converged first, because a repo that STAYS level never reaches the reset that
        // writes it: without this, an install that has never once fallen behind carries no marker at all, and so
        // would meet its first rewind defenceless. That is also the state a hand-run recovery leaves behind, and
        // arming the valve must not cost the user a second freeze.
        if (head !== undefined && installed !== head) {
            await exec.run("git", ["update-ref", bridged, head], dir);
        }
        return;
    }
    if ((await exec.run("git", ["fetch", "-q", "sandbox", `+refs/heads/${branch}:refs/remotes/sandbox/${branch}`], dir)) === undefined) {
        log(`  ${repo}: fetch from the sandbox failed — will retry next pass`);
        return;
    }
    // Re-read the tip from the ref the fetch just wrote instead of trusting the probe's: if the sandbox
    // committed again in between, this is the sha we actually hold the objects for.
    const tip = (await exec.run("git", ["rev-parse", "-q", "--verify", `refs/remotes/sandbox/${branch}`], dir))?.trim();
    if (tip === undefined || tip === "") {
        return;
    }
    // Anything staged is a commit the user is composing, the mixed reset below would silently unstage it.
    if (head !== undefined && (await exec.run("git", ["diff", "--cached", "--quiet"], dir)) === undefined) {
        return;
    }
    /* Fast-forward only: local commits the sandbox lacks stay exactly where they are. UNLESS the local tip is
     * EXACTLY what the bridge last installed, which means nobody committed here and the sandbox rewound its own
     * history (a commit undone in the Changes panel, an amend, a reset). There is no local work to protect in
     * that case, and refusing is not the safe choice it looks like: the desktop stays pinned to a commit the
     * sandbox has thrown away, file sync keeps delivering every later commit's FILES, and the local `git status`
     * grows without bound, hundreds of "changes" the user cannot commit, revert or explain, with nothing short
     * of a hand-run `git reset` to clear them. So follow the rewind; the worktree is untouched either way. */
    if (head !== undefined && head !== tip && (await exec.run("git", ["merge-base", "--is-ancestor", "HEAD", tip], dir)) === undefined) {
        if (head !== installed) {
            log(`  ${repo}: local commits diverge from the sandbox — leaving it alone`);
            return;
        }
        log(`  ${repo}: the sandbox rewound ${branch} — following it back`);
    }
    if (localBranch !== branch) {
        // The sandbox checked out a different branch (or this repo was just initialized): follow it by name,
        // symbolic-ref moves HEAD without touching a single file, unless a local branch of that name holds
        // commits the sandbox lacks, which the reset below would strand.
        const existing = (await exec.run("git", ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], dir))?.trim();
        if (
            existing !== undefined &&
            existing !== "" &&
            existing !== tip &&
            // The marker answers for a branch the bridge is not standing on just as well as for the one it is:
            // a branch it installed and the sandbox has since rewound holds no local work either, and freezing
            // on it strands the same way, just out of sight, on a branch nobody is looking at.
            existing !== installed &&
            (await exec.run("git", ["merge-base", "--is-ancestor", existing, tip], dir)) === undefined
        ) {
            log(`  ${repo}: local branch ${branch} diverges from the sandbox — leaving it alone`);
            return;
        }
        await exec.run("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    } else if (head === tip) {
        return; // already there
    }
    if ((await exec.run("git", ["reset", "-q", tip], dir)) !== undefined) {
        // Record what was just installed, in the same breath as installing it. This is the whole memory the
        // valve has: everything above is a read, and a reset whose marker never landed is a rewind this bridge
        // will refuse to follow however many passes it gets.
        await exec.run("git", ["update-ref", bridged, tip], dir);
        log(`  ${repo}: fast-forwarded ${branch} to ${tip.slice(0, 8)}`);
    }
};

// One bridge pass over one pairing's sandbox repos. Only a "sync"-mode enrollment has a local tree to bridge into.
//
// `known` is the repo list an earlier pass returned. The set only changes when a repo is added or removed, so
// the caller holds onto it and passes undefined when it wants a fresh listing, that keeps the per-tick cost at
// the one `ls-remote` each repo already pays instead of an ssh round trip just to re-learn the same names.
// Returns the list that was used, or undefined when there was nothing to bridge or the sandbox was unreachable.
export const runGitBridge = async (
    exec: BridgeExec,
    pairing: Pairing,
    log: Log,
    known: readonly string[] | undefined,
): Promise<readonly string[] | undefined> => {
    if (pairing.mode !== "sync" || pairing.localDir === undefined) {
        return undefined;
    }
    const alias = sshAlias(pairing.sandboxId);
    const repos = known ?? (await listSandboxRepos(exec, alias));
    if (repos === undefined) {
        // Named, because one machine bridges a FLEET and this line repeats every pass: an unnamed "couldn't list
        // the sandbox's repos" every few seconds says nothing about WHICH sandbox is down, so a reader watching a
        // healthy pairing's log cannot tell whether it is the one being reported.
        log(`  ${pairing.sandboxId}: git bridge couldn't list the sandbox's repos — will retry next pass`);
        return undefined;
    }
    for (const repo of repos) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one repo at a time, on purpose: they share one ssh
        // transport and one log, and a burst of concurrent fetches would contend for both
        await bridgeRepo(exec, alias, pairing.localDir, repo, log);
    }
    return repos;
};
