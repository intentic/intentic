import { describe, expect, it } from "vitest";
import { dedupeByPath } from "./uploadChunking";

/* Guards the upload queue's same-destination invariant: a single drop may contain two entries aimed at the same
 * path (same-named files dragged from different folders). If both reached the parallel XHR pool their offset
 * writes would interleave into one destination file — dedupeByPath must keep exactly one entry per path, and it
 * must be the LAST one (later write wins, matching overwrite intent). chunkItems is covered by
 * scripts/uploadChunking.check.mjs. */

const entry = (path: string, tag: string) => ({ path, tag });

describe(`dedupeByPath`, () => {
    it(`passes unique paths through in order`, () => {
        const items = [entry(`a.txt`, `1`), entry(`b/c.txt`, `2`), entry(`d.txt`, `3`)];
        expect(dedupeByPath(items, (item) => item.path)).toEqual(items);
    });

    it(`keeps only the last occurrence of a duplicated path`, () => {
        const items = [entry(`a.txt`, `first`), entry(`b.txt`, `keep`), entry(`a.txt`, `last`)];
        expect(dedupeByPath(items, (item) => item.path)).toEqual([entry(`b.txt`, `keep`), entry(`a.txt`, `last`)]);
    });

    it(`preserves survivor order by the position of the last occurrence`, () => {
        const items = [entry(`x`, `1`), entry(`y`, `2`), entry(`x`, `3`), entry(`z`, `4`), entry(`y`, `5`)];
        expect(dedupeByPath(items, (item) => item.path).map((item) => item.tag)).toEqual([`3`, `4`, `5`]);
    });

    it(`handles empty input`, () => {
        expect(dedupeByPath([], () => ``)).toEqual([]);
    });
});
