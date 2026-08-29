// codebase health: one repository's structure and risk, in numbers
import { z } from "zod";
import { WorkspaceSearchFreshnessSchema } from "./workspace-search.js";
// The repo-level companion to the management panel and the git-history graph: what the same resident engine's
// `hotspots` (churn × complexity) and `map` (PageRank over the import graph) verbs rank, as figures a panel can
// plot instead of lines a terminal prints.
//
// Every field is a COUNT that can be recounted in the files themselves, commits, branch points, exported
// symbols. Deliberately no composite "maintainability grade": those aren't comparable across projects and can't
// be checked, and a repo-health surface that launders counts into a letter is worse than none.
// How many hotspot files and key modules a report carries when the caller names no limit. A leaderboard, not an
// inventory: past a screenful the ranking stops being the point, and the reader should be reading the files.
export const HEALTH_LIMIT = 20;
export const WorkspaceHealthQuerySchema = z.object({
    // "root" (the /work repo) or a nested repo's root-relative dir, the same {repo} ids the git routes take.
    repo: z.string().min(1).describe("Which repository, using the same ids the git routes take."),
    // Churn window (2d, 12h, 1w, 3m). Absent = all of history, which is what a hotspot ranking wants by default.
    since: z
        .string()
        .max(16)
        .optional()
        .describe("How far back to count changes, written as a span such as 2d, 12h, 1w or 3m. Leave it out for all of history."),
    limit: z.coerce
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("How many files and modules to rank. A leaderboard rather than an inventory: past a screenful the ranking stops being the point."),
});
// One file that is BOTH churning and tangled. `score` is the product the ranking sorts by, carried explicitly
// so the panel plots the number it ranks by rather than recomputing it.
export const WorkspaceHotspotSchema = z.object({
    path: z.string(),
    commits: z.number(),
    adds: z.number(),
    dels: z.number(),
    complexity: z.number(),
    score: z.number(),
    // Epoch ms of the latest commit touching the file, within the window.
    latestMs: z.number(),
});
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
// A file of the import graph's ranked skeleton, order IS the rank, so no rank number rides along.
export const WorkspaceKeyModuleSchema = z.object({ path: z.string(), exports: z.number() });
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export const WorkspaceHealthSchema = z.object({
    repo: z.string().describe("Which repository this describes."),
    totals: z
        .object({
            files: z.number().describe("Files counted."),
            symbols: z.number().describe("Named things they export."),
            complexity: z.number().describe("Branch points across all of them added up."),
            hotspots: z.number().describe("How many files qualify as hotspots at all. The list below is capped; this is not."),
        })
        .describe(
            "Counts anybody could recount in the files themselves. Deliberately no single maintainability grade: those cannot be checked and are not comparable between projects.",
        ),
    hotspots: z.array(WorkspaceHotspotSchema).describe("Files that change often and are complicated at the same time, worst first."),
    modules: z.array(WorkspaceKeyModuleSchema).describe("The parts of the codebase the rest of it leans on most."),
    // Same index-freshness signal the search route reports: a panel drawn off a half-built index says so.
    freshness: WorkspaceSearchFreshnessSchema.describe("Whether the index these numbers were read from is up to date."),
});
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;
