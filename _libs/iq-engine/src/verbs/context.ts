import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

// `iq outline <path>` — the file's symbol skeleton, with each entry's preceding doc first-line when present.
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

export const parseAnchor = (anchor: string): { path: string; line: number; endLine?: number } => {
    const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(anchor);
    if (match === null) {
        throw new Error(`iq: expected an anchor like path:line, got: ${anchor}`);
    }
    return { path: guard(match[1]!), line: Number(match[2]), ...(match[3] !== undefined ? { endLine: Number(match[3]) } : {}) };
};

// `iq context <path:line>` — the smallest enclosing symbol's live body (fallback: ±20 lines), grown by -C.
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
