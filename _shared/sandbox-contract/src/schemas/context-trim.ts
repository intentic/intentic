// context-trim: what a window too small for a full turn made the sandbox leave out
import { z } from "zod";

// The only disclosure of a note that never rode; without it a turn runs thinner and nothing on screen says why.
export const ContextTrimSchema = z.object({
    window: z.number().int().positive().describe("The window that decided it, in tokens, as the model's server declared it."),
    omitted: z
        .array(z.string())
        .describe("What was left out, under the same label the chat would have drawn it with, in the order a full turn would have read them."),
    base: z
        .boolean()
        .describe(
            "Whether the agent loop's own base instructions were swapped for a short paragraph as well, which only a replacing runtime can do.",
        ),
});
export type ContextTrim = z.infer<typeof ContextTrimSchema>;

// 16k, 32k; a server's own odd number spelled out in full.
const windowLabel = (tokens: number): string => (tokens % 1024 === 0 ? `${tokens / 1024}k` : tokens.toLocaleString("en-US"));

// The closing clause is load-bearing: without it the row reads as "my AGENTS.md may not have arrived".
export const contextTrimLine = ({ window, omitted, base }: ContextTrim): string => {
    const swapped = base ? ` The agent's own base instructions were swapped for a short paragraph, too.` : ``;
    const left = omitted.length === 0 ? `` : ` — left out: ${omitted.join(`, `)}`;
    return (
        `Sent thin for this model's ${windowLabel(window)} window${left}.${swapped}` +
        ` Your workspace rules, this turn's persona and where its files live still rode.`
    );
};
