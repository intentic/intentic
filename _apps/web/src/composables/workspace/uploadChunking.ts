// Split a drop into bounded upload chunks — pure and framework-free (unit-checkable, see
// scripts/uploadChunking.check.mjs). Each chunk becomes its own request in useUploadQueue, so a stall or reset
// costs one chunk (retried), not the whole tree, and every request stays short enough to dodge intermediary
// timeouts (e.g. Cloudflare's ~100s origin cap).

// ponytail: 200 files / 32 MB per chunk keeps a request a few seconds even on a slow uplink — well under
// Cloudflare's ~100s origin timeout — so a chunk never sits long enough to be reset. Tune if resets persist.
export const CHUNK_FILES = 200;
export const CHUNK_BYTES = 32 * 1024 * 1024;

// Greedily fill chunks up to BOTH caps. A single item larger than the byte cap forms its own chunk (it can't fit
// anywhere smaller, and it still streams — never buffered), so one big binary never blocks the rest of the drop.
export const chunkItems = <T extends { readonly size: number }>(items: readonly T[]): T[][] => {
    const chunks: T[][] = [];
    let current: T[] = [];
    let bytes = 0;
    for (const item of items) {
        if (current.length > 0 && (current.length >= CHUNK_FILES || bytes + item.size > CHUNK_BYTES)) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(item);
        bytes += item.size;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
};
