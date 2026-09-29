// `--pages` for `fileq render`: `3`, `1-3`, `2,5,7-9`, and `7-` for "to the end". Numbers count from 1, the way a
// reader and the checks' own `slide 3` / `page 7` count.

export interface PageRange {
    readonly from: number;
    /** Undefined for an open range (`7-`), which runs to the last page. */
    readonly to: number | undefined;
}

export class BadPages extends Error {}

/** A `--pages` value as ranges; throws BadPages on anything else. */
export const parsePages = (raw: string): PageRange[] => {
    const parts = raw.split(",").map((part) => part.trim());
    return parts.map((part) => {
        const match = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(part);
        if (match === null) {
            throw new BadPages(`--pages takes numbers and ranges like 1-3,5,7-; "${part}" is neither`);
        }
        const from = Number(match[1]);
        const to = match[2] === undefined ? from : match[2] === "" ? undefined : Number(match[2]);
        if (from < 1 || (to !== undefined && to < from)) {
            throw new BadPages(`--pages ${part}: pages count from 1, and a range runs forward`);
        }
        return { from, to };
    });
};

/** The page numbers the ranges name within 1..total, ascending, each once. */
export const pagesWithin = (ranges: readonly PageRange[], total: number): number[] => {
    const pages = new Set<number>();
    for (const range of ranges) {
        for (let page = range.from; page <= Math.min(range.to ?? total, total); page += 1) {
            pages.add(page);
        }
    }
    return [...pages].toSorted((a, b) => a - b);
};

/** Consecutive runs of sorted page numbers, for a rasterizer that takes a first and a last page. */
export const runsOf = (pages: readonly number[]): [number, number][] => {
    const runs: [number, number][] = [];
    for (const page of pages) {
        const last = runs.at(-1);
        if (last !== undefined && last[1] === page - 1) {
            last[1] = page;
        } else {
            runs.push([page, page]);
        }
    }
    return runs;
};

/** `1-3, 5` for a message. */
export const describePages = (pages: readonly number[]): string =>
    runsOf(pages)
        .map(([from, to]) => (from === to ? String(from) : `${from}-${to}`))
        .join(", ");
