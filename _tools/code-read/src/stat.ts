import { keepsAny, sameStrip, STRIP_START, stripLines } from "./analysis.js";
import { highlightLangFor } from "./lang-for-path.js";
import { type Grammars, tokenWalk } from "./tokens.js";

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
export const lineStat = (before: string, after: string): LineStat | undefined => lineStatOf(splitLines(before), splitLines(after));

// The same counts over lines already split.
const lineStatOf = (old: readonly string[], now: readonly string[]): LineStat | undefined => {
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

// What `lineStat` reads a side's kept lines as once they are joined: a last empty line is the file's final newline.
const ended = (lines: readonly string[]): readonly string[] => (lines.at(-1) === `` ? lines.slice(0, -1) : lines);

/** What a count came to: its numbers, or two sides too far apart to be worth diffing (as `lineStat` finds them). */
export type CodeCount = { readonly stat: LineStat } | { readonly dissimilar: true };

// Too far apart is a property of the two texts, never of the moment: one reading of it holds for good.
const countOf = (stat: LineStat | undefined): CodeCount => (stat === undefined ? { dissimilar: true } : { stat });

/**
 * Same counts with every comment stripped from both sides, or undefined when the file can't be stripped (no grammar,
 * or a walk abandoned): exactly what `lineStat` answers for the two sides `analyzeCode` strips, with each unchanged
 * stretch tokenized once. The lines both sides open with read alike, so they are walked once; the lines both end with
 * read alike too when the walks reach them in the same state, and then only whether any of them keeps code matters,
 * since kept they are a common tail.
 */
export const codeLineStat = async (before: string, after: string, path: string, grammars: Grammars): Promise<CodeCount | undefined> => {
    // Resolved exactly as the diff pane resolves it; none above the highlight cap, where it shows the file whole.
    const lang = highlightLangFor(path, Math.max(before.length, after.length), after === `` ? before : after);
    const grammar = lang === undefined ? undefined : await grammars(lang);
    // Undefined mirrors the pane's own fallback (verbatim render); the caller then trusts git's counts.
    if (grammar === undefined) {
        return undefined;
    }
    const walk = tokenWalk(grammar);
    const old = before.split(`\n`);
    const now = after.split(`\n`);
    let head = 0;
    while (head < old.length && head < now.length && old[head] === now[head]) {
        head++;
    }
    let tail = 0;
    while (tail < old.length - head && tail < now.length - head && old[old.length - 1 - tail] === now[now.length - 1 - tail]) {
        tail++;
    }
    const shared = stripLines(walk, old.slice(0, head), STRIP_START);
    const oldMiddle = shared === undefined ? undefined : stripLines(walk, old.slice(head, old.length - tail), shared.state);
    const nowMiddle = shared === undefined ? undefined : stripLines(walk, now.slice(head, now.length - tail), shared.state);
    if (shared === undefined || oldMiddle === undefined || nowMiddle === undefined) {
        return undefined;
    }
    if (tail > 0 && sameStrip(oldMiddle.state, nowMiddle.state)) {
        const kept = keepsAny(walk, old.slice(old.length - tail), oldMiddle.state);
        if (kept === undefined) {
            return undefined;
        }
        // A tail that keeps code is a suffix both sides share, so the middles alone decide; one that keeps none leaves
        // the file's end, and its final newline, to them.
        return countOf(
            kept
                ? lineStatOf(oldMiddle.kept, nowMiddle.kept)
                : lineStatOf(ended([...shared.kept, ...oldMiddle.kept]), ended([...shared.kept, ...nowMiddle.kept])),
        );
    }
    const oldTail = stripLines(walk, old.slice(old.length - tail), oldMiddle.state);
    const nowTail = stripLines(walk, now.slice(now.length - tail), nowMiddle.state);
    if (oldTail === undefined || nowTail === undefined) {
        return undefined;
    }
    return countOf(lineStatOf(ended([...shared.kept, ...oldMiddle.kept, ...oldTail.kept]), ended([...shared.kept, ...nowMiddle.kept, ...nowTail.kept])));
};
