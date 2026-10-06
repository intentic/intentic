import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// A successful write may consume only part of its buffer. Never acknowledge a frame or blob until every byte landed.
interface Writer {
    readonly write: (bytes: Buffer, offset: number, length: number) => Promise<{ readonly bytesWritten: number }>;
}

export const writeAll = async (handle: Writer, bytes: Buffer): Promise<void> => {
    let offset = 0;
    while (offset < bytes.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each write resumes where the previous one stopped.
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
        if (bytesWritten === 0) {
            throw new Error("record write made no progress");
        }
        offset += bytesWritten;
    }
};

// File datasync does not persist a new name. Sync its directory and ancestors, including any directories mkdir just
// created, before publishing a durable record or removing its predecessor. Also safe when another writer made them.
export const syncParents = async (path: string): Promise<void> => {
    let directory = dirname(resolve(path));
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- children are persisted before their parents.
        const handle = await open(directory, "r");
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
            await handle.sync();
        } finally {
            // oxlint-disable-next-line eslint/no-await-in-loop -- release each directory before opening the next.
            await handle.close();
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return;
        }
        directory = parent;
    }
};

// Puts `chunks` at `path` whole and durable before this resolves: written to a temporary beside it, flushed, renamed
// over it, its name persisted. Never a half-written file at `path`, and no temporary left behind by any failure, the
// write's or the rename's. The one way the record files are replaced, so the three of them cannot drift apart.
export const writeDurable = async (path: string, chunks: Iterable<Buffer>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    // Unique per write: worker threads share the process id, and two writers may store beside the same path.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, "w");
        try {
            for (const bytes of chunks) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- chunks go down in order.
                await writeAll(handle, bytes);
            }
            await handle.datasync();
        } finally {
            await handle.close();
        }
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
    await syncParents(path);
};
