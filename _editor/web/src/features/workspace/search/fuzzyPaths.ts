// The client half of quick-open. The scorer and the ranking order are `@intentic/base/fuzzy`, the same ones the
// sandbox's iq `files` engine answers with, so typing the same letters here and there puts the same file first.
import { fuzzyRanker } from "@intentic/base/fuzzy";

/**
 * A quick-open ranking that keeps its last answer: a keystroke that extends the query over the same path list scores
 * only what still matched. Answers the query's best matches, capped at `limit`.
 */
export const pathRanker = (limit: number): ((query: string, paths: readonly string[]) => string[]) => {
    const rank = fuzzyRanker();
    let source: readonly string[] | undefined;
    let unique: readonly string[] = [];
    return (query, paths) => {
        if (paths !== source) {
            source = paths;
            // Deduped before scoring: a repeated path would score twice and displace a genuine next-best match under the cap.
            unique = [...new Set(paths)];
        }
        return rank(query, unique)
            .slice(0, limit)
            .map((entry) => entry.path);
    };
};
