import { z } from "zod";

// What a runtime's own extensions put on screen, said the same way whichever runtime ran them: Pi's extension UI
// sub-protocol, Claude Code's informational lines, and whatever later runtime lets an in-process plugin draw. Two shapes
// and nothing more. A status entry is live state (a keyed line beside the composer, replaced by its key, gone when the
// turn ends), so it travels as a turn fact. A notice is something that happened, so it folds into the transcript as a
// notice row and a reopened conversation still says it. A dialog an extension opens is neither: it rides the question
// card every runtime already uses.

// How loud a notice is. `info` is a muted line, `warning` and `error` are drawn in their colour; a runtime's own scale
// is folded onto these three where it reaches the wire.
export const AgentNoticeLevelSchema = z.enum(["info", "warning", "error"]);
export type AgentNoticeLevel = z.infer<typeof AgentNoticeLevelSchema>;

// What a notice row carries beside its `text`: the level it was said at, and who said it.
export const TranscriptAgentNoticeSchema = z.object({
    level: AgentNoticeLevelSchema.describe("How loud it was said: a muted line, a warning or an error."),
    source: z
        .string()
        .optional()
        .describe("Who said it, when the runtime named one: the extension or plugin, as the runtime spells it. Absent when the runtime's loop said it itself."),
});
export type TranscriptAgentNotice = z.infer<typeof TranscriptAgentNoticeSchema>;

// The two frames, as members of AgentEventSchema.
export const agentStatusEvent = {
    kind: z.literal("agent_status"),
    key: z.string().describe("Which entry: a later frame with the same key replaces it."),
    text: z
        .string()
        .nullable()
        .describe("The entry's words, one or more lines; null clears it. Every entry is gone once the turn ends, whatever it last said."),
    source: z.string().optional().describe("Who set it, when the runtime named one."),
} as const;

export const agentNoticeEvent = {
    kind: z.literal("agent_notice"),
    text: z.string().describe("The words, as plain text."),
    ...TranscriptAgentNoticeSchema.shape,
} as const;
