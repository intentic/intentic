// Edit scripts over sequences and over the words of two texts, the machinery under every reading that draws two
// versions as one: the prose diff, the table diff, and a rendered document's redline. Pure, so each view only draws.

export type SegmentKind = "same" | "added" | "removed";

// A stretch of text and whether it is in both versions, only the new one, or only the old.
export interface Segment {
    readonly kind: SegmentKind;
    readonly text: string;
}

// One step of an edit script over any items. A kept step names both sides' items: equal by the caller's measure,
// not the same object, and a reader drawing the new version wants the new one.
export type Op<T> = { readonly kind: "same"; readonly before: T; readonly after: T } | { readonly kind: "added" | "removed"; readonly item: T };

// Past this much work the sequences read as replaced whole. Named in table cells, its unit when the edit script was a
// full table, and still the most work a script may take; `maxCells` lowers it for a caller that runs often and must
// stay cheap (a chat tool card re-diffs on every streamed patch).
const MAX_CELLS = 4_000_000;
// What one step of the search costs in table cells, measured (2026-11-24, Node 24): a step reads two neighbours,
// compares, and keeps its row for the walk, where a cell only compares and takes a max.
const SEARCH_STEP_CELLS = 4;

// How far each point is from the ends of both sequences in edits, found by Myers' greedy search run from the ends back
// toward the start: for every edit count d, the furthest point back on each diagonal still within d edits of the end.
// Along a diagonal that distance only shrinks toward the end, so one number per (d, diagonal) answers "is this point
// within d" for every point on it. Coordinates count items from the end (x of `before`, y of `after`); diagonal k is x - y.
interface Reach {
    // The edit distance from `from` in both sequences to their ends.
    readonly distance: number;
    // Whether (i, j), indices from the start, is within d edits of the end.
    readonly within: (d: number, i: number, j: number) => boolean;
}

// Each step's row of furthest points, kept for the walk: step d's first diagonal, where its values begin, and the
// values for every other diagonal from there. Grows by doubling up to the search's budget, which bounds it.
class Rows {
    private readonly lows: number[] = [];
    private readonly starts: number[] = [];
    private readonly cap: number;
    private values: Int32Array;
    private size = 0;

    constructor(cap: number) {
        this.cap = cap;
        this.values = new Int32Array(Math.min(cap, 1024));
    }

    open(low: number): void {
        this.lows.push(low);
        this.starts.push(this.size);
    }

    push(x: number): void {
        if (this.size === this.values.length) {
            const grown = new Int32Array(Math.min(this.values.length * 2, this.cap));
            grown.set(this.values);
            this.values = grown;
        }
        this.values[this.size++] = x;
    }

    // The furthest x on diagonal k within `step` edits, or -1 when that step reached no point on it.
    at(step: number, k: number): number {
        const first = this.lows[step];
        if (first === undefined || k < first || ((k - first) & 1) === 1) {
            return -1;
        }
        const index = this.starts[step]! + ((k - first) >> 1);
        return index < (this.starts[step + 1] ?? this.size) ? this.values[index]! : -1;
    }
}

// The diagonals of step d's parity that hold any point of an n-by-m grid.
const diagonalsAt = (d: number, n: number, m: number): readonly [number, number] => [
    Math.max(-d, (m + d) % 2 === 0 ? -m : 1 - m),
    Math.min(d, (n + d) % 2 === 0 ? n : n - 1),
];

// Where step d starts on diagonal k: one past the left neighbour's point (a removal) or the right neighbour's point
// (an addition), whichever lies further and stays inside the grid; -1 when neither does.
const entryAt = (v: Int32Array, shift: number, d: number, k: number, n: number, m: number): number => {
    if (d === 0) {
        return 0;
    }
    const left = v[k - 1 + shift]!;
    const removal = left >= 0 && left < n ? left + 1 : -1;
    const right = v[k + 1 + shift]!;
    return right > removal && right - k <= m ? right : removal;
};

const reachFromEnd = <T>(before: readonly T[], after: readonly T[], from: number, equal: (left: T, right: T) => boolean, budget: number): Reach | undefined => {
    const n = before.length - from;
    const m = after.length - from;
    // The furthest x on each diagonal so far, at index k + m + 1 (a spare slot each side), -1 for none yet. Step d
    // reads its neighbours' step d - 1 values and its own from d - 2, which is the one array Myers keeps.
    const v = new Int32Array(n + m + 3).fill(-1);
    const shift = m + 1;
    const lastBefore = before.length - 1;
    const lastAfter = after.length - 1;
    // From x on diagonal k, past the run of equal items there.
    const slide = (start: number, k: number): number => {
        let x = start;
        while (x < n && x - k < m && equal(before[lastBefore - x]!, after[lastAfter - x + k]!)) {
            x++;
        }
        return x;
    };
    const rows = new Rows(budget + 1);
    let work = 0;
    for (let d = 0; ; d++) {
        const [low, high] = diagonalsAt(d, n, m);
        rows.open(low);
        for (let k = low; k <= high; k += 2) {
            const entry = entryAt(v, shift, d, k, n, m);
            const x = entry < 0 ? entry : slide(entry, k);
            work += Math.max(0, x - entry) + 1;
            // A point reached in fewer edits may lie further along than any reached in exactly d.
            v[k + shift] = Math.max(x, v[k + shift]!);
            rows.push(v[k + shift]!);
            if (k === n - m && v[k + shift]! >= n) {
                return { distance: d, within: (step, i, j) => rows.at(step, before.length - i - (after.length - j)) >= before.length - i };
            }
            if (work > budget) {
                return undefined;
            }
        }
    }
};

// The longest-common-subsequence lengths from every (i, j) to the ends, one row per `before` item plus a sentinel.
const lcsTable = <T>(before: readonly T[], after: readonly T[], equal: (left: T, right: T) => boolean): Uint32Array => {
    const cols = after.length + 1;
    const table = new Uint32Array((before.length + 1) * cols);
    for (let i = before.length - 1; i >= 0; i--) {
        for (let j = after.length - 1; j >= 0; j--) {
            table[i * cols + j] = equal(before[i]!, after[j]!) ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
        }
    }
    return table;
};

// Walks the table from the start, taking a match when there is one and otherwise the side with more subsequence
// left; whatever remains on either side at the end is removed or added whole.
const walkTable = <T>(table: Uint32Array, before: readonly T[], after: readonly T[], equal: (left: T, right: T) => boolean): Op<T>[] => {
    const cols = after.length + 1;
    const ops: Op<T>[] = [];
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (equal(before[i]!, after[j]!)) {
            ops.push({ kind: `same`, before: before[i++]!, after: after[j++]! });
        } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
            ops.push({ kind: `removed`, item: before[i++]! });
        } else {
            ops.push({ kind: `added`, item: after[j++]! });
        }
    }
    ops.push(...before.slice(i).map((item): Op<T> => ({ kind: `removed`, item })), ...after.slice(j).map((item): Op<T> => ({ kind: `added`, item })));
    return ops;
};

// The same walk as the table's, steered by distances instead of subsequence lengths: a match when there is one, else
// a removal whenever it keeps the script shortest, else an addition. So among equally short scripts it picks the very
// one the table did (removals before additions), and a view or test reading the old order reads the same.
const walkReach = <T>(reach: Reach, before: readonly T[], after: readonly T[], from: number, equal: (left: T, right: T) => boolean): Op<T>[] => {
    const ops: Op<T>[] = [];
    for (let index = 0; index < from; index++) {
        ops.push({ kind: `same`, before: before[index]!, after: after[index]! });
    }
    let i = from;
    let j = from;
    let left = reach.distance;
    while (i < before.length && j < after.length) {
        if (equal(before[i]!, after[j]!)) {
            ops.push({ kind: `same`, before: before[i++]!, after: after[j++]! });
        } else if (reach.within(left - 1, i + 1, j)) {
            ops.push({ kind: `removed`, item: before[i++]! });
            left--;
        } else {
            ops.push({ kind: `added`, item: after[j++]! });
            left--;
        }
    }
    ops.push(...before.slice(i).map((item): Op<T> => ({ kind: `removed`, item })), ...after.slice(j).map((item): Op<T> => ({ kind: `added`, item })));
    return ops;
};

// A shortest edit script (longest common subsequence). The common head is matched as it stands, the rest by Myers'
// O((N+M)·D) search, whose work grows with how much changed rather than with the sizes multiplied; past `maxCells` of
// it the sequences get `undefined`, which a caller reports as removed then added, honest rather than slow. Sequences
// small enough for the old full table (N·M within `maxCells`) still always get a script: when they differ so much that
// the search would cost more than the table, the table is built instead, so nothing the table answered now gives up.
//
// 2026-11-24: replaced the full O(N·M) table every call built, which gave up past 4M cells: a 2,000-line file with
// one edit (2000·2001 cells) read as replaced whole. Measured on real source, Node 24: 1,000 lines with 10 edits 4.3 ms
// → 0.15 ms; 2,000 and 20,000 lines with 200 edits, given up before, 0.6 ms and 1.3 ms; a 1,000- or 2,000-line file
// rewritten whole, where the search hands over to the table, 4 → 6 ms and 20 → 29 ms; a 20,000-line rewrite still
// gives up, after 20 ms. A 500-paragraph document with 100 edits drew in 243 ms, now 19 ms. Same script as the table
// on every input the table answered (200,000 random sequences compared, budgets included).
export const diffSequence = <T>(
    before: readonly T[],
    after: readonly T[],
    equal: (left: T, right: T) => boolean,
    maxCells = MAX_CELLS,
): Op<T>[] | undefined => {
    let from = 0;
    while (from < before.length && from < after.length && equal(before[from]!, after[from]!)) {
        from++;
    }
    const n = before.length - from;
    const m = after.length - from;
    const fits = before.length * after.length <= maxCells;
    // With the table affordable, the search gets a quarter of its cost and the table answers past that, so two texts
    // with little in common cost at most a quarter more than the table alone; without it, the search gets the time
    // the largest table would have taken. Either way the linear part (the shared tail, one pass) comes on top.
    const budget = (fits ? (n * m) / 4 : maxCells) / SEARCH_STEP_CELLS + n + m;
    // The tail needs no trimming of its own: it is the search's first, zero-edit stretch, and trimming it apart would
    // change which of two equal scripts the walk picks where the tail's first item also appears just before it.
    const reach = reachFromEnd(before, after, from, equal, budget);
    if (reach !== undefined) {
        return walkReach(reach, before, after, from, equal);
    }
    if (!fits) {
        return undefined;
    }
    const head = before.slice(0, from).map((item, index): Op<T> => ({ kind: `same`, before: item, after: after[index]! }));
    const restBefore = before.slice(from);
    const restAfter = after.slice(from);
    return [...head, ...walkTable(lcsTable(restBefore, restAfter, equal), restBefore, restAfter, equal)];
};

// Words, runs of whitespace, and runs of punctuation are the units; a changed comma then marks the comma, not the word.
const tokens = (text: string): string[] => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];

// Adjacent tokens of one kind become one segment, so a view draws a phrase as one mark rather than word by word.
const merge = (ops: readonly Op<string>[]): Segment[] => {
    const segments: Segment[] = [];
    for (const op of ops) {
        const text = op.kind === `same` ? op.after : op.item;
        const last = segments.at(-1);
        if (last !== undefined && last.kind === op.kind) {
            segments[segments.length - 1] = { kind: op.kind, text: last.text + text };
        } else {
            segments.push({ kind: op.kind, text });
        }
    }
    return segments;
};

// Word-level marks between two versions of one paragraph, in order: the same text's segments, then the words only
// one side has, at the place they left or arrived.
export const wordDiff = (before: string, after: string): Segment[] => {
    const ops = diffSequence(tokens(before), tokens(after), (left, right) => left === right);
    if (ops === undefined) {
        return [
            { kind: `removed`, text: before },
            { kind: `added`, text: after },
        ];
    }
    return merge(ops);
};

// Words alone, since spaces and full stops match between any two sentences.
const words = (text: string): number => tokens(text).filter((token) => /[\p{L}\p{N}_]/u.test(token)).length;

// How much of two texts is the same text, 0 to 1, by the words the diff keeps; what decides whether a removed
// paragraph and the added one after it are one paragraph edited or two different paragraphs.
export const similarity = (before: string, after: string): number => similarityOf(before, after, wordDiff(before, after));

// `similarity` from a word diff the caller already holds, for one that both measures a pair and draws it.
export const similarityOf = (before: string, after: string, segments: readonly Segment[]): number => {
    const total = words(before) + words(after);
    if (total === 0) {
        return 1;
    }
    const kept = segments.filter((segment) => segment.kind === `same`).reduce((sum, segment) => sum + words(segment.text), 0);
    return (2 * kept) / total;
};

// An edit script with its removals and additions paired: a run of removals followed by additions between two kept
// items is, far more often than not, the same items edited, so they are matched in order and what is left over on
// either side stands as removed or added whole. `alike` vetoes a pair that is two different items rather than one
// edited, which then read as removed and added in turn.
export type Edit<T> =
    | { readonly kind: "same"; readonly before: T; readonly after: T }
    | { readonly kind: "pair"; readonly before: T; readonly after: T }
    | { readonly kind: "removed"; readonly item: T }
    | { readonly kind: "added"; readonly item: T };

export const pairEdits = <T>(ops: readonly Op<T>[], alike: (before: T, after: T) => boolean = () => true): Edit<T>[] => {
    const edits: Edit<T>[] = [];
    let removed: T[] = [];
    let added: T[] = [];
    const flush = (): void => {
        const pairs = Math.min(removed.length, added.length);
        for (let index = 0; index < pairs; index++) {
            const before = removed[index]!;
            const after = added[index]!;
            if (alike(before, after)) {
                edits.push({ kind: `pair`, before, after });
            } else {
                edits.push({ kind: `removed`, item: before }, { kind: `added`, item: after });
            }
        }
        edits.push(...removed.slice(pairs).map((item): Edit<T> => ({ kind: `removed`, item })), ...added.slice(pairs).map((item): Edit<T> => ({ kind: `added`, item })));
        removed = [];
        added = [];
    };
    for (const op of ops) {
        if (op.kind === `same`) {
            flush();
            edits.push(op);
        } else {
            (op.kind === `removed` ? removed : added).push(op.item);
        }
    }
    flush();
    return edits;
};
