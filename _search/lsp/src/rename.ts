import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { findTsconfig } from "./checker.js";
import { LspSession } from "./lsp-rpc.js";
import { tsgoExePath } from "./tsgo.js";

/* Project-wide rename, asked of the native compiler's language server — the same edit VS Code runs.
 *
 * The CLI names the symbol, not a position, so the position is recovered first: the server's own document
 * symbols give every declaration's name range, and the first one matching the requested name anchors the
 * rename. Symbols the outline does not carry (a parameter, a property in an object literal) fall back to a
 * lexical scan — every word-boundary occurrence of the name is offered to the server in order, and the first
 * position it agrees to rename from is the anchor. The server refusing every candidate is the honest failure:
 * nothing by that name can be renamed here. */

export interface RenameResult {
    readonly changedFiles: readonly string[];
    readonly edits: number;
}

const REQUEST_TIMEOUT_MS = 60_000;
// A lexical scan of a name-dense file can offer many positions; past this many refusals the answer is clear.
const MAX_CANDIDATES = 20;

interface Position {
    readonly line: number;
    readonly character: number;
}
interface Range {
    readonly start: Position;
    readonly end: Position;
}
interface DocumentSymbol {
    readonly name: string;
    readonly selectionRange: Range;
    readonly children?: readonly DocumentSymbol[];
}
interface TextEdit {
    readonly range: Range;
    readonly newText: string;
}
interface WorkspaceEdit {
    readonly changes?: Record<string, readonly TextEdit[]>;
    readonly documentChanges?: readonly { readonly textDocument?: { readonly uri: string }; readonly edits?: readonly TextEdit[] }[];
}

const LANGUAGE_IDS: Record<string, string> = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
};

// Positions in LSP are UTF-16 line/character pairs; JS strings are UTF-16, so both directions are plain counting.
const offsetOf = (text: string, position: Position): number => {
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
        const next = text.indexOf("\n", offset);
        if (next === -1) {
            return text.length;
        }
        offset = next + 1;
    }
    return Math.min(offset + position.character, text.length);
};

const positionOf = (text: string, offset: number): Position => {
    let line = 0;
    let lineStart = 0;
    for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
        line += 1;
        lineStart = i + 1;
    }
    return { line, character: offset - lineStart };
};

// Document order, declarations before their members — the anchor is the FIRST declaration by that name.
const symbolPosition = (symbols: readonly DocumentSymbol[], name: string): Position | undefined => {
    for (const symbol of symbols) {
        // The outline reports a property's name as declared; a quoted or computed one never string-matches, which
        // is fine — the lexical fallback covers it.
        if (symbol.name === name) {
            return symbol.selectionRange.start;
        }
        const inChildren = symbolPosition(symbol.children ?? [], name);
        if (inChildren !== undefined) {
            return inChildren;
        }
    }
    return undefined;
};

// Every word-boundary occurrence of the name, as positions — the candidates the server is asked to rename from
// when the outline has no anchor to offer.
const lexicalCandidates = (text: string, name: string): Position[] => {
    const positions: Position[] = [];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{ID_Continue}$])${escaped}(?![\\p{ID_Continue}$])`, "gu");
    for (let match = pattern.exec(text); match !== null && positions.length < MAX_CANDIDATES; match = pattern.exec(text)) {
        positions.push(positionOf(text, match.index));
    }
    return positions;
};

const collectEdits = (edit: WorkspaceEdit): Map<string, TextEdit[]> => {
    const byFile = new Map<string, TextEdit[]>();
    const add = (uri: string, edits: readonly TextEdit[]): void => {
        const file = new URL(uri).pathname;
        const list = byFile.get(file) ?? [];
        list.push(...edits);
        byFile.set(file, list);
    };
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
        add(uri, edits);
    }
    for (const change of edit.documentChanges ?? []) {
        if (change.textDocument !== undefined && change.edits !== undefined) {
            add(change.textDocument.uri, change.edits);
        }
    }
    return byFile;
};

// Apply one file's edits back-to-front so earlier splices don't shift later offsets.
const applyToFile = (file: string, edits: readonly TextEdit[]): void => {
    let text = readFileSync(file, "utf8");
    const ordered = edits.toSorted((a, b) => offsetOf(text, b.range.start) - offsetOf(text, a.range.start));
    for (const edit of ordered) {
        text = `${text.slice(0, offsetOf(text, edit.range.start))}${edit.newText}${text.slice(offsetOf(text, edit.range.end))}`;
    }
    writeFileSync(file, text);
};

// Rename every usage of the named symbol across its project and write each touched file. Throws when nothing
// by that name can be renamed from this file.
export const rename = async (file: string, symbol: string, newName: string): Promise<RenameResult> => {
    const text = readFileSync(file, "utf8");
    const uri = pathToFileURL(file).href;
    const rootDir = dirname(findTsconfig(file) ?? file);
    const session = new LspSession(tsgoExePath(), ["--lsp", "--stdio"], rootDir);
    try {
        await session.request(
            "initialize",
            {
                processId: process.pid,
                rootUri: pathToFileURL(rootDir).href,
                capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
            },
            REQUEST_TIMEOUT_MS,
        );
        session.notify("initialized", {});
        session.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: LANGUAGE_IDS[extname(file)] ?? "typescript", version: 1, text },
        });
        const outline = (await session.request("textDocument/documentSymbol", { textDocument: { uri } }, REQUEST_TIMEOUT_MS)) as
            readonly DocumentSymbol[] | null;
        const anchored = outline === null ? undefined : symbolPosition(outline, symbol);
        const candidates = anchored !== undefined ? [anchored] : lexicalCandidates(text, symbol);
        if (candidates.length === 0) {
            throw new Error(`nothing named "${symbol}" in ${file}`);
        }
        let refusal: Error | undefined;
        for (const position of candidates) {
            let edit: WorkspaceEdit | null;
            try {
                edit = (await session.request(
                    "textDocument/rename",
                    { textDocument: { uri }, position, newName },
                    REQUEST_TIMEOUT_MS,
                )) as WorkspaceEdit | null;
            } catch (error) {
                refusal = error instanceof Error ? error : new Error(String(error));
                continue;
            }
            const byFile = edit === null ? new Map<string, TextEdit[]>() : collectEdits(edit);
            if (byFile.size === 0) {
                continue;
            }
            let edits = 0;
            for (const [target, textEdits] of byFile) {
                applyToFile(target, textEdits);
                edits += textEdits.length;
            }
            return { changedFiles: [...byFile.keys()], edits };
        }
        throw refusal ?? new Error(`"${symbol}" cannot be renamed from ${file} (it may be external or ambient)`);
    } finally {
        session.dispose();
    }
};
