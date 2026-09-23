import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

// Hash-anchored editing: a read tags each line with a short content hash plus a whole-file anchor; an edit references
// those tags and echoes the anchor. Cuts output tokens versus str_replace (the model points at tags, not full lines)
// and rejects an edit whose anchor no longer matches instead of corrupting the file.

const short = (input: string, length: number): string => sha256Hex(input).slice(0, length);

// Whole-file anchor over the raw text, line endings included: changes on any byte change, so a mismatch at edit time
// means the read is stale.
export const fileAnchor = (content: string): string => short(content, 8);

// Tag over a line plus its neighbours, so two identical lines in different places tag differently. It also means an
// edit moves the tags of only the lines it wrote and the two lines beside it.
const lineTag = (prev: string, line: string, next: string): string => short(`${prev}\n${line}\n${next}`, 4);

interface Line {
    readonly text: string;
    // The terminator as found on disk; "" for a line an edit wrote or an unterminated last line.
    readonly end: string;
}

interface Split {
    readonly lines: readonly Line[];
    // What a written line ends with: the terminator most of the file's lines use, "\n" on a tie or with none.
    readonly eol: string;
    // Whether the last line has a terminator, which an edit keeps whatever line ends up last.
    readonly trailing: boolean;
}

// A "\r" before "\n" belongs to the terminator, so neither tags nor the read view see it and a CRLF file tags like LF.
const splitLines = (content: string): Split => {
    const segments = content.split("\n");
    // What follows the last "\n": "" when the file ends with one (or is empty), else an unterminated last line.
    const tail = segments.pop() ?? "";
    const lines: Line[] = segments.map((segment) => (segment.endsWith("\r") ? { text: segment.slice(0, -1), end: "\r\n" } : { text: segment, end: "\n" }));
    const crlf = lines.filter((line) => line.end === "\r\n").length;
    if (tail !== "") {
        lines.push({ text: tail, end: "" });
    }
    return { lines, eol: crlf * 2 > segments.length ? "\r\n" : "\n", trailing: tail === "" && lines.length > 0 };
};

const textsOf = (content: string): string[] => splitLines(content).lines.map((line) => line.text);

const ending = (line: Line, last: boolean, { eol, trailing }: Split): string => {
    if (last && !trailing) {
        return "";
    }
    return line.end === "" ? eol : line.end;
};

// Kept lines keep their terminator and written ones take the file's, so an untouched line round-trips byte for byte.
const joinLines = (lines: readonly Line[], split: Split): string => lines.map((line, i) => `${line.text}${ending(line, i === lines.length - 1, split)}`).join("");

const tagAt = (texts: readonly string[], i: number): string => lineTag(texts[i - 1] ?? "", texts[i] ?? "", texts[i + 1] ?? "");

// One line of a read or edit view: `<tag> <n>│<text>`, numbered from 1.
const row = (texts: readonly string[], i: number): string => `${tagAt(texts, i)} ${i + 1}│${texts[i] ?? ""}`;

// Lines one read shows when the caller names no limit, as the native Read does; and a character budget (~25k tokens)
// that stops a file of long lines sooner. A read always shows at least one line.
const READ_LINES = 2000;
const READ_CHARS = 100_000;

// Which lines a read shows: `offset` is the 1-based first line.
export interface ReadRange {
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
}

const readRows = (texts: readonly string[], first: number, limit: number): string[] => {
    const rows: string[] = [];
    let chars = 0;
    for (let i = first; i < Math.min(texts.length, first + limit); i++) {
        const next = row(texts, i);
        chars += next.length + 1;
        if (rows.length > 0 && chars > READ_CHARS) {
            break;
        }
        rows.push(next);
    }
    return rows;
};

// Read view the model anchors edits against: a header with the whole-file anchor and which lines follow, then one row
// per line. The anchor covers the whole file whatever range is shown.
export const renderForRead = (content: string, { offset = 1, limit = READ_LINES }: ReadRange = {}): string => {
    const texts = textsOf(content);
    const anchor = fileAnchor(content);
    if (texts.length === 0) {
        return `anchor ${anchor} · 0 lines: pass this anchor to hashline_edit\n(empty file)`;
    }
    if (offset > texts.length) {
        return `anchor ${anchor} · ${texts.length} lines, none from offset ${offset}`;
    }
    const rows = readRows(texts, offset - 1, limit);
    const last = offset - 1 + rows.length;
    const rest = last < texts.length ? `; the rest: hashline_read with offset ${last + 1}` : "";
    return [`anchor ${anchor} · lines ${offset}-${last} of ${texts.length}: pass this anchor and the line tags to hashline_edit${rest}`, ...rows].join("\n");
};

// One anchored edit; tags come from a hashline_read of the same file. "^" anchors an insert at the top.
export type HashlineOp =
    | { readonly op: "replace"; readonly from: string; readonly to?: string; readonly lines: readonly string[] }
    | { readonly op: "insert"; readonly after: string; readonly lines: readonly string[] }
    | { readonly op: "delete"; readonly from: string; readonly to?: string };

// Where one op's lines landed in the new file, 0-based and end-exclusive; empty for a deletion.
export interface EditedRange {
    readonly from: number;
    readonly to: number;
}

export interface HashlineEdit {
    readonly content: string;
    // In file order, one per op.
    readonly edited: readonly EditedRange[];
}

// Resolves a tag to its line index; a missing or ambiguous tag errors, so the model re-reads to recover.
const resolveTag = (tag: string, tags: readonly string[]): number => {
    const matches = tags.flatMap((candidate, index) => (candidate === tag ? [index] : []));
    if (matches[0] === undefined) {
        throw new Error(`unknown line tag "${tag}": re-read the file with hashline_read to get current tags`);
    }
    if (matches.length > 1) {
        throw new Error(`ambiguous line tag "${tag}" (lines ${matches.map((i) => i + 1).join(", ")}): anchor a nearby unique line instead`);
    }
    return matches[0];
};

// A string holding line breaks is that many lines, each written with the file's terminator.
const writtenLines = (lines: readonly string[]): string[] => lines.flatMap((line) => line.split(/\r?\n/));

// A replaced or deleted range of the old file, both ends inclusive.
interface Replacement {
    readonly from: number;
    readonly to: number;
    readonly lines: readonly string[];
}

interface Plan {
    readonly replacements: ReadonlyMap<number, Replacement>;
    // Written lines by the index of the line they follow, -1 for the top of the file.
    readonly inserts: ReadonlyMap<number, readonly string[]>;
}

const replacementOf = (op: Exclude<HashlineOp, { readonly op: "insert" }>, tags: readonly string[]): Replacement => {
    const from = resolveTag(op.from, tags);
    const to = op.to === undefined ? from : resolveTag(op.to, tags);
    if (to < from) {
        throw new Error(`range end (${op.to}) is before its start (${op.from})`);
    }
    return { from, to, lines: op.op === "delete" ? [] : writtenLines(op.lines) };
};

// Ranges must not overlap, and an insert may not land inside a replaced/deleted range.
const checkDisjoint = (replacements: readonly Replacement[], inserts: ReadonlyMap<number, unknown>): void => {
    const sorted = replacements.toSorted((a, b) => a.from - b.from);
    if (sorted.some((replacement, i) => i > 0 && (sorted[i - 1] as Replacement).to >= replacement.from)) {
        throw new Error("overlapping replace/delete ranges: anchor them to disjoint line ranges");
    }
    if ([...inserts.keys()].some((after) => replacements.some(({ from, to }) => after >= from && after <= to))) {
        throw new Error("an insert is anchored to a line inside a replaced/deleted range: anchor it to a kept line");
    }
};

const planOps = (ops: readonly HashlineOp[], tags: readonly string[]): Plan => {
    const replacements: Replacement[] = [];
    const inserts = new Map<number, readonly string[]>();
    for (const op of ops) {
        if (op.op !== "insert") {
            replacements.push(replacementOf(op, tags));
            continue;
        }
        const after = op.after === "^" ? -1 : resolveTag(op.after, tags);
        if (inserts.has(after)) {
            throw new Error(`two inserts anchored after the same line (${op.after}): combine them into one op`);
        }
        inserts.set(after, writtenLines(op.lines));
    }
    checkDisjoint(replacements, inserts);
    return { replacements: new Map(replacements.map((replacement) => [replacement.from, replacement])), inserts };
};

// Rebuilt in one pass, so no op shifts another's indices; records where each op's lines land.
const rebuild = (lines: readonly Line[], { replacements, inserts }: Plan): { readonly lines: Line[]; readonly edited: EditedRange[] } => {
    const out: Line[] = [];
    const edited: EditedRange[] = [];
    const write = (texts: readonly string[] | undefined): void => {
        if (texts === undefined) {
            return;
        }
        edited.push({ from: out.length, to: out.length + texts.length });
        for (const text of texts) {
            out.push({ text, end: "" });
        }
    };
    write(inserts.get(-1));
    for (let i = 0; i < lines.length; ) {
        const replacement = replacements.get(i);
        if (replacement === undefined) {
            out.push(lines[i] as Line);
            write(inserts.get(i));
            i++;
            continue;
        }
        write(replacement.lines);
        i = replacement.to + 1;
    }
    return { lines: out, edited };
};

// Applies ops to `content`, refusing a stale edit up front.
export const applyEdit = (content: string, anchor: string, ops: readonly HashlineOp[]): HashlineEdit => {
    const actual = fileAnchor(content);
    if (anchor !== actual) {
        throw new Error(
            `stale edit: file anchor is ${actual}, edit targets ${anchor}, the file changed since you read it; re-read with hashline_read`,
        );
    }
    if (ops.length === 0) {
        throw new Error("no ops given");
    }
    const split = splitLines(content);
    const texts = split.lines.map((line) => line.text);
    const plan = planOps(ops, texts.map((_, i) => tagAt(texts, i)));
    const { lines, edited } = rebuild(split.lines, plan);
    return { content: joinLines(lines, split), edited };
};

// Lines shown either side of an edit: the nearest kept line is the only one whose tag moved, the second places the edit.
const CONTEXT = 2;

// The windows an edit view shows: each edited range widened by CONTEXT, clamped to the file, merged where they touch.
const windows = (edited: readonly EditedRange[], count: number): EditedRange[] => {
    const merged: EditedRange[] = [];
    for (const { from, to } of edited) {
        const window = { from: Math.max(0, from - CONTEXT), to: Math.min(count, to + CONTEXT) };
        const previous = merged.at(-1);
        if (previous !== undefined && window.from <= previous.to) {
            merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, window.to) };
            continue;
        }
        merged.push(window);
    }
    return merged;
};

// What an edit answers with instead of the whole file: the new anchor and each changed stretch with its current tags,
// windows apart separated by "…". A line not shown kept its tag, so the next edit needs no re-read.
export const renderForEdit = ({ content, edited }: HashlineEdit): string => {
    const texts = textsOf(content);
    const header = `anchor ${fileAnchor(content)} · ${texts.length} lines: edit applied`;
    if (texts.length === 0) {
        return `${header}\n(empty file)`;
    }
    const shown = windows(edited, texts.length).map(({ from, to }) => Array.from({ length: to - from }, (_, k) => row(texts, from + k)).join("\n"));
    return `${header}. Below, each change with up to ${CONTEXT} lines either side and their current tags; every line not shown kept its tag, so pass this anchor to the next hashline_edit without re-reading.\n${shown.join("\n…\n")}`;
};
