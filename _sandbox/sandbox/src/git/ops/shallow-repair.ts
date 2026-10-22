import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { commonDirOf, gitDirOf } from "../git-dir.js";

/* A WORKSPACE REPO CUT SHALLOW WHILE ITS WHOLE HISTORY IS STILL HERE IS MADE WHOLE AGAIN (2026-10-21).

   One command anybody in the sandbox may run, `git fetch --depth N` in a full clone (an agent narrowing a fetch to save
   time does), writes a `shallow` file that hides every commit behind the cut from every reader: `git log` and `blame`
   end there, and the daily gc (git-gc.ts) counts the hidden history as unreachable and prunes it once its grace runs
   out. A computer syncing the workspace follows the repo's history with a fetch (the machine agent's git bridge), and a
   clone that does not hold the cut commit cannot take it, so the history there stopped where the cut began. intentic's
   own repo was cut at 2026-10-04 this way with all 4,792 commits still on disk, and only the file in the way.

   No flow of Intentic's makes a workspace repo shallow, and a clone made shallow on purpose (`clone --depth`) has nothing
   behind its cut, so a cut with the whole of its history still behind it is one nobody wanted. That is checked, never
   assumed: every object reachable from the commits behind the cut must be here (`rev-list --objects --quiet` fails on
   the first missing one), and only then does the file go, under git's own lock for it. A cut with history missing
   behind it is left as it is and said once per cut; nothing here fetches. Hourly, with the rest of maintenance, so a cut
   is undone long before the gc's grace could take what it hid. */

// A commit id as the `shallow` file lists it: sha-1, or sha-256 in a repository that uses it.
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type ShallowRepair = "whole" | "repaired" | "kept";

// The cuts already found to have history missing behind them, by repository, so the walk is not paid again every hour
// for a cut nothing here can undo. A new cut is a new key.
const keptCuts = new Map<string, string>();

// The commits behind the cut: each root's own parents, read off the commit as stored, which the shallow file does not
// hide from `cat-file`. Undefined when a root itself cannot be read.
const parentsBehind = async (dir: string, roots: readonly string[], git: GitRunner): Promise<string[] | undefined> => {
    const parents: string[] = [];
    for (const root of roots) {
        // one small read per root; a shallow file lists a handful
        // allow(silent-catch): a root that cannot be read is a cut this cannot vouch for, which the caller keeps and says.
        const raw = await git(dir, ["cat-file", "-p", root]).catch(() => undefined);
        if (raw === undefined) {
            return undefined;
        }
        parents.push(...[...raw.stdout.matchAll(/^parent ([0-9a-f]+)$/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));
    }
    return parents;
};

// Whether every object reachable from `parents` is here: git's own connectivity test, quiet, failing on the first gap.
const wholeBehind = async (dir: string, parents: readonly string[], git: GitRunner): Promise<boolean> =>
    parents.length === 0 || (await git(dir, ["rev-list", "--objects", "--quiet", ...parents, "--"]).then(() => true, () => false));

// Removes the file under `shallow.lock`, the lock git itself takes to write it; a lock somebody holds is a fetch writing
// it right now, which this leaves to finish and asks about again next hour.
const dropShallowFile = async (file: string): Promise<boolean> => {
    // allow(silent-catch): a lock that exists (or cannot be made) is a writer this leaves alone until the next pass.
    const lock = await open(`${file}.lock`, "wx").catch(() => undefined);
    if (lock === undefined) {
        return false;
    }
    try {
        await rm(file, { force: true });
        return true;
    } finally {
        await lock.close();
        await rm(`${file}.lock`, { force: true });
    }
};

const repair = async (dir: string, repo: string, logger: Pick<Logger, "info" | "warn">, git: GitRunner): Promise<ShallowRepair> => {
    const gitDir = await gitDirOf(dir);
    if (gitDir === undefined) {
        return "whole";
    }
    const file = join(await commonDirOf(gitDir), "shallow");
    const listed = await readFile(file, "utf8").catch(undefinedIfMissing);
    const roots = (listed ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => SHA.test(line));
    if (roots.length === 0) {
        return "whole";
    }
    const cut = roots.toSorted().join(" ");
    if (keptCuts.get(file) === cut) {
        return "kept";
    }
    const parents = await parentsBehind(dir, roots, git);
    if (parents === undefined || !(await wholeBehind(dir, parents, git))) {
        keptCuts.set(file, cut);
        logger.info({ repo, roots: roots.length }, "git: this repo is shallow and its history behind the cut is not all here, so it stays shallow");
        return "kept";
    }
    if (!(await dropShallowFile(file))) {
        return "kept";
    }
    keptCuts.delete(file);
    logger.warn(
        { repo, roots: roots.length },
        "git: this repo had been cut shallow (a `git fetch --depth` in it does that) while its whole history was still here; the cut is undone",
    );
    return "repaired";
};

// Never throws: a repo this cannot read is left as it is, and asked about again next time.
export const repairShallow = async (
    dir: string,
    repo: string,
    logger: Pick<Logger, "info" | "warn">,
    git: GitRunner = defaultGit,
): Promise<ShallowRepair> => {
    try {
        return await repair(dir, repo, logger, git);
    } catch (error) {
        logger.warn({ err: error, repo }, "git: could not check this repo for a shallow cut");
        return "kept";
    }
};
