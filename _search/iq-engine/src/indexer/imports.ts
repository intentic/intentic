import { NON_CODE } from "./languages.js";
import { scriptBlocksOf } from "./sfc.js";

// Module specifiers a file imports, the edges of `iq map`'s reference graph, built on imports rather than symbol-name
// matches since a name like `App` proves nothing. Extraction is lexical, not per-grammar AST: a specifier that fails to
// resolve to an indexed file simply vanishes, so a permissive scanner costs nothing.

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
