import { open } from "node:fs/promises";
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
