// The client half of quick-open. The scorer and the ranking order are `@intentic/base/fuzzy`, the same ones the
// sandbox's iq `files` engine answers with, so typing the same letters here and there puts the same file first.
import { rankByFuzzy } from "@intentic/base/fuzzy";

/** The query's best matches over the workspace paths, capped at `limit`. */
export const rankPaths = (query: string, paths: readonly string[], limit: number): string[] =>
    // Deduped before scoring: a repeated path would score twice and displace a genuine next-best match under the cap.
    rankByFuzzy(query, new Set(paths))
        .slice(0, limit)
        .map((entry) => entry.path);
