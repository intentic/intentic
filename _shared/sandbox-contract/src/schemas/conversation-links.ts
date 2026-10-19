import { z } from "zod";
import { CONVERSATION_ID } from "../ids/conversation-ids.js";

// HOW ONE CONVERSATION RELATES TO ANOTHER at its birth, latched on its registry entry and carried on its card: the
// conversation a fork was cut from, and the work a fresh session was opened on. Re-exported by agent.ts, whose turn
// names them on a conversation's first turn.

// agent.ts's ConversationIdSchema, spelled here rather than imported, since agent.ts re-exports this module.
const ConversationIdSchema = z.string().regex(CONVERSATION_ID);

// Where a conversation was cut from, the durable half of a fork, carried on the registry entry. `index` is the message
// the cut sat above in the source, so its transcript can put the mark back.
export const ForkedFromSchema = z.object({
    conversationId: ConversationIdSchema,
    index: z.number().int().nonnegative(),
    // Which files this fork opened on; kept so the fork can still say it later, not only right after the click.
    files: z.enum(["then", "now"]),
});
export type ForkedFrom = z.infer<typeof ForkedFromSchema>;
// A FRESH SESSION on another conversation's work: a code review, a test pass, or a person's own ask, started from that
// conversation's work as it stands now and with none of its messages. A harness's own reviewer runs this way (Claude
// Code's /code-review in a forked subagent, Codex's /review in a thread of its own) so it judges the diff rather than
// the reasoning that produced it. Its first turn names the origin; the daemon then treats it as the origin's child: cut
// from its current work, its edits going back into it, folded under its card. It is still a person's chat, never woken
// for nor waking its origin: findings reach the origin only when a person sends them.
export const FRESH_KINDS = ["review", "test", "ask"] as const;
export const FreshKindSchema = z.enum(FRESH_KINDS);
export type FreshKind = z.infer<typeof FreshKindSchema>;
export const FreshOfSchema = z.object({
    conversationId: ConversationIdSchema.describe("The conversation whose work this one starts from."),
    kind: FreshKindSchema.describe("What it is opened for: a code review, a test pass, or the person's own ask."),
});
export type FreshOf = z.infer<typeof FreshOfSchema>;
// The durable half, latched on the entry by the first turn and never cleared: the relationship, not a pending state.
export const FreshSessionSchema = z.object({
    of: ConversationIdSchema.describe("The conversation whose work it started from."),
    kind: FreshKindSchema.describe("What it was opened for: a code review, a test pass, or the person's own ask."),
    at: z.number().describe("When it started, in milliseconds. Work its origin changed after this is work it has not seen."),
});
export type FreshSession = z.infer<typeof FreshSessionSchema>;

export const FRESH_OF_DESCRIPTION =
    "Open this conversation on another conversation's work as it stands now, with none of that conversation's messages: for a review or a test that should judge the work, not the reasoning behind it. Its edits go back into that work. First turn only, and only on a private copy.";

// The turn's own rules for `freshOf`: a new private copy of its own, never beside a fork's copy of a chat, never on itself.
export const freshOfIssues = (
    turn: { readonly freshOf?: FreshOf | undefined; readonly conversationId?: string | undefined; readonly isolated?: boolean | undefined; readonly forkOf?: unknown },
    ctx: z.RefinementCtx,
): void => {
    if (turn.freshOf === undefined) {
        return;
    }
    if (turn.conversationId === undefined || turn.isolated !== true) {
        ctx.addIssue({ code: "custom", message: "freshOf requires an isolated conversationId" });
    }
    if (turn.forkOf !== undefined) {
        ctx.addIssue({ code: "custom", message: "freshOf and forkOf are two different starts: a fork carries the conversation, a fresh session carries none of it" });
    }
    if (turn.freshOf.conversationId === turn.conversationId) {
        ctx.addIssue({ code: "custom", message: "a conversation cannot start fresh on its own work" });
    }
};
