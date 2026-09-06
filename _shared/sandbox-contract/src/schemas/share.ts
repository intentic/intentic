// share: a conversation published as a page
import { z } from "zod";
/* The outbox holds FILES; a conversation is not one, so sharing it means RENDERING it into one. The result is
 * an ordinary published page under the same `public-<slot>` hostname, with the same guards in front of it,
 * which is the whole reason this rides the outbox rather than inventing a second public surface with its own
 * auth story to get wrong.
 *
 * A share is a SNAPSHOT, not a window. The page holds the conversation as it read at the moment of sharing and
 * does not move again until the owner re-takes it, because the alternative, a link that keeps publishing
 * whatever is said next, makes every later turn a disclosure the user did not consciously make. `sharedAt`
 * is therefore relied on by the row: it dates what the recipient can actually see. */

/* HOW MUCH OF A CONVERSATION TRAVELS, decided per share rather than by a setting, because the two answers suit
 * genuinely different acts. `messages` is the two speakers' words and nothing else, what you send a friend to
 * show what the thing said. `everything` adds the agent's work (its tool cards, the diffs of what it edited,
 * the pictures it took) and its thinking, what you send a colleague to show HOW it got there, and which
 * necessarily publishes the code and command output that appear in those cards.
 *
 * Two levels, not a set of switches: every extra toggle is another thing to get wrong about a link that cannot
 * be recalled once sent, and the honest distinction here is between "the conversation" and "the record". */
export const ShareDetailSchema = z.enum(["messages", "everything"]);
export type ShareDetail = z.infer<typeof ShareDetailSchema>;
// One shared conversation, as the Public view lists it.
export const SharedConversationSchema = z.object({
    /* The share's own id, and the name its page is filed under in the outbox. NOT the conversation's id: that
     * one is a memorable pair (`swift-otter-k9m2`, see conversation-ids.ts) chosen to be guessable BY A HUMAN
     * at a glance, which is the opposite of what should name a page whose only protection is that its address
     * is not enumerable. Minted per share, so re-sharing the same conversation twice yields two links. */
    id: z
        .string()
        .describe(
            "The share's own id, minted fresh each time, so sharing one conversation twice gives two links. Deliberately not the conversation's id, which is memorable by design and would make a page's address guessable.",
        ),
    // Which conversation the snapshot was taken from, what Update re-reads, and what the chat matches against
    // to know it already has a share.
    conversationId: z.string().describe("Which conversation it was taken from."),
    title: z.string().describe("The title on the page, which is the sharer's choice rather than the conversation's own."),
    detail: ShareDetailSchema.describe(
        "How much travels: the two speakers' words alone, or the whole record including the agent's work and thinking, which necessarily publishes the code and command output in it.",
    ),
    // When the snapshot was taken (epoch ms). A share is frozen, so this dates what a recipient can see,
    // not when the conversation happened.
    sharedAt: z
        .number()
        .describe(
            "When the snapshot was taken, in milliseconds. A share is frozen, so this dates what a recipient can see rather than when the conversation happened.",
        ),
    // How many messages the snapshot holds, so a row can say how much is behind the link without opening it.
    messages: z.number().describe("How many messages are behind the link."),
    // The page's public URL. Absent on a sandbox with no tunnel, which has nowhere to publish to, the same
    // rule (and the same cause) as PublicFile.url.
    url: z.string().optional().describe("The page's address. Absent on a sandbox with nowhere to publish to."),
});
export type SharedConversation = z.infer<typeof SharedConversationSchema>;
export const ShareListSchema = z.object({ shares: z.array(SharedConversationSchema).describe("Every conversation currently published as a page.") });
export type ShareList = z.infer<typeof ShareListSchema>;
// The title is the sharer's, not the conversation's: the chat's own name is only the default the dialog opens
// with. Bounded at the registry's title budget (title.ts MAX_LENGTH) so one surface can't store what the others
// truncate away.
export const ShareCreateSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation to publish."),
    title: z.string().min(1).max(80).describe("The title for the page. The conversation's own name is only what a dialog would open with."),
    detail: ShareDetailSchema.describe(
        "How much to publish. Two levels rather than a set of switches, because every extra toggle is another thing to get wrong about a link that cannot be recalled.",
    ),
});
// Re-take an existing share's snapshot, keeping its id, and therefore its link, which has already been sent.
export const ShareUpdateSchema = z.object({
    id: z.string().min(1).describe("Which share to re-take. Its link stays the same, which matters because it has already been sent."),
});
export const ShareRemoveSchema = z.object({ id: z.string().min(1).describe("Which share to take down.") });
