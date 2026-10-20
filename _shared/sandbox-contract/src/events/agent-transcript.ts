import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "../schemas/agent.js";
import { SessionTranscriptSchema, TurnEndingSchema } from "./transcript.js";

// The record a reopened tab rebuilds from: messages plus what the session is bound to (provider, runtime, account). A
// client can't derive these: after a mid-chat switch, its own picks belong to a different session.
export const AgentTranscriptSchema = SessionTranscriptSchema.extend({
    sessionId: z.string().optional().describe("The provider session behind the last turn, when there is one."),
    provider: AgentProviderSchema.optional().describe("Which provider minted that session."),
    harness: AgentHarnessSchema.optional().describe("Which runtime minted it: a session resumes only on the loop that opened it."),
    account: z
        .string()
        .optional()
        .describe("Which stored account it belongs to, as the daemon resolved it. Absent when no stored account paid for the turn."),
    // How the last turn ended, for endings that leave a live session with just a press to offer; absent otherwise.
    ending: TurnEndingSchema.optional().describe(
        "How the last turn ended, when it left work behind that one press finishes. Absent for a conversation whose last turn ended on its own, and for the failures that name something to repair first.",
    ),
    // `from` offsets every `rewindIndex` here, and is the `before` for the page above; `more` flags older messages.
    from: z
        .number()
        .int()
        .nonnegative()
        .describe("Where the first message sits in the whole record, and the `before` that asks for the page above this one."),
    more: z.boolean().describe("Whether older messages precede this page."),
    // The cursor a reader keeps between reads: `through` (with the id of the row just before it) is the `after` of its
    // next read, which then carries only what the record gained since.
    through: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            "The position just past this page's last message: pass it back as `after`, with that message's `rowId` as `afterRow`, to read only what the record gains from here on. Absent from a sandbox older than reading forward.",
        ),
    continuous: z
        .boolean()
        .optional()
        .describe(
            "Answered to a read with `after`: true when these messages carry on exactly from there, to be added to what the reader holds; false when the record no longer runs through that point (a rewind since, or more written than one page carries), so this is its latest page instead, to replace what the reader holds.",
        ),
    live: z
        .string()
        .optional()
        .describe(
            "The run going on in this conversation right now, which the record does not hold yet: attach to it for its rows as they are drawn. Absent when nothing runs.",
        ),
});
