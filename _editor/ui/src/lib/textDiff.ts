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

// Past this many cells the table is not worth building; the sequences read as replaced whole.
const MAX_CELLS = 4_000_000;

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

// A longest-common-subsequence edit script, by table. Fine at paragraph and word counts; sequences too large for
// the table get `undefined`, which a caller reports as removed then added, honest rather than slow.
export const diffSequence = <T>(before: readonly T[], after: readonly T[], equal: (left: T, right: T) => boolean): Op<T>[] | undefined =>
    before.length * after.length > MAX_CELLS ? undefined : walkTable(lcsTable(before, after, equal), before, after, equal);

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
export const similarity = (before: string, after: string): number => {
    const total = words(before) + words(after);
    if (total === 0) {
        return 1;
    }
    const kept = wordDiff(before, after)
        .filter((segment) => segment.kind === `same`)
        .reduce((sum, segment) => sum + words(segment.text), 0);
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
