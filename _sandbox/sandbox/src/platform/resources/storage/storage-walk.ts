import { lstat, opendir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";

// A bounded, cancellable walk of one tree that never follows a link and never leaves the filesystem it started on. It
// reports what it meets and decides nothing: the scan and the cleaner each bring their own reading of a path.

export interface WalkedFile {
    readonly path: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly nlink: number;
    // `dev:ino`, what tells two links to one file apart from two files.
    readonly inode: string;
}

export interface TreeVisitor<T> {
    // What a folder's contents inherit from it, or `skip` to leave it unwalked.
    readonly folder: (path: string, parent: T) => T | "skip";
    readonly file: (file: WalkedFile, folder: T) => void;
    // Reported, never followed: a running browser's lock is a link to nowhere.
    readonly link?: (path: string, folder: T) => void;
}

export interface WalkLimits {
    readonly signal?: AbortSignal;
    // Epoch milliseconds after which the walk stops where it stands and reports itself incomplete.
    readonly deadline?: number;
    // Folders read at once; each holds one filesystem call in flight, so this bounds the daemon's share of the pool.
    readonly concurrency?: number;
}

export interface WalkOutcome {
    readonly complete: boolean;
    readonly unreadable: number;
}

const DEFAULT_CONCURRENCY = 8;

const codeOf = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

export const abortError = (): DOMException => new DOMException("the storage walk was cancelled", "AbortError");

export const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

// Walks everything below `root`, which the caller has already read as `context`; the root itself is never reported.
export const walkTree = async <T>(root: string, context: T, visitor: TreeVisitor<T>, limits: WalkLimits = {}): Promise<WalkOutcome> => {
    let top: Stats;
    try {
        top = await lstat(root);
    } catch (error) {
        return { complete: true, unreadable: codeOf(error) === "ENOENT" ? 0 : 1 };
    }
    if (!top.isDirectory()) {
        return { complete: true, unreadable: 0 };
    }
    const pending: { readonly dir: string; readonly context: T }[] = [{ dir: root, context }];
    let unreadable = 0;
    let expired = false;
    const halted = (): boolean => {
        expired ||= limits.deadline !== undefined && Date.now() > limits.deadline;
        return expired || limits.signal?.aborted === true;
    };
    const stat = (path: string): Promise<Stats | undefined> =>
        lstat(path).catch((error: unknown) => {
            // Gone between the listing and the look is the ordinary race with a writer, not a read failure.
            unreadable += codeOf(error) === "ENOENT" ? 0 : 1;
            return undefined;
        });
    const visit = async (path: string, inherited: T): Promise<void> => {
        const stats = await stat(path);
        if (stats === undefined) {
            return;
        }
        if (stats.isSymbolicLink()) {
            visitor.link?.(path, inherited);
            return;
        }
        if (stats.isFile()) {
            visitor.file({ path, size: stats.size, mtimeMs: stats.mtimeMs, nlink: stats.nlink, inode: `${stats.dev}:${stats.ino}` }, inherited);
            return;
        }
        // Another filesystem mounted here (a container's layer, a namespace's overlay) is not this volume's to count.
        if (stats.isDirectory() && stats.dev === top.dev) {
            const next = visitor.folder(path, inherited);
            if (next !== "skip") {
                pending.push({ dir: path, context: next });
            }
        }
    };
    const readFolder = async (dir: string, inherited: T): Promise<void> => {
        const handle = await opendir(dir).catch((error: unknown) => {
            unreadable += codeOf(error) === "ENOENT" ? 0 : 1;
            return undefined;
        });
        if (handle === undefined) {
            return;
        }
        for await (const entry of handle) {
            if (halted()) {
                break;
            }
            await visit(join(dir, entry.name), inherited);
        }
    };
    await new Promise<void>((resolve, reject) => {
        let active = 0;
        const pump = (): void => {
            while (active < (limits.concurrency ?? DEFAULT_CONCURRENCY) && !halted()) {
                // Last in, first out: depth first, so the queue stays as short as the tree is deep.
                const next = pending.pop();
                if (next === undefined) {
                    break;
                }
                active += 1;
                readFolder(next.dir, next.context).then(() => {
                    active -= 1;
                    pump();
                }, reject);
            }
            if (active === 0) {
                resolve();
            }
        };
        pump();
    });
    if (limits.signal?.aborted === true) {
        throw abortError();
    }
    return { complete: !expired && pending.length === 0, unreadable };
};
