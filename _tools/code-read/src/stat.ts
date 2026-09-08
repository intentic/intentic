import type { CodeAnalysis } from "./analysis.js";
import { highlightLangFor } from "./lang-for-path.js";

// Added/removed line counts with comments stripped, for the review row shown by default; computed from the same code
// analysis the diff pane renders so the two cannot disagree. Cached per text+language.

export interface LineStat {
    readonly additions: number;
    readonly deletions: number;
}

// Cell budget for the diff table; past it the caller falls back to git's raw counts instead of paying for it.
const MAX_CELLS = 1_000_000;

// Splits like git counts lines: a trailing newline ends the last line rather than starting an empty one.
const splitLines = (text: string): string[] => {
    if (text === ``) {
        return [];
    }
    const lines = text.split(`\n`);
    if (lines.at(-1) === ``) {
        lines.pop();
    }
    return lines;
};

// Length of the longest common subsequence only, no alignment; two rolling rows instead of a full table and backtrack.
const commonLength = (before: readonly string[], after: readonly string[]): number => {
    let previous = new Uint32Array(after.length + 1);
    let current = new Uint32Array(after.length + 1);
    for (let i = 1; i <= before.length; i++) {
        for (let j = 1; j <= after.length; j++) {
            current[j] = before[i - 1] === after[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
        }
        // previous/current swap; column 0 stays zero and is never written on either row.
        [previous, current] = [current, previous];
    }
    return previous[after.length]!;
};

/** Added/removed line counts between two texts, or undefined when they're too dissimilar to be worth diffing. */
export const lineStat = (before: string, after: string): LineStat | undefined => {
    const old = splitLines(before);
    const now = splitLines(after);
    // Trim the matching head and tail first so only the differing middle reaches the table.
    let start = 0;
    while (start < old.length && start < now.length && old[start] === now[start]) {
        start++;
    }
    let endOld = old.length;
    let endNow = now.length;
    while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) {
        endOld--;
        endNow--;
    }
    const removed = old.slice(start, endOld);
    const added = now.slice(start, endNow);
    if (removed.length * added.length > MAX_CELLS) {
        return undefined;
    }
    const common = commonLength(removed, added);
    return { additions: added.length - common, deletions: removed.length - common };
};

/**
 * Reads one side with comments stripped; the app runs this in a worker, the daemon in-process. Undefined when there's
 * no grammar for the file.
 */
export type Analyze = (text: string, lang: string | undefined) => Promise<CodeAnalysis | undefined>;

/** Same counts with every comment stripped from both sides, or undefined when the file can't be stripped. */
export const codeLineStat = async (before: string, after: string, path: string, analyze: Analyze): Promise<LineStat | undefined> => {
    // Resolved exactly as the diff pane resolves it; none above the highlight cap, where it shows the file whole.
    const lang = highlightLangFor(path, Math.max(before.length, after.length), after === `` ? before : after);
    const [old, now] = await Promise.all([analyze(before, lang), analyze(after, lang)]);
    // Undefined mirrors the pane's own fallback (verbatim render); the caller then trusts git's counts.
    if (old === undefined || now === undefined) {
        return undefined;
    }
    return lineStat(old.code.text, now.code.text);
};
