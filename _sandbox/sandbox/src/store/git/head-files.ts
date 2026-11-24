import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { commonDirOf, gitDirOf } from "./git-dir.js";

// HEAD'S SHA, AND A BRANCH'S, OFF THE FILES GIT KEEPS THEM IN, for the readers that ask it of every repo at every tool
// call (the mid-turn catch-up, the land standing) and of every conversation on every roster read. The feed keeps a
// reading per change it counts in the checkout, but the workspace's own checkout counts a change at nearly every write
// anyone makes in it, so its HEAD went to git about fifteen times a minute (2026-11-24). What git itself reads: HEAD,
// the loose ref it names, else packed-refs. Anything this does not know how to read (a symbolic ref chain, a reftable
// store, an unborn branch, no checkout) answers undefined, and the caller asks git, so the answer is git's in every
// case this reads and exact in each: a ref is replaced by rename, so a read sees the old file or the new one.

const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Refs a linked worktree keeps for itself rather than in the common dir; everything else is shared.
const PER_WORKTREE = /^refs\/(?:bisect|worktree|rewritten)\//;

const packedRef = async (commonDir: string, name: string): Promise<string | undefined> => {
    const packed = await readFile(join(commonDir, "packed-refs"), "utf8").catch(undefinedIfMissing);
    for (const line of packed?.split("\n") ?? []) {
        const [sha, ref] = line.split(" ");
        if (ref === name && sha !== undefined && OBJECT_NAME.test(sha)) {
            return sha;
        }
    }
    return undefined;
};

// A ref's sha in `store`: its loose file, else its packed-refs line; undefined where neither names an object outright.
const refIn = async (store: string, name: string): Promise<string | undefined> => {
    const loose = (await readFile(join(store, name), "utf8").catch(undefinedIfMissing))?.trim();
    if (loose !== undefined) {
        return OBJECT_NAME.test(loose) ? loose : undefined;
    }
    return packedRef(store, name);
};

/** HEAD's sha read off the checkout's files, or undefined where git must say (see above). */
export const headShaFromFiles = async (checkout: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(checkout);
    if (gitDir === undefined) {
        return undefined;
    }
    const head = (await readFile(join(gitDir, "HEAD"), "utf8").catch(undefinedIfMissing))?.trim();
    if (head === undefined) {
        return undefined;
    }
    if (OBJECT_NAME.test(head)) {
        return head;
    }
    const name = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (name === undefined) {
        return undefined;
    }
    return refIn(PER_WORKTREE.test(name) ? gitDir : await commonDirOf(gitDir), name);
};

/** A shared ref's sha (`refs/heads/…`, never a per-worktree one) off the repository's files, or undefined where git
 *  must say: a ref neither its loose file nor packed-refs holds is git's to look for, so an absence is never read here. */
export const refShaFromFiles = async (checkout: string, name: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(checkout);
    return gitDir === undefined || PER_WORKTREE.test(name) ? undefined : refIn(await commonDirOf(gitDir), name);
};
