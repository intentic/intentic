import { existsSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import type { Log } from "@intentic/local-agent";
import type { Pairing } from "./config.js";
import { runProcess } from "./exec.js";
import { sshAlias } from "./ssh.js";

// Moves git state, not worktree files, which file sync owns, from the sandbox's real git dirs to the local clone:
// fetch, then fast-forward. One-way only: local commits or staged work the sandbox lacks freeze the bridge rather
// than being rebased, reset or merged. Steady state costs one ls-remote per repo.

// One seam for every effect the bridge has, so the fast-forward policy tests without git, ssh or a disk. Async:
// these commands share the SSH transport this process serves on loopback (tunnel.ts); a blocking spawn would deadlock
// it.
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

// Repo-id shape enforced by workspace/repo-discovery.ts: 1-4 segments, each starting alphanumeric. Re-checked here
// since ids arrive as sandbox directory names; unvalidated, joining under localDir risks a path escape.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const isSafeRepoId = (id: string): boolean => {
    const segments = id.split("/");
    return segments.length <= 4 && segments.every((segment) => SEGMENT.test(segment));
};

// Repo ids are the URI-encoded git-dir names under /history/gits, read over ssh (the daemon consults the same
// listing). Undefined means the sandbox was unreachable; retry next pass.
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

// Brings one local repo up to the sandbox's history, fast-forward only. Every early return leaves the repo alone
// this pass rather than touch the user's work.
export const bridgeRepo = async (exec: BridgeExec, alias: string, localDir: string, repo: string, log: Log): Promise<void> => {
    const dir = join(localDir, repo);
    if (!exec.exists(dir)) {
        return; // the worktree hasn't synced down yet: a later pass catches it
    }
    const url = `${alias}:/history/gits/${encodeURIComponent(repo)}`;
    if (!exec.exists(join(dir, ".git"))) {
        // A repo born in the sandbox: file sync delivered its files, this delivers its git-ness.
        if ((await exec.run("git", ["init", "-q"], dir)) === undefined) {
            return;
        }
        log(`  ${repo}: initialized, this repo's history now follows the sandbox`);
    }
    // Mirrors the sandbox's core.fileMode=false (daemon's GIT_GLOBAL_ARGS): local git defaults true. Checked every
    // pass, not just init, since already-paired repos may predate this.
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
    // The one round trip a quiet repo pays for: answers branch, tip, and reachability together.
    const symref = (await exec.run("git", ["ls-remote", "--symref", "sandbox", "HEAD"], dir)) ?? "";
    const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(symref)?.[1];
    // Sha line of the listing; unchecked length also matches sha256; anchor excludes origin/HEAD below.
    const remoteTip = /^([0-9a-f]+)\s+HEAD\s*$/m.exec(symref)?.[1];
    if (branch === undefined || remoteTip === undefined) {
        return; // unreachable, or an unborn HEAD in the sandbox: nothing to bridge yet
    }
    // Local and free; read before the fetch so the quiet case can be decided without one.
    const head = (await exec.run("git", ["rev-parse", "-q", "--verify", "HEAD"], dir))?.trim();
    const localBranch = (await exec.run("git", ["symbolic-ref", "--short", "-q", "HEAD"], dir))?.trim();
    // Records what the bridge itself installed into this branch, not the remote-tracking ref: a fetch advances that
    // regardless of whether HEAD followed. The ref moves only when HEAD moves.
    const bridged = `refs/intentic/bridged/${branch}`;
    const installed = (await exec.run("git", ["rev-parse", "-q", "--verify", bridged], dir))?.trim();
    if (head === remoteTip && localBranch === branch) {
        // Level with the sandbox: nothing to do, but converge the marker here too — a repo that never falls behind
        // never
        // reaches the reset that would otherwise write it.
        if (head !== undefined && installed !== head) {
            await exec.run("git", ["update-ref", bridged, head], dir);
        }
        return;
    }
    if ((await exec.run("git", ["fetch", "-q", "sandbox", `+refs/heads/${branch}:refs/remotes/sandbox/${branch}`], dir)) === undefined) {
        log(`  ${repo}: fetch from the sandbox failed, will retry next pass`);
        return;
    }
    // Re-reads the tip from the fetch's ref, not the probe's: the sandbox may have committed again meanwhile.
    const tip = (await exec.run("git", ["rev-parse", "-q", "--verify", `refs/remotes/sandbox/${branch}`], dir))?.trim();
    if (tip === undefined || tip === "") {
        return;
    }
    // Anything staged is a commit the user is composing, the mixed reset below would silently unstage it.
    if (head !== undefined && (await exec.run("git", ["diff", "--cached", "--quiet"], dir)) === undefined) {
        return;
    }
    // Fast-forward only, unless local HEAD is exactly what the bridge last installed: then the sandbox rewound its
    // own history, and this follows it back.
    if (head !== undefined && head !== tip && (await exec.run("git", ["merge-base", "--is-ancestor", "HEAD", tip], dir)) === undefined) {
        if (head !== installed) {
            log(`  ${repo}: local commits diverge from the sandbox, leaving it alone`);
            return;
        }
        log(`  ${repo}: the sandbox rewound ${branch}, following it back`);
    }
    if (localBranch !== branch) {
        // Sandbox checked out a different branch (or repo was freshly initialized): follow by name via symbolic-ref,
        // which moves HEAD without touching files unless the local branch holds commits the sandbox lacks.
        const existing = (await exec.run("git", ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], dir))?.trim();
        if (
            existing !== undefined &&
            existing !== "" &&
            existing !== tip &&
            // Also covers a branch the bridge installed that the sandbox has since rewound: no local work there either.
            existing !== installed &&
            (await exec.run("git", ["merge-base", "--is-ancestor", existing, tip], dir)) === undefined
        ) {
            log(`  ${repo}: local branch ${branch} diverges from the sandbox, leaving it alone`);
            return;
        }
        await exec.run("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    } else if (head === tip) {
        return; // already there
    }
    if ((await exec.run("git", ["reset", "-q", tip], dir)) !== undefined) {
        // Records what was just installed, right after the reset: this is the valve's only memory, and a reset whose
        // marker never lands can't be followed as a rewind later.
        await exec.run("git", ["update-ref", bridged, tip], dir);
        log(`  ${repo}: fast-forwarded ${branch} to ${tip.slice(0, 8)}`);
    }
};

// One bridge pass over a pairing's sandbox repos (sync-mode only). `known` lets the caller skip re-listing over
// ssh when the repo set is unchanged; returns the list used, or undefined if there was nothing to bridge.
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
        // Named so a reader can tell which sandbox is down when one machine bridges a fleet.
        log(`  ${pairing.sandboxId}: git bridge couldn't list the sandbox's repos, will retry next pass`);
        return undefined;
    }
    for (const repo of repos) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one repo at a time, on purpose: they share one ssh
        // transport and log; concurrent fetches would contend for both.
        await bridgeRepo(exec, alias, pairing.localDir, repo, log);
    }
    return repos;
};
