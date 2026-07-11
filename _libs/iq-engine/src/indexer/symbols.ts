import type { SgNode } from "@ast-grep/napi";
import type { SymbolRow } from "../types.js";
import { LANGUAGES, parseLang } from "./languages.js";

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
        const name = declarator.field("name")?.text();
        if (name === undefined) {
            continue;
        }
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

// Docs/config/markup never hold definitions — heuristic patterns would turn prose code samples into fake symbols.
const NON_CODE = /\.(md|mdx|rst|txt|json|jsonc|ya?ml|toml|ini|lock|csv|html|xml|svg|css|scss)$/i;

export const extractSymbols = (path: string, lang: string | undefined, content: string): SymbolRow[] => {
    if (NON_CODE.test(path)) {
        return [];
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
