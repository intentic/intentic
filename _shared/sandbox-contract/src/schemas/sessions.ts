import { z } from "zod";
import { MatchSnippetSchema } from "./agents.js";
export const SessionIdParamSchema = z.object({ id: z.string().describe("Which past conversation.") });
export const SessionSummarySchema = z.object({
    id: z.string().describe("Its id."),
    title: z.string().describe("What it is called."),
    updatedAt: z.number().describe("When it last moved, in milliseconds."),
    // Why a searched session matched: the line the query hit, windowed around it, and who said it. Absent on an
    // unfiltered list, and on a match the title already shows, a snippet repeating the row's own heading is
    // noise, not evidence. See AgentMatchSchema for the same field on the fleet's side.
    snippet: MatchSnippetSchema.optional().describe(
        "Why a search matched: the line it hit, with a little around it, and who said it. Absent on an unfiltered list, and on a match the title already shows, where repeating it would be noise rather than evidence.",
    ),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionsListSchema = z.object({ sessions: z.array(SessionSummarySchema).describe("Past conversations, newest first.") });
