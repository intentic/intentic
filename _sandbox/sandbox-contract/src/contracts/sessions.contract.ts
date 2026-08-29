import { oc } from "@orpc/contract";
import { z } from "zod";
import { SessionTranscriptSchema } from "../events.js";
import { SessionIdParamSchema, SessionsListSchema } from "../schemas/sessions.js";

// Past conversations in this workspace (the SDK-native session store, keyed on the working dir, which for a
// repo covers its linked worktrees too, so an isolated conversation's transcript is reachable from the
// workspace root). `list` returns summaries for the history menu (filtered by `query` when the search box is
// used); `get` restores one transcript for display.
//
// `caseSensitive` is the filter's Aa switch, on the same terms as the fleet search's, off means the letters do
// not matter, and the two routes answer one query together (the board lists these rows under its own cards), so
// a switch either of them ignored would show as one field returning two different match sets.
export const sessionsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/sessions",
            summary: "Past conversations in this workspace",
            description:
                "Summaries for a history menu, filtered when you pass a search. Covers conversations that worked in their own private copies too, so nothing is hidden just because it happened on a branch.",
        })
        .input(z.object({ query: z.string().optional(), caseSensitive: z.stringbool().optional() }))
        .output(SessionsListSchema),
    get: oc
        .route({
            method: "GET",
            path: "/sessions/{id}",
            summary: "Read one past conversation",
            description: "The full record of a single conversation, restored for display.",
        })
        .input(SessionIdParamSchema)
        .output(SessionTranscriptSchema),
};
