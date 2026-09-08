// Splits a drop into bounded upload chunks, pure and framework-free (see scripts/uploadChunking.check.mjs).
// Each chunk is its own request, so a stall costs one chunk, not the whole tree, and stays short enough to
// avoid intermediary timeouts.

// 200 files / 32 MB per chunk keeps a request within Cloudflare's ~100s origin timeout even on a slow uplink.
const CHUNK_FILES = 200;
export const CHUNK_BYTES = 32 * 1024 * 1024;

// When two entries target the same path (dragged from different folders), only the last occurrence survives;
// survivor order is preserved.
export const dedupeByPath = <T>(items: readonly T[], pathOf: (item: T) => string): T[] => {
    const seen = new Set<string>();
    const kept: T[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] as T;
        const path = pathOf(item);
        if (seen.has(path)) {
            continue;
        }
        seen.add(path);
        kept.push(item);
    }
    return kept.toReversed();
};

// Greedily fills chunks up to both the file-count and byte caps. An item larger than the byte cap gets its own
// chunk, since it can't fit anywhere smaller and streams rather than buffers.
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
