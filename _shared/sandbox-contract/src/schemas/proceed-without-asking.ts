import { z } from "zod";

// PROCEED WITHOUT ASKING (2026-11-19). In the shinobi-society audit 12 of the owner's messages were a bare go-ahead ("Go
// for all of it", "1. Yes.") arriving 5 to 47 minutes after an agent had stopped to propose, overnight turns stopped to
// ask while the owner slept, and parents wrote "the owner is asleep, don't ask" into the prompts of the agents they
// started. On, every turn is told plainly to carry on with its own recommendation and to stop only before something
// destructive or outward-facing (the daemon's agent/prompt/guidance.ts, entry `proceed`). Words, not a gate: whatever
// stops a turn regardless (a permission card, a held command, a payment, a credential release) still stops it. Off by
// default, which leaves every turn as it was. Night hours, while they are in force, say what a question gets instead.

/** The sandbox setting, declared here so settings.ts carries one line for it. */
export const proceedWithoutAskingSetting = z
    .boolean()
    .default(false)
    .describe(
        "Whether agents carry on with their own recommendation instead of stopping to propose or to ask for a go-ahead. They still stop before anything destructive (deleting work or data that cannot be recovered, rewriting shared history) or outward-facing (publishing, sending a message as you, a payment, a deploy, a push), and end with what they decided so you can overturn it. Subagents follow the conversation that started them. Any one conversation can say otherwise. While night hours are in force, they decide instead.",
    );

/** A conversation's own answer, as its card carries it; absent where it follows the sandbox (or the conversation that started it). */
export const proceedOverride = z
    .boolean()
    .optional()
    .describe(
        "This conversation's own answer to whether it proceeds without asking for a go-ahead. Absent means it follows the conversation that started it, if another one did, else the sandbox-wide setting.",
    );

/** POST /agents/{id}/proceed: one conversation's own answer, or null to follow again. */
export const AgentProceedSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    proceed: z
        .boolean()
        .nullable()
        .describe(
            "Whether it carries on with its own recommendation instead of stopping for a go-ahead, from its next turn. Null clears its own answer, so it follows the conversation that started it or the sandbox-wide setting again.",
        ),
});
export type AgentProceed = z.infer<typeof AgentProceedSchema>;
