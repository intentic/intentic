import { z } from "zod";

// A clone of its own a turn left inside its copy (TurnReach.stranded), settled one of two ways: folded into the
// repository it sits in, its own `.git` removed so its files land with the rest, or moved into the workspace as a
// repository of its own.
export const AgentCloneSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    dir: z.string().min(1).describe("The clone, exactly as the card's reach names it: a folder relative to the conversation's copy of the workspace."),
    action: z
        .enum(["fold", "adopt"])
        .describe(
            "`fold`: remove the clone's own `.git`, so its files are ordinary work of the repository it sits in and land with it. `adopt`: move it into your workspace at the same folder, `.git` and all, as a repository of its own.",
        ),
    dropCommits: z
        .number()
        .int()
        .optional()
        .describe(
            "For `fold` of a clone that holds commits: how many the caller was shown and agreed to drop. The files stay; only that history goes. Refused when absent or not the clone's count now.",
        ),
});
export type AgentClone = z.infer<typeof AgentCloneSchema>;
