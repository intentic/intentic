import { access, chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

// Keyed by resolved path, so two handles on one file share one queue; holds only paths with work queued.
const queues = new Map<string, Promise<void>>();

// Runs `task` once every task queued earlier on the same path has settled, whoever queued it; a failed task still ends its turn.
export const queueOnFile = <T>(path: string, task: () => Promise<T>): Promise<T> => {
    const key = resolve(path);
    const next = (queues.get(key) ?? Promise.resolve()).then(task);
    const settled: Promise<void> = next
        .then(
            () => undefined,
            () => undefined,
        )
        .then(() => {
            if (queues.get(key) === settled) {
                queues.delete(key);
            }
        });
    queues.set(key, settled);
    return next;
};

// Windows refuses a rename over a file another process holds open for a moment; these codes are that moment, not a fault.
const TRANSIENT_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 25;

// Retried on Windows only: anywhere else these codes are a permission or a mount point, which waiting never changes.
const renameOver = async (from: string, to: string): Promise<void> => {
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

// Per write, not per process: two writes of one path in flight at once must not share a staging file.
let writes = 0;

// The bytes on the disk before the rename publishes them, and the rename itself flushed with its directory: for a file
// whose loss locks someone out or loses the only way back (an owner file, a conversion journal), where a power cut
// right after an ordinary write can leave a name pointing at nothing. A directory cannot be opened for this on Windows,
// which orders the rename itself.
const writeDurably = async (staging: string, content: string | Uint8Array, mode: number | undefined): Promise<void> => {
    const handle = await open(staging, "w", mode);
    try {
        await handle.writeFile(content);
        await handle.sync();
    } finally {
        await handle.close();
    }
};

const syncDirectory = async (dir: string): Promise<void> => {
    if (process.platform === "win32") {
        return;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(dir, "r");
        await handle.sync();
    } catch {
        // allow(silent-catch): the rename already happened; a filesystem that cannot flush a directory has no better answer to give.
    } finally {
        await handle?.close();
    }
};

export interface WriteOptions {
    // Flushed to the disk before and after the rename (writeDurably); for the few files whose loss costs more than the
    // write's time, never for a file written on every turn.
    readonly durable?: boolean;
}

// A reader sees the old file or the new one whole. `mode` is exact, the umask not applied; without one, the umask decides.
export const writeFileAtomic = async (path: string, content: string | Uint8Array, mode?: number, options: WriteOptions = {}): Promise<void> => {
    writes += 1;
    // The leading dot keeps a watcher's path table from prefix-matching the target.
    const staging = join(dirname(path), `.${basename(path)}.${process.pid}.${writes}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    try {
        if (options.durable === true) {
            await writeDurably(staging, content, mode);
        } else {
            await writeFile(staging, content, mode === undefined ? undefined : { mode });
        }
        if (mode !== undefined) {
            await chmod(staging, mode);
        }
        await renameOver(staging, path);
        if (options.durable === true) {
            await syncDirectory(dirname(path));
        }
    } finally {
        // Already gone after the rename; after a failure, a partial file no later write would ever reuse.
        await rm(staging, { force: true });
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
