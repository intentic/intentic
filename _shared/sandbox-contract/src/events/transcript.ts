import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema } from "../schemas/agent.js";
import { ShareDetailSchema } from "../schemas/share.js";
import { SubagentKindSchema, SubagentStatusSchema, SubagentVerificationSchema } from "../schemas/terminal.js";
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind} from "./cards.js";
import { browserHelpCard, capabilityOfferCard, CapabilityOutcomeSchema, credentialOfferCard, CredentialReceiptSchema, paymentOfferCard, PaymentReceiptSchema, PermissionAskSchema, permissionCard, planCard, questionCard, terminalHelpCard, TodoItemSchema, ToolCallContentSchema, ToolCallLocationSchema, ToolCallStatusSchema, ToolKindSchema } from "./cards.js";

/* A CONVERSATION AS IT IS RECORDED AND REPLAYED: the rows, the cards they carry, and the patches that change
 * them while a turn runs.
 *
 * One shape for the live row and the recorded one, because they are the same row: the daemon folds a turn's
 * frames into these rows as they stream (text/transcript-fold.ts) and writes the same rows down when the turn
 * settles, so a chat reopened tomorrow is the chat that was on screen. */

// ---- transcript cards ----
/* THE CARDS A TURN PARKED ON, as a transcript row carries them: the card exactly as it was raised, how it was
 * settled, and whatever landed on it afterwards (a permission's late explanation, an offer's stream and
 * receipt). One shape for the live row and the recorded one, because they are the same row: the daemon folds
 * the turn's frames into these rows as they stream (transcript-fold.ts) and writes the same rows down when the
 * turn settles, so a chat reopened tomorrow is the chat that was on screen.
 *
 * The STATUS is settled by the fold, from the reply that released the card (card-status.ts), and rides the
 * row rather than the reply it came from: every reader wants the verdict, and the one derivation lives beside
 * the fold that applies it. `pending` is a card the turn is still parked on; `cancelled` is nobody answering,
 * the turn stopped or died under the card, which is not a decision and does not read back as one. */
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
// A yes settles the DECISION, not the ask: the owner is now setting the capability up, so the card moves to
// `connecting` and stays there until the capability_outcome frame says how the setup ended.
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
// `explain`, the judge's sentence, lands here through PermissionAskSchema; it is on the card from the moment
// it is raised, so nothing patches it in afterwards.
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

// ---- transcript rows ----
// What a conversation is made of, on every surface: the rows the daemon folds a turn's frames into as they
// stream (the live chat renders these, patched as they grow), the rows the record keeps once the turn settles,
// and the rows /agents/{id}/transcript replays into a reopened tab. One shape because it is one thing: a
// reopened chat REDRAWS the transcript the user was looking at rather than paraphrasing it, so a row keeps the
// assistant's thinking and the tool cards its block ran, which is also what lets a runtime handoff carry more
// than bare prose across to a replacement session (see runtime-history.ts).
//
// One tool card. A subagent's own calls and its thinking nest under the Agent card that spawned them, so a
// delegation reads as one unit instead of a flat run of siblings. z.lazy because the shape refers to itself: a
// subagent that delegates nests one level deeper.
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
/* THE CHILD A CALL STARTED, on the card whose id the `subagent`/`subagent_update` frames name (that call's own),
 * so no correlation is needed: an Agent card wears its subagent's live state, and a Bash card that turned out
 * to be a `codex exec` wears its delegate's. The identifying fields arrive once (the `subagent` frame), the
 * moving ones (status, spend, what it is doing) replace as each update lands. */
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
// Mutable, unlike most of this file: the fold settles a card IN PLACE when its result arrives turns later
// (transcript-fold.ts's `cards` map, readWorkspaceSession's `awaiting`), which is what saves it a second pass.
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

/* ONE NOTE THE DAEMON PUT IN FRONT OF A USER'S MESSAGE, as both audiences see it: the model reads `text`, and
 * the chat draws `title` on a collapsed row that opens to that same `text`. Shared by the live frame and the
 * restored transcript so a note reads identically whether the tab watched it arrive or reopened an hour later. */
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

// One row. Each block of the agent's prose is its own, with the tool cards that block introduced, which is what
// reproduces the way a turn actually unfolded rather than collapsing its whole narration into one bubble with
// every tool hanging off the end.
export const TranscriptRowSchema = z.object({
    /* `notice` is neither side of the conversation: it is something that HAPPENED to the turn, a refusal, a
     * landed delta, a compaction, a stop, written down so a reopened conversation says it too. The one that
     * matters most is a refused turn: a provider that answers "your organization has disabled Claude
     * subscription access" produced no assistant text, so a transcript of the two speakers alone ends on the
     * user's message and reads as broken. */
    role: z
        .enum(["user", "assistant", "notice"])
        .describe(
            "Who said it. A notice is neither side: it is something that happened to the turn, recorded so a reopened conversation can say it. Without those, a turn a provider refused ends on the user's message and reads as broken.",
        ),
    text: z.string().describe("The words."),
    /* WHEN THIS TURN WAS SENT, in epoch milliseconds (user rows only), what the chat shows on the bubble it
     * belongs to. The turn's START, not the moment the record was written: a turn that ran for twenty minutes
     * was still sent when the user pressed send, and a stamp taken at settlement would say the conversation
     * happened at the times its answers finished.
     *
     * Only the user's row carries one, because it is the only row whose moment the daemon actually knows. A
     * turn's frames arrive with no clock of their own, so an assistant bubble could only ever be stamped with
     * the whole turn's start or end, a number that says nothing about when that particular block was written.
     * Rows recorded before this existed simply have none, and the chat draws nothing for them. */
    sentAt: z
        .number()
        .optional()
        .describe(
            "When it was sent, in milliseconds. On the user's rows only, because that is the only moment actually known: a turn's own frames arrive with no clock, so stamping the agent's rows could only ever mean the whole turn's start or end.",
        ),
    // Files the user attached to this turn (user rows only) as workspace-relative paths, the uploads alone:
    // a path @-mentioned inline in the text is already visible there and is not drawn as a chip.
    attachments: z.array(z.string()).optional().describe("Files attached to this message, as workspace paths."),
    /* The checkpoint this message can be rewound to (user rows only), and where this message sits in the
     * conversation's record, which is what the rewind route addresses it by. Never stored: both are stamped
     * onto the live row by the turn's own `checkpoint` frame and onto a replayed row by the read that serves
     * it, looked up from the daemon's rewind points, which a rewind rewrites, so a reopened tab offers exactly
     * the turns that are still there to go back to. */
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
    /* What the daemon added to this turn's message (user rows only), the same notes the live `preamble` frame
     * carries, read off that frame by the fold.
     *
     * On the message rather than as a row of its own, and that matters twice: they ARE part of what was
     * sent, and a record row per turn preamble would break the one-row-per-bubble correspondence a branch counts
     * with. */
    notes: z
        .array(TurnNoteSchema)
        .optional()
        .describe(
            "What the sandbox added to this message before the model saw it. Carried on the message rather than as rows of their own, because they genuinely were part of what was sent.",
        ),
    /* THE USER WROTE THIS ROW WEARING THE AGENT'S VOICE (assistant rows only), the composer's "as agent" mode
     * appending straight into the record, with no turn behind it (agents.place).
     *
     * The flag exists for exactly one audience: the HUMAN re-reading the transcript, whose bubble carries a
     * quiet mark so that months later their own words don't pass as the agent's. The one reader that must
     * never see it is the agent itself, a placed line reaches the model only through the handoff that seeds a
     * fresh runtime session (agent/runtime-history.ts), which renders role and text alone, so there the line is
     * indistinguishable from anything the agent genuinely said. Keep it that way: rendering this flag into any
     * agent-facing text would break the feature's whole contract. */
    placed: z
        .boolean()
        .optional()
        .describe(
            "A person wrote this in the agent's voice, with no turn behind it. Marked for the human re-reading the conversation months later, so their own words do not pass as the agent's. The agent itself never sees the mark.",
        ),
    /* THE ONE-PRESS OFFER A NOTICE CARRIES (notice rows only), named rather than inferred from its words: the
     * landed notice's "keep future work on the branch", the outage notice's "stop resuming these by itself",
     * the terminal a dependency install the daemon just started is running in, and the routed turn's "keep
     * this chat on my pick". A KIND, not a callback: the chat decides what the press does and whether the
     * offer still stands (a chat already holding its pick shows a settled sentence, not a stale button). */
    noticeAction: z
        .enum(["landHold", "outageOptOut", "depsInstall", "tierHold"])
        .optional()
        .describe("A one-press follow-up this notice offers, by name. The chat decides what it does and whether it still applies."),
    /* A WAIT THIS NOTICE DESCRIBES that had not finished when it was written (notice rows only): the chat draws
     * a spinner over it while the wait is on, and the plain line once it is over. A KIND rather than a boolean
     * because whether the wait is STILL running is a fact about the conversation now, not about a row in a
     * record: the reader pairs the kind with the live state that answers it. */
    noticeWait: z.enum(["credentialRenewal"]).optional().describe("The wait this notice describes, by name, so a reader can say whether it is still on."),
    /* THE CARD THIS BUBBLE PARKED ON (assistant rows only), at most one: a card closes the bubble it lands in,
     * so the next thing the agent says opens a fresh row beneath it. One field per kind rather than one union
     * field, so a reader reaches the card it draws by name. */
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

/* THE CARD FIELDS A ROW CAN CARRY, as one list, for every reader that has to ask "does this row hold a card":
 * the fold that counts a card-only bubble as a row, the chat's row count (a branch is cut by it), and the
 * surfaces that draw whichever card a bubble is waiting on. */
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

/* ONE CHANGE TO A RUN'S ROWS, what the attach stream carries while a turn runs. The daemon folds each frame
 * into its rows (transcript-fold.ts) and says what moved, so a client keeps rows, never frames: it applies
 * these to the list it holds and draws it. `index` counts from the run's first row, which the attach head
 * places in the conversation.
 *
 * Prose and thinking arrive as APPENDS to a row rather than as the row again, so the chat can type them out at
 * the pace they are written; a tool card arrives whole (`tool`, by id, replacing an earlier copy of the same
 * id wherever it nests), because its updates are snapshots already; everything else replaces its row. `drop`
 * is the one removal: an assistant row opened for a block that then wrote nothing. */
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
/* HOW A TURN THAT LEFT WORK BEHIND ENDED, as the daemon has it, for whoever asks and however long after.
 *
 * One shape for every ending that leaves finished work behind a live session, because they are one situation
 * with one answer (a press) and they differ only in what can honestly be said about WHEN and what the press
 * DOES. The client folds this straight into its pick-up state (chat/pickUp.ts), which is why the field names
 * line up: a second vocabulary between the two halves is how they came to disagree in the first place.
 *
 * IT USED TO BE A BOOLEAN, and the boolean is what left the longest wait uncovered. One flag could only say
 * "a Stop, or a daemon killed under it", so a spent allowance, the one ending that reliably OUTLIVES the
 * window that hit it, reached a reopened tab as nothing at all: no strip, no countdown, no press, and the user
 * typing the word by hand hours later. It could not say more without these three facts, and each of them
 * changes what the surface may promise:
 *
 *   · `resetsAt` is the only honest "not before this" any ending knows, and it is the whole of what a chat
 *     reopened the next morning wants to be told;
 *   · `held` is what makes the press cheap. The daemon keeps the refused turn whole, so continuing RE-RUNS it
 *     and adds nothing to the conversation; without this the same press appends a message reading "Continue",
 *     which is exactly the transcript pollution the press exists to prevent, and `ran` separates a turn that
 *     got somewhere from one the allowance refused at the door (two different sentences);
 *   · `scheduled` says somebody else is already bringing this turn back, so the surface REPORTS a wait instead
 *     of offering one, and no local automation races the daemon's own pass for it. */
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

/* THE RECORD A REOPENED TAB IS REBUILT FROM: the messages, plus what the session behind them is BOUND to.
 *
 * A provider session is minted on one runtime under one credential, and it resumes only there, so a client
 * deciding whether its next message continues this conversation or starts a fresh one needs all four facts
 * together. The client cannot derive the last three: its tab holds the picks the NEXT turn would use, which
 * after a mid-chat switch are exactly the ones the session does not belong to. Stamping those onto the session
 * is what made switching BACK to the account that minted it announce a fresh session and then retire a
 * perfectly resumable one, spending the whole transcript again on a cold prompt cache.
 *
 * The session fields are all optional, and absent together on a conversation that has no session to resume. */
export const AgentTranscriptSchema = SessionTranscriptSchema.extend({
    sessionId: z.string().optional().describe("The provider session behind the last turn, when there is one."),
    provider: AgentProviderSchema.optional().describe("Which provider minted that session."),
    harness: AgentHarnessSchema.optional().describe("Which runtime minted it: a session resumes only on the loop that opened it."),
    account: z
        .string()
        .optional()
        .describe("Which stored account it belongs to, as the daemon resolved it. Absent when no stored account paid for the turn."),
    /* AND HOW THE LAST TURN ENDED, for the endings that leave the client something to OFFER rather than
     * something to draw: work half done behind a session that is perfectly alive, where the only thing missing
     * is somebody saying carry on.
     *
     * It rides the transcript because the offer used to ride the WINDOW. A chat armed the continue press from
     * the stream it was watching when the turn stopped, so the press existed only where somebody had been
     * looking: stop an agent from the board with its chat closed, or reopen the tab on another device, or after
     * a reload that dropped the tab, and the same stopped session came back with no way on but typing the word
     * by hand, which is precisely what the press exists to spare. The daemon is the one party that knows this
     * about a conversation whoever asks and however long after, so it is the one that says it. */
    ending: TurnEndingSchema.optional().describe(
        "How the last turn ended, when it left work behind that one press finishes. Absent for a conversation whose last turn ended on its own, and for the failures that name something to repair first.",
    ),
    /* WHERE THIS PAGE SITS IN THE CONVERSATION. `messages` is the tail, not the whole record: a conversation
     * that ran all week used to be served entire to every tab that opened it and to every card the board warms
     * behind it, which is megabytes over a tunnel to redraw a screenful.
     *
     * `from` is the position of the first message in the WHOLE record, which makes it two things at once: the
     * offset every `rewindIndex` in this page is counted against, and the `before` that asks for the page above
     * it. `more` says whether there is one, so a client can offer to go back without spending a round trip
     * finding out. */
    from: z.number().int().nonnegative().describe("Where the first message sits in the whole record, and the `before` that asks for the page above this one."),
    more: z.boolean().describe("Whether older messages precede this page."),
});

/* WHAT A PUBLISHED CONVERSATION'S PAGE IS HANDED, the whole of it, baked into the page as one JSON block.
 *
 * A share has to keep working with nothing behind it: no daemon, no session, no sandbox that has to still be
 * running when the recipient finally opens the link. So the page carries its conversation rather than fetching
 * it, which also settles the security question by construction, a page with nothing to ask has no way to ask
 * for something it was not given.
 *
 * The messages are the SAME TranscriptRow rows the app replays a reopened tab from, already filtered to the
 * chosen detail level and with every picture path rewritten to the copy published beside the page. That
 * sameness is the point: the shared page renders them with the app's own components, so what a recipient sees
 * is what the owner saw. */
export const SharePayloadSchema = z.object({
    title: z.string(),
    // When the snapshot was taken, not when the conversation happened, see SharedConversation.sharedAt.
    sharedAt: z.number(),
    detail: ShareDetailSchema,
    messages: z.array(TranscriptRowSchema),
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;
