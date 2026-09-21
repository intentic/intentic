import { rankByFuzzy } from "@intentic/base/fuzzy";
import type { EngineHit } from "../types.js";
import { globToRegExp } from "../workspace/glob.js";

// No pattern lists every path in the sweep, sorted, never treated as an empty-result error. Only the `files` verb
// routes here; `q` calls fileSearch directly, where an empty pattern would flood fusion with every path.
export const filesVerbHits = (pattern: string, paths: readonly string[], glob: boolean): EngineHit[] =>
    pattern === ""
        ? paths.toSorted((a, b) => (a < b ? -1 : 1)).map((path) => ({ path, line: 1, text: path, tags: [{ kind: "path" as const }] }))
        : fileSearch(pattern, paths, glob);

// Filename search over the sweep's paths: fuzzy by default, exact globbing with `glob: true`. Hits are
// score-ranked; line 1 anchors the file itself.
export const fileSearch = (pattern: string, paths: readonly string[], glob: boolean): EngineHit[] => {
    if (glob) {
        const re = globToRegExp(pattern);
        return paths.filter((path) => re.test(path)).map((path) => ({ path, line: 1, text: path, tags: [{ kind: "path" as const }] }));
    }
    return rankByFuzzy(pattern, paths).map(({ path, score }) => ({
            path,
            line: 1,
            text: path,
            tags: [{ kind: "fuzzy" as const, score: Math.round(Math.min(1, score) * 100) / 100 }],
        }));
};
