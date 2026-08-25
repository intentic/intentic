import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type RunnerSync, runnerGitUrl, runnerIncomingRef } from "@intentic/sandbox-contract";
import type { AgentWorktrees } from "../agents/worktrees.js";
import { repoGitDir } from "../history/history.js";
import type { RunnerIdentity } from "./runner-identity.js";

/* THE RUNNER'S HALF OF THE WORKSPACE, git both ways and nothing else (docs/remote-runners-plan.md §6 at the
 * workspace root). The runner's /work is a MIRROR of the parent's: before a turn, each repo's main line and
 * the conversation's branch are fetched from the parent's git door and the checkouts moved onto them; after
 * one, the branch is pushed back to refs/runner-incoming/<id>, from which the parent advances its own copy.
 *
 * Everything here is stock `git` against smart HTTP, authenticated by the runner's durable token as a bearer.
 * The token rides in as GIT_CONFIG_* environment rather than argv, argv is world-readable in /proc on the
 * very machine whose other sandboxes this runner shares.
 *
 * The fetched refs land under refs/runner-parent/ first and the local refs are moved FROM them, rather than
 * fetching straight into refs/heads/: the conversation's branch may be checked out in this runner's own
 * worktree, and moving a checked-out ref behind git's back is how a checkout and its branch end up telling
 * two stories. An attached worktree is hard-reset (the sanctioned move); a detached branch is `branch -f`d. */

const execFileAsync = promisify(execFile);

// Where each fetched ref parks before the local ref moves onto it. Per repo, so no cross-repo collision.
const PARENT_MAIN_REF = "refs/runner-parent/main";
const PARENT_TURN_REF = "refs/runner-parent/turn";

export interface RunnerSyncDeps {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly worktrees: AgentWorktrees;
}

const gitEnv = (identity: RunnerIdentity): NodeJS.ProcessEnv => ({
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${identity.token}`,
    // A fetch that stops for a password prompt has already failed; fail it legibly instead.
    GIT_TERMINAL_PROMPT: "0",
});

const git = async (identity: RunnerIdentity, cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(identity), maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
};

// The working dir a composition entry means on THIS machine: "" is the workspace root itself.
const workingDirOf = (deps: RunnerSyncDeps, dir: string): string => (dir === "" ? deps.workspaceRoot : join(deps.workspaceRoot, dir));

/* Make one repo exist here in the daemon's canonical shape: working dir in /work, real git dir on /history
 * (`--separate-git-dir`, the shape every boot converges toward, git/repo-git-dirs.ts). A repo that already
 * has the pointer is left exactly as it is, which is the steady state and the root repo always. */
const ensureRepo = async (deps: RunnerSyncDeps, identity: RunnerIdentity, repo: string, dir: string): Promise<string> => {
    const workingDir = workingDirOf(deps, dir);
    const gitDir = repoGitDir(deps.historyRoot, repo);
    await mkdir(workingDir, { recursive: true });
    try {
        await git(identity, workingDir, ["rev-parse", "--resolve-git-dir", gitDir]);
    } catch {
        // init writes INTO gits/ but will not create it; the daemon's own boot makes it, a fresh mirror must too.
        await mkdir(dirname(gitDir), { recursive: true });
        await git(identity, workingDir, ["init", "--separate-git-dir", gitDir]);
    }
    return workingDir;
};

export const syncFromParent = async (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, onLine: (line: string) => void): Promise<void> => {
    for (const { repo, dir, mainBranch } of input.repos) {
        const workingDir = await ensureRepo(deps, identity, repo, dir);
        const url = runnerGitUrl(identity.parentUrl, repo);
        onLine(`${repo}: fetching from the parent…`);
        await git(identity, workingDir, ["fetch", "--no-tags", url, `+refs/heads/${mainBranch}:${PARENT_MAIN_REF}`]);
        /* The main line first: `checkout -B` moves this mirror's checked-out branch onto the parent's, under
         * the parent's own branch NAME, so a runner initialized with a different default is converged rather
         * than accumulating a second history. Tracked content only; untracked files (state, junk from an
         * interrupted turn) are deliberately left, .intentic is excluded on both ends. */
        await git(identity, workingDir, ["checkout", "-B", mainBranch, PARENT_MAIN_REF]);
        /* Then the conversation's branch. It exists on the parent from the first turn (the mirror worktree's
         * ensure creates it), but tolerate its absence rather than failing the whole sync: a branch the
         * parent has not created yet simply starts here at main, which is where ensure would put it. */
        const fetched = await git(identity, workingDir, ["fetch", "--no-tags", url, `+refs/heads/${input.branch}:${PARENT_TURN_REF}`])
            .then(() => true)
            .catch(() => false);
        if (!fetched) {
            onLine(`${repo}: the parent has no ${input.branch} yet, starting it at ${mainBranch}`);
            continue;
        }
        if (await deps.worktrees.attached(input.conversationId, repo)) {
            await git(identity, deps.worktrees.worktreeDir(input.conversationId, repo), ["reset", "--hard", PARENT_TURN_REF]);
        } else {
            await git(identity, workingDir, ["branch", "-f", input.branch, PARENT_TURN_REF]);
        }
        onLine(`${repo}: up to date`);
    }
};

export const pushToParent = async (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, onLine: (line: string) => void): Promise<void> => {
    for (const { repo, dir } of input.repos) {
        const workingDir = workingDirOf(deps, dir);
        const url = runnerGitUrl(identity.parentUrl, repo);
        const tip = await git(identity, workingDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`]).catch(() => "");
        if (tip === "") {
            // A repo the turn never touched has no branch here; nothing to deliver is a normal answer.
            onLine(`${repo}: no ${input.branch} here, nothing to push`);
            continue;
        }
        onLine(`${repo}: pushing ${tip.slice(0, 7)}…`);
        await git(identity, workingDir, ["push", "--no-verify", url, `+refs/heads/${input.branch}:${runnerIncomingRef(input.conversationId)}`]);
    }
};
