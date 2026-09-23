// The module specifiers a TypeScript or JavaScript file names, read by pattern because the checks run before any install:
// static imports and re-exports, side-effect imports, `import()` and `require()`, each at the line its specifier is on.
// A static clause naming only types is type-only; every other form evaluates the module it names.

const STATIC =
    /(?<![\w$.])(?:import|export)\s+(type\s+)?(?:(\*(?:\s+as\s+[\w$]+)?|[\w$]+|\{[^}]*\})\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?\s*from\s*)?["']([^"']+)["']/dg;
const CALL = /(?<![\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/dg;

// `{ type A, type B }` erases at compile time; `{ type A, B }` and `{ A }` do not. A default or namespace binding is a
// value whatever follows it.
const namesOnlyTypes = (clause) =>
    clause.startsWith("{") &&
    clause
        .slice(1, -1)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .every((name) => name.startsWith("type "));

const lineStarts = (text) => {
    const starts = [0];
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        starts.push(at + 1);
    }
    return starts;
};

// 1-based line of a character offset.
const lineAt = (starts, offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (starts[middle] <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return low + 1;
};

/** @returns {{ specifier: string, typeOnly: boolean, line: number }[]} in the order the patterns found them */
export const importsOf = (text) => {
    const starts = lineStarts(text);
    const found = [];
    for (const match of text.matchAll(STATIC)) {
        const [, typeKeyword, clause, specifier] = match;
        const typeOnly = typeKeyword !== undefined || (clause !== undefined && namesOnlyTypes(clause));
        found.push({ specifier, typeOnly, line: lineAt(starts, match.indices[3][0]) });
    }
    for (const match of text.matchAll(CALL)) {
        found.push({ specifier: match[1], typeOnly: false, line: lineAt(starts, match.indices[1][0]) });
    }
    return found;
};
