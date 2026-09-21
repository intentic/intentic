// context-trim: what a window too small for a full turn made the sandbox leave out
import { z } from "zod";

// A model's context window is data (providers/provider-oauth.ts `contextWindow`), and below a certain size the
// sandbox's own additions — the project map, the skill list, the search teaching, this product's guidance, the field
// notes — stop being help and become the reason a turn does not fit. This is that decision, said back: what was left
// out, and the window that left it out.
//
// It is the only disclosure there is. The notes that rode are drawn beside the message; a note that never rode has no
// message to be drawn beside, so without this the turn simply runs thinner and nothing on screen says why.

export const ContextTrimSchema = z.object({
    window: z.number().int().positive().describe("The window that decided it, in tokens, as the model's server declared it."),
    omitted: z
        .array(z.string())
        .describe("What was left out, under the same label the chat would have drawn it with, in the order a full turn would have read them."),
    base: z
        .boolean()
        .describe("Whether the agent loop's own base instructions were swapped for a short paragraph as well, which only a replacing runtime can do."),
});
export type ContextTrim = z.infer<typeof ContextTrimSchema>;

// Tokens as the windows are spoken about everywhere else in the product: 16k, 32k, and a server's own odd number
// spelled out in full.
const windowLabel = (tokens: number): string => (tokens % 1024 === 0 ? `${tokens / 1024}k` : tokens.toLocaleString("en-US"));

// The notice row a trimmed turn draws. Here rather than in the daemon because the frame is what travels, and a reader
// reopening the conversation months later renders it from the same words.
//
// The window comes first, since it is the fact that decided everything after it; each item keeps the label the chat
// would have drawn it under, so it can be matched against the fold beside a full turn's message. The closing clause is
// the one that has to be there: "the sandbox left some instructions out" otherwise reads as "my AGENTS.md may not have
// arrived".
export const contextTrimLine = ({ window, omitted, base }: ContextTrim): string => {
    const swapped = base ? ` The agent's own base instructions were swapped for a short paragraph, too.` : ``;
    const left = omitted.length === 0 ? `` : ` — left out: ${omitted.join(`, `)}`;
    return (
        `Sent thin for this model's ${windowLabel(window)} window${left}.${swapped}` +
        ` Your workspace rules, this turn's persona and where its files live still rode.`
    );
};
