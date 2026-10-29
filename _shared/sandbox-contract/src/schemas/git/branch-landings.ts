import { z } from "zod";
import { ConversationIdSchema } from "../agent.js";
import { RepoBranchSchema } from "../shared.js";

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const BranchLandingsQuerySchema = RepoBranchSchema.extend({
    before: CommitShaSchema.optional().describe("Continue before this landing from the previous page."),
});

export const BranchLandingSchema = z.object({
    sha: CommitShaSchema.describe("The landing commit, whose first parent is the state before this landing."),
    short: z.string().describe("Its abbreviated hash."),
    subject: z.string().describe("What the landing did."),
    at: z.number().describe("When it was committed, in milliseconds."),
    agent: ConversationIdSchema.describe("The session named by the commit's Conversation-Id trailer."),
});
export type BranchLanding = z.infer<typeof BranchLandingSchema>;

export const BranchLandingsSchema = z.object({
    mainBranch: z.string().describe("The main line excluded from this branch's landings."),
    commits: z.array(BranchLandingSchema).describe("Session commits on this branch's first-parent history, newest first, excluding the main line."),
    next: CommitShaSchema.optional().describe("Continue before this commit. Absent on the last page."),
});
export type BranchLandings = z.infer<typeof BranchLandingsSchema>;
