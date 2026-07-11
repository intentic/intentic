export type QueryKind = "path" | "identifier" | "regex" | "natural";

const IDENTIFIER = /^[A-Za-z_$][\w$]*([.#][\w$]+)*$/;
const REGEX_META = /[\\^$.|+()[\]{]/;

const compiles = (pattern: string): boolean => {
    try {
        return new RegExp(pattern) instanceof RegExp;
    } catch {
        return false;
    }
};

// Deterministic auto-mode classification, first match wins:
// path-shaped → identifier → regex → natural language.
export const classify = (query: string): QueryKind => {
    const trimmed = query.trim();
    // Dots, stars and question marks are path-normal (extensions, globs) — only other regex metachars disqualify.
    if (!/\s/.test(trimmed) && (trimmed.includes("/") || /[*?]/.test(trimmed)) && !REGEX_META.test(trimmed.replace(/[*?.]/g, ""))) {
        return "path";
    }
    if (IDENTIFIER.test(trimmed)) {
        return "identifier";
    }
    if (!/\s/.test(trimmed) && REGEX_META.test(trimmed) && compiles(trimmed)) {
        return "regex";
    }
    return "natural";
};
