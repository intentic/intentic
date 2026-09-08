// Turns a drop (or file-input pick) into a flat file list with workspace-relative paths, recursing directories via
// webkitGetAsEntry. Roots are captured synchronously before the drag-data store tears down, then walked concurrently to
// finish inside that store's short validity window.

import { IGNORED_DIRS as WORKSPACE_IGNORED_DIRS } from "@intentic/workspace-ignore/constants";

export interface DroppedFile {
    readonly file: File;
    readonly path: string;
}

// No isSymbolicLink flag (Chrome follows symlinks); timeout, visited set and depth cap guard stalls and cycles.
const READ_TIMEOUT_MS = 8000;
const MAX_DEPTH = 64;

// Rejects if the wrapped callback never settles, so one hung entry can't hang the whole walk. Timer clears once the
// real promise settles, so a big drop doesn't leak one per read.
const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`Timed out reading ${label}`)), READ_TIMEOUT_MS))),
        ]);
    } finally {
        clearTimeout(timer!);
    }
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
    withTimeout(new Promise<File>((resolve, reject) => entry.file(resolve, reject)), entry.name);

// readEntries batches children (≤100); call repeatedly until empty, or large folders silently truncate.
const readAllChildren = async (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
        const batch = await withTimeout(new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)), dir.name);
        if (batch.length === 0) {
            return all;
        }
        all.push(...batch);
    }
};

interface WalkContext {
    readonly out: DroppedFile[];
    readonly visited: Set<string>;
    readonly onFile?: (path: string) => void;
    readonly signal?: AbortSignal;
}

// Walks one entry, skipping ignored dirs/secret files; children walk concurrently so output order isn't deterministic.
// `signal` cancels mid-walk; a timed-out or erroring subtree is logged and skipped, never rethrown.
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
            ctx.out.push({ file: await fileOf(entry as FileSystemFileEntry), path });
            ctx.onFile?.(path);
            return;
        }
        if (IGNORED_DIRS.has(entry.name)) {
            return;
        }
        const children = await readAllChildren(entry as FileSystemDirectoryEntry);
        await Promise.all(children.map((child) => walkEntry(child, path, depth + 1, ctx)));
    } catch (error) {
        console.warn(`Skipped ${path} while scanning the drop`, error);
    }
};

const walkRoots = async (roots: readonly FileSystemEntry[], onFile?: (path: string) => void, signal?: AbortSignal): Promise<DroppedFile[]> => {
    const ctx: WalkContext = { out: [], visited: new Set(), onFile, signal };
    await Promise.all(roots.map((entry) => walkEntry(entry, "", 0, ctx)));
    return ctx.out;
};

export interface DropResult {
    readonly files: DroppedFile[];
    // Items webkitGetAsEntry couldn't resolve (symlinks, special files); surfaced so a drop isn't silent.
    readonly skipped: number;
}

export const collectDroppedFiles = async (dataTransfer: DataTransfer, onFile?: (path: string) => void, signal?: AbortSignal): Promise<DropResult> => {
    // Must call webkitGetAsEntry synchronously, while the drop's items are still alive.
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
    if (roots.length > 0) {
        const files = await walkRoots(roots, onFile, signal);
        if (files.length > 0) {
            return { files, skipped };
        }
    }
    // No entries (some sources expose files but not the entry API): fall back to the flat file list.
    const files = Array.from(dataTransfer.files)
        .filter((file) => !isSecretFile(file.name))
        .map((file): DroppedFile => ({ file, path: file.name }));
    return { files, skipped };
};

// File-input pick (button fallback): webkitRelativePath is set when the input has webkitdirectory, keeping a picked
// folder's structure.
export const filesToEntries = (files: FileList): DroppedFile[] =>
    Array.from(files).map((file) => ({ file, path: file.webkitRelativePath !== "" ? file.webkitRelativePath : file.name }));
