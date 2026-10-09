// Turns a drop (or file-input pick) into a flat file list with workspace-relative paths, recursing directories via
// webkitGetAsEntry. Roots are captured synchronously before the drag-data store tears down, then walked concurrently to
// finish inside that store's short validity window.

import { withTimeout } from "@intentic/base/async";
import { IGNORED_DIRS as WORKSPACE_IGNORED_DIRS } from "@intentic/workspace-ignore/constants";

export interface DroppedFile {
    readonly file: File;
    readonly path: string;
}

// No isSymbolicLink flag (Chrome follows symlinks); timeout, visited set and depth cap guard stalls and cycles. The
// timeout is per read, so one entry whose callback never comes cannot hang the whole walk.
const READ_TIMEOUT_MS = 8000;
const MAX_DEPTH = 64;
// Reads outstanding at once. The browser answers them one after another, so a walk that asked for a 10,000-file
// folder's files all at once started 10,000 timeouts together, and the ones answered last ran out while still queued:
// files missing from the upload with nothing said. Bounded, each timeout measures one read.
const MAX_READS = 16;

type Gate = <T>(task: () => Promise<T>) => Promise<T>;

// At most `limit` tasks running, the rest waiting in arrival order. Read from a moving head: shift() on an array of
// tens of thousands of waiters is quadratic.
const gate = (limit: number): Gate => {
    let active = 0;
    const waiting: ((() => void) | undefined)[] = [];
    let head = 0;
    const release = (): void => {
        if (head === waiting.length) {
            active -= 1;
            return;
        }
        // The slot passes straight to the next waiter, so nothing can slip in between.
        const wake = waiting[head];
        waiting[head] = undefined;
        head += 1;
        if (head === waiting.length) {
            waiting.length = 0;
            head = 0;
        }
        wake?.();
    };
    return async (task) => {
        if (active < limit) {
            active += 1;
        } else {
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
        try {
            return await task();
        } finally {
            release();
        }
    };
};

// Daemon's IGNORED_DIRS minus `.git`/`.tmp`: a dropped repo keeps its `.git`, staying connected to its remote.
const IGNORED_DIRS = new Set([...WORKSPACE_IGNORED_DIRS].filter((dir) => dir !== ".git" && dir !== ".tmp"));

// Client-side choice, not a daemon rule (the daemon would happily write these); `.env.example` is exempt, placeholder
// values only.
const isSecretFile = (name: string): boolean =>
    name === ".secrets.json" || name === "claude.json" || name === "capabilities.json" || (name.startsWith(".env") && name !== ".env.example");

// Checked against the destination, not the drop's shape: /work/.git is a pointer file, so a repo dropped at the root
// would aim a directory at it. Fine once nested under a folder (a nested repo's own .git).
export const isRootGitPath = (destination: string): boolean => destination === ".git" || destination.startsWith(".git/");

// Promisify FileSystemFileEntry.file(cb, errCb).
const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
    withTimeout(new Promise<File>((resolve, reject) => entry.file(resolve, reject)), READ_TIMEOUT_MS, `Timed out reading ${entry.name}`);

// readEntries batches children (≤100); call repeatedly until empty, or large folders silently truncate.
const readAllChildren = async (dir: FileSystemDirectoryEntry, read: Gate): Promise<FileSystemEntry[]> => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
        const batch = await read(() =>
            withTimeout(
                new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)),
                READ_TIMEOUT_MS,
                `Timed out reading ${dir.name}`,
            ),
        );
        if (batch.length === 0) {
            return all;
        }
        all.push(...batch);
    }
};

interface WalkContext {
    readonly out: DroppedFile[];
    readonly visited: Set<string>;
    readonly read: Gate;
    readonly onFile?: (path: string, size: number) => void;
    readonly signal?: AbortSignal;
    // Entries that failed or timed out, each counted once however much lay under it.
    unreadable: number;
}

// Walks one entry, skipping ignored dirs/secret files; children walk concurrently so output order isn't deterministic.
// `signal` cancels mid-walk; a timed-out or erroring subtree is counted and skipped, never rethrown.
const walkEntry = async (entry: FileSystemEntry, prefix: string, depth: number, ctx: WalkContext): Promise<void> => {
    if (ctx.signal?.aborted || ctx.visited.has(entry.fullPath) || depth > MAX_DEPTH) {
        return;
    }
    ctx.visited.add(entry.fullPath);
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    try {
        if (entry.isFile) {
            if (isSecretFile(entry.name)) {
                return;
            }
            const file = await ctx.read(() => fileOf(entry as FileSystemFileEntry));
            ctx.out.push({ file, path });
            ctx.onFile?.(path, file.size);
            return;
        }
        if (IGNORED_DIRS.has(entry.name)) {
            return;
        }
        const children = await readAllChildren(entry as FileSystemDirectoryEntry, ctx.read);
        await Promise.all(children.map((child) => walkEntry(child, path, depth + 1, ctx)));
    } catch (error) {
        if (ctx.signal?.aborted) {
            return;
        }
        ctx.unreadable += 1;
        console.warn(`Skipped ${path} while scanning the drop`, error);
    }
};

const walkRoots = async (
    roots: readonly FileSystemEntry[],
    onFile?: (path: string, size: number) => void,
    signal?: AbortSignal,
): Promise<{ readonly files: DroppedFile[]; readonly unreadable: number }> => {
    const ctx: WalkContext = { out: [], visited: new Set(), read: gate(MAX_READS), onFile, signal, unreadable: 0 };
    await Promise.all(roots.map((entry) => walkEntry(entry, "", 0, ctx)));
    return { files: ctx.out, unreadable: ctx.unreadable };
};

export interface DropResult {
    readonly files: DroppedFile[];
    // Items webkitGetAsEntry couldn't resolve (symlinks, special files); surfaced so a drop isn't silent.
    readonly skipped: number;
    // Files and folders the walk found but could not read (a read that failed or never answered); everything under
    // an unreadable folder is left out with it.
    readonly unreadable: number;
}

// A paste reads the same way as a drop: Chromium registers pasted OS files in the same isolated file system, so a
// copied folder resolves to a directory entry. Its bare File (in `files`) is a zero-byte stand-in named after the folder.
export const collectDroppedFiles = async (
    dataTransfer: DataTransfer,
    onFile?: (path: string, size: number) => void,
    signal?: AbortSignal,
): Promise<DropResult> => {
    // Must call webkitGetAsEntry synchronously, while the drop's (or paste's) items are still alive.
    const roots: FileSystemEntry[] = [];
    let skipped = 0;
    for (const item of Array.from(dataTransfer.items)) {
        if (item.kind !== "file") {
            continue;
        }
        const entry = item.webkitGetAsEntry?.();
        if (entry !== null && entry !== undefined) {
            roots.push(entry);
        } else {
            skipped += 1;
        }
    }
    // Resolved entries are the truth even when the walk yields nothing (an empty or all-ignored folder): the flat list
    // would turn each folder into an empty file named after it.
    if (roots.length > 0) {
        return { ...(await walkRoots(roots, onFile, signal)), skipped };
    }
    // No entries (a pasted screenshot is image data, not a file on disk; some sources lack the entry API): fall back to
    // the flat file list.
    const files = Array.from(dataTransfer.files)
        .filter((file) => !isSecretFile(file.name))
        .map((file): DroppedFile => ({ file, path: file.name }));
    return { files, skipped, unreadable: 0 };
};

// File-input pick (button fallback): webkitRelativePath is set when the input has webkitdirectory, keeping a picked
// folder's structure.
export const filesToEntries = (files: FileList): DroppedFile[] =>
    Array.from(files).map((file) => ({ file, path: file.webkitRelativePath !== "" ? file.webkitRelativePath : file.name }));
