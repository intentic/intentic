import { z } from "zod";
// Shared by /workspace/search and the web client. Groups rank by relevance, best first; each hit carries match tags and
// the char spans in `text`, for highlighting without a re-find.
export const WorkspaceSearchQuerySchema = z.object({
    query: z.string().min(2).max(512).describe("What to look for. Plain words, a pattern, a symbol name, or a question."),
    // Search verbs only; anchor/git verbs are CLI-only. Natural language needs none, `q` classifies it.
    mode: z
        .enum(["q", "find", "files", "def", "refs", "sym", "ast"])
        .optional()
        .describe(
            "Narrow the search to one kind: plain text, filenames, definitions, references, symbols, or code structure. Leave it out to blend them, which also answers a question asked in words.",
        ),
    includeIgnored: z.stringbool().optional().describe("Search inside installed packages and other ignored folders too."),
    // The three switches every search box has; caseSensitive off means case-insensitive, not ripgrep's smart case.
    literal: z.stringbool().optional().describe("Treat the query as fixed text rather than a pattern."),
    word: z.stringbool().optional().describe("Match whole words only."),
    caseSensitive: z.stringbool().optional().describe("Whether capitals matter. Off means they do not, rather than being guessed at from the query."),
    // Files-to-include grammar: comma-separated patterns, any depth unless `./`-anchored, leading ! excludes.
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
    // Every matched span in text, in order; empty when the whole line is the match, not part of it.
    spans: z
        .array(WorkspaceSearchSpanSchema)
        .describe(
            "Where in the line the matches are, so you can highlight without searching again. Empty when the whole line is the match rather than part of it.",
        ),
    tags: z.array(WorkspaceSearchTagSchema).describe("Why it matched."),
    // Enclosing symbol or heading; often enough on its own, no need to open the file.
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
    // This file had more matches than kept per file; the count is a floor (say "50+", not "50").
    capped: z
        .boolean()
        .optional()
        .describe("This file had more matches than are kept per file, so the count is a floor. Say fifty-plus rather than fifty."),
});
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
// building means the index is still filling (progress 0..1); stale means revalidation was skipped. ageMs is time since
// the index last matched disk.
export const WorkspaceSearchFreshnessSchema = z.object({
    state: z.enum(["fresh", "building", "stale"]).describe("Whether the index matches what is on disk, is still filling, or has fallen behind."),
    ageMs: z.number().optional().describe("How long since it last matched the disk, in milliseconds."),
    progress: z.number().optional().describe("How far through building it is, from zero to one."),
    // How many files it hasn't caught up with; worth showing since "stale" alone reads as a warning.
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
    // Files matched in total; `groups` only reports the ones on this page.
    files: z.number().describe("Files the query matched in total."),
    shown: z.number().describe("How many of those lines are on this page."),
    groups: z.array(WorkspaceSearchGroupSchema).describe("The results, grouped by file, best first."),
    freshness: WorkspaceSearchFreshnessSchema.describe("Whether the index behind the answer is up to date."),
    truncated: z.boolean().describe("This page is not all of it. Use the cursor."),
    // A floor: some file had more matches than kept per file. Distinct from truncated, which is about the page.
    partial: z
        .boolean()
        .optional()
        .describe(
            "At least one file had more matches than are kept per file, so the total is a floor. Different from the page being truncated: a complete page can still count partially.",
        ),
    cursor: z.string().optional().describe("Pass this back as `after` to get the next page."),
    hint: z.string().optional().describe("A suggestion for getting a better answer out of this query."),
    // What the engine did unasked: a pattern rerun as literal, escapes rewritten, or a filter matching nothing.
    note: z
        .string()
        .optional()
        .describe(
            "What the engine did that you did not ask for: a pattern rerun as plain text because it was not valid, escapes rewritten, a language filter that matched nothing.",
        ),
    // Code-graph neighbors of the top hits: definition anchors and each one's strongest caller.
    related: z.array(z.string()).optional().describe("Places next door to the best results: where each is defined, and whatever calls it most."),
    // Ranked path:line anchors that placed but weren't shown, best first; the answer often sits at rank 5-13.
    candidates: z
        .array(z.string())
        .optional()
        .describe(
            "Ranked places that scored but did not make the page, best first. The answer often sits at rank five to thirteen, so this saves paging through to find out.",
        ),
    // Retrieval stages disabled for this run, for benchmarking; absent means the full pipeline ran.
    features: z.array(z.string()).optional().describe("Which stages of the search were switched off for this run. Absent means all of them ran."),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;
