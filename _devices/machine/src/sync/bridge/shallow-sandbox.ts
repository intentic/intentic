import { HISTORY_ROOT } from "@intentic/constants";
import type { BridgeExec } from "./git-bridge.js";

/* WHETHER A FULL CLONE CAN FOLLOW A SHALLOW SANDBOX (2026-10-21). A sandbox repo turns shallow by one command anybody
   in it may run (`git fetch --depth N` in a full clone writes a `shallow` file that hides everything behind it), and the
   bridge then has two cases that look alike and are not:

   - the clone already has every commit the sandbox's history stops at. Its own history reaches below them, so the new
     commits connect to ones it holds, git asks for no shallow boundary, and the fetch is an ordinary one;
   - the clone lacks one of them. Git receives the whole pack, then refuses the ref ("shallow roots are not allowed to be
     updated") while still exiting 0, and keeps the pack: every try leaves another copy of the history on the drive.

   The bridge used to hold every full clone behind a shallow sandbox, the first case too, for a day doubling to a week:
   rog's clone of intentic, which held the sandbox's cut commit and the two weeks of history above it, stopped
   following on 2026-10-18 and was told to wait 96 hours. Now only the second case holds, and asking which case it is
   costs two small reads over the alias and a lookup per listed commit, so the hold is asked again within the hour. */

// A commit id as the `shallow` file lists it: sha-1, or sha-256 in a repository that uses it.
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const gitDirOf = (repo: string): string => `${HISTORY_ROOT}/gits/${encodeURIComponent(repo)}`;

// Whether the sandbox's copy is shallow, asked of its git dir; undefined when it could not be asked.
const sandboxIsShallow = async (exec: BridgeExec, alias: string, repo: string): Promise<boolean | undefined> => {
    const said = (await exec.run("ssh", ["-o", "BatchMode=yes", alias, "git", `--git-dir=${gitDirOf(repo)}`, "rev-parse", "--is-shallow-repository"]))?.trim();
    return said === "true" ? true : said === "false" ? false : undefined;
};

// The commits a shallow sandbox's history stops at, as its `shallow` file lists them; undefined when it would not say.
const sandboxShallowRoots = async (exec: BridgeExec, alias: string, repo: string): Promise<readonly string[] | undefined> => {
    const listed = await exec.run("ssh", ["-o", "BatchMode=yes", alias, "cat", `${gitDirOf(repo)}/shallow`]);
    const roots = listed
        ?.split("\n")
        .map((line) => line.trim())
        .filter((line) => SHA.test(line));
    return roots === undefined || roots.length === 0 ? undefined : roots;
};

/**
 * Whether the sandbox's history is cut at a commit the full clone in `dir` lacks: the one case its fetch cannot take.
 * Asked before fetching, never after, since git refuses that ref only once the whole pack is on the drive. A sandbox that
 * could not be asked is not held (the fetch goes, as it always did); one that is shallow and would not say where it is
 * cut is, since unknown is the case that leaves a pack behind.
 */
export const cutBeyondClone = async (exec: BridgeExec, alias: string, repo: string, dir: string): Promise<boolean> => {
    if ((await sandboxIsShallow(exec, alias, repo)) !== true) {
        return false;
    }
    const roots = await sandboxShallowRoots(exec, alias, repo);
    if (roots === undefined) {
        return true;
    }
    for (const root of roots) {
        // one lookup each, local and cheap; the first missing one answers
        if ((await exec.run("git", ["cat-file", "-e", `${root}^{commit}`], dir)) === undefined) {
            return true;
        }
    }
    return false;
};
