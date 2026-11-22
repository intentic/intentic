import { z } from "zod";

// AUTO-APPROVE (2026-11-22). A mark a person puts on a conversation from its card, alone or on several selected at once,
// so it stops asking them anything a permission card would ask: every such card raised there, or in a subagent it
// starts, settles as allowed the moment it is raised, until somebody takes the mark off. Wider than a permission card's
// "Allow everything in this conversation" in two ways: it answers the owner's hard rules too (a destructive command on
// the sandbox or on one of the owner's computers), and the conversations it starts follow it. It still never answers a
// card whose consequence reaches other conversations (restarting the sandbox stops their turns too) or one addressed to
// a named person (a gated credential's approvers), and it never turns a refusal into a yes: what the owner's policy or a
// device's own switch refuses stays refused. Kept with the other yeses in the conversation grants, off anything an agent
// can write, and listed under Access ▸ Allowed, where it can be taken back too.

/** How a card carries the mark: its own, or followed from the conversation that started it. Absent: neither. */
export const autoApproveMark = z
    .enum(["own", "inherited"])
    .optional()
    .describe(
        "Whether every permission this conversation asks for is approved without asking anybody, the owner's hard rules included: `own` when it was marked itself, `inherited` when a conversation that started it was. Absent means its permission cards wait for a person as usual.",
    );
export type AutoApproveMark = z.infer<typeof autoApproveMark>;

/** POST /agents/auto-approve: puts the mark on, or takes it off, several conversations at once. */
export const AgentAutoApproveSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(500).describe("Which conversations."),
    on: z
        .boolean()
        .describe(
            "True marks each so its permission cards, and those of the subagents it starts, are approved without asking from now on, cards already waiting included. False takes each one's own mark off; a conversation started by one still marked keeps following that one.",
        ),
});
export type AgentAutoApprove = z.infer<typeof AgentAutoApproveSchema>;
