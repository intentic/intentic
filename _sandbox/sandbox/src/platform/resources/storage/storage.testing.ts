import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StorageRoots } from "./storage-catalog.js";

// Throwaway volumes for the storage suites: a workspace, a history, and a folder outside both that no clean may reach.
// Every tree lives under the system temp dir and is removed by `removeStorageTrees`, never anything else.

export interface StorageTree {
    readonly roots: StorageRoots;
    // Beside the roots, never inside one: what a link out of the volumes points at.
    readonly outside: string;
}

const made: string[] = [];

export const storageTree = async (): Promise<StorageTree> => {
    // Real paths, as the daemon resolves its roots: a temp dir behind a link would read as a link in every parent.
    const base = await realpath(await mkdtemp(join(tmpdir(), "intentic-storage-")));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history") };
    const outside = join(base, "outside");
    await Promise.all([roots.workspace, roots.history, outside].map((dir) => mkdir(dir, { recursive: true })));
    return { roots, outside };
};

// Writes `bytes` bytes at `path`, parents included, last modified `ageMs` before `now`.
export const plant = async (path: string, bytes: number, now: number, ageMs = 0): Promise<string> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "x".repeat(bytes));
    const at = new Date(now - ageMs);
    await utimes(path, at, at);
    return path;
};

export const removeStorageTrees = async (): Promise<void> => {
    for (const dir of made.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
};
