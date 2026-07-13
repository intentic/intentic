import type { WorkspaceSearchTag } from "@intentic/sandbox-contract";
import type { IndexDb } from "../store/db.js";
import type { EngineHit, SymbolRow } from "../types.js";
import { globToRegExp } from "../workspace/glob.js";
import { fuzzyScore } from "./files.js";
import { rgSearch, type RgOptions } from "./lexical.js";

export interface StoredSymbol extends SymbolRow {
    readonly path: string;
}

const symbolRows = (db: IndexDb, where: string, ...params: string[]): StoredSymbol[] =>
    db
        .all(
            `SELECT f.path, s.name, s.kind, s.line, s.end_line, s.signature, s.exported, s.heuristic
             FROM symbols s JOIN files f ON f.id = s.file_id ${where} ORDER BY f.path, s.line`,
            ...params,
        )
        .map((row) => ({
            path: row["path"] as string,
            name: row["name"] as string,
            kind: row["kind"] as SymbolRow["kind"],
            line: Number(row["line"]),
            endLine: Number(row["end_line"]),
            signature: row["signature"] as string,
            exported: row["exported"] === 1,
            heuristic: row["heuristic"] === 1,
        }));

const defTags = (symbol: StoredSymbol): WorkspaceSearchTag[] => (symbol.heuristic ? [{ kind: "def" }, { kind: "heuristic" }] : [{ kind: "def" }]);

// `iq def X` — exact-name definitions from the symbol table, exported first.
export const defOf = (db: IndexDb, name: string, allowed: ReadonlySet<string>): EngineHit[] =>
    symbolRows(db, "WHERE s.name = ?", name)
        .filter((symbol) => allowed.has(symbol.path))
        .toSorted((a, b) => Number(b.exported) - Number(a.exported) || (a.path < b.path ? -1 : 1))
        .map((symbol) => ({ path: symbol.path, line: symbol.line, text: symbol.signature, tags: defTags(symbol) }));

// `iq sym <pattern>` — fuzzy (or glob) match over symbol names, optionally narrowed by kind.
export const symSearch = (db: IndexDb, pattern: string, kind: SymbolRow["kind"] | undefined, allowed: ReadonlySet<string>): EngineHit[] => {
    const glob = /[*?[]/.test(pattern) ? globToRegExp(pattern) : undefined;
    const scored: { symbol: StoredSymbol; score: number }[] = [];
    for (const symbol of symbolRows(db, kind !== undefined ? "WHERE s.kind = ?" : "", ...(kind !== undefined ? [kind] : []))) {
        if (!allowed.has(symbol.path)) {
            continue;
        }
        if (glob !== undefined) {
            if (glob.test(symbol.name)) {
                scored.push({ symbol, score: 1 });
            }
            continue;
        }
        const score = fuzzyScore(pattern, symbol.name);
        if (score !== undefined) {
            scored.push({ symbol, score });
        }
    }
    return scored
        .toSorted((a, b) => b.score - a.score || (a.symbol.path < b.symbol.path ? -1 : 1) || a.symbol.line - b.symbol.line)
        .map(({ symbol }) => ({
            path: symbol.path,
            line: symbol.line,
            text: `${symbol.kind.padEnd(6)} ${symbol.signature}`,
            tags: defTags(symbol),
        }));
};

export type RefKind = "call" | "import" | "type" | "write";

const classifyRef = (name: string, text: string): RefKind | "text" => {
    if (/^\s*(import\b|from\b|export\s+\{|use\s)/.test(text) || text.includes(`require(`)) {
        return "import";
    }
    if (new RegExp(`\\b${name}\\s*(=[^=>]|\\+\\+|--|\\+=|-=)`).test(text)) {
        return "write";
    }
    if (new RegExp(`\\b${name}\\s*[(<]`).test(text) && !new RegExp(`(function|def|const|let|var|class)\\s+${name}\\b`).test(text)) {
        return "call";
    }
    if (new RegExp(`(:\\s*|extends\\s+|implements\\s+|new\\s+|satisfies\\s+|as\\s+)${name}\\b`).test(text)) {
        return "type";
    }
    return "text";
};

export interface RefsResult {
    readonly hits: EngineHit[];
    readonly hint?: string;
}

// `iq refs X` — live word-boundary ripgrep, each hit classified by lexical context; definition lines dropped.
export const refsOf = async (db: IndexDb, name: string, kindFilter: RefKind | undefined, rgBase: Omit<RgOptions, "pattern">): Promise<RefsResult> => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = await rgSearch({ ...rgBase, pattern: escaped, word: true });
    const defLines = new Set(symbolRows(db, "WHERE s.name = ?", name).map((symbol) => `${symbol.path}:${symbol.line}`));
    const counts = new Map<string, number>();
    const classified: EngineHit[] = [];
    for (const hit of raw) {
        if (defLines.has(`${hit.path}:${hit.line}`)) {
            continue;
        }
        const kind = classifyRef(name, hit.text);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        if (kindFilter !== undefined && kind !== kindFilter) {
            continue;
        }
        classified.push({ ...hit, tags: [{ kind: kind === "text" ? "text" : kind }] });
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    let hint: string | undefined;
    if (kindFilter === undefined && total > 5) {
        const [topKind, topCount] = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]!;
        if (topKind !== "text" && topCount / total >= 0.6) {
            hint = `${topCount}/${total} refs are [${topKind}]; narrow with --kind ${topKind}`;
        }
    }
    return { hits: classified, ...(hint !== undefined ? { hint } : {}) };
};
