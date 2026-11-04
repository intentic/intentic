import { defaultGit, type GitRunner } from "@intentic/base/git";
import { checkedOutBranch } from "../store/git/git-dir.js";
import { headSha } from "./changes/changes.js";
import { lockedBranchOf } from "./main-line-lock.js";

// WHERE A SHARED CHECKOUT'S MAIN LINE IS READ, for what cuts a conversation from it and syncs one onto it
// (worktrees.ts composableHead, sync.ts). HEAD, while the checkout stands on its main line, which every door keeps it
// on (main-line-lock.ts); the locked branch's own tip once something went around them, so no conversation is cut from
// or rebased onto whatever branch the checkout was moved to. Asked of every repo at every sync, so the ordinary answer
// costs two file reads and a remembered config value, no spawn.

// How long a latched main line is reused: the config moves only when a person edits it by hand.
const LOCKED_TTL_MS = 30_000;
const latched = new Map<string, { readonly locked: string | undefined; readonly at: number }>();

const lockedNow = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    const hit = latched.get(dir);
    if (hit !== undefined && Date.now() - hit.at < LOCKED_TTL_MS) {
        return hit.locked;
    }
    // allow(silent-catch): a config git cannot read locks nothing, which is what a checkout with no main line reads as.
    const locked = await lockedBranchOf(dir, git).catch(() => undefined);
    latched.set(dir, { locked, at: Date.now() });
    return locked;
};

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
    return rev === "HEAD" ? headSha(dir, git) : (await git(dir, ["rev-parse", "-q", "--verify", rev])).stdout.trim();
};
