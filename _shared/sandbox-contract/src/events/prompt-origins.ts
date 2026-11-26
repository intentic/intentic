import { z } from "zod";

// What reached a conversation as a prompt, and what came with one, as its user row carries it: a watch, a need or another
// agent that woke it, and the file a person was looking at when they wrote it. Re-exported by transcript.ts.

// Every ending that wakes a conversation off a condition watch; composing and parsing the wake is watch-wake.ts.
export const WatchOutcomeSchema = z.enum(["met", "timeout", "restart-expired", "broken"]);
export type WatchOutcome = z.infer<typeof WatchOutcomeSchema>;

// A condition watch waking the conversation, as the row carries it. The wake arrives as an ordinary turn prompt that
// nobody typed, so the row keeps that prompt verbatim rather than a summary of it.
export const TranscriptWatchWakeSchema = z.object({
    outcome: WatchOutcomeSchema.describe("How the watch ended: the condition held, the deadline passed, or a restart cut it short."),
    note: z.string().describe("The agent's own line on what it was waiting for."),
    elapsed: z
        .string()
        .describe("How long the watch stood, already worded ('43m'): carried rather than recomputed, since the arming instant is not on the row."),
    sent: z.string().describe("The whole prompt the model was woken with, disclosed under the row."),
});
export type TranscriptWatchWake = z.infer<typeof TranscriptWatchWakeSchema>;

// A need's answer that reached this conversation as a prompt (need-wake.ts); the row keeps the prompt and names the need.
export const TranscriptNeedWakeSchema = z.object({
    outcome: z.enum(["met", "declined"]).describe("How the need ended: a person gave it, or said no."),
    title: z.string().describe("The need, as its card leads with it."),
    id: z.string().describe("The need's handle, which its live card is keyed by."),
    sent: z.string().describe("The whole prompt the model received, disclosed under the row."),
});
export type TranscriptNeedWake = z.infer<typeof TranscriptNeedWakeSchema>;

// Another agent's words that reached this conversation as a prompt; the row keeps the prompt and names the sender.
export const TranscriptAgentWordsSchema = z.object({
    kind: z.enum(["peer", "child"]).describe("Who sent it: another conversation in the workspace, or a subagent this one started."),
    from: z.string().describe("The sending conversation's id."),
    title: z.string().optional().describe("The sender's title, when it had one."),
    failed: z.boolean().optional().describe("A child's report on a turn that failed rather than finished."),
    machine: z.string().optional().describe("The runner a child's turn ran on; absent for a child that ran in this sandbox."),
    review: z
        .enum(["review", "test"])
        .optional()
        .describe("A child's report from a code review or test pass a person opened on this conversation's work, not a subagent it spawned."),
    sent: z.string().describe("The whole prompt the model received, disclosed under the row."),
});
export type TranscriptAgentWords = z.infer<typeof TranscriptAgentWordsSchema>;

// What the sandbox told a conversation about one of its subagents between the start and the report (child-news.ts): a
// move, a stop, a restart, a message that did not go. The parent reads it as a prompt; the row keeps that prompt and
// names the subagent, so a reader never draws it as the owner's own words.
export const ChildNewsKindSchema = z.enum([
    "movedHere",
    "stopped",
    "restarted",
    "otherModel",
    "fellBack",
    "working",
    "notStarted",
    "allowed",
    "messageLost",
    "answerLost",
    "question",
    "landed",
    "landConflict",
    "drift",
]);
export type ChildNewsKind = z.infer<typeof ChildNewsKindSchema>;

export const TranscriptChildNewsSchema = z.object({
    kind: ChildNewsKindSchema.describe("What became of the subagent."),
    from: z.string().describe("The subagent's id."),
    title: z.string().optional().describe("The subagent's title, when the news named one."),
    runner: z.string().optional().describe("The runner it could not start on (movedHere)."),
    model: z.string().optional().describe("The model it runs on now, where that is the news (otherModel, fellBack)."),
    cause: z
        .string()
        .optional()
        .describe("Why, in the sandbox's own words, where the news says: the same words for every subagent one cause hit, so a reader says it once."),
    sent: z.string().describe("The whole prompt the model received, disclosed under the row."),
});
export type TranscriptChildNews = z.infer<typeof TranscriptChildNewsSchema>;

// What a user row says the person was looking at when they sent it (the composer's "Viewing" chip): the file and the
// selected lines, never the selected text, which rode that one prompt and is not worth keeping on every copy of the row.
export const TranscriptEditorContextSchema = z.object({
    file: z.string().describe("The file open in the editor, as a workspace path."),
    startLine: z.number().int().min(1).optional().describe("First selected line, counting from one."),
    endLine: z.number().int().min(1).optional().describe("Last selected line, counting from one."),
});
export type TranscriptEditorContext = z.infer<typeof TranscriptEditorContextSchema>;

// The pointer a sent editor context leaves on its row: its file and lines, the selection's text dropped.
export const editorContextPointer = (context: TranscriptEditorContext): TranscriptEditorContext => {
    const pointer: TranscriptEditorContext = { file: context.file };
    if (context.startLine !== undefined) {
        pointer.startLine = context.startLine;
    }
    if (context.endLine !== undefined) {
        pointer.endLine = context.endLine;
    }
    return pointer;
};
