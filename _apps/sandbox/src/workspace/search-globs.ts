import type { Scope } from "@intentic/iq-engine";

/* The search box's second field, in the engine's vocabulary: VSCode writes "which files" as one comma-separated
 * list of path globs with `!` for the exclusions, and the engine takes two lists (`--glob` / `--not-glob`), so
 * the split happens here rather than in the browser — one grammar, one implementation, and the URL carries what
 * the reader typed.
 *
 * The comma is a separator everywhere except inside `{ts,py}`, which is one pattern's own alternation — the
 * same rule VSCode splits by, and without it the field's most useful shorthand would arrive as two broken
 * halves. Everything else is passed through verbatim: `*.test.ts`, `src/**` and `src/*.{ts,py}` all mean here
 * what they mean in the editor. */
const splitPatterns = (include: string): string[] => {
    const patterns: string[] = [];
    let current = "";
    let depth = 0;
    for (const char of include) {
        if (char === "," && depth === 0) {
            patterns.push(current);
            current = "";
            continue;
        }
        depth += char === "{" ? 1 : char === "}" && depth > 0 ? -1 : 0;
        current += char;
    }
    patterns.push(current);
    // A bare "!" excludes nothing, and as a glob it would match everything.
    return patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern !== "" && pattern !== "!");
};

/* A pattern with no wildcard is a directory ("_apps/web"), which the engine's glob only reads as a subtree when
 * it ends in a slash — so one is added. Typing a folder name is how most of these fields get used.
 *
 * A bare name with no slash in it means that folder wherever it sits ("web" → any web/), while a path is
 * anchored at the workspace root — the same split the editor's field makes, and the same one the engine makes
 * for a wildcard pattern (`*.ts` matches at any depth, `src/*.ts` only in src). */
const subtree = (pattern: string): string => {
    if (/[*?[\]{}]/.test(pattern)) {
        return pattern;
    }
    const directory = pattern.replace(/\/+$/, "");
    return directory.includes("/") ? `${directory}/` : `**/${directory}/`;
};

export const globScope = (include: string | undefined): Pick<Scope, "globs" | "notGlobs"> => {
    const patterns = splitPatterns(include ?? "");
    const globs = patterns.filter((pattern) => !pattern.startsWith("!")).map(subtree);
    const notGlobs = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => subtree(pattern.slice(1)));
    return { ...(globs.length > 0 ? { globs } : {}), ...(notGlobs.length > 0 ? { notGlobs } : {}) };
};
