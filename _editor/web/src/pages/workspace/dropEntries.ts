// Turn a drag-drop (or a file-input pick) into a flat list of files with workspace-relative paths, recursing
// dropped directories via the webkitGetAsEntry filesystem API. The dropped FileSystemEntry roots are captured
// SYNCHRONOUSLY in the drop handler (before the browser tears down the drag-data store), then the tree is walked
// in PARALLEL — every readEntries/file() call is fired concurrently (Promise.all over a directory's children and
// over the roots), so a deep or multi-directory drop finishes inside the drag store's short validity window rather
// than racing it as a slow sequential DFS would. `onFile` fires as each file is captured, so the caller can show
// live scan progress. Pure — no framework, no network — so it's unit-checkable (scripts/dropEntries.check.mjs).

import { IGNORED_DIRS as WORKSPACE_IGNORED_DIRS } from "@intentic/workspace-ignore/constants";

export interface DroppedFile {
    readonly file: File;
    readonly path: string;
}

// The drag-drop FileSystem Entries API exposes NO isSymbolicLink flag (unlike the server's dirent), and Chrome
// FOLLOWS symlinks — so we can't detect one mid-tree. Instead the walk stays unstallable three ways: a per-call
// timeout (a readEntries/file callback that fires neither success nor error — Chromium does this once the drag
// store's short validity window lapses — can't wedge the whole scan), a visited set on fullPath (breaks symlink
// cycles + avoids re-uploading a followed target), and a depth cap (backstop for a pathological symlink chain).
const READ_TIMEOUT_MS = 8000;
const MAX_DEPTH = 64;

// Reject if the wrapped browser callback never settles, so one hung entry can't hang the whole Promise.all walk.
// The timer is cleared once the real promise settles so a big drop doesn't leave one live timer per file/dir read.
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

// Directories never worth uploading: generated/cache/dependency trees the workspace tree hides anyway, so
// uploading them file-by-file over HTTP is pure waste (the cause of multi-minute stalls). Reuses the daemon's
// IGNORED_DIRS (@intentic/workspace-ignore) as the single source, minus `.git`/`.tmp`: a dropped repo keeps its
// `.git` so it stays connected to its remote, and `.tmp` scratch never shows up in a drop.
const IGNORED_DIRS = new Set([...WORKSPACE_IGNORED_DIRS].filter((dir) => dir !== ".git" && dir !== ".tmp"));

// Secrets a drop leaves behind on purpose: shipping your local credentials into the sandbox is not what dragging
// a project in meant. This is the client's own choice, not a mirror of a daemon rule — the daemon refuses only
// its own control-plane files (isControlPlanePath: owner/members/capabilities + the provider token dirs under
// /work/.intentic), and would happily write every name below. `.env.example` is safe (placeholder values only).
const isSecretFile = (name: string): boolean =>
    name === ".secrets.json" || name === "claude.json" || name === "capabilities.json" || (name.startsWith(".env") && name !== ".env.example");

// The one `.git` a drop must leave behind, keyed on the DESTINATION (workspace-root-relative, targetDir already
// joined) rather than the drop's own shape. /work is itself a repo whose git dir lives on /history, so /work/.git
// is that repo's pointer FILE — dropping a repo's CONTENTS at the root, rather than its folder, aims a directory
// at it. Unlike the rest of this module's policy the daemon agrees here (isControlPlanePath covers the root .git),
// so sending them anyway buys nothing but a panel full of 404s. The very same `.git/config` entry is legitimate the
// moment the drop lands ON a folder — there it becomes <folder>/.git/config, a nested repo keeping its metadata.
export const isRootGitPath = (destination: string): boolean => destination === ".git" || destination.startsWith(".git/");

// Promisify FileSystemFileEntry.file(cb, errCb).
const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
    withTimeout(new Promise<File>((resolve, reject) => entry.file(resolve, reject)), entry.name);

// readEntries returns a directory's children in BATCHES (≤100), so it must be called repeatedly until it comes
// back empty — a single call silently truncates large folders.
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

// Walk one dropped entry, accumulating files under their slash-joined relative path and skipping ignored dirs +
// secret files. Children (and sibling subtrees, via walkRoots) are walked CONCURRENTLY so all the underlying reads
// fire promptly — order in `ctx.out` is therefore not deterministic, which is fine (each file carries its own path).
// `signal` lets a cancel stop a big walk part-way (checked before each file read and directory descent). A subtree
// that times out or errors (a hung/unreadable entry, a followed symlink) is LOGGED and SKIPPED, never rethrown, so
// one bad branch can't reject the whole Promise.all and freeze the scan on "Scanning" forever.
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
    // Dropped items (kind "file") that webkitGetAsEntry couldn't turn into an entry — symlinks or special files
    // Chrome refuses to expose. Surfaced so a drop of e.g. only a symlink shows "skipped" instead of silence.
    readonly skipped: number;
}

export const collectDroppedFiles = async (dataTransfer: DataTransfer, onFile?: (path: string) => void, signal?: AbortSignal): Promise<DropResult> => {
    // Capture the entry roots SYNCHRONOUSLY — webkitGetAsEntry must be called while the drop's items are alive; the
    // FileSystemEntry objects it returns stay usable just long enough for the parallel walk below to drain them.
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

// A file-input pick (button fallback). `webkitRelativePath` is set when the input has `webkitdirectory`, so a
// picked folder keeps its structure; a plain multi-file pick lands each at its basename.
export const filesToEntries = (files: FileList): DroppedFile[] =>
    Array.from(files).map((file) => ({ file, path: file.webkitRelativePath !== "" ? file.webkitRelativePath : file.name }));
