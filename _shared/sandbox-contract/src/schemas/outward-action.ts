import { z } from "zod";

// POST /capabilities/{id}/outward-action: an extension's backend, about to carry out an outward action with one of its
// cards' credentials, asks the owner's action rules for the verdict. The daemon decides, records and, on a hold, drafts
// the approvals-queue item the extension carries out once a person says yes; the extension decides nothing of the rule.

// The parts every call about one action carries, for its verdict and for its outcome alike.
const OutwardActionCallSchema = z.object({
    id: z.string().describe("The card whose credential it would use. Only a card the calling extension contributes."),
    action: z
        .string()
        .min(1)
        .max(100)
        .describe("The action below the card's kind, as the card's manifest declares it (`message.send`): the rules' key is `<kind>.<action>`."),
    conversationId: z.string().max(200).optional().describe("The conversation the action is for, as the call that asked for it named it. Absent for an approved one."),
    endpoint: z.string().max(500).optional().describe("Where it goes below the service (`/me/sendMail`), for its Activity row. Never a credential."),
    channel: z.string().max(500).optional().describe("Who or where it goes to, for its Activity row."),
    content: z.string().max(256 * 1024).optional().describe("What it says, for its Activity row."),
});
export const OutwardActionAskSchema = OutwardActionCallSchema.extend({
    hold: z
        .object({
            summary: z.string().min(1).max(200).describe("The approval's headline."),
            details: z.string().max(64 * 1024).describe("Everything the person should read before saying yes."),
            digest: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .describe("The SHA-256 of exactly what the extension will carry out, which it recomputes before acting."),
        })
        .optional()
        .describe("What to put before the owner when the rules hold it. Absent, a hold is only answered, never drafted (an approved action asking again)."),
});
export const OutwardActionVerdictSchema = z.discriminatedUnion("verdict", [
    z.object({ verdict: z.literal("allow").describe("Go ahead, then report how it went.") }),
    z.object({ verdict: z.literal("deny"), reason: z.string().describe("The rule's reason, to say to whoever asked.") }),
    z.object({
        verdict: z.literal("hold"),
        reason: z.string().describe("Why it waits."),
        approvalId: z.string().optional().describe("The approvals-queue item drafted for it, when the ask carried one."),
    }),
]);
export type OutwardActionVerdict = z.infer<typeof OutwardActionVerdictSchema>;
// POST /capabilities/{id}/outward-action/outcome: how an allowed or approved action went, for its Activity row.
export const OutwardActionOutcomeSchema = OutwardActionCallSchema.extend({
    outcome: z.enum(["ok", "error"]).describe("Whether it happened."),
    error: z.string().max(2000).optional().describe("What went wrong, in the service's own words."),
});
