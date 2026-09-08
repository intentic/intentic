import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

// Hash-anchored editing: a read tags each line with a short content hash plus a whole-file anchor; an edit references
// those tags and echoes the anchor. Cuts output tokens versus str_replace (the model points at tags, not full lines)
// and rejects an edit whose anchor no longer matches instead of corrupting the file.

const short = (input: string, length: number): string => sha256Hex(input).slice(0, length);

// Whole-file anchor: changes on any byte change, so a mismatch at edit time means the read is stale.
export const fileAnchor = (content: string): string => short(content, 8);

// Tag over a line plus its neighbours, so two identical lines in different places tag differently.
const lineTag = (prev: string, line: string, next: string): string => short(`${prev}\n${line}\n${next}`, 4);

interface Split {
    readonly lines: string[];
    readonly trailingNewline: boolean;
}

// Splits into content lines, remembering a trailing newline so a round-trip through join() is byte-exact.
const splitLines = (content: string): Split => {
    if (content === "") {
        return { lines: [], trailingNewline: false };
    }
    const trailingNewline = content.endsWith("\n");
    return { lines: (trailingNewline ? content.slice(0, -1) : content).split("\n"), trailingNewline };
};

const join = (lines: readonly string[], trailingNewline: boolean): string => `${lines.join("\n")}${trailingNewline && lines.length > 0 ? "\n" : ""}`;

const tagsOf = (lines: readonly string[]): string[] => lines.map((line, i) => lineTag(lines[i - 1] ?? "", line, lines[i + 1] ?? ""));

// Read view the model anchors edits against: an anchor header to echo back, then `<tag> <n>│<text>` per line.
export const renderForRead = (content: string): string => {
    const { lines } = splitLines(content);
    const header = `anchor ${fileAnchor(content)} · ${lines.length} line(s): pass this anchor and the line tags to hashline_edit`;
    if (lines.length === 0) {
        return `${header}\n(empty file)`;
    }
    const tags = tagsOf(lines);
    return `${header}\n${lines.map((line, i) => `${tags[i]} ${i + 1}│${line}`).join("\n")}`;
};

// One anchored edit; tags come from a hashline_read of the same file. "^" anchors an insert at the top.
export type HashlineOp =
    | { readonly op: "replace"; readonly from: string; readonly to?: string; readonly lines: readonly string[] }
    | { readonly op: "insert"; readonly after: string; readonly lines: readonly string[] }
    | { readonly op: "delete"; readonly from: string; readonly to?: string };

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

interface Replacement {
    readonly from: number;
    readonly to: number;
    readonly lines: readonly string[];
}

// Applies ops to `content`, refusing a stale edit up front. Ranges must not overlap, and an insert may not land inside
// a replaced/deleted range; rebuilt in one pass so no op shifts another's indices.
export const applyEdit = (content: string, anchor: string, ops: readonly HashlineOp[]): string => {
    const actual = fileAnchor(content);
    if (anchor !== actual) {
        throw new Error(
            `stale edit: file anchor is ${actual}, edit targets ${anchor}, the file changed since you read it; re-read with hashline_read`,
        );
    }
    if (ops.length === 0) {
        throw new Error("no ops given");
    }
    const { lines, trailingNewline } = splitLines(content);
    const tags = tagsOf(lines);

    const replacements: Replacement[] = [];
    const insertsAfter = new Map<number, readonly string[]>();
    for (const op of ops) {
        if (op.op === "insert") {
            const after = op.after === "^" ? -1 : resolveTag(op.after, tags);
            if (insertsAfter.has(after)) {
                throw new Error(`two inserts anchored after the same line (${op.after}): combine them into one op`);
            }
            insertsAfter.set(after, op.lines);
            continue;
        }
        const from = resolveTag(op.from, tags);
        const to = op.to === undefined ? from : resolveTag(op.to, tags);
        if (to < from) {
            throw new Error(`range end (${op.to}) is before its start (${op.from})`);
        }
        replacements.push({ from, to, lines: op.op === "delete" ? [] : op.lines });
    }

    replacements.sort((a, b) => a.from - b.from);
    for (let i = 1; i < replacements.length; i++) {
        if ((replacements[i - 1] as Replacement).to >= (replacements[i] as Replacement).from) {
            throw new Error("overlapping replace/delete ranges: anchor them to disjoint line ranges");
        }
    }
    const replacementFrom = new Map(replacements.map((r) => [r.from, r]));
    const replacedIndices = new Set(replacements.flatMap((r) => Array.from({ length: r.to - r.from + 1 }, (_, k) => r.from + k)));
    for (const after of insertsAfter.keys()) {
        if (replacedIndices.has(after)) {
            throw new Error("an insert is anchored to a line inside a replaced/deleted range: anchor it to a kept line");
        }
    }

    const out: string[] = [...(insertsAfter.get(-1) ?? [])];
    for (let i = 0; i < lines.length;) {
        const replacement = replacementFrom.get(i);
        if (replacement !== undefined) {
            out.push(...replacement.lines);
            i = replacement.to + 1;
            continue;
        }
        out.push(lines[i] as string);
        const inserted = insertsAfter.get(i);
        if (inserted !== undefined) {
            out.push(...inserted);
        }
        i++;
    }
    return join(out, trailingNewline);
};
