import type { GitBranch, GitRemoteBranch } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

// Branch list/create/delete over a real repo. Listing is one `for-each-ref` call that never fails for a branch with no
// upstream (unlike `rev-list @{upstream}...`); checkout lives in changes-commits.ts with the other HEAD-movers.

// Field separator for for-each-ref output; no field can contain US, so a plain split is exact.
const US = "\x1f";

// `%(upstream:track)` renders as `[ahead N, behind N]`, `[gone]`, or empty (in sync or no upstream); unparsed reads as
// zero, never a throw.
const parseTrack = (track: string): { ahead: number; behind: number; gone: boolean } => {
    if (track.includes("gone")) {
        return { ahead: 0, behind: 0, gone: true };
    }
    const ahead = /ahead (\d+)/.exec(track)?.[1];
    const behind = /behind (\d+)/.exec(track)?.[1];
    return { ahead: Number(ahead ?? 0), behind: Number(behind ?? 0), gone: false };
};

// One branch's upstream, remote and ahead/behind in one `for-each-ref`; `%(upstream:remotename)` is this branch's own
// remote (not necessarily `git remote`'s first). No upstream reads as all-absent, not a throw.
export const upstreamOf = async (
    dir: string,
    branch: string,
    git: GitRunner = defaultGit,
): Promise<{ upstream?: string; remote?: string; ahead: number; behind: number }> => {
    const format = ["%(upstream:short)", "%(upstream:remotename)", "%(upstream:track)"].join(US);
    const { stdout } = await git(dir, ["for-each-ref", `--format=${format}`, `refs/heads/${branch}`]);
    const [upstream, remote, track] = (stdout.split("\n")[0] ?? "").split(US);
    const { ahead, behind } = parseTrack(track ?? "");
    return {
        ...(upstream !== undefined && upstream !== "" ? { upstream } : {}),
        ...(remote !== undefined && remote !== "" ? { remote } : {}),
        ahead,
        behind,
    };
};

// Every local branch, newest commit first: the order a switcher wants.
export const listBranches = async (dir: string, git: GitRunner = defaultGit): Promise<GitBranch[]> => {
    const format = ["%(refname:short)", "%(upstream:short)", "%(upstream:track)", "%(committerdate:unix)", "%(HEAD)"].join(US);
    // A repo with no commits has no refs/heads at all: an empty list, not an error.
    const { stdout } = await git(dir, ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"]);
    const branches: GitBranch[] = [];
    for (const line of stdout.split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        const [name, upstream, track, at, head] = line.split(US);
        if (name === undefined || name === "") {
            continue;
        }
        const { ahead, behind, gone } = parseTrack(track ?? "");
        branches.push({
            name,
            current: head === "*",
            ...(upstream !== undefined && upstream !== "" ? { upstream } : {}),
            ahead,
            behind,
            // Upstream configured but gone from the remote; surfaced so the UI can offer to delete local.
            ...(gone ? { gone: true } : {}),
            at: Number(at ?? "0") * 1000,
        });
    }
    return branches;
};

// Remote-tracking branches (`origin/main`, etc.), read separately since the fields differ from a local branch's (no
// upstream, no ahead/behind). `origin/HEAD` is skipped: a symref would duplicate a tip under two names.
export const listRemoteBranches = async (dir: string, git: GitRunner = defaultGit): Promise<GitRemoteBranch[]> => {
    const format = ["%(refname:short)", "%(committerdate:unix)", "%(symref)"].join(US);
    const { stdout } = await git(dir, ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/remotes"]);
    const branches: GitRemoteBranch[] = [];
    for (const line of stdout.split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        const [name, at, symref] = line.split(US);
        // A symref has a target; that is what makes it `origin/HEAD` rather than a real branch.
        if (name === undefined || name === "" || (symref !== undefined && symref !== "")) {
            continue;
        }
        // Splits on the first slash only: a branch name may contain slashes, a remote name may not.
        const slash = name.indexOf("/");
        if (slash <= 0) {
            continue;
        }
        branches.push({ name, remote: name.slice(0, slash), branch: name.slice(slash + 1), at: Number(at ?? "0") * 1000 });
    }
    return branches;
};

// Creates a branch at a ref (`git branch`), or checks it out immediately (`git switch -c`). Non-destructive: a
// duplicate name or an unsafe checkout is git's refusal to propagate.
export const createBranch = async (
    dir: string,
    name: string,
    start: string | undefined,
    checkout: boolean,
    git: GitRunner = defaultGit,
): Promise<void> => {
    const args = checkout ? ["switch", "-c", name] : ["branch", name];
    await git(dir, start !== undefined ? [...args, start] : args);
};

// Deletes a local branch. Without `force`, git refuses an unmerged or checked-out branch; that refusal propagates so
// the UI can offer a forced retry.
export const deleteBranch = async (dir: string, name: string, force: boolean, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["branch", force ? "-D" : "-d", name]);
};
