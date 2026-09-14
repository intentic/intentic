// A document's two versions as one text with tracked changes, the way a word processor shows them: paragraphs are
// matched first, then the words inside a changed paragraph. Pure, so the view only draws.

export type SegmentKind = "same" | "added" | "removed";

export interface ProseSegment {
    readonly kind: SegmentKind;
    readonly text: string;
}

export type BlockKind = "same" | "changed" | "added" | "removed";

export interface ProseBlock {
    readonly kind: BlockKind;
    // A markdown heading's level, with its hashes already stripped from the segments; absent for a paragraph.
    readonly heading?: number;
    readonly segments: readonly ProseSegment[];
}

type Op<T> = { readonly kind: SegmentKind; readonly item: T };

// Past this many cells the paragraph table is not worth building; the block reads as replaced whole.
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
            ops.push({ kind: `same`, item: before[i++]! });
            j++;
        } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
            ops.push({ kind: `removed`, item: before[i++]! });
        } else {
            ops.push({ kind: `added`, item: after[j++]! });
        }
    }
    ops.push(...before.slice(i).map((item): Op<T> => ({ kind: `removed`, item })), ...after.slice(j).map((item): Op<T> => ({ kind: `added`, item })));
    return ops;
};

// A longest-common-subsequence edit script, by table. Fine at paragraph and word counts; a block too large for the
// table is reported as removed then added, which is honest rather than slow.
const diffSequence = <T>(before: readonly T[], after: readonly T[], equal: (left: T, right: T) => boolean): Op<T>[] | undefined =>
    before.length * after.length > MAX_CELLS ? undefined : walkTable(lcsTable(before, after, equal), before, after, equal);

// Words, runs of whitespace, and runs of punctuation are the units; a changed comma then marks the comma, not the word.
const tokens = (text: string): string[] => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];

// Adjacent tokens of one kind become one segment, so the view draws a phrase as one mark rather than word by word.
const merge = (ops: readonly Op<string>[]): ProseSegment[] => {
    const segments: ProseSegment[] = [];
    for (const op of ops) {
        const last = segments.at(-1);
        if (last !== undefined && last.kind === op.kind) {
            segments[segments.length - 1] = { kind: op.kind, text: last.text + op.item };
        } else {
            segments.push({ kind: op.kind, text: op.item });
        }
    }
    return segments;
};

// Word-level marks inside one paragraph that exists on both sides.
export const wordDiff = (before: string, after: string): ProseSegment[] => {
    const ops = diffSequence(tokens(before), tokens(after), (left, right) => left === right);
    if (ops === undefined) {
        return [{ kind: `removed`, text: before }, { kind: `added`, text: after }];
    }
    return merge(ops);
};

const HEADING = /^(#{1,6})\s+/;

// Splits a heading's hashes off, so the view can size the line and the words diffed are the words.
const shape = (block: string): { heading?: number; text: string } => {
    const match = HEADING.exec(block);
    return match === null ? { text: block } : { heading: match[1]!.length, text: block.slice(match[0].length) };
};

// Paragraphs: runs of lines separated by a blank line, whitespace trimmed at both ends, line endings normalised.
export const blocksOf = (text: string): string[] =>
    text
        .replace(/\r\n/g, `\n`)
        .split(/\n[ \t]*\n+/)
        .map((block) => block.trim())
        .filter((block) => block !== ``);

const whole = (kind: BlockKind, block: string): ProseBlock => {
    const { heading, text } = shape(block);
    const segmentKind: SegmentKind = kind === `added` ? `added` : kind === `removed` ? `removed` : `same`;
    return { kind, ...(heading === undefined ? {} : { heading }), segments: [{ kind: segmentKind, text }] };
};

// A removed paragraph followed by an added one is, far more often than not, the same paragraph edited: paired in
// order and diffed word by word. What is left over on either side stands as removed or added whole.
const pairRun = (removed: readonly string[], added: readonly string[]): ProseBlock[] => {
    const blocks: ProseBlock[] = [];
    const pairs = Math.min(removed.length, added.length);
    for (let index = 0; index < pairs; index++) {
        const from = shape(removed[index]!);
        const to = shape(added[index]!);
        const heading = to.heading ?? from.heading;
        blocks.push({ kind: `changed`, ...(heading === undefined ? {} : { heading }), segments: wordDiff(from.text, to.text) });
    }
    for (const block of removed.slice(pairs)) {
        blocks.push(whole(`removed`, block));
    }
    for (const block of added.slice(pairs)) {
        blocks.push(whole(`added`, block));
    }
    return blocks;
};

// Paragraph ops into blocks: every run of removals and additions between two kept paragraphs is one edit, paired up.
const assemble = (ops: readonly Op<string>[]): ProseBlock[] => {
    const blocks: ProseBlock[] = [];
    let removed: string[] = [];
    let added: string[] = [];
    const flush = (): void => {
        blocks.push(...pairRun(removed, added));
        removed = [];
        added = [];
    };
    for (const op of ops) {
        if (op.kind === `same`) {
            flush();
            blocks.push(whole(`same`, op.item));
        } else {
            (op.kind === `removed` ? removed : added).push(op.item);
        }
    }
    flush();
    return blocks;
};

export const proseDiff = (before: string, after: string): ProseBlock[] => {
    const ops = diffSequence(blocksOf(before), blocksOf(after), (left, right) => left === right);
    return ops === undefined
        ? [...blocksOf(before).map((block) => whole(`removed`, block)), ...blocksOf(after).map((block) => whole(`added`, block))]
        : assemble(ops);
};

// What the view draws: every changed block, with a little unchanged context on each side, and the long unchanged runs
// between folded into one line that says how many paragraphs it stands for.
export type ProseRun = { readonly kind: "block"; readonly block: ProseBlock } | { readonly kind: "fold"; readonly count: number; readonly at: number };

const CONTEXT = 1;

const shown = (blocks: readonly ProseBlock[], from: number, to: number): ProseRun[] => blocks.slice(from, to).map((block) => ({ kind: `block`, block }));

// One unchanged run [from, to): context at each edge that touches a change, and a fold for the middle, which only
// earns its line when it hides more than the line would show.
const foldRun = (blocks: readonly ProseBlock[], from: number, to: number): ProseRun[] => {
    const lead = from === 0 ? 0 : CONTEXT;
    const tail = to === blocks.length ? 0 : CONTEXT;
    const hidden = to - from - lead - tail;
    if (hidden <= 1) {
        return shown(blocks, from, to);
    }
    return [...shown(blocks, from, from + lead), { kind: `fold`, count: hidden, at: from + lead }, ...shown(blocks, to - tail, to)];
};

export const foldUnchanged = (blocks: readonly ProseBlock[]): ProseRun[] => {
    if (!blocks.some((block) => block.kind !== `same`)) {
        return shown(blocks, 0, blocks.length);
    }
    const runs: ProseRun[] = [];
    let index = 0;
    while (index < blocks.length) {
        let end = index;
        while (end < blocks.length && blocks[end]!.kind === `same`) {
            end++;
        }
        if (end === index) {
            runs.push({ kind: `block`, block: blocks[index]! });
            index++;
        } else {
            runs.push(...foldRun(blocks, index, end));
            index = end;
        }
    }
    return runs;
};
