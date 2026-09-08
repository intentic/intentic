import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "../schemas/agent.js";
import { ShareDetailSchema } from "../schemas/share.js";
import { SubagentKindSchema, SubagentStatusSchema, SubagentVerificationSchema } from "../schemas/terminal.js";
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind} from "./cards.js";
import { browserHelpCard, capabilityOfferCard, CapabilityOutcomeSchema, credentialOfferCard, CredentialReceiptSchema, paymentOfferCard, PaymentReceiptSchema, PermissionAskSchema, permissionCard, planCard, questionCard, terminalHelpCard, TodoItemSchema, ToolCallContentSchema, ToolCallLocationSchema, ToolCallStatusSchema, ToolKindSchema } from "./cards.js";

// A conversation as recorded and replayed: the rows, the cards they carry, and the patches that change them while a
// turn runs. One shape for the live row and the recorded one, since they're the same row.

// Transcript cards.
// Status enums for a parked card, settled by the fold from the reply that released it (card-status.ts), riding the row
// rather than the reply. `cancelled` means nobody answered, not a decision; `pending` is still parked.
export const PlanStatusSchema = z.enum(["pending", "approved", "rejected", "cancelled"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export const QuestionStatusSchema = z.enum(["pending", "answered", "cancelled"]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export const PermissionStatusSchema = z.enum(["pending", "allowed", "always", "denied", "cancelled"]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;
export const HelpStatusSchema = z.enum(["pending", "helped", "declined", "cancelled"]);
export type HelpStatus = z.infer<typeof HelpStatusSchema>;
export const OfferStatusSchema = z.enum(["pending", "approved", "skipped", "cancelled"]);
export type OfferStatus = z.infer<typeof OfferStatusSchema>;
// A yes settles the decision, not the ask: the card moves to `connecting` until the outcome frame resolves it.
export const CapabilityOfferStatusSchema = z.enum(["pending", "connecting", "skipped", "cancelled"]);
export type CapabilityOfferStatus = z.infer<typeof CapabilityOfferStatusSchema>;

export const TranscriptPlanSchema = z.object({ ...planCard, status: PlanStatusSchema.describe("Where the decision stands.") });
export type TranscriptPlan = z.infer<typeof TranscriptPlanSchema>;
export const TranscriptQuestionSchema = z.object({
    ...questionCard,
    status: QuestionStatusSchema.describe("Where the answer stands."),
    answers: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("What was chosen, keyed by the question, with the chosen labels or the user's own words."),
});
export type TranscriptQuestion = z.infer<typeof TranscriptQuestionSchema>;
// `explain`, the judge's sentence, arrives via PermissionAskSchema at raise time; nothing patches it in after.
export const TranscriptPermissionSchema = PermissionAskSchema.extend({ ...permissionCard, status: PermissionStatusSchema.describe("Where the decision stands.") });
export type TranscriptPermission = z.infer<typeof TranscriptPermissionSchema>;
export const TranscriptBrowserHelpSchema = z.object({ ...browserHelpCard, status: HelpStatusSchema.describe("How the hand-over ended.") });
export type TranscriptBrowserHelp = z.infer<typeof TranscriptBrowserHelpSchema>;
export const TranscriptTerminalHelpSchema = z.object({ ...terminalHelpCard, status: HelpStatusSchema.describe("How the hand-over ended.") });
export type TranscriptTerminalHelp = z.infer<typeof TranscriptTerminalHelpSchema>;
export const TranscriptCapabilityOfferSchema = z.object({
    ...capabilityOfferCard,
    status: CapabilityOfferStatusSchema.describe("Where the decision stands."),
    outcome: CapabilityOutcomeSchema.optional().describe("How an accepted ask's setup ended (the capability_outcome frame)."),
});
export type TranscriptCapabilityOffer = z.infer<typeof TranscriptCapabilityOfferSchema>;
export const TranscriptPaymentOfferSchema = z.object({
    ...paymentOfferCard,
    status: OfferStatusSchema.describe("Where the decision stands."),
    receipt: PaymentReceiptSchema.optional().describe("How the approved payment ended (the payment_receipt frame)."),
});
export type TranscriptPaymentOffer = z.infer<typeof TranscriptPaymentOfferSchema>;
export const TranscriptCredentialOfferSchema = z.object({
    ...credentialOfferCard,
    status: OfferStatusSchema.describe("Where the decision stands."),
    receipt: CredentialReceiptSchema.optional().describe("Who released it, or that somebody refused (the credential_receipt frame)."),
});
export type TranscriptCredentialOffer = z.infer<typeof TranscriptCredentialOfferSchema>;

// One row shape across live folding, storage and replay; a reopened chat redraws the transcript, not paraphrases it. A
// subagent's own calls nest under the card that spawned them (z.lazy, self-referential).
export const TranscriptToolSchema: z.ZodType<TranscriptTool> = z.lazy(() =>
    z.object({
        id: z.string().describe("The call's id."),
        name: z.string().describe("Which tool."),
        category: ToolKindSchema.describe(
            "What kind of thing it does: read, edit, delete, move, search, run, think, fetch. Named the same way whatever the backend called the tool.",
        ),
        status: ToolCallStatusSchema.describe("How it went."),
        target: z.string().optional().describe("What it acted on, in one line: a file, a command, an address."),
        locations: z.array(ToolCallLocationSchema).optional().describe("The files it touched."),
        content: z.array(ToolCallContentSchema).optional().describe("What it produced: text, a change to a file, or a picture."),
        children: z
            .array(TranscriptToolSchema)
            .optional()
            .describe(
                "Calls a delegated subagent made, nested under the call that started it, so a reopened conversation redraws the delegation rather than collapsing it into one result.",
            ),
        thinking: z.string().optional().describe("What the agent was reasoning about around this call."),
        subagent: TranscriptSubagentSchema.optional().describe(
            "The helper this call started, as the daemon's registry sees it: what it is, how it is going, what it has spent. What a card can say about a backgrounded child whose result is minutes away.",
        ),
    }),
);
// The child a call started, keyed by that call's own id, so `subagent`/`subagent_update` frames need no separate
// correlation. Identifying fields arrive once; status/spend/activity replace on each update.
export const TranscriptSubagentSchema = z.object({
    kind: SubagentKindSchema,
    agentType: z.string().optional(),
    description: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    background: z.boolean().optional(),
    status: SubagentStatusSchema,
    tokens: z.number().optional(),
    toolUses: z.number().optional(),
    lastTool: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    verification: SubagentVerificationSchema.optional(),
});
export type TranscriptSubagent = z.infer<typeof TranscriptSubagentSchema>;
// Mutable, unlike most of this file: the fold settles a card in place when its result lands turns later, saving a
// second pass.
export interface TranscriptTool {
    id: string;
    name: string;
    category: ToolKind;
    status: ToolCallStatus;
    target?: string | undefined;
    locations?: ToolCallLocation[] | undefined;
    content?: ToolCallContent[] | undefined;
    children?: TranscriptTool[] | undefined;
    thinking?: string | undefined;
    subagent?: TranscriptSubagent | undefined;
}

// One note the daemon put before a user's message: the model reads `text`, the chat draws `title` on a row that opens
// to it. Shared by the live frame and the restored transcript, so it reads the same either way.
export const TurnNoteSchema = z.object({
    title: z.string().describe("The one line a reader sees, on a row that opens to the text below."),
    text: z.string().describe("The note itself, which is also exactly what the model was told."),
});
export type TurnNote = z.infer<typeof TurnNoteSchema>;

// End-of-turn accounting (assistant rows only, the last bubble of a turn): what the turn cost, attached where
// the answer ended so a reader can see what each exchange spent.
export const TranscriptUsageSchema = z.object({
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    durationMs: z.number().optional(),
    numTurns: z.number().optional(),
});
export type TranscriptUsage = z.infer<typeof TranscriptUsageSchema>;

// One row; each block of the agent's prose is its own, with the tool cards that block introduced, so a turn redraws as
// it actually unfolded rather than one bubble with everything hanging off the end.
export const TranscriptRowSchema = z.object({
    // `notice` is neither speaker: something that happened to the turn (a refusal, a landed delta, a stop).
    role: z
        .enum(["user", "assistant", "notice"])
        .describe(
            "Who said it. A notice is neither side: it is something that happened to the turn, recorded so a reopened conversation can say it. Without those, a turn a provider refused ends on the user's message and reads as broken.",
        ),
    text: z.string().describe("The words."),
    // The turn's send time (user rows only), not settlement; the only row-moment the daemon actually knows.
    sentAt: z
        .number()
        .optional()
        .describe(
            "When it was sent, in milliseconds. On the user's rows only, because that is the only moment actually known: a turn's own frames arrive with no clock, so stamping the agent's rows could only ever mean the whole turn's start or end.",
        ),
    // Uploaded files only (user rows); a path already @-mentioned inline is not drawn again as a chip.
    attachments: z.array(z.string()).optional().describe("Files attached to this message, as workspace paths."),
    // Never stored: looked up each read from the daemon's rewind points, matching what's still there.
    checkpointId: z
        .string()
        .optional()
        .describe(
            "The saved point this message can be rewound to. Looked up on each read rather than stored, so what is offered is exactly what is still there to go back to.",
        ),
    rewindIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("This message's position in the conversation's record, which is how a rewind names it. Present only beside a checkpoint."),
    thinking: z.string().optional().describe("What the agent was reasoning about."),
    tools: z.array(TranscriptToolSchema).optional().describe("The tool calls this part of the turn made."),
    todos: z.array(TodoItemSchema).optional().describe("The agent's task checklist, as of this bubble."),
    usage: TranscriptUsageSchema.optional().describe("What the turn cost, on the bubble its answer ended in."),
    // The daemon's preamble notes for this message; on the message, not its own row, since they were part of it.
    notes: z
        .array(TurnNoteSchema)
        .optional()
        .describe(
            "What the sandbox added to this message before the model saw it. Carried on the message rather than as rows of their own, because they genuinely were part of what was sent.",
        ),
    // The user wrote this as the agent, no turn behind it; marked for a human reader, never surfaced to the agent.
    placed: z
        .boolean()
        .optional()
        .describe(
            "A person wrote this in the agent's voice, with no turn behind it. Marked for the human re-reading the conversation months later, so their own words do not pass as the agent's. The agent itself never sees the mark.",
        ),
    // The one-press follow-up this notice offers, by name; the chat decides what it does, and whether it stands.
    noticeAction: z
        .enum(["landHold", "outageOptOut", "depsInstall", "tierHold"])
        .optional()
        .describe("A one-press follow-up this notice offers, by name. The chat decides what it does and whether it still applies."),
    // An unfinished wait this notice describes, by name; whether it's still running is live state, not stored here.
    noticeWait: z
        .enum(["credentialRenewal", "personaRoute"])
        .optional()
        .describe("The wait this notice describes, by name, so a reader can say whether it is still on."),
    // At most one card per row; a card closes its bubble. One field per kind, so a reader reaches it by name.
    plan: TranscriptPlanSchema.optional().describe("The plan this row asked approval for, and the answer."),
    question: TranscriptQuestionSchema.optional().describe("The questions this row asked, and the picks that answered them."),
    permission: TranscriptPermissionSchema.optional().describe("The tool this row asked permission for, and the decision."),
    browserHelp: TranscriptBrowserHelpSchema.optional().describe("The browser hand-over this row asked for, and how it ended."),
    terminalHelp: TranscriptTerminalHelpSchema.optional().describe("The terminal hand-over this row asked for, and how it ended."),
    capabilityOffer: TranscriptCapabilityOfferSchema.optional().describe("The capability setup this row asked for, the decision, and the outcome."),
    paymentOffer: TranscriptPaymentOfferSchema.optional().describe("The payment this row asked for, the decision, and the receipt."),
    credentialOffer: TranscriptCredentialOfferSchema.optional().describe(
        "The gated credential this row asked to use, who may release it, and who did.",
    ),
});
export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;

// Every card field, as one list, for readers asking whether a row holds a card at all.
export const CARD_FIELDS = [
    "plan",
    "question",
    "permission",
    "browserHelp",
    "terminalHelp",
    "capabilityOffer",
    "paymentOffer",
    "credentialOffer",
] as const;
export type CardField = (typeof CARD_FIELDS)[number];
export type TranscriptCards = Pick<TranscriptRow, CardField>;
// Whether a row holds a card at all, answered or not.
export const holdsCard = (row: TranscriptCards): boolean => CARD_FIELDS.some((field) => row[field] !== undefined);
// Whether a row is holding the turn open on a card nobody has answered.
export const isAwaitingDecision = (row: TranscriptCards): boolean => CARD_FIELDS.some((field) => row[field]?.status === "pending");

// One change to a run's rows, so a client keeps rows rather than frames. Prose/thinking append to a row; a `tool` card
// replaces whole by id; everything else replaces its row; `drop` removes a row that opened and never wrote.
export const TranscriptPatchSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("append").describe("A new row at the end."), row: TranscriptRowSchema }),
    z.object({ op: z.literal("replace").describe("This row, whole, in place of the one at that index."), index: z.number().int().nonnegative(), row: TranscriptRowSchema }),
    z.object({ op: z.literal("drop").describe("The row at that index is gone: it was opened and never written into."), index: z.number().int().nonnegative() }),
    z.object({ op: z.literal("text").describe("More of the agent's prose, onto that row's text."), index: z.number().int().nonnegative(), text: z.string() }),
    z.object({ op: z.literal("thinking").describe("More of the agent's reasoning, onto that row's thinking."), index: z.number().int().nonnegative(), text: z.string() }),
    z.object({
        op: z.literal("tool").describe("A tool card, whole: new, or the latest state of one already there, matched by id wherever it nests."),
        index: z.number().int().nonnegative(),
        tool: TranscriptToolSchema,
        parent: z.string().optional().describe("The card this one nests under, when it is a delegated subagent's own call."),
    }),
]);
export type TranscriptPatch = z.infer<typeof TranscriptPatchSchema>;

export const SessionTranscriptSchema = z.object({
    messages: z
        .array(TranscriptRowSchema)
        .describe(
            "The conversation, in order. Each block of the agent's prose is its own message with the tools that block introduced, which is what reproduces the way it actually unfolded.",
        ),
});
// How a turn that left work behind ended, folded straight into pickup state (chat/pickUp.ts). `held` makes a press
// re-run the turn instead of appending a message; `scheduled` means it's already coming back.
export const TurnEndingSchema = z.object({
    reason: z
        .enum(["stopped", "limit", "outage"])
        .describe(
            "Which ending left the work here: a Stop or a daemon killed under the turn, a spent usage allowance, or a provider that refused it.",
        ),
    resetsAt: z
        .number()
        .optional()
        .describe("When the spent allowance reopens, in epoch seconds. Absent for every ending that names no instant, and for a provider that publishes none."),
    held: z
        .object({
            ran: z.boolean().describe("Whether the held turn got anywhere before it was refused, which is a different sentence from one refused at the door."),
            contextTokens: z
                .number()
                .optional()
                .describe("How much context a press that keeps the session re-reads once, on this account at the reset or carried to another. Absent when no usage frame measured it."),
            handoffTokens: z
                .number()
                .optional()
                .describe("What a press that opens a fresh session pays instead: the capped record plus the sandbox's measured brief, counted at the failure."),
            moving: z.string().optional().describe("The account the owner's policy is already moving this turn to, when it is; the surface then reports the move rather than offering a press."),
        })
        .optional()
        .describe("Present when the daemon still holds the refused turn whole, so a press re-runs it rather than appending a message after it."),
    scheduled: z
        .boolean()
        .optional()
        .describe("Whether something other than the user is already booked to send this turn again, so the surface reports the wait instead of offering a press."),
});
export type TurnEnding = z.infer<typeof TurnEndingSchema>;

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
    from: z.number().int().nonnegative().describe("Where the first message sits in the whole record, and the `before` that asks for the page above this one."),
    more: z.boolean().describe("Whether older messages precede this page."),
});

// The whole of a published conversation, baked into the page since nothing else may still be running when it opens. The
// same TranscriptRow rows the app replays, filtered to the chosen detail, pictures rewritten to published copies.
export const SharePayloadSchema = z.object({
    title: z.string(),
    // When the snapshot was taken, not when the conversation happened.
    sharedAt: z.number(),
    detail: ShareDetailSchema,
    messages: z.array(TranscriptRowSchema),
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;
