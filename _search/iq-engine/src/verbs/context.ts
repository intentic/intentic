import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type StoredSymbol, symbolRows } from "../engines/symbols.js";
import type { IndexDb } from "../store/db.js";
import type { RankedGroup } from "../types.js";
import { isIqDenied } from "../workspace/floor.js";

const FALLBACK_RADIUS = 20;

interface FileSymbol {
    readonly name: string;
    readonly kind: string;
    readonly line: number;
    readonly endLine: number;
    readonly signature: string;
    readonly heuristic: boolean;
}

const symbolsOfFile = (db: IndexDb, path: string): FileSymbol[] =>
    db
        .all(
            "SELECT s.name, s.kind, s.line, s.end_line, s.signature, s.heuristic FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.line",
            path,
        )
        .map((row) => ({
            name: row["name"] as string,
            kind: row["kind"] as string,
            line: Number(row["line"]),
            endLine: Number(row["end_line"]),
            signature: row["signature"] as string,
            heuristic: row["heuristic"] === 1,
        }));

const guard = (path: string): string => {
    const normalized = path.replace(/^\.\//, "");
    if (isIqDenied(normalized) || normalized.startsWith("..") || normalized.startsWith("/")) {
        throw new Error(`iq: path is denied or outside the workspace: ${path}`);
    }
    return normalized;
};

// `iq outline <path>`, the file's symbol skeleton, with each entry's preceding doc first-line when present.
export const outlineOf = async (db: IndexDb, root: string, rawPath: string): Promise<RankedGroup[]> => {
    const path = guard(rawPath);
    const symbols = symbolsOfFile(db, path);
    if (symbols.length === 0) {
        return [];
    }
    const lines = (await readFile(join(root, path), "utf8").catch(() => "")).split(/\r?\n/);
    const hits = symbols.map((symbol, index) => {
        const above = lines[symbol.line - 2]?.trim() ?? "";
        const doc = /^(\/\/|\/\*|\*|#)/.test(above) ? `  ${above.replace(/^(\/\/|\/\*+|\*|#)\s?/, "// ")}` : "";
        return {
            path,
            line: symbol.line,
            text: `${symbol.signature}${doc}`,
            tags: symbol.heuristic ? [{ kind: "heuristic" as const }] : [],
            score: 1 / (index + 1),
        };
    });
    return [{ path, score: 1, hits }];
};

// `iq read` addresses a symbol by NAME — `path::name`, `path::Outer::method`, or a bare `name` — so a body costs one
// call instead of the `def` → `context path:line` round trip that was the only way to get one.
export interface SymbolRef {
    readonly path?: string;
    // Outermost first; the LAST element is the symbol whose body is wanted.
    readonly chain: readonly string[];
}

// A leading segment is a path if it has a separator or a file extension; `Outer::method` is then unambiguously a
// scope chain rather than a file.
const LOOKS_LIKE_PATH = /[/\\]|\.[a-z0-9]+$/i;

export const parseSymbolRef = (raw: string): SymbolRef => {
    const parts = raw
        .split("::")
        .map((part) => part.trim())
        .filter((part) => part !== "");
    const head = parts[0];
    if (head === undefined) {
        throw new Error(`iq read: expected a symbol like name, path::name or path::Outer::method, got: ${raw}`);
    }
    if (LOOKS_LIKE_PATH.test(head)) {
        if (parts.length === 1) {
            throw new Error(`iq read: "${raw}" names a file, not a symbol — \`iq outline ${raw}\` is that file's skeleton`);
        }
        return { path: guard(head), chain: parts.slice(1) };
    }
    return { chain: parts };
};

// Bodies returned at once before the answer becomes a file dump; past this the verb hands back anchors and asks to be
// narrowed, since reading is supposed to be the cheap half.
const MAX_BODIES = 3;

// Nesting is read off line spans because the index stores no parent link — the same way contextOf picks the smallest
// enclosing scope. Every chain element ahead of the last must enclose the target; their order among themselves is not
// checked, since containment already orders them in any real file.
const matchesChain = (siblings: readonly StoredSymbol[], symbol: StoredSymbol, chain: readonly string[]): boolean =>
    chain
        .slice(0, -1)
        .every((outer) =>
            siblings.some((other) => other.name === outer && other.line <= symbol.line && other.endLine >= symbol.endLine && other !== symbol),
        );

// Every symbol the ref could mean, best first: exported ahead of local, then smallest span, since the tightest
// definition of a name is what someone asking to read it means.
const refMatches = (db: IndexDb, ref: SymbolRef, allowed: ReadonlySet<string>): StoredSymbol[] => {
    const byPath = new Map<string, StoredSymbol[]>();
    for (const row of symbolRows(db, "")) {
        byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
    }
    return symbolRows(db, "WHERE s.name = ?", ref.chain.at(-1) ?? "")
        .filter((symbol) => allowed.has(symbol.path))
        .filter((symbol) => ref.path === undefined || symbol.path === ref.path)
        .filter((symbol) => matchesChain(byPath.get(symbol.path) ?? [], symbol, ref.chain))
        .toSorted((a, b) => Number(b.exported) - Number(a.exported) || a.endLine - a.line - (b.endLine - b.line));
};

// One symbol's live body off disk, grown by -C. Undefined when the file has gone since it was indexed.
const bodyOf = async (root: string, symbol: StoredSymbol, grow: number, rank: number): Promise<RankedGroup | undefined> => {
    const content = await readFile(join(root, symbol.path), "utf8").catch(() => undefined);
    if (content === undefined) {
        return undefined;
    }
    const lines = content.split(/\r?\n/);
    const from = Math.max(1, symbol.line - grow);
    const to = Math.min(lines.length, symbol.endLine + grow);
    const hits = [];
    for (let i = from; i <= to; i++) {
        hits.push({ path: symbol.path, line: i, text: lines[i - 1] ?? "", tags: [], score: 1 });
    }
    return { path: symbol.path, score: 1 / (rank + 1), hits };
};

// `iq read <symbol>`, the named symbol's live body, grown by -C. Unlike `context` the caller needs no line number,
// which is the whole point: the model names what it wants to see.
export const readOf = async (
    db: IndexDb,
    root: string,
    raw: string,
    grow: number,
    allowed: ReadonlySet<string>,
): Promise<{ groups: RankedGroup[]; label: string; hint?: string }> => {
    const ref = parseSymbolRef(raw);
    const name = ref.chain.at(-1) ?? "";
    const matches = refMatches(db, ref, allowed);
    const first = matches[0];
    if (first === undefined) {
        const where = ref.path === undefined ? "the workspace" : ref.path;
        return { groups: [], label: `${raw} — no symbol by that name in ${where}`, hint: `iq sym '${name}*' names the near misses` };
    }
    if (matches.length > MAX_BODIES) {
        return {
            groups: matches.map((symbol) => ({
                path: symbol.path,
                score: 1,
                hits: [{ path: symbol.path, line: symbol.line, text: symbol.signature, tags: [{ kind: "def" as const }], score: 1 }],
            })),
            label: `${name}, ${matches.length} definitions — anchors only, too many to read at once`,
            hint: `narrow with a path (\`iq read <path>::${name}\`) or --in <dir>`,
        };
    }
    const bodies = await Promise.all(matches.map((symbol, rank) => bodyOf(root, symbol, grow, rank)));
    const groups = bodies.filter((group): group is RankedGroup => group !== undefined);
    const label =
        matches.length === 1
            ? `${first.name} (${first.kind}) ${first.path}:${first.line}-${first.endLine}`
            : `${name}, ${matches.length} definitions`;
    return { groups, label };
};

export const parseAnchor = (anchor: string): { path: string; line: number; endLine?: number } => {
    const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(anchor);
    if (match === null) {
        throw new Error(`iq: expected an anchor like path:line, got: ${anchor}`);
    }
    return { path: guard(match[1]!), line: Number(match[2]), ...(match[3] !== undefined ? { endLine: Number(match[3]) } : {}) };
};

// `iq context <path:line>`, the smallest enclosing symbol's live body (fallback: ±20 lines), grown by -C.
export const contextOf = async (db: IndexDb, root: string, anchor: string, grow: number): Promise<{ groups: RankedGroup[]; label: string }> => {
    const { path, line } = parseAnchor(anchor);
    const content = await readFile(join(root, path), "utf8").catch(() => undefined);
    if (content === undefined) {
        throw new Error(`iq: no such file: ${path}`);
    }
    const lines = content.split(/\r?\n/);
    const enclosing = symbolsOfFile(db, path)
        .filter((symbol) => symbol.line <= line && symbol.endLine >= line)
        .toSorted((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
    const from = Math.max(1, (enclosing?.line ?? line - FALLBACK_RADIUS) - grow);
    const to = Math.min(lines.length, (enclosing?.endLine ?? line + FALLBACK_RADIUS) + grow);
    const hits = [];
    for (let i = from; i <= to; i++) {
        hits.push({ path, line: i, text: lines[i - 1] ?? "", tags: [], score: 1 });
    }
    const label = enclosing !== undefined ? `${enclosing.name} (${enclosing.kind}) ${path}:${from}-${to}` : `${path}:${from}-${to}`;
    return { groups: [{ path, score: 1, hits }], label };
};
