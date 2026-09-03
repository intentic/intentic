import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { lockShrinkage } from "@intentic/constants/contract-shrink";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* THE WIRE-CONTRACT SHRINK, DETECTED WHERE THE MESSAGE IS WRITTEN, not where the push is refused.
 *
 * This repo's own gate (_tools/checks/contract-shrink.mjs) blocks a push whose contract lock lost a surface
 * with no `!` commit or `Breaking-Note:` trailer anywhere in the range. Five times running, the gate fired
 * AFTER the shrinking commit had already landed on the main line, and five times a session wrote the missing
 * declaration on its own branch, where it can never matter, because landing applies PATCHES to the main
 * working tree and an empty declaring commit contributes no patch. The one place a declaration can enter the
 * range is the commit the user files, and the one thing that writes that commit's draft is the landing
 * describer (agents/landed-subject.ts). So the detection runs here, mechanically, and the draft it feeds is
 * FORCED to carry the `!` and the Breaking-Note rather than asked to consider them: the model judges what the
 * sentence should say, never whether one is owed.
 *
 * The comparison itself is @intentic/constants/contract-shrink, the one copy the gate reads too (by relative
 * path, since it runs before `pnpm install`), so "the draft declared it" and "the gate wanted it declared" are
 * the same judgment by construction. */
// Any file with this basename is read as a wire-contract lock: one JSON document whose top-level keys are
// exported schema names (see _sandbox/sandbox-contract/src/contract-lock.ts for the format and why it exists).
const CONTRACT_LOCK_NAME = `contract.lock.json`;

/* What a commit recording `paths` in `dir` would remove from the wire contract: the working tree's lock against
 * HEAD's, for every claimed path that IS a lock. HEAD rather than any merge-base on purpose, this describes
 * THE COMMIT ABOUT TO BE FILED, and a shrink already committed undeclared is the gate's to name, not this
 * draft's to confess. A lock that is new at HEAD removes nothing; a lock unreadable in the tree is left to the
 * contract-lock test. Never throws: every caller is a draft that must not fail a land. */
export const claimedContractShrink = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<string[]> => {
    const removed: string[] = [];
    for (const path of paths.filter((candidate) => basename(candidate) === CONTRACT_LOCK_NAME)) {
        const base = await git(dir, [`show`, `HEAD:${path}`])
            .then((result) => result.stdout)
            .catch(() => undefined);
        const head = base === undefined ? undefined : await readFile(join(dir, path), `utf8`).catch(() => undefined);
        if (base !== undefined && head !== undefined) {
            removed.push(...lockShrinkage(base, head));
        }
    }
    return removed;
};
