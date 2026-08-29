import { z } from "zod";
// The workspace-search wire shape, shared by the daemon's /workspace/search route and the web client.
// (Implementation detail, not part of the contract: the daemon backs this route with a resident in-process iq
// engine; the engine is interchangeable behind this shape.) Groups are relevance-ranked (best first, never path
// order); each hit carries the match-reason tags the fused engines contributed, and the char spans within `text`
// that matched, so clients highlight without re-finding the needle.
export const WorkspaceSearchQuerySchema = z.object({
    query: z.string().min(2).max(512).describe("What to look for. Plain words, a pattern, a symbol name, or a question."),
    // Search verbs only, anchor/git verbs (outline, context, log, who, …) are CLI-only surface. Natural language
    // has no verb of its own: `q` classifies the query and answers it semantically when the words call for it.
    mode: z
        .enum(["q", "find", "files", "def", "refs", "sym", "ast"])
        .optional()
        .describe(
            "Narrow the search to one kind: plain text, filenames, definitions, references, symbols, or code structure. Leave it out to blend them, which also answers a question asked in words.",
        ),
    includeIgnored: z.stringbool().optional().describe("Search inside installed packages and other ignored folders too."),
    // How `find` reads the query, the three switches every editor's search box has (VSCode: Aa, ab, .*).
    // `literal` treats it as fixed text instead of a regex; `caseSensitive` off means case-INSENSITIVE, not
    // ripgrep's smart case.
    literal: z.stringbool().optional().describe("Treat the query as fixed text rather than a pattern."),
    word: z.stringbool().optional().describe("Match whole words only."),
    caseSensitive: z.stringbool().optional().describe("Whether capitals matter. Off means they do not, rather than being guessed at from the query."),
    // Which FILES the query is asked of, in VSCode's files-to-include grammar, as TYPED, because the reading
    // of it is shared (search-globs.ts) rather than each end guessing: comma-separated patterns, each matched
    // at any depth unless `./` anchors it, a leading `!` excluding instead. Distinct from `includeIgnored`,
    // which decides whether the ignored layers are searched at all, this narrows within what that admitted.
    include: z
        .string()
        .max(512)
        .optional()
        .describe(
            "Which files to ask, in the same grammar an editor's files-to-include box takes: comma-separated patterns, matched at any depth unless anchored, a leading exclamation mark excluding instead.",
        ),
    limit: z.coerce.number().int().positive().optional().describe("How many results to return."),
    after: z.string().optional().describe("Resume from the cursor a previous answer handed back."),
});
export const WorkspaceSearchTagSchema = z.object({
    kind: z
        .enum(["def", "text", "sem", "bm25", "rerank", "path", "import", "call", "type", "write", "fuzzy", "heuristic"])
        .describe(
            "Why this line matched: the literal text, its meaning, the path, a definition, a call, and so on. Several kinds can agree on one line.",
        ),
    score: z.number().optional().describe("How strongly that reason applied."),
});
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export const WorkspaceSearchSpanSchema = z.object({
    start: z.number().describe("First character of the match within the line."),
    end: z.number().describe("One past the last."),
});
export type WorkspaceSearchSpan = z.infer<typeof WorkspaceSearchSpanSchema>;
export const WorkspaceSearchHitSchema = z.object({
    line: z.number().describe("Which line, counting from one."),
    text: z.string().describe("The line itself."),
    // Every matched span in `text`, in order, a text search marks all of them, the way an editor does. Empty
    // where the LINE is the match and no span of it is (a semantic or definition hit reports none).
    spans: z
        .array(WorkspaceSearchSpanSchema)
        .describe(
            "Where in the line the matches are, so you can highlight without searching again. Empty when the whole line is the match rather than part of it.",
        ),
    tags: z.array(WorkspaceSearchTagSchema).describe("Why it matched."),
    // Enclosing symbol ("createWidget (fn)"), parent-document context so the reader often needs no follow-up.
    context: z
        .string()
        .optional()
        .describe("What it sits inside: the function, the class, the heading. Often enough that you need not open the file."),
});
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export const WorkspaceSearchGroupSchema = z.object({
    path: z.string().describe("The file."),
    score: z.number().describe("How well it matched. Groups arrive best first, never in path order."),
    hits: z.array(WorkspaceSearchHitSchema).describe("The matching lines in it."),
    // This file had more matching lines than the engine keeps per file, so `hits` is a floor, a panel showing a
    // per-file count has to say "50+" rather than "50".
    capped: z
        .boolean()
        .optional()
        .describe("This file had more matches than are kept per file, so the count is a floor. Say fifty-plus rather than fifty."),
});
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
// `building` = index still filling (progress 0..1, e.g. embeddings pending); `stale` = revalidation was skipped
// (cursor replay). ageMs = time since the index last matched the disk state.
export const WorkspaceSearchFreshnessSchema = z.object({
    state: z.enum(["fresh", "building", "stale"]).describe("Whether the index matches what is on disk, is still filling, or has fallen behind."),
    ageMs: z.number().optional().describe("How long since it last matched the disk, in milliseconds."),
    progress: z.number().optional().describe("How far through building it is, from zero to one."),
    // How many files the index has not caught up with, when it is stale. A count is reportable; "stale" alone
    // reads as a warning about the answer, which it almost never is.
    behind: z
        .number()
        .optional()
        .describe(
            "How many files it has not caught up with. Worth showing, because the word stale on its own reads as a warning about the answer, which it almost never is.",
        ),
});
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export const WorkspaceSearchResultSchema = z.object({
    mode: z.string().describe("Which kind of search actually ran, which matters when you let it choose."),
    total: z.number().describe("Matching lines across the whole workspace, not just this page."),
    // Files the query matched in total, which `groups` reports only for the page it carries, the count a
    // results panel puts beside the hit total ("218 results in 61 files").
    files: z.number().describe("Files the query matched in total."),
    shown: z.number().describe("How many of those lines are on this page."),
    groups: z.array(WorkspaceSearchGroupSchema).describe("The results, grouped by file, best first."),
    freshness: WorkspaceSearchFreshnessSchema.describe("Whether the index behind the answer is up to date."),
    truncated: z.boolean().describe("This page is not all of it. Use the cursor."),
    // `total` is a FLOOR: at least one file had more matches than the engine keeps per file. Distinct from
    // `truncated`, which is about this PAGE, a result can be complete on the page and still count partially.
    partial: z
        .boolean()
        .optional()
        .describe(
            "At least one file had more matches than are kept per file, so the total is a floor. Different from the page being truncated: a complete page can still count partially.",
        ),
    cursor: z.string().optional().describe("Pass this back as `after` to get the next page."),
    hint: z.string().optional().describe("A suggestion for getting a better answer out of this query."),
    // What the engine did with the query that the query did not ask for, a pattern rerun as literal text
    // because it is not valid regex, grep-style escapes rewritten, a language filter that matched no files. The
    // text surface has always printed this above the results; a JSON caller could not see it at all.
    note: z
        .string()
        .optional()
        .describe(
            "What the engine did that you did not ask for: a pattern rerun as plain text because it was not valid, escapes rewritten, a language filter that matched nothing.",
        ),
    // Code-graph neighbors of the top hits (definition anchors + the strongest caller of each).
    related: z.array(z.string()).optional().describe("Places next door to the best results: where each is defined, and whatever calls it most."),
    // Ranked `path:line` anchors that placed but were NOT shown, best first, the answer often sits at rank 5–13,
    // behind groups the budget spent itself on. The text surface has always printed this map; a JSON caller could
    // not see it, so it had to page through `cursor` to learn what the terminal was told up front.
    candidates: z
        .array(z.string())
        .optional()
        .describe(
            "Ranked places that scored but did not make the page, best first. The answer often sits at rank five to thirteen, so this saves paging through to find out.",
        ),
    // Run provenance for benchmarking: retrieval stages DISABLED this invocation (absent = full pipeline).
    features: z.array(z.string()).optional().describe("Which stages of the search were switched off for this run. Absent means all of them ran."),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;
