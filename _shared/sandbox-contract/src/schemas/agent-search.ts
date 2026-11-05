import { z } from "zod";

// The board's search over what conversations said: the query, and what came back with its evidence.

// Spaces count, at the ends too: " ui " is the word, not "build" or "quit", and a box that trimmed them made the one
// cheap way to say "a whole word" impossible. A run of whitespace reads as one space, because every searched line is
// collapsed the same way, and a line's own start and end read as a space, so " fix" still finds a line opening "fix".
// One rule for the board's local tier, the daemon's index and its overlay, so the tiers never disagree on a hit.
export const MIN_SEARCH_CHARS = 2;

// The query as it is matched: whitespace runs folded to one space, never trimmed.
export const searchTermOf = (query: string): string => query.replace(/\s+/gu, " ");

// Whether a term is long enough to search: its spaces don't count toward the floor, or " a" would match most lines.
export const searchable = (term: string): boolean => term.trim().length >= MIN_SEARCH_CHARS;

// Where `term` starts in `line`, reading the line's ends as spaces; -1 when absent. Both are already folded to the
// same case.
export const indexOfTerm = (line: string, term: string): number => {
    const at = ` ${line} `.indexOf(term);
    return at === -1 ? -1 : Math.min(line.length, Math.max(0, at - 1));
};

// Searches only speech, both sides of the conversation, never thinking, tool output or protocol text, which would
// otherwise match nearly the whole board. Two characters besides spaces at least, the spaces kept as typed;
// `caseSensitive` off means case-insensitive, matching workspace search's own switch.
export const AgentSearchQuerySchema = z.object({
    query: z
        .string()
        .min(MIN_SEARCH_CHARS)
        .refine(searchable, { message: "Too short to search: two characters besides spaces." })
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
