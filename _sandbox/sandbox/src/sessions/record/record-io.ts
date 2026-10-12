import { dirname } from "node:path";
import { syncDirectories, writeChunksAtomic } from "@intentic/base/fs";

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
// Best effort: a parent this process cannot open, or a filesystem that cannot flush a directory, must not fail a record
// whose bytes already landed.
export const syncParents = (path: string): Promise<void> => syncDirectories([dirname(path)], { upTo: "/" });

// Puts `chunks` at `path` whole and durable before this resolves: written beside it, flushed, renamed over it, its
// name and every directory above it flushed. The one way the record files are replaced, so the three of them cannot
// drift apart. Each chunk is written as the source yields it, so a record is never held whole in memory.
export const writeDurable = async (path: string, chunks: Iterable<Buffer>): Promise<void> => {
    await writeChunksAtomic(path, chunks, undefined, { durable: true, syncUpTo: "/" });
};
