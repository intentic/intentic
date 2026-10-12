import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, chmod, chown, mkdir, open, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { keyedLock } from "../async.js";
import { errnoCode } from "../errors.js";

// Reachability, not shape: `access`, so a path this process cannot reach answers false, the same as a missing one.
export const pathExists = async (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

// Three answers where pathExists gives two: only ENOENT says the path is gone. Any other failure (EACCES, EIO, a mount
// not up yet, and ENOTDIR too, unlike isMissing: a file standing where a directory belongs is damage, not an absence)
// says nothing about it, so a caller that archives or reaps on "absent" must read it as unknown.
export const pathPresence = async (path: string): Promise<"present" | "absent" | "unknown"> => {
    try {
        await access(path);
        return "present";
    } catch (error) {
        return errnoCode(error) === "ENOENT" ? "absent" : "unknown";
    }
};

// Keyed by resolved path, so two handles on one file share one queue; the lock forgets a path once its queue drains.
const fileLock = keyedLock<string>();

// Runs `task` once every task queued earlier on the same path has settled, whoever queued it; a failed task still ends its turn.
export const queueOnFile = <T>(path: string, task: () => Promise<T>): Promise<T> => fileLock(resolve(path), task);

// Windows refuses a rename over a file another process holds open for a moment; these codes are that moment, not a fault.
const TRANSIENT_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 25;

// Retried on Windows only: anywhere else these codes are a permission or a mount point, which waiting never changes.
// For any rename that replaces a file someone may have open (an editor, an indexer, antivirus), not only this module's.
export const renameOver = async (from: string, to: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            if (process.platform !== "win32" || attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME.has((error as NodeJS.ErrnoException).code ?? "")) {
                throw error;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded retry of one rename, serial by definition
            await sleep(RENAME_RETRY_MS);
        }
    }
};

// Per write, not per process: two writes of one path in flight at once must not share a staging file, and neither may
// two worker threads (one process id between them) or two containers writing one volume (each may be pid 1), so the
// name is random rather than counted.
// Beside the target, so the rename stays on one filesystem; the leading dot keeps a watcher's path table from
// prefix-matching the target.
export const stagingOf = (path: string): string => join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);


type FileHandle = Awaited<ReturnType<typeof open>>;

// A write call may take only part of its buffer; nothing is published until every byte landed.
const writeAll = async (handle: FileHandle, bytes: Uint8Array): Promise<void> => {
    for (let offset = 0; offset < bytes.byteLength; ) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each write resumes where the previous one stopped
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
        if (bytesWritten === 0) {
            throw new Error("file write made no progress");
        }
        offset += bytesWritten;
    }
};

// The staging file, whole. With `durable`, its bytes on the disk before the rename publishes them: for a file whose loss
// locks someone out or loses the only way back (an owner file, a conversion journal), where a power cut right after an
// ordinary write can leave a name pointing at nothing.
const writeStaged = async (staging: string, write: (handle: FileHandle) => Promise<void>, mode: number | undefined, durable: boolean): Promise<void> => {
    const handle = await open(staging, "w", mode);
    try {
        await write(handle);
        if (durable) {
            await handle.sync();
        }
    } finally {
        await handle.close();
    }
};

// Flushes a directory's entries (a rename or link just made in it) to the disk; best effort, and a no-op on Windows.
export const syncDirectory = async (dir: string): Promise<void> => await syncDirectories([dir]);

export interface SyncDirectoriesOptions {
    // Also flush every directory above each one, up to and including this one: a directory mkdir just made is itself
    // only an entry in its parent. "/" walks to the root of the filesystem.
    readonly upTo?: string;
}

// The directories `dirs` names, each once, and with `upTo` every ancestor between each and it, children first.
const directoriesToSync = (dirs: Iterable<string>, upTo: string | undefined): string[] => {
    const top = upTo === undefined ? undefined : resolve(upTo);
    const seen = new Set<string>();
    for (const dir of dirs) {
        for (let directory = resolve(dir); !seen.has(directory); directory = dirname(directory)) {
            seen.add(directory);
            const parent = dirname(directory);
            if (top === undefined || directory === top || parent === directory || !isUnder(top, directory)) {
                break;
            }
        }
    }
    return [...seen];
};

// Lexical and segment-wise; a private copy of the rule `contained.ts` exports, kept here so this module stays a leaf.
const isUnder = (top: string, path: string): boolean => path === top || path.startsWith(top.endsWith("/") ? top : `${top}/`);

// Flushes each directory's entries to the disk once, best effort: a directory gone since has nothing to flush, one this
// process cannot open (EACCES on a parent) or a filesystem that refuses to flush a directory (EINVAL) has no better
// answer to give, and Windows cannot open a directory for it at all and orders the rename itself. Never throws: the
// write it follows has already happened, and failing it now would report a loss that did not occur.
export const syncDirectories = async (dirs: Iterable<string>, options: SyncDirectoriesOptions = {}): Promise<void> => {
    if (process.platform === "win32") {
        return;
    }
    for (const directory of directoriesToSync(dirs, options.upTo)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- children are flushed before their parents, one handle at a time
        await syncOne(directory);
    }
};

const syncOne = async (directory: string): Promise<void> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(directory, "r");
        await handle.sync();
    } catch {
        // allow(silent-catch): best effort by contract, see syncDirectories.
    } finally {
        // allow(silent-catch): a close that fails leaves nothing this caller could act on.
        await handle?.close().catch(() => undefined);
    }
};

export interface WriteOptions {
    // Flushed to the disk before and after the rename (writeStaged, then the target's directory); for the few files
    // whose loss costs more than the write's time, never for a file written on every turn.
    readonly durable?: boolean;
    // With `durable`: also flush every directory above the target up to and including this one, for a write that may
    // have just created them (see syncDirectories).
    readonly syncUpTo?: string;
    // Who owns the new file: a replace is a new inode, so a file someone else owned would otherwise come back owned by
    // this process. Only a process allowed to give a file away (root) can name another user here.
    readonly owner?: { readonly uid: number; readonly gid: number };
}

// Staged, renamed over `path`, the staging file removed on any failure, and with `durable` the directories flushed.
const replaceAtomically = async (path: string, write: (handle: FileHandle) => Promise<void>, mode: number | undefined, options: WriteOptions): Promise<void> => {
    const staging = stagingOf(path);
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeStaged(staging, write, mode, options.durable === true);
        if (options.owner !== undefined) {
            await chown(staging, options.owner.uid, options.owner.gid);
        }
        // After the owner: a chown clears setuid and setgid bits, which an exact mode must keep.
        if (mode !== undefined) {
            await chmod(staging, mode);
        }
        await renameOver(staging, path);
    } finally {
        // Already gone after the rename; after a failure, a partial file no later write would ever reuse.
        await rm(staging, { force: true });
    }
    if (options.durable === true) {
        await syncDirectories([dirname(path)], options.syncUpTo === undefined ? {} : { upTo: options.syncUpTo });
    }
};

// A reader sees the old file or the new one whole. `mode` is exact, the umask not applied; without one, the umask decides.
export const writeFileAtomic = async (path: string, content: string | Uint8Array, mode?: number, options: WriteOptions = {}): Promise<void> =>
    await replaceAtomically(path, async (handle) => await handle.writeFile(content), mode, options);

// writeFileAtomic for content produced a chunk at a time (a transcript record of many megabytes, compressed frame by
// frame): each chunk is written as the source yields it, never joined into a copy of the whole first. A source that
// throws part-way fails the write, and nothing is published.
export const writeChunksAtomic = async (path: string, chunks: Iterable<Uint8Array>, mode?: number, options: WriteOptions = {}): Promise<void> =>
    await replaceAtomically(
        path,
        async (handle) => {
            for (const chunk of chunks) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- chunks go down in order
                await writeAll(handle, chunk);
            }
        },
        mode,
        options,
    );

// writeFileAtomic for a write that must land before the process exits (an exit hook, a failure recorded on the way
// out), where nothing can be awaited. Into a directory that already exists: a caller for whom a missing one means
// something (a volume not mounted) learns it from the throw instead of being handed a new one. It neither flushes to
// the disk nor waits out Windows' brief refusal of a rename: both take time such a caller does not have.
export const writeFileAtomicSync = (path: string, content: string | Uint8Array, mode?: number): void => {
    const staging = stagingOf(path);
    try {
        writeFileSync(staging, content, mode === undefined ? undefined : { mode });
        if (mode !== undefined) {
            chmodSync(staging, mode);
        }
        renameSync(staging, path);
    } finally {
        rmSync(staging, { force: true });
    }
};

// An OS-assigned port nothing on `host` holds right now, taken by binding one and letting go.
export const freePort = (host = "127.0.0.1"): Promise<number> =>
    new Promise((resolvePort, rejectPort) => {
        const server = createServer();
        server.on("error", rejectPort);
        server.listen(0, host, () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => (port === 0 ? rejectPort(new Error("no free port")) : resolvePort(port)));
        });
    });
