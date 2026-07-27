import { Lang, parse, registerDynamicLanguage, type SgRoot } from "@ast-grep/napi";
import langGo from "@ast-grep/lang-go";
import langJava from "@ast-grep/lang-java";
import langPython from "@ast-grep/lang-python";
import langRust from "@ast-grep/lang-rust";
import type { SymbolRow } from "../types.js";

// One rule = one tree-sitter node kind mapped to a symbol kind. `nameField` defaults to "name".
export interface KindRule {
    readonly kind: string;
    readonly symbolKind: SymbolRow["kind"];
}

export interface LanguageConfig {
    // The id handed to ast-grep's parse() — a Lang enum value for built-ins, the registered name for packs.
    readonly astLang: string;
    readonly rules: readonly KindRule[];
}

let registered = false;

const ensureRegistered = (): void => {
    if (registered) {
        return;
    }
    registerDynamicLanguage({ python: langPython, go: langGo, rust: langRust, java: langJava } as Parameters<typeof registerDynamicLanguage>[0]);
    registered = true;
};

export const LANGUAGES: Record<string, LanguageConfig> = {
    ts: {
        astLang: Lang.TypeScript,
        rules: [
            { kind: "function_declaration", symbolKind: "fn" },
            { kind: "class_declaration", symbolKind: "class" },
            { kind: "interface_declaration", symbolKind: "type" },
            { kind: "type_alias_declaration", symbolKind: "type" },
            { kind: "enum_declaration", symbolKind: "type" },
            { kind: "method_definition", symbolKind: "method" },
        ],
    },
    tsx: {
        astLang: Lang.Tsx,
        rules: [
            { kind: "function_declaration", symbolKind: "fn" },
            { kind: "class_declaration", symbolKind: "class" },
            { kind: "interface_declaration", symbolKind: "type" },
            { kind: "type_alias_declaration", symbolKind: "type" },
            { kind: "method_definition", symbolKind: "method" },
        ],
    },
    js: {
        astLang: Lang.JavaScript,
        rules: [
            { kind: "function_declaration", symbolKind: "fn" },
            { kind: "class_declaration", symbolKind: "class" },
            { kind: "method_definition", symbolKind: "method" },
        ],
    },
    python: {
        astLang: "python",
        rules: [
            { kind: "function_definition", symbolKind: "fn" },
            { kind: "class_definition", symbolKind: "class" },
        ],
    },
    go: {
        astLang: "go",
        rules: [
            { kind: "function_declaration", symbolKind: "fn" },
            { kind: "method_declaration", symbolKind: "method" },
            { kind: "type_spec", symbolKind: "type" },
        ],
    },
    rust: {
        astLang: "rust",
        rules: [
            { kind: "function_item", symbolKind: "fn" },
            { kind: "struct_item", symbolKind: "type" },
            { kind: "enum_item", symbolKind: "type" },
            { kind: "trait_item", symbolKind: "type" },
            { kind: "const_item", symbolKind: "const" },
        ],
    },
    java: {
        astLang: "java",
        rules: [
            { kind: "method_declaration", symbolKind: "method" },
            { kind: "class_declaration", symbolKind: "class" },
            { kind: "interface_declaration", symbolKind: "type" },
            { kind: "enum_declaration", symbolKind: "type" },
        ],
    },
};

// Docs/config/markup hold no definitions and no code paths. Both the heuristic symbol patterns and the lexical
// complexity fallback are keyword scans, and on this kind of file they read the CONTENT as if it were code — a
// pnpm-lock.yaml scores 300+ branch points purely on `\bfor\b` matching inside hyphenated package names.
export const NON_CODE = /\.(md|mdx|rst|txt|json|jsonc|ya?ml|toml|ini|lock|csv|html|xml|svg|css|scss)$/i;

export const parseLang = (lang: string, content: string): SgRoot | undefined => {
    const config = LANGUAGES[lang];
    if (config === undefined) {
        return undefined;
    }
    ensureRegistered();
    return parse(config.astLang as Lang, content);
};
