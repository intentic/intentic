import { createHash, randomUUID } from "node:crypto";
import { undefinedIfMissing } from "@intentic/base/errors";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

// Tool outputs too long to keep in a record's rows, stored once each under the hash of their text, zstd-compressed: a
// fork shares its source's, and a page reads none of them. Named by content, so a write that finds the name taken is
// already done.

export const blobsRoot = (historyRoot: string): string => join(historyRoot, "blobs");

// The file a hash lives in, two hex digits of directory so none holds more than a few thousand.
const blobPath = (historyRoot: string, hash: string): string => join(blobsRoot(historyRoot), hash.slice(0, 2), `${hash}.zst`);

const HASH = /^[0-9a-f]{64}$/u;

export const hashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Writes under way, by path: the same text twice in one turn is stored once.
const writing = new Map<string, Promise<void>>();

const write = async (path: string, text: string): Promise<void> => {
    // Found, it is named again now: a sweep reads a blob's age as the last time anything named it.
    const now = new Date();
    if (await utimes(path, now, now).then(() => true, () => false)) {
        return;
    }
    await mkdir(dirname(path), { recursive: true });
    // Unique per write, so two processes storing the same text never share a temporary name.
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "w");
    try {
        await handle.write(zstdCompressSync(Buffer.from(text, "utf8"), { params: { [constants.ZSTD_c_compressionLevel]: 6, [constants.ZSTD_c_checksumFlag]: 1 } }));
        await handle.datasync();
    } finally {
        await handle.close();
    }
    // Content-addressed: whichever of two racing writers renames last leaves the same bytes behind.
    await rename(temporary, path);
};

// Stores `text`, durable before this resolves, and answers its hash.
export const putBlob = async (historyRoot: string, text: string): Promise<string> => {
    const hash = hashOf(text);
    const path = blobPath(historyRoot, hash);
    let pending = writing.get(path);
    if (pending === undefined) {
        pending = write(path, text).finally(() => writing.delete(path));
        writing.set(path, pending);
    }
    await pending;
    return hash;
};

// The text stored under `hash`, or undefined when there is none.
export const getBlob = async (historyRoot: string, hash: string): Promise<string | undefined> => {
    if (!HASH.test(hash)) {
        return undefined;
    }
    const bytes = await readFile(blobPath(historyRoot, hash)).catch(undefinedIfMissing);
    return bytes === undefined ? undefined : zstdDecompressSync(bytes).toString("utf8");
};

// What a sweep may not remove though no record names it yet: a blob a write in this process is about to name.
export type BlobInUse = (hash: string) => boolean;

// Removes one unnamed blob unless it turns out to be in use: set aside first, so a writer that looks for it after `inUse`
// was asked finds nothing and writes it again, and one that looked before is seen by `inUse`, which puts it back.
const sweepOne = async (path: string, hash: string, inUse: BlobInUse): Promise<boolean> => {
    const aside = `${path}.${randomUUID()}.swept`;
    if (!(await rename(path, aside).then(() => true, () => false))) {
        return false;
    }
    if (inUse(hash)) {
        await rename(aside, path);
        return false;
    }
    await rm(aside, { force: true });
    return true;
};

// Removes every blob no record names, not in use, and not named within `graceMs`: a blob is written before the row
// naming it, and another process's writes are seen only through a blob's age. Leftovers of crashed writes and sweeps go
// too once as old.
export const sweepBlobs = async (historyRoot: string, referenced: ReadonlySet<string>, inUse: BlobInUse, now: number, graceMs: number): Promise<number> => {
    let removed = 0;
    for (const shard of await readdir(blobsRoot(historyRoot)).catch((): string[] => [])) {
        const dir = join(blobsRoot(historyRoot), shard);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one shard at a time keeps the sweep off the shared I/O pool.
        for (const name of await readdir(dir).catch((): string[] => [])) {
            const path = join(dir, name);
            const hash = name.replace(/\.zst$/u, "");
            const blob = HASH.test(hash);
            if (blob && (referenced.has(hash) || inUse(hash))) {
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
            const info = await stat(path).catch(undefinedIfMissing);
            if (info === undefined || now - info.mtimeMs <= graceMs) {
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
            if (blob ? await sweepOne(path, hash, inUse) : await rm(path, { force: true }).then(() => true)) {
                removed += 1;
            }
        }
    }
    return removed;
};
