import type { SgNode } from "@ast-grep/napi";
import type { SymbolRow } from "../types.js";
import { LANGUAGES, NON_CODE, parseLang } from "./languages.js";
import { scriptBlocksOf } from "./sfc.js";

const SIGNATURE_MAX = 160;

const signatureOf = (node: SgNode): string => {
    const first = node.text().split("\n", 1)[0]!.trim();
    return first.length > SIGNATURE_MAX ? `${first.slice(0, SIGNATURE_MAX)}…` : first;
};

const isExported = (node: SgNode, lang: string, name: string): boolean => {
    if (lang === "go") {
        return /^[A-Z]/.test(name);
    }
    if (lang === "python") {
        return !name.startsWith("_");
    }
    if (lang === "rust") {
        return node.children().some((child) => child.kind() === "visibility_modifier");
    }
    for (let current: SgNode | null = node, depth = 0; current !== null && depth < 4; current = current.parent(), depth++) {
        if (current.kind() === "export_statement") {
            return true;
        }
    }
    return false;
};

const isTestPath = (path: string): boolean => /(^|\/)((__tests__|tests?)\/|test_[^/]*$)|\.(test|spec)\.[^/.]+$/.test(path);

const row = (path: string, lang: string, node: SgNode, name: string, kind: SymbolRow["kind"]): SymbolRow => {
    const range = node.range();
    return {
        name,
        kind: isTestPath(path) && (kind === "fn" || kind === "const") ? "test" : kind,
        line: range.start.line + 1,
        endLine: range.end.line + 1,
        signature: signatureOf(node),
        exported: isExported(node, lang, name),
        heuristic: false,
    };
};

// Top-level `const x = () => …` / `const x = 1` declarators (TS/JS only): fn when the value is a function.
const declaratorRows = (path: string, lang: string, root: SgNode): SymbolRow[] => {
    const rows: SymbolRow[] = [];
    for (const declarator of root.findAll({ rule: { kind: "variable_declarator" } })) {
        const statementParent = declarator.parent()?.parent()?.kind();
        if (statementParent !== "program" && statementParent !== "export_statement") {
            continue;
        }
        /* An identifier, or nothing. A declarator's name field is also where a DESTRUCTURING PATTERN lives, and
         * `.text()` on one yields the pattern source rather than a name — `{ app }`, `[logPath, pattern]`, and
         * in a `.vue` the whole multi-line `defineProps` destructure. 481 of those were in the index, 31 of them
         * spanning lines, and every consumer of the symbol table was worse for it: `iq def` offered them as
         * definitions, hits annotated themselves `⟨in { app } (const)⟩`, and the graph stage fed one to ripgrep
         * as a pattern and killed the query outright.
         *
         * Skipped rather than expanded into the names it binds. Those are re-binds and imports (`app`,
         * `version`, `utils`) — not what anyone means by the symbol defined here — and the statement is already
         * indexed as a chunk, so nothing becomes unfindable by dropping it. */
        const nameNode = declarator.field("name");
        if (nameNode === null || nameNode.kind() !== "identifier") {
            continue;
        }
        const name = nameNode.text();
        const value = declarator.field("value")?.kind();
        // Anchor the row on the whole statement (incl. `export const`) so the signature reads naturally.
        const statement = statementParent === "export_statement" ? declarator.parent()!.parent()! : declarator.parent()!;
        rows.push(row(path, lang, statement, name, value === "arrow_function" || value === "function_expression" ? "fn" : "const"));
    }
    return rows;
};

const HEURISTIC_PATTERNS: readonly { re: RegExp; kind: SymbolRow["kind"] }[] = [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "fn" },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "fn" },
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "fn" },
];

// Best-effort outline for languages without an ast-grep grammar — flagged so output can say "heuristic".
const heuristicSymbols = (path: string, content: string): SymbolRow[] => {
    const rows: SymbolRow[] = [];
    content.split(/\r?\n/).forEach((text, i) => {
        for (const { re, kind } of HEURISTIC_PATTERNS) {
            const match = re.exec(text);
            if (match !== null) {
                rows.push({
                    name: match[1]!,
                    kind: isTestPath(path) && kind === "fn" ? "test" : kind,
                    line: i + 1,
                    endLine: i + 1,
                    signature: text.trim().slice(0, SIGNATURE_MAX),
                    exported: !match[1]!.startsWith("_"),
                    heuristic: true,
                });
                return;
            }
        }
    });
    return rows;
};

// An SFC's symbols come from its <script> blocks, parsed as TypeScript and shifted back onto their real file
// lines, so `def`/`sym`/`outline` can see inside a component.
//
// A `<script setup>` body has no `export` statements, so nearly everything here reads as internal — which is
// accurate, and deliberately kept that way. Marking top-level declarations "exported" on the theory that a
// component's script is its public shape was tried and reverted: a component's locals are ordinary words
// (`step`, `busy`, `error`), so it turned every large component into a fake hub in the map's reference graph.
// A component is a consumer, not a definition site, and the export flag should say so.
const sfcSymbols = (path: string, content: string): SymbolRow[] => {
    const rows: SymbolRow[] = [];
    for (const block of scriptBlocksOf(content)) {
        for (const symbol of extractSymbols(path, block.lang, block.content)) {
            rows.push({ ...symbol, line: symbol.line + block.lineOffset, endLine: symbol.endLine + block.lineOffset });
        }
    }
    return rows.toSorted((a, b) => a.line - b.line);
};

export const extractSymbols = (path: string, lang: string | undefined, content: string): SymbolRow[] => {
    if (NON_CODE.test(path)) {
        return [];
    }
    if (lang === "vue") {
        return sfcSymbols(path, content);
    }
    const config = lang !== undefined ? LANGUAGES[lang] : undefined;
    if (lang === undefined || config === undefined) {
        return heuristicSymbols(path, content);
    }
    const root = parseLang(lang, content)?.root();
    if (root === undefined) {
        return heuristicSymbols(path, content);
    }
    const rows: SymbolRow[] = [];
    for (const rule of config.rules) {
        for (const node of root.findAll({ rule: { kind: rule.kind } })) {
            const name = node.field("name")?.text();
            if (name !== undefined && name !== "") {
                rows.push(row(path, lang, node, name, rule.symbolKind));
            }
        }
    }
    if (lang === "ts" || lang === "tsx" || lang === "js") {
        rows.push(...declaratorRows(path, lang, root));
    }
    // Python methods: function_definition nested in a class becomes method.
    if (lang === "python") {
        for (const item of rows) {
            if (item.kind === "fn" && rows.some((other) => other.kind === "class" && other.line < item.line && other.endLine >= item.endLine)) {
                rows[rows.indexOf(item)] = { ...item, kind: "method" };
            }
        }
    }
    return rows.toSorted((a, b) => a.line - b.line);
};
