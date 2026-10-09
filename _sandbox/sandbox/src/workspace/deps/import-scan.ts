// The module specifiers a source file names, read by pattern rather than parsed, as _tools/checks/lib/imports.mjs reads
// them for the boundary checks: static imports and re-exports, side-effect imports, `import()` and `require()`, and a
// stylesheet's `@import`, each at the line its specifier is on. A static clause naming only types is type-only; every
// other form loads the module it names. A Vue or Svelte component is read through its `<script>` and `<style>` blocks.

export interface ImportSite {
    readonly specifier: string;
    readonly typeOnly: boolean;
    readonly line: number;
}

// A static specifier is a string literal: a backtick there is a syntax error (TS1141), so only quotes are read. An `@`
// before `import` is a stylesheet's, which CSS_IMPORT reads.
const STATIC =
    /(?<![\w$.@])(?:import|export)\s+(type\s+)?(?:(\*(?:\s+as\s+[\w$]+)?|[\w$]+|\{[^}]*\})\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?\s*from\s*)?["']([^"']+)["']/dg;
// A call's specifier may be a template, and may follow a comment (`import(/* @vite-ignore */ "x")`) or come before
// import attributes (`import("x", { with: … })`).
const CALL = /(?<![\w$.@])(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(["'`])([^"'`]+)\1\s*[,)]/dg;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1/dg;

// `{ type A, type B }` erases at compile time; `{ type A, B }` and `{ A }` do not. A default or namespace binding is a
// value whatever follows it.
const namesOnlyTypes = (clause: string): boolean =>
    clause.startsWith("{") &&
    clause
        .slice(1, -1)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .every((name) => name.startsWith("type "));

const lineStarts = (text: string): number[] => {
    const starts = [0];
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        starts.push(at + 1);
    }
    return starts;
};

// 1-based line of a character offset.
const lineAt = (starts: readonly number[], offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (starts[middle]! <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return low + 1;
};

const STYLESHEET = /\.(?:css|scss|sass|less|pcss)$/;
const COMPONENT = /\.(?:vue|svelte)$/;

// A component's `<script>` and `<style>` blocks, everything else blanked to its newlines so a line stays the file's line.
const blocksOf = (text: string): string => {
    const blank = (part: string): string => part.replace(/[^\n]/g, " ");
    let code = "";
    let at = 0;
    for (const match of text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/dg)) {
        const [start, end] = match.indices![2]!;
        code += blank(text.slice(at, start)) + text.slice(start, end);
        at = end;
    }
    return code + blank(text.slice(at));
};

/** Every specifier `text` names, in the order the patterns found them. `path` picks how the file is read. */
export const importsOf = (path: string, text: string): ImportSite[] => {
    const code = COMPONENT.test(path) ? blocksOf(text) : text;
    const starts = lineStarts(code);
    const found: ImportSite[] = [];
    for (const match of code.matchAll(CSS_IMPORT)) {
        found.push({ specifier: match[2]!, typeOnly: false, line: lineAt(starts, match.indices![2]![0]) });
    }
    if (STYLESHEET.test(path)) {
        return found;
    }
    for (const match of code.matchAll(STATIC)) {
        const [, typeKeyword, clause, specifier] = match;
        const typeOnly = typeKeyword !== undefined || (clause !== undefined && namesOnlyTypes(clause));
        found.push({ specifier: specifier!, typeOnly, line: lineAt(starts, match.indices![3]![0]) });
    }
    for (const match of code.matchAll(CALL)) {
        const [, quote, specifier] = match;
        // A template with a substitution (`./locales/${locale}.json`) names a pattern, not one module.
        if (quote !== "`" || !specifier!.includes("${")) {
            found.push({ specifier: specifier!, typeOnly: false, line: lineAt(starts, match.indices![2]![0]) });
        }
    }
    return found;
};
