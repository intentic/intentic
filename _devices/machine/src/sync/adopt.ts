import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import { ignoreExpressions, ignoreMatcher, type Listed, type Listing } from "./project-files.js";
import { hashFile, walkLocal } from "./project-local.js";
import type { SandboxCopy } from "./project-remote.js";

// A FOLDER THAT ALREADY HAD FILES, SET UP AS A SANDBOX'S COPY. A fresh two-way-safe session has no history, so Mutagen
// reads every difference between the two copies as an edit on each side: a file only this device has is CREATED in the
// sandbox (a file an agent deleted there since comes back), and a file both have with different bytes is a conflict that
// stops syncing it. Setting up again into the folder an earlier pairing filled is exactly that case, measured on a
// dogfooding PC (2026-10-08): seven deleted files written back into the sandbox and 117 conflicts, one per file the
// sandbox had moved on from while the folder sat unsynced.
//
// So setup says the sandbox is the copy that counts, once, before the first session: every file of this folder that the
// sandbox does not hold byte for byte is MOVED to a sibling folder (`<folder>.before-sync-<when>`), never deleted, and
// the session then starts from two copies that agree wherever both have a file. What the sandbox has that the folder
// lacks simply arrives. Files that already match stay where they are, so a folder that was nearly current costs no
// download.

// What has to move aside: every regular file the sandbox lacks or holds differently, and anything that is a file on one
// side and something else (a link) on the other. A link on both sides is left to Mutagen, which compares its target.
// Pure over two listings; a local file whose size matches carries a hash, one whose size differs need not.
export const setAsidePaths = (here: Listing, sandbox: Listing): string[] => {
    const moving: string[] = [];
    for (const [path, mine] of here) {
        const theirs = sandbox.get(path);
        if (theirs === undefined || differs(mine, theirs)) {
            moving.push(path);
        }
    }
    return moving.toSorted();
};

const differs = (mine: Listed, theirs: Listed): boolean => {
    if (mine === "other" || theirs === "other") {
        return mine !== theirs;
    }
    return mine.size !== theirs.size || mine.hash === undefined || mine.hash !== theirs.hash;
};

// The sibling folder the moved files keep their relative paths under, named for the minute it was made.
export const asidePrefix = (localDir: string): string => `${localDir.replace(/[\\/]+$/, "")}.before-sync-`;
export const asideFolder = (localDir: string, at: Date): string =>
    `${asidePrefix(localDir)}${at.toISOString().slice(0, 16).replace("T", "-").replace(":", "")}`;

export interface AdoptOutcome {
    readonly moved: number;
    readonly movedTo?: string;
}

export interface AdoptArgs {
    readonly localDir: string;
    readonly sandbox: SandboxCopy;
    readonly ignores: readonly string[];
    readonly log: (line: string) => void;
    readonly now?: Date;
}

// The folder made to agree with the sandbox's copy, by moving rather than deleting. An empty or missing folder is
// nothing to do and never asks the sandbox anything. Throws when the sandbox's copy cannot be listed: a session must not
// start over a folder that was not compared.
export const adoptFolder = async ({ localDir, sandbox, ignores, log, now = new Date() }: AdoptArgs): Promise<AdoptOutcome> => {
    if ((await stat(localDir).catch(undefinedIfMissing))?.isDirectory() !== true) {
        return { moved: 0 };
    }
    const sized = await walkLocal({ root: localDir, ignored: ignoreMatcher(ignores), cached: new Map(), wantsHash: () => false });
    if (sized.listing.size === 0) {
        return { moved: 0 };
    }
    log(`${localDir} already holds ${plural(sized.listing.size, "file")}: comparing it with the sandbox's copy before syncing starts.`);
    const theirs = await sandbox.list(ignoreExpressions(ignores));
    // Only a file whose size matches the sandbox's is read: a different size already says it differs.
    const here = new Map<string, Listed>();
    for (const [path, mine] of sized.listing) {
        const counterpart = theirs.get(path);
        if (mine !== "other" && counterpart !== undefined && counterpart !== "other" && counterpart.size === mine.size) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time keeps a large folder's read bounded
            const hash = await hashFile(join(localDir, path)).catch(() => undefined);
            here.set(path, hash === undefined ? "other" : { size: mine.size, hash });
            continue;
        }
        here.set(path, mine);
    }
    const moving = setAsidePaths(here, theirs);
    if (moving.length === 0) {
        log(`${localDir} already matches the sandbox's copy wherever both have a file.`);
        return { moved: 0 };
    }
    const aside = asideFolder(localDir, now);
    for (const path of moving) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential moves keep the order a log can follow
        await moveFile(join(localDir, path), join(aside, path));
    }
    await pruneEmptied(localDir, moving);
    log(
        `${plural(moving.length, "file")} in ${localDir} differed from the sandbox's copy or were not in it, so they were moved to ${aside} rather than synced into the sandbox. The sandbox's versions arrive in their place.`,
    );
    return { moved: moving.length, movedTo: aside };
};

// A rename where the two folders share a disk, which a sibling nearly always does; a copy then an unlink where they
// do not.
const moveFile = async (from: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true });
    try {
        await rename(from, to);
    } catch (error) {
        if (errnoCode(error) !== "EXDEV") {
            throw error;
        }
        await copyFile(from, to);
        await unlink(from);
    }
};

// Folders the moves left empty, removed from the deepest up and never the root: an empty folder here that the sandbox
// lacks would otherwise be created there.
const pruneEmptied = async (root: string, moved: readonly string[]): Promise<void> => {
    const folders = new Set<string>();
    for (const path of moved) {
        for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
            folders.add(path.slice(0, at));
        }
    }
    for (const folder of [...folders].toSorted((a, b) => b.split("/").length - a.split("/").length)) {
        const full = join(root, folder);
        // oxlint-disable-next-line eslint/no-await-in-loop -- deepest first, so a parent is read after its children went
        const left = await readdir(full).catch(() => undefined);
        if (left !== undefined && left.length === 0) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above
            await rmdir(full).catch(() => undefined);
        }
    }
};
