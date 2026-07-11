import { createHash } from "node:crypto";
import type { ChunkRow, SymbolRow } from "../types.js";

const WINDOW_LINES = 40;
const WINDOW_OVERLAP = 10;
const CHUNK_MAX_CHARS = 1200;
// Body char budget per symbol chunk, leaving headroom for the `path § label\n` prefix so a long function splits
// into several fully-covered dense chunks instead of ONE chunk truncated at CHUNK_MAX_CHARS — which silently
// dropped (and left unindexed) everything past ~25 lines. Benchmarked: that truncation buried mid-function code.
const SYMBOL_BODY_CHARS = CHUNK_MAX_CHARS - 100;

const chunk = (path: string, label: string, lines: readonly string[], startLine: number, endLine: number): ChunkRow => {
    // The path § symbol prefix is a strong retrieval signal; the body is capped so one chunk ≈ a few hundred tokens.
    const text = `${path} § ${label}\n${lines.slice(startLine - 1, endLine).join("\n")}`.slice(0, CHUNK_MAX_CHARS);
    return { startLine, endLine, hash: createHash("sha256").update(text).digest("hex"), text };
};

// Symbol-aligned chunks (doc-comment + signature + body come along via the line range), oversized bodies split
// into windows; uncovered regions (markdown, config, gaps) fall back to overlapping fixed windows.
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
            for (let from = windowStart; from <= i; from += WINDOW_LINES - WINDOW_OVERLAP) {
                const to = Math.min(i, from + WINDOW_LINES - 1);
                chunks.push(chunk(path, `L${from}`, lines, from, to));
                if (to === i) {
                    break;
                }
            }
            windowStart = undefined;
        }
    }
    return chunks.toSorted((a, b) => a.startLine - b.startLine);
};
