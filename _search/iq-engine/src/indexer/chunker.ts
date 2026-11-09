import { createHash } from "node:crypto";
import type { ChunkRow, SymbolRow } from "../types.js";

const WINDOW_LINES = 40;
const CHUNK_MAX_CHARS = 1200;
// Body char budget per symbol chunk, leaving headroom for the `path § label\n` prefix so a long function splits
// into several fully-covered dense chunks instead of ONE chunk truncated at CHUNK_MAX_CHARS, which silently
// dropped (and left unindexed) everything past ~25 lines. Benchmarked: that truncation buried mid-function code.
const SYMBOL_BODY_CHARS = CHUNK_MAX_CHARS - 100;
// A run of lines no symbol covers is cut after a line whose own text hashes onto residue 0 of WINDOW_CUT_EVERY, once
// the window holds WINDOW_MIN_CHARS. The cut depends on the lines and not on their numbers, so a line inserted
// above moves only the windows up to the next cut both versions share: every later window keeps its text, its hash
// and its vector. Fixed 40-line windows labelled with their first line number shifted all at once, so one key added
// near the top of a translation catalog re-embedded the whole file.
const WINDOW_MIN_CHARS = 700;
const WINDOW_CUT_EVERY = 4;

// The chunk text starts with `path § label` for a symbol or a page, which is a strong retrieval signal, and with the
// path alone for a window, whose only label would be a line number. The body is capped so a chunk is a few hundred
// tokens.
const chunk = (path: string, label: string | undefined, lines: readonly string[], startLine: number, endLine: number): ChunkRow => {
    const head = label === undefined ? path : `${path} § ${label}`;
    const text = `${head}\n${lines.slice(startLine - 1, endLine).join("\n")}`.slice(0, CHUNK_MAX_CHARS);
    return { startLine, endLine, hash: createHash("sha256").update(text).digest("hex"), text };
};

// FNV-1a: a stable, cheap hash of one line, used to pick where windows are cut.
const lineHash = (line: string): number => {
    let hash = 0x81_1c_9d_c5;
    for (let i = 0; i < line.length; i++) {
        hash ^= line.charCodeAt(i);
        hash = Math.imul(hash, 0x01_00_01_93);
    }
    return hash >>> 0;
};

const cutsAfter = (line: string): boolean => lineHash(line) % WINDOW_CUT_EVERY === 0;

// Lines `from`..`to` (1-based, inclusive) as windows that cover each line exactly once. Each window ends at a
// content-chosen cut, or earlier when the next line would pass the body budget or WINDOW_LINES.
const windowsOver = (path: string, lines: readonly string[], from: number, to: number): ChunkRow[] => {
    const windows: ChunkRow[] = [];
    let start = from;
    while (start <= to) {
        let end = start;
        let chars = (lines[start - 1]?.length ?? 0) + 1;
        while (end < to && !(chars >= WINDOW_MIN_CHARS && cutsAfter(lines[end - 1] ?? ""))) {
            const next = (lines[end]?.length ?? 0) + 1;
            if (end - start + 1 >= WINDOW_LINES || chars + next > SYMBOL_BODY_CHARS) {
                break;
            }
            end += 1;
            chars += next;
        }
        windows.push(chunk(path, undefined, lines, start, end));
        start = end + 1;
    }
    return windows;
};

// Symbol-aligned chunks (doc-comment + signature + body come along via the line range), oversized bodies split
// into windows; uncovered regions (markdown, config, gaps) fall back to content-cut windows.
export const chunkFile = (path: string, symbols: readonly SymbolRow[], content: string): ChunkRow[] => {
    const lines = content.split(/\r?\n/);
    const chunks: ChunkRow[] = [];
    const covered = Array.from({ length: lines.length }, () => false);

    const top = symbols.filter(
        (symbol) => !symbols.some((other) => other !== symbol && other.line <= symbol.line && other.endLine >= symbol.endLine),
    );
    for (const symbol of top) {
        // Include the immediately preceding comment line (doc first-line) when present.
        const start = symbol.line > 1 && /^\s*(\/\/|\/\*|\*|#)/.test(lines[symbol.line - 2] ?? "") ? symbol.line - 1 : symbol.line;
        // Walk the body in char-budgeted windows so the whole symbol is covered by dense chunks (never truncated).
        let from = start;
        while (from <= symbol.endLine) {
            let to = from;
            let chars = (lines[from - 1]?.length ?? 0) + 1;
            while (to + 1 <= symbol.endLine && chars + (lines[to]?.length ?? 0) + 1 <= SYMBOL_BODY_CHARS) {
                to += 1;
                chars += (lines[to - 1]?.length ?? 0) + 1;
            }
            chunks.push(chunk(path, symbol.name, lines, from, to));
            from = to + 1;
        }
        for (let i = start - 1; i < symbol.endLine; i++) {
            covered[i] = true;
        }
    }

    let windowStart: number | undefined;
    for (let i = 0; i <= lines.length; i++) {
        const uncovered = i < lines.length && !covered[i] && (lines[i] ?? "").trim() !== "";
        if (uncovered && windowStart === undefined) {
            windowStart = i + 1;
        }
        if (!uncovered && windowStart !== undefined) {
            chunks.push(...windowsOver(path, lines, windowStart, i));
            windowStart = undefined;
        }
    }
    return chunks.toSorted((a, b) => a.startLine - b.startLine);
};

// Lines of a page-marked document (`[p. 12] …`, `[slide 3] …`) to the page they sit on.
const PAGE_LABEL = /^\[(p\.|slide) (\d+)\] /;
const pageOf = (line: string): string | undefined => {
    const match = PAGE_LABEL.exec(line);
    return match === null ? undefined : `${match[1]} ${match[2]}`;
};

// A document's text (a shadow, page-marked: see workspace/shadows.ts) in windows that never straddle a page, each
// labelled with its page (`docs/terms.pdf § p. 12`) so the page is a retrieval signal and the passage's context.
// Windows are char-budgeted as well as line-capped: one page of a pdf can be a few long lines.
export const chunkDocument = (path: string, content: string): ChunkRow[] => {
    const lines = content.split(/\r?\n/);
    const chunks: ChunkRow[] = [];
    let from = 1;
    while (from <= lines.length) {
        const page = pageOf(lines[from - 1] ?? "");
        let to = from;
        let chars = (lines[from - 1]?.length ?? 0) + 1;
        while (
            to < lines.length &&
            to - from + 1 < WINDOW_LINES &&
            pageOf(lines[to] ?? "") === page &&
            chars + (lines[to]?.length ?? 0) + 1 <= SYMBOL_BODY_CHARS
        ) {
            chars += (lines[to]?.length ?? 0) + 1;
            to += 1;
        }
        const body = lines.slice(from - 1, to);
        if (body.some((line) => line.replace(PAGE_LABEL, "").trim() !== "")) {
            chunks.push(chunk(path, page, lines, from, to));
        }
        from = to + 1;
    }
    return chunks;
};
