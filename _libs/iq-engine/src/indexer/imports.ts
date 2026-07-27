import { NON_CODE } from "./languages.js";
import { scriptBlocksOf } from "./sfc.js";

// Module specifiers a file imports — the edges of `iq map`'s reference graph. An import is the one statement in
// a file that unambiguously says "this file depends on that one", which is why the map is built on these rather
// than on symbol-name text matches: a name like `App` or `Host` occurs everywhere and proves nothing.
//
// Extraction is deliberately lexical rather than per-grammar AST rules. Module specifiers are quoted strings in
// a handful of rigid syntactic positions, and — the reason this is safe — a specifier that isn't real simply
// fails to resolve to an indexed file and vanishes. Resolution is the filter, so a permissive scanner costs
// nothing and spares us six per-language kind tables that would drift on grammar upgrades.

const PATTERNS: readonly RegExp[] = [
    // import x from "m" · export { x } from "m" · import type { x } from "m"
    /\b(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"'\n]+)["']/g,
    // side-effect import: import "m"
    /\bimport\s*["']([^"'\n]+)["']/g,
    // require("m") and dynamic import("m")
    /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    // Python: from m import x · import m
    /^\s*from\s+([\w.]+)\s+import\b/gm,
    /^\s*import\s+([\w.]+)\s*$/gm,
    // Go import blocks and Rust/Java paths, whose specifiers are unquoted or dotted.
    /^\s*use\s+([\w:]+)/gm,
    /^\s*import\s+([\w.]+);/gm,
];

export const extractImports = (path: string, lang: string | undefined, content: string): string[] => {
    if (NON_CODE.test(path)) {
        return [];
    }
    if (lang === "vue") {
        return scriptBlocksOf(content).flatMap((block) => extractImports(path, block.lang, block.content));
    }
    const specifiers = new Set<string>();
    for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
            const specifier = match[1]!.trim();
            if (specifier !== "") {
                specifiers.add(specifier);
            }
        }
    }
    return [...specifiers];
};
