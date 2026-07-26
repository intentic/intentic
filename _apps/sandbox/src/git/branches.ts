import type { GitBranch } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* Branch management over a real repo: the list the switcher renders, plus create and delete. Reading is one
 * `for-each-ref` — it reports each branch's upstream and its ahead/behind counts in the same pass, and (unlike
 * `rev-list @{upstream}...`) it simply leaves them empty for a branch with no upstream instead of failing.
 * Checkout lives in changes.ts with the other HEAD-movers, because it is auto-checkpointed like they are. */

// Field separator for the for-each-ref format. A branch name can't contain US, and neither can any of the
// other fields, so a plain split is exact — the same trick commitLog uses for its log records.
const US = "\x1f";

// `%(upstream:track)` renders as "[ahead 2, behind 1]", "[ahead 3]", "[behind 1]", "[gone]" or "" (in sync, or
// no upstream at all — `upstream` distinguishes those two). Anything unparsed reads as zero, never as a throw.
const parseTrack = (track: string): { ahead: number; behind: number; gone: boolean } => {
    if (track.includes("gone")) {
        return { ahead: 0, behind: 0, gone: true };
    }
    const ahead = /ahead (\d+)/.exec(track)?.[1];
    const behind = /behind (\d+)/.exec(track)?.[1];
    return { ahead: Number(ahead ?? 0), behind: Number(behind ?? 0), gone: false };
};

// One branch's upstream facts in a single `for-each-ref`: its tracking ref, the REMOTE that ref lives on, and
// how far each side has moved. `%(upstream:remotename)` is the branch's own remote, which is not necessarily
// the first one `git remote` lists — a fork has both `origin` and `upstream` — so it is the only correct
// target for a push. An unknown branch, or one with no upstream, reads as all-absent rather than throwing.
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

// Every local branch, newest commit first — the order a switcher wants (what you were just on is near the top).
export const listBranches = async (dir: string, git: GitRunner = defaultGit): Promise<GitBranch[]> => {
    const format = ["%(refname:short)", "%(upstream:short)", "%(upstream:track)", "%(committerdate:unix)", "%(HEAD)"].join(US);
    // A repo with no commits has no refs/heads at all — an empty list, not an error.
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
            // The upstream ref is configured but no longer exists on the remote (a merged PR's deleted branch).
            // Surfaced so the UI can offer "delete local" rather than silently showing 0/0 like a synced branch.
            ...(gone ? { gone: true } : {}),
            at: Number(at ?? "0") * 1000,
        });
    }
    return branches;
};

// Create a branch at a ref and leave HEAD where it is (`git branch <name> <start>`), or check it out
// immediately (`git switch -c`), which is what "new branch from here" in a switcher means. Non-destructive
// either way — git refuses a duplicate name and refuses a checkout that would lose changes; both propagate.
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

// Delete a local branch. Without `force` git refuses to drop a branch whose commits aren't merged anywhere
// (and always refuses the checked-out one) — that refusal propagates as the error it is, so the UI can offer
// the force retry rather than the daemon guessing on the user's behalf.
export const deleteBranch = async (dir: string, name: string, force: boolean, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["branch", force ? "-D" : "-d", name]);
};
