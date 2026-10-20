import { z } from "zod";
import { ConversationIdSchema } from "./agent.js";

// Attaches to a conversation's newest run (live, or finished within retention); no cursor to resume from, the head
// carries all rows. `run` names what the client was watching, so a newer run's head id tells it to catch up.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema.describe("Which conversation to watch."),
    run: z
        .string()
        .optional()
        .describe(
            "The run you were watching. The stream opens on the conversation's newest run whatever you name: if a newer turn has started since, the head names that one instead, and its rows are that turn's.",
        ),
    // The next run after one the reader saw end, which the conversation's queue starts a moment after: waited for here,
    // where the start is an event, rather than looked for by a client asking again on a timer.
    after: z
        .string()
        .optional()
        .describe(
            "A run you already watched to its end. The stream opens on the first run after it, waiting a few seconds for one to start (the message the conversation's queue sends next) before answering that nothing runs.",
        ),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;
