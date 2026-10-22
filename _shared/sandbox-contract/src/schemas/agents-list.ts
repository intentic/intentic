import { z } from "zod";
import { AgentSummarySchema } from "./agents.js";
import { ConversationIdSchema } from "./agent.js";
import { AutomationApprovalSchema } from "./automations.js";

// The fleet list: its own module, since it joins conversations (agents.ts) with held automation wakes (automations.ts),
// and agents.ts reaches automations.ts through needs.ts (a need can propose an automation), so neither may hold it.
// `rev` is the registry revision this roster was read at: fleet snapshots are last-frame-wins, so the browser drops any
// roster older than the newest it applied and holds a pending change until a roster past `rev` arrives. `held` is the
// approvals queue projected onto the board, defaulted for an older daemon's roster.
export const AgentsListSchema = z.object({
    agents: z.array(AgentSummarySchema).describe("The conversations."),
    rev: z
        .number()
        .describe(
            "Which version of the fleet this is. The fleet is published as whole snapshots, so without a version a list read before a change but delivered after it would silently undo that change. Drop any list older than the newest you have already applied.",
        ),
    held: z
        .array(AutomationApprovalSchema)
        .default([])
        .describe(
            "Automations waiting at the door for a yes, put alongside the running conversations so needs-you sits beside working rather than on a page nobody opens.",
        ),
});
export type AgentsList = z.infer<typeof AgentsListSchema>;

// What the fleet owes its owner, counted by the board's own rules (models/agent-lanes.ts `fleetAttention`): what the
// desktop app's status bar and `ic sandbox attention` read over the loopback port, so neither has to fetch the whole
// roster and fold it the way the board does.
export const AgentsAttentionSchema = z.object({
    needsYou: z
        .number()
        .int()
        .nonnegative()
        .describe("How many cards the board's Attention lane draws (a child agent counted through its family's one card), plus the automations waiting for a yes."),
    working: z.number().int().nonnegative().describe("How many conversations are producing something right now."),
});
export type AgentsAttention = z.infer<typeof AgentsAttentionSchema>;

// The caller's home conversation in this sandbox (ids/conversation-ids.ts homeConversationId), as the master view opens it:
// the id is the daemon's answer to whose it is, so no client has to derive it, and the card once its first turn opened it.
export const HomeConversationSchema = z.object({
    conversationId: ConversationIdSchema.describe(
        "Your home conversation's id here. Send to it as to any conversation (`POST /agent`, isolated): its first turn opens it as your home.",
    ),
    agent: AgentSummarySchema.optional().describe("Its card, once a first turn has opened it. Absent until then."),
    lands: z
        .enum(["itself", "asks"])
        .describe(
            "What becomes of the work it accepts: `itself`, it lands and commits when its turn ends, because you may merge here; `asks`, it waits for a maintainer, because you may not.",
        ),
});
export type HomeConversation = z.infer<typeof HomeConversationSchema>;
