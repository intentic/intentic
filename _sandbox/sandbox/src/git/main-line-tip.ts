import { defaultGit, type GitRunner } from "@intentic/base/git";
import { checkedOutBranch } from "../store/git/git-dir.js";
import { feedHeadSha } from "./changes/changes.js";
import { latchedMainBranch } from "./main-line-lock.js";

// WHERE A SHARED CHECKOUT'S MAIN LINE IS READ, for what cuts a conversation from it and syncs one onto it
// (worktrees.ts composableHead, sync.ts), and what every main-thread tool call's catch-up compares against
// (worktree-placement.ts mainHeadsOf). HEAD, while the checkout stands on its main line, which every door keeps it on
// (main-line-lock.ts); the locked branch's own tip once something went around them, so no conversation is cut from or
// rebased onto whatever branch the checkout was moved to. Asked of every repo at every tool call, so the ordinary answer
// is file reads and stats: the latch is kept while the config file is unchanged, and HEAD is read once per change netd
// counts in the checkout (git/feed). Before, it spawned `rev-parse` per repo per tool call: 37% of the daemon's git
// processes on 2026-11-05.

// allow(silent-catch): a config git cannot read locks nothing, which is what a checkout with no main line reads as.
const lockedNow = (dir: string, git: GitRunner): Promise<string | undefined> => latchedMainBranch(dir, git).catch(() => undefined);

/** Whether a shared checkout stands on its main line, as the cheap read above answers it; a no is worth asking git again. */
export const standsOnMainLine = async (dir: string, git: GitRunner = defaultGit): Promise<boolean> => {
    const [current, locked] = await Promise.all([checkedOutBranch(dir), lockedNow(dir, git)]);
    return locked === undefined || current === locked;
};

/**
 * The revision a shared checkout's main line is read at: `HEAD` while it stands on it (or nothing is locked), else the
 * locked branch's ref. A locked branch that no longer exists leaves `HEAD`: there is no other line to read, and the
 * land refuses such a checkout on its own (land/landable.ts).
 */
export const mainLineRev = async (dir: string, git: GitRunner = defaultGit): Promise<string> => {
    const locked = await lockedNow(dir, git);
    if (locked === undefined || (await standsOnMainLine(dir, git))) {
        return "HEAD";
    }
    const ref = `refs/heads/${locked}`;
    const there = await git(dir, ["rev-parse", "-q", "--verify", ref]).then(
        () => true,
        () => false,
    );
    return there ? ref : "HEAD";
};

/** The main line's sha, as headSha reads HEAD's: undefined for an unborn line or no repository at `dir`. */
export const mainLineSha = async (dir: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    const rev = await mainLineRev(dir, git);
    return rev === "HEAD" ? feedHeadSha(dir, git) : (await git(dir, ["rev-parse", "-q", "--verify", rev])).stdout.trim();
};
