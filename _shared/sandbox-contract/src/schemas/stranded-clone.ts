import { z } from "zod";

// A repository a conversation cloned (or `git init`ed) inside its own copy of the workspace and left work in: it never
// rides that conversation's land, so the review lists it with what folding it into its parent, or keeping it as a
// workspace repository of its own, would carry.
export const StrandedCloneSchema = z.object({
    dir: z.string().describe("The clone, as a folder relative to its own copy of the workspace."),
    uncommitted: z.number().describe("Files changed in it and never committed."),
    unpushed: z.number().describe("Commits in it its upstream does not have, or that no remote has when it follows none."),
    commits: z
        .number()
        .optional()
        .describe("Commits it holds at all, 0 for a repository `git init` made and nothing was committed in: what folding it would drop. Absent from a sandbox too old to count them."),
    parent: z.string().optional().describe("The workspace repository it sits inside, `root` for the workspace's own: where folding puts its files."),
});
