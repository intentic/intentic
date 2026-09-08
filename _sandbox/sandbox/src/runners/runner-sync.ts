import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type RunnerSync, runnerGitUrl, runnerIncomingRef } from "@intentic/sandbox-contract";
import type { AgentWorktrees } from "../agents/worktrees/worktrees.js";
import { repoGitDir } from "../history/history.js";
import type { RunnerIdentity } from "./runner-identity.js";

// The runner's /work mirrors the parent's: fetched before a turn, pushed to refs/runner-incoming/<id> after. The token
// rides in as GIT_CONFIG_* env, not argv (readable in /proc on a shared machine). Fetched refs land in
// refs/runner-parent/ first, since moving a checked-out branch straight into refs/heads/ would desync it from its
// worktree.

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

// The working dir a composition entry means locally; "" is the workspace root itself.
const workingDirOf = (deps: RunnerSyncDeps, dir: string): string => (dir === "" ? deps.workspaceRoot : join(deps.workspaceRoot, dir));

// Puts a repo in the daemon's canonical shape: working dir in /work, real git dir on /history. Already-shaped repos are
// left alone.
const ensureRepo = async (deps: RunnerSyncDeps, identity: RunnerIdentity, repo: string, dir: string): Promise<string> => {
    const workingDir = workingDirOf(deps, dir);
    const gitDir = repoGitDir(deps.historyRoot, repo);
    await mkdir(workingDir, { recursive: true });
    try {
        await git(identity, workingDir, ["rev-parse", "--resolve-git-dir", gitDir]);
    } catch {
        // git init writes into gits/ but will not create the directory; a fresh mirror has to make it too.
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
        // Moves this mirror onto the parent's own branch name, converging rather than growing a second history.
        await git(identity, workingDir, ["checkout", "-B", mainBranch, PARENT_MAIN_REF]);
        // Tolerates a branch the parent hasn't created yet: this repo just starts at main instead of failing.
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
