// share: a conversation published as a page
import { z } from "zod";
// A share renders the conversation into an ordinary published page under the same `public-<slot>` hostname as the
// outbox, with the same guards. It is a snapshot: the page holds the conversation as it read at `sharedAt` until
// re-shared.

// messages carries only the two speakers' words. everything adds the agent's tool cards, diffs and thinking, publishing
// any code or command output they contain.
export const ShareDetailSchema = z.enum(["messages", "everything"]);
export type ShareDetail = z.infer<typeof ShareDetailSchema>;
// One shared conversation, as the Public view lists it.
export const SharedConversationSchema = z.object({
    // The share's own id, minted per share, not the conversation's id; re-sharing the same conversation yields two
    // links.
    id: z
        .string()
        .describe(
            "The share's own id, minted fresh each time, so sharing one conversation twice gives two links. Deliberately not the conversation's id, which is memorable by design and would make a page's address guessable.",
        ),
    // Which conversation this was taken from; what Update re-reads and matching uses to find an existing share.
    conversationId: z.string().describe("Which conversation it was taken from."),
    title: z.string().describe("The title on the page, which is the sharer's choice rather than the conversation's own."),
    detail: ShareDetailSchema.describe(
        "How much travels: the two speakers' words alone, or the whole record including the agent's work and thinking, which necessarily publishes the code and command output in it.",
    ),
    // Epoch ms of the snapshot; a share is frozen, so this dates what the recipient sees, not the conversation.
    sharedAt: z
        .number()
        .describe(
            "When the snapshot was taken, in milliseconds. A share is frozen, so this dates what a recipient can see rather than when the conversation happened.",
        ),
    // How many messages the snapshot holds.
    messages: z.number().describe("How many messages are behind the link."),
    // The page's URL; absent when the sandbox has no tunnel to publish to.
    url: z.string().optional().describe("The page's address. Absent on a sandbox with nowhere to publish to."),
});
export type SharedConversation = z.infer<typeof SharedConversationSchema>;
export const ShareListSchema = z.object({ shares: z.array(SharedConversationSchema).describe("Every conversation currently published as a page.") });
export type ShareList = z.infer<typeof ShareListSchema>;
// Title is the sharer's, not the conversation's default name. Capped at 80, matching the registry's MAX_LENGTH in
// title.ts.
export const ShareCreateSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation to publish."),
    title: z.string().min(1).max(80).describe("The title for the page. The conversation's own name is only what a dialog would open with."),
    detail: ShareDetailSchema.describe(
        "How much to publish. Two levels rather than a set of switches, because every extra toggle is another thing to get wrong about a link that cannot be recalled.",
    ),
});
// Re-takes an existing share's snapshot; the id, and its already-sent link, stays the same.
export const ShareUpdateSchema = z.object({
    id: z.string().min(1).describe("Which share to re-take. Its link stays the same, which matters because it has already been sent."),
});
export const ShareRemoveSchema = z.object({ id: z.string().min(1).describe("Which share to take down.") });
