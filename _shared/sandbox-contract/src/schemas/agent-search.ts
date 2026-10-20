import { z } from "zod";

// The board's search over what conversations said: the query, and what came back with its evidence.

// Searches only speech, both sides of the conversation, never thinking, tool output or protocol text, which would
// otherwise match nearly the whole board. Two-char minimum; `caseSensitive` off means case-insensitive, matching
// workspace search's own switch.
export const AgentSearchQuerySchema = z.object({
    query: z
        .string()
        .trim()
        .min(2)
        .describe(
            "What to look for. Searched against what was said, both sides of the conversation, and nothing else: not the thinking, not the tool output, which between them name nearly every identifier in the workspace and would return most of the board.",
        ),
    caseSensitive: z.stringbool().optional().describe("Whether capitals matter."),
});
// Why a row survived the filter: the matched line, windowed, and who said it. `speaker` rides with the text since agent
// prose alone can read as something the user typed.
export const SpeakerSchema = z.enum(["user", "agent"]);
export type Speaker = z.infer<typeof SpeakerSchema>;
export const MatchSnippetSchema = z.object({
    text: z.string().describe("The matching line, with a little either side of it."),
    speaker: SpeakerSchema.describe(
        "Who said it. Carried with the words rather than beside them, because a line of the agent's prose under a card reads as something you typed until the row says otherwise.",
    ),
});
export type MatchSnippet = z.infer<typeof MatchSnippetSchema>;
// One matching agent and its evidence; `snippet` is absent for a title match, which the card already shows.
export const AgentMatchSchema = z.object({
    id: z.string().describe("Which conversation matched."),
    snippet: MatchSnippetSchema.optional().describe(
        "Why, in its own words. Absent when the title was the match, which the card already shows: repeating it underneath is noise where evidence was wanted.",
    ),
});
export type AgentMatch = z.infer<typeof AgentMatchSchema>;
// How many agents were actually read, so the board can say a search saw less than the whole fleet.
export const AgentSearchResultSchema = z.object({
    matches: z.array(AgentMatchSchema).describe("What matched, from the live fleet and the archive together."),
    scanned: z
        .number()
        .describe(
            "How many conversations were actually read, so a screen can say when a search saw less than everything rather than implying it saw all of it.",
        ),
    indexing: z
        .boolean()
        .describe(
            "Whether what was said is still being read in the background. True means this answer can still grow, so a screen must say it is incomplete rather than presenting it as the whole list.",
        ),
});
export type AgentSearchResult = z.infer<typeof AgentSearchResultSchema>;
