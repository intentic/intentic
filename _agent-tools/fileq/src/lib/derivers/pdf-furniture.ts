// Running headers, footers and page numbers: the lines a printed document repeats on every page, which cost tokens on
// each one and split the text they interrupt. Adapted from docurip's PDF text cleaner (MIT,
// https://github.com/MokuDev/docurip), keeping only its structural rules. Its footnote and "copyright"-line removal
// delete content, so they are left out.
// A line is furniture when it sits near a page edge AND recurs at that same edge on most pages (verbatim, or with its
// numbers counting with the pages), or it is a page number. Content is never judged by what it says.

// How many non-blank lines at each edge of a page can be furniture.
const EDGE_LINES = 3;
// Share of pages an edge line must recur on. Below MIN_PAGES there is too little evidence to call anything running.
const RECUR_SHARE = 0.6;
const MIN_PAGES = 4;

// A bare number is only a page number when it counts with the pages (see folioOffset); these shapes say so themselves.
const PAGE_NUMBER = [
    /^page\s+\d{1,4}(?:\s+of\s+\d{1,4})?$/i, // Page 7, Page 7 of 90
    /^\d{1,4}\s*(?:of|\/)\s*\d{1,4}$/i, // 7 of 90, 7/90
    /^[-–—]\s*\d{1,4}\s*[-–—]$/, // - 7 -
];

export interface Destripped {
    readonly pages: string[];
    /** Lines removed, summed over every page. */
    readonly removed: number;
    /** The most frequent running line, for the note: a reader should see what was taken. */
    readonly example: string | undefined;
}

// Two signatures per line: its exact text (a title, a date that never changes), and its text with every number
// rewritten as its offset from the page index, so "Page 7" on the seventh page and "Page 8" on the eighth agree.
// Blanking digits outright would also match "Question 3" and "Question 4", which are content.
const signaturesOf = (line: string, page: number): string[] => {
    const exact = line.replaceAll(/\s+/g, " ").trim().toLowerCase();
    return [`=${exact}`, `~${exact.replaceAll(/\d+/g, (n) => `#${Number(n) - page}`)}`];
};

interface Edges {
    readonly top: number[];
    readonly bottom: number[];
}

const edgesOf = (lines: readonly string[]): Edges => {
    const filled = lines.flatMap((line, index) => (line.trim() === "" ? [] : [index]));
    // At most half a page's lines sit in each edge zone, so a line is a header or a footer, never both.
    const edge = Math.min(EDGE_LINES, Math.floor(filled.length / 2));
    return edge === 0 ? { top: [], bottom: [] } : { top: filled.slice(0, edge), bottom: filled.slice(-edge) };
};

// Headers and footers are counted apart: a line is running only where it recurs at the same edge.
const recurringAt = (split: readonly string[][], side: keyof Edges, needed: number): Set<string> => {
    const recurrence = new Map<string, number>();
    for (const [page, lines] of split.entries()) {
        // A signature counts once per page, however many edge lines carry it.
        for (const signature of new Set(edgesOf(lines)[side].flatMap((index) => signaturesOf(lines[index] ?? "", page)))) {
            recurrence.set(signature, (recurrence.get(signature) ?? 0) + 1);
        }
    }
    // A bare number is folioOffset's call, so a data column's repeated value is not caught here.
    return new Set(
        [...recurrence].filter(([signature, count]) => count >= needed && !/^[=~]#?-?\d+$/.test(signature)).map(([signature]) => signature),
    );
};

const BARE_NUMBER = /^\d{1,4}$/;

// The offset between page index and printed number that most pages' bare edge numbers agree on, when enough do.
// A table's last value at a page edge does not count with the pages, so it never matches.
const folioOffset = (split: readonly string[][], needed: number): number | undefined => {
    const votes = new Map<number, number>();
    split.forEach((lines, page) => {
        const offsets = new Set(
            [...edgesOf(lines).top, ...edgesOf(lines).bottom]
                .map((index) => (lines[index] ?? "").trim())
                .filter((line) => BARE_NUMBER.test(line))
                .map((line) => Number(line) - page),
        );
        for (const offset of offsets) {
            votes.set(offset, (votes.get(offset) ?? 0) + 1);
        }
    });
    const [offset, count] = [...votes].toSorted((a, b) => b[1] - a[1])[0] ?? [0, 0];
    return count >= needed ? offset : undefined;
};

/** Strips running headers, footers and page numbers from per-page text. Pages keep their count and order. */
export const stripRunningFurniture = (pages: readonly string[]): Destripped => {
    if (pages.length < MIN_PAGES) {
        return { pages: [...pages], removed: 0, example: undefined };
    }
    const split = pages.map((page) => page.split("\n"));
    const needed = Math.ceil(pages.length * RECUR_SHARE);
    const headers = recurringAt(split, "top", needed);
    const footers = recurringAt(split, "bottom", needed);
    const offset = folioOffset(split, needed);
    const seen = new Map<string, number>();
    let removed = 0;
    const out = split.map((lines, page) => {
        const { top, bottom } = edgesOf(lines);
        const furniture =
            (running: Set<string>) =>
            (index: number): boolean => {
                const line = (lines[index] ?? "").trim();
                const folio = offset !== undefined && BARE_NUMBER.test(line) && Number(line) - page === offset;
                return folio || signaturesOf(line, page).some((signature) => running.has(signature)) || PAGE_NUMBER.some((shape) => shape.test(line));
            };
        const drop = new Set([...top.filter(furniture(headers)), ...bottom.filter(furniture(footers))]);
        for (const index of drop) {
            const line = (lines[index] ?? "").trim();
            if (!/^\d+$/.test(line)) {
                seen.set(line, (seen.get(line) ?? 0) + 1);
            }
        }
        removed += drop.size;
        return lines
            .filter((_, index) => !drop.has(index))
            .join("\n")
            .trim();
    });
    const example = [...seen].toSorted((a, b) => b[1] - a[1])[0]?.[0];
    return { pages: out, removed, example };
};
