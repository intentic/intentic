import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import type { IgnoreScope } from "@intentic/workspace-ignore";
import { within } from "./paths.js";
import { scopeAt } from "./walk.js";

// The files a search or a lookup reads, found the way the explorer finds them (walk.ts): breadth first, a folder's
// .gitignore and the ignored folders (node_modules, build output) skipped unless asked for, a version history never
// entered. A link is read only as a file that stays inside the folder; a linked folder is not entered, so no walk goes
// round in a loop or out of the folder. Bounded by a count and a clock, since a folder on the user's disk can be their
// whole home directory.

export interface SweptFile {
    // Root-relative, forward slashes: the path every answer speaks in.
    readonly path: string;
    // Where its bytes are, with no link left in the way.
    readonly abs: string;
}

export interface SweepBounds {
    // The subtree to look in, as segments below the root; empty for the whole folder.
    readonly dir: readonly string[];
    readonly includeIgnored: boolean;
    readonly maxFiles: number;
    // Whether the time for the walk is up.
    readonly over: () => boolean;
    // Whether a found file is one the caller wants: an `include` pattern, a name.
    readonly wanted: (path: string) => boolean;
}

export interface Swept {
    readonly files: readonly SweptFile[];
    // Stopped by a bound before the folder was all looked at.
    readonly cut: boolean;
}

interface Folder {
    readonly abs: string;
    readonly rel: string;
    readonly scope: IgnoreScope;
}

// A version history is never searched, even with the ignored folders let in; Intentic's own records only where the
// file API refuses them.
const closed = (name: string, path: string): boolean => name === `.git` || isLockedWorkspacePath(path);

// allow(silent-catch): each of these failing is a fact about the entry (gone, unreadable, dangling): nothing to read.
const quietly = <T>(read: Promise<T>): Promise<T | undefined> => read.catch(() => undefined);

// A linked entry as a file to read: its real path when it is a file inside the root.
const linkedFile = async (root: string, abs: string): Promise<string | undefined> => {
    const real = await quietly(realpath(abs));
    const found = real === undefined || !within(root, real) ? undefined : await quietly(stat(real));
    return found?.isFile() === true ? real : undefined;
};

// One folder's entries in name order: its files, and its folders to look in next.
const listed = async (root: string, folder: Folder, bounds: SweepBounds): Promise<{ files: SweptFile[]; folders: Folder[] }> => {
    const scope = await quietly(folder.scope.descend(folder.abs, folder.rel));
    const dirents: Dirent[] = scope === undefined ? [] : ((await quietly(readdir(folder.abs, { withFileTypes: true }))) ?? []);
    const files: SweptFile[] = [];
    const folders: Folder[] = [];
    for (const dirent of dirents.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = folder.rel === `` ? dirent.name : `${folder.rel}/${dirent.name}`;
        const abs = join(folder.abs, dirent.name);
        if (scope === undefined || closed(dirent.name, path) || (!bounds.includeIgnored && scope.isIgnored(dirent.name, path, dirent.isDirectory()))) {
            continue;
        }
        if (dirent.isDirectory()) {
            folders.push({ abs, rel: path, scope });
        } else if (dirent.isFile() && bounds.wanted(path)) {
            files.push({ path, abs });
        } else if (dirent.isSymbolicLink() && bounds.wanted(path)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- links are few, and each is resolved before the next is listed
            const real = await linkedFile(root, abs);
            if (real !== undefined) {
                files.push({ path, abs: real });
            }
        }
    }
    return { files, folders };
};

// Every file under `bounds.dir` the caller wants, shallowest first, until a bound stops the walk.
export const sweep = async (root: string, bounds: SweepBounds): Promise<Swept> => {
    const start = await scopeAt(root, bounds.dir);
    const startAbs = await quietly(realpath(join(root, ...bounds.dir)));
    if (start === undefined || startAbs === undefined || !within(root, startAbs) || (start.ignored && !bounds.includeIgnored)) {
        return { files: [], cut: false };
    }
    const files: SweptFile[] = [];
    let level: Folder[] = [{ abs: startAbs, rel: bounds.dir.join(`/`), scope: start.scope }];
    while (level.length > 0) {
        const next: Folder[] = [];
        for (const folder of level) {
            if (files.length >= bounds.maxFiles || bounds.over()) {
                return { files: files.slice(0, bounds.maxFiles), cut: true };
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- breadth first by design: a level lists before the next, under one bound
            const found = await listed(root, folder, bounds);
            files.push(...found.files);
            next.push(...found.folders);
        }
        level = next;
    }
    return { files: files.slice(0, bounds.maxFiles), cut: files.length > bounds.maxFiles };
};
