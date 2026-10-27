import { Binary } from "../../fixture/git/gitSeeds";
import type { Body } from "./gitGraph";

// A three-way merge of one file, the way git's own lands most changes: what `theirs` did to `base`, applied to `ours`,
// hunk by hunk, as long as `ours` left the lines around each hunk as `base` had them. Anything else is a conflict. This
// is what lets a rebase, a pull, a cherry-pick or a revert carry an edit onto a file the other side also changed.

/** The merged file, or `undefined`'s stand-in: a conflict git would stop on. */
export const CONFLICTED = Symbol(`conflicted`);

const lines = (text: string): string[] => (text === `` ? [] : text.replace(/\n$/u, ``).split(`\n`));

// For each line of `a`, the index of the line of `b` an LCS pairs it with, or -1.
const pairs = (a: readonly string[], b: readonly string[]): number[] => {
    const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            const row = table[i] ?? [];
            row[j] = a[i] === b[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
        }
    }
    const paired = Array.from({ length: a.length }, () => -1);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            paired[i] = j;
            i += 1;
            j += 1;
        } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
            i += 1;
        } else {
            j += 1;
        }
    }
    return paired;
};

interface Hunk {
    /** The base lines [from, to) it replaces. */
    readonly from: number;
    readonly to: number;
    readonly with: readonly string[];
}

// The hunks that turn `base` into `next`: between two paired lines, what `base` lost and what `next` has instead.
const hunks = (base: readonly string[], next: readonly string[]): Hunk[] => {
    const paired = pairs(base, next);
    const found: Hunk[] = [];
    let i = 0;
    let j = 0;
    while (i < base.length || j < next.length) {
        if (i < base.length && paired[i] === j) {
            i += 1;
            j += 1;
            continue;
        }
        const from = i;
        while (i < base.length && paired[i] === -1) {
            i += 1;
        }
        const until = i < base.length ? (paired[i] ?? next.length) : next.length;
        found.push({ from, to: i, with: next.slice(j, until) });
        j = until;
    }
    return found;
};

const mergeText = (base: string, ours: string, theirs: string): string | typeof CONFLICTED => {
    const baseLines = lines(base);
    const ourLines = lines(ours);
    const where = pairs(baseLines, ourLines);
    const merged = [...ourLines];
    // Bottom up, so an applied hunk never shifts the lines of one still to come.
    for (const hunk of hunks(baseLines, lines(theirs)).toReversed()) {
        // The hunk's own lines and one line of context either side must still be where `base` had them.
        const span = Array.from({ length: hunk.to - hunk.from + 2 }, (_unused, at) => hunk.from - 1 + at).filter((at) => at >= 0 && at < baseLines.length);
        const mapped = span.map((at) => where[at] ?? -1);
        if (mapped.some((at) => at === -1) || mapped.some((at, index) => index > 0 && at !== (mapped[index - 1] ?? 0) + 1)) {
            return CONFLICTED;
        }
        const start = hunk.from < baseLines.length ? (where[hunk.from] ?? 0) : ourLines.length;
        const anchor = hunk.from === 0 ? 0 : (where[hunk.from - 1] ?? -1) + 1;
        const at = hunk.to > hunk.from ? start : anchor;
        merged.splice(at, hunk.to - hunk.from, ...hunk.with);
    }
    return merged.length === 0 ? `` : `${merged.join(`\n`)}\n`;
};

/** `theirs`' change to `base`, carried onto `ours`; absent sides are files added or deleted. */
export const merge3 = (base: Body | undefined, ours: Body | undefined, theirs: Body | undefined): Body | undefined | typeof CONFLICTED => {
    if (ours === base || ours === theirs) {
        return theirs;
    }
    if (theirs === base) {
        return ours;
    }
    if (base === undefined || ours === undefined || theirs === undefined || base instanceof Binary || ours instanceof Binary || theirs instanceof Binary) {
        return CONFLICTED;
    }
    return mergeText(base, ours, theirs);
};
