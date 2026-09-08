import { z } from "zod";
import { AgentProviderSchema } from "../schemas/agent.js";
import { CredentialGateKindSchema, CredentialGateScopeSchema, CredentialLaneSchema } from "../schemas/secrets.js";

// Cards a turn raises to ask the person something mid-turn; each pauses the turn until `POST /agent/reply` answers it.
// Shapes shared by the daemon that raises them, the browser that draws them, and the transcript that records them
// (transcript.ts).

// One interactive question the agent asks via the `ask` tool (mirrors AskUserQuestion's input shape).
export const AskOptionSchema = z.object({
    label: z.string().describe("The choice, in a few words."),
    description: z.string().describe("What picking it means."),
    preview: z.string().optional().describe("Something to look at while deciding: a mock-up, a snippet, a layout."),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskQuestionSchema = z.object({
    question: z.string().describe("What the agent is asking."),
    header: z.string().describe("A short label for the question."),
    multiSelect: z.boolean().describe("Whether more than one answer can be picked."),
    options: z.array(AskOptionSchema).describe("The choices offered. A free-text answer is always possible as well."),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

// The command a card is holding, as data rather than prose. `spans` is carried from the classifier's own match (never
// re-derived), offset into `text` after truncation.
export const ProgramAskSchema = z.object({
    text: z.string().describe("What would run."),
    language: z.enum(["bash", "javascript"]).describe("Which of the two backends it is written for, named as the grammar that colours it."),
    truncated: z
        .boolean()
        .describe(
            "Whether this is an excerpt of a longer program, so the card can say so instead of ending mid-word. An excerpt always carries the flagged fragment: the beginning, then a window around the fragment, with any skipped middle written into the text as a bracketed count.",
        ),
    spans: z
        .array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }))
        .describe(
            "Which fragments of the text the pattern match fired on: every matched class's, or, under the hard rule, only the class the title names. Offsets into text, in order, never overlapping.",
        ),
});
export type ProgramAsk = z.infer<typeof ProgramAskSchema>;

// One per-tool permission prompt (SDK's canUseTool, surfaced as a card); the daemon passes the bridge's own rendered
// strings through unchanged. `alwaysLabel` is present only when the SDK offered a rule to persist.
export const PermissionAskSchema = z.object({
    toolName: z.string().describe("Which tool it wants to use."),
    // The whole prompt sentence, exactly as the runtime words it, when the bridge rendered one.
    title: z.string().optional().describe("The whole question, as a sentence, exactly as the runtime words it."),
    // Short noun phrase for the allow button ("Read file").
    displayName: z.string().optional().describe("A short phrase for the button, such as read file."),
    description: z.string().optional().describe("More about what it is asking for."),
    // Why the prompt fired ('rule' | 'mode' | 'classifier' | …), shown as the card's muted subline.
    reason: z.string().optional().describe("Why it is asking at all: a rule, the current mode, something that looked risky."),
    // The file the request is about, when it is about one, workspace-root-relative.
    path: z.string().optional().describe("Which file it concerns, when it concerns one."),
    alwaysLabel: z
        .string()
        .optional()
        .describe(
            "The wording for an always-allow answer. Present only when there is something an always could actually remember; without it the only answers are once and no.",
        ),
    program: ProgramAskSchema.optional().describe(
        "The program this card is holding, when the card is about one. Present on a command gate's card and absent on every other permission ask.",
    ),
    // The judge's own sentence, present only when the title can't say it; never written by the agent being gated.
    explain: z
        .string()
        .optional()
        .describe(
            "One plain sentence saying what the program does and why it is being asked about, where the title says something else. Written by the judge that read your safety policy, never by the agent being gated.",
        ),
});
export type PermissionAsk = z.infer<typeof PermissionAskSchema>;

// One missing capability asked for; `card`/`name` are resolved by the daemon from the catalog it validates against. The
// model contributes only `why`, so the card can't misrepresent what's being connected.
export const CapabilityOfferSchema = z.object({
    // The catalog card being asked for, and how the catalog itself titles it ("Notion", "GitHub", "Docker").
    card: z.string().describe("Which connection is being asked for."),
    name: z.string().describe("What it is called, as the catalogue titles it rather than as the agent named it."),
    // The agent's one-line case for connecting it, the only prose on the card that is the model's.
    why: z.string().optional().describe("The agent's case for connecting it, and the only words on this card that are the agent's."),
});
export type CapabilityOffer = z.infer<typeof CapabilityOfferSchema>;

// One outbound USDC payment offered; every number is the daemon's own arithmetic over the endpoint's challenge and the
// wallet's ledger. The model contributes only `why`, so the price can't be misquoted.
export const PaymentOfferSchema = z.object({
    // The paid resource, as the endpoint's challenge stated it.
    url: z.string().describe("What is being paid for."),
    description: z.string().optional().describe("What the endpoint says it is."),
    // Where the money goes, verbatim off the challenge: recipient address, CAIP-2 network, token contract.
    payTo: z.string().describe("Where the money goes, taken verbatim from the endpoint's own demand."),
    network: z.string().describe("On which network."),
    asset: z.string().describe("In which token."),
    // The token's display name ("USDC"), dollar-pegged, so every amount below reads as USD.
    assetName: z.string().describe("That token's name. It is pegged to the dollar, which is what lets every amount here read as dollars."),
    // The exact price; the x402 exact scheme has no ranges, so this is the whole spend, not a ceiling.
    amountUsd: z.string().describe("The exact price. Not a ceiling: this scheme has no ranges, so this is the whole spend."),
    // The wallet's meter as the daemon's ledger states it, what "spent today / cap" renders from.
    spentTodayUsd: z.string().describe("What has already gone out today."),
    dailyCapUsd: z.string().describe("What may go out in a day."),
    // The agent's one-line case for paying, the only prose on the card that is the model's.
    why: z.string().optional().describe("The agent's case for paying, and the only words on this card that are the agent's."),
});
export type PaymentOffer = z.infer<typeof PaymentOfferSchema>;

// One gated credential asked for; every field but `why` is the daemon's own, off the gate policy and the exit that
// would spend it. `approvers` are shown since the card addresses a named list, not the owner.
export const CredentialOfferSchema = z.object({
    // The gate's subject: a secret's reference name (`DATABASE_URL`) or a capability id (`reddit`).
    subject: z.string().describe("Which credential is being asked for."),
    kind: CredentialGateKindSchema,
    lane: CredentialLaneSchema,
    // Where it would go, in the reader's terms; reference-form, never a value, so it can be shown safely.
    detail: z
        .string()
        .optional()
        .describe("Where it would go: the start of the command, the site, or what is being mounted. Never a value: the command still reads as a reference at this point."),
    // The agent's one-line case, the only prose on the card that is the model's.
    why: z.string().optional().describe("The agent's case for using it, and the only words on this card that are the agent's."),
    approvers: z.array(z.string()).describe("Who may release it. A click from anyone else is refused and leaves the card standing."),
    scope: CredentialGateScopeSchema,
});
export type CredentialOffer = z.infer<typeof CredentialOfferSchema>;

// One provider-advertised slash command (ACP's available_commands, or a Claude Code session's supportedCommands).
// `hint` is the argument placeholder the popover shows after the name.
export const AgentCommandSchema = z.object({
    name: z.string().describe("What to type, without the leading slash."),
    description: z.string().describe("What it does."),
    hint: z.string().optional().describe("What its argument should look like, shown after the name."),
});
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

// GET /agent/commands: which provider's last-published list to read; absent means claude, matching AgentTurn.
export const AgentCommandsQuerySchema = z.object({
    agent: AgentProviderSchema.optional().describe("Whose commands to read. Leave it out for Claude."),
});
export const AgentCommandsSchema = z.object({
    commands: z.array(AgentCommandSchema).describe("The shortcut commands, as the provider last published them."),
});

// One TodoWrite/Task checklist item, surfaced live so the UI shows the agent's plan-of-work.
export const TodoItemSchema = z.object({
    content: z.string().describe("The item, as the agent wrote it."),
    status: z.enum(["pending", "in_progress", "completed"]).describe("Where it is."),
    activeForm: z
        .string()
        .optional()
        .describe("How to phrase it while it is happening, so a screen can say what the agent is doing rather than what it plans to do."),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// Context-window fill for a conversation: tokens the latest request sent vs. the model's window, so the UI can warn
// near auto-compaction. Per-conversation, unlike the account-wide usage.
export const ContextUsageSchema = z.object({
    tokens: z.number().describe("How much the latest request sent, all told."),
    contextWindow: z.number().describe("How much the model can hold. The gap between these two is how close the conversation is to being compacted."),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

// ACP-aligned tool taxonomy (Agent Client Protocol's ToolKind, verbatim): what a tool call does, driving the card icon
// regardless of which backend named the tool.
export const ToolKindSchema = z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

// A file a tool call touches. Workspace-root-relative, forward-slash; adapters normalize from the turn's cwd. `line` is
// 1-based.
export const ToolCallLocationSchema = z.object({
    path: z.string().describe("The file, as a workspace path, whatever directory the tool was run from."),
    line: z.number().optional().describe("Which line, counting from one."),
});
export type ToolCallLocation = z.infer<typeof ToolCallLocationSchema>;

// Structured tool output (ACP's ToolCallContent, verbatim); `diff` is hunk-level for edits, whole-file for Write.
// `image` is a workspace path, not bytes, so it stays openable without bloating the stream.
export const ToolCallContentSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("text").describe("Plain output."),
        text: z.string().describe("What the tool said."),
    }),
    z.object({
        type: z.literal("diff").describe("A change to a file."),
        path: z.string().describe("Which file, as a workspace path."),
        oldText: z.string().optional().describe("What was there. Absent for a new file, or where the previous contents are not known."),
        newText: z.string().describe("What is there now."),
        truncated: z.boolean().optional().describe("One of the two sides was too large to send whole."),
    }),
    z.object({
        type: z.literal("image").describe("A picture the tool produced."),
        path: z
            .string()
            .describe(
                "Where it is, as a workspace path. A path rather than the bytes, because the workspace already serves it, sending it inline would bloat every stored record, and this way the picture stays openable afterwards.",
            ),
    }),
]);
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;

// The document a parked card is asking about, carried by value: the bytes are already in hand, and a restored
// transcript has no workspace to fetch a path from. `path` rides along for an overflow.
export const CardDocumentSchema = z.object({
    path: z.string().describe("Where it lives, as a workspace path."),
    title: z.string().describe("What it is called: its opening heading, or its file name."),
    markdown: z.string().describe("The document itself."),
    truncated: z.boolean().optional().describe("It was clipped at the wire cap; the file on disk has more."),
    plan: z.boolean().optional().describe("It is one of the CLI's plan files, written to be approved rather than merely read."),
});
export type CardDocument = z.infer<typeof CardDocumentSchema>;

// One card's fields, spelled once: the raising frame, the parked-card journal entry, and the transcript row all share
// this shape rather than declaring it three times.
const REQUEST_ID = z.string().describe("What to send back when you answer.");
export const planCard = {
    requestId: REQUEST_ID,
    text: z.string().describe("The plan itself."),
    // Present when the plan prose points at a document; absent when the text already is the whole plan.
    document: CardDocumentSchema.optional().describe("The write-up this plan refers to, when the plan itself is a pointer to one."),
};
export const questionCard = {
    requestId: REQUEST_ID,
    questions: z.array(AskQuestionSchema).describe("What it wants to know."),
    document: CardDocumentSchema.optional().describe("The document this turn wrote and is asking about, so the choice can be read beside it."),
};
export const permissionCard = { requestId: REQUEST_ID };
// The agent's browser is parked on something it can't clear itself (captcha, password, phone check). `session` names it
// on /browsers; `account` says whose login is stuck.
export const browserHelpCard = {
    requestId: z.string(),
    session: z.string(),
    account: z.string(),
    message: z.string(),
};
// The agent's terminal is sitting at a prompt it can't answer (OTP, security-key touch, confirm). `session` names it on
// the terminal panel, same division as the browser card.
export const terminalHelpCard = {
    requestId: z.string(),
    session: z.string(),
    message: z.string(),
};
export const capabilityOfferCard = { requestId: z.string(), offer: CapabilityOfferSchema };
export const paymentOfferCard = { requestId: z.string(), offer: PaymentOfferSchema };
export const credentialOfferCard = { requestId: z.string(), offer: CredentialOfferSchema };

// How an accepted capability offer ended, shared by the frame that reports it and the record that keeps it, so a
// reopened receipt matches the live card.
export const CapabilityOutcomeSchema = z.object({
    outcome: z.enum(["connected", "unfinished"]),
    id: z.string().optional(),
});
export type CapabilityOutcome = z.infer<typeof CapabilityOutcomeSchema>;
export const PaymentReceiptSchema = z.object({
    outcome: z.enum(["paid", "failed"]),
    amountUsd: z.string(),
    transaction: z.string().optional(),
    network: z.string().optional(),
});
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;
// Who released a gated credential, or that someone refused it. `released` carries the approver's verified identity, not
// what the click claimed.
export const CredentialReceiptSchema = z.object({
    outcome: z.enum(["released", "refused"]),
    approvedBy: z.string().optional(),
});
export type CredentialReceipt = z.infer<typeof CredentialReceiptSchema>;

// The three cards a turn journal can restore verbatim after a daemon restart. `browser_help`/`terminal_help` are
// excluded: their Chromium/waiting command dies with the container, so those can only be reported, not restored.
export const PlanCardSchema = z.object({
    kind: z.literal("plan").describe("The agent has written a plan and is waiting for a yes."),
    ...planCard,
});
export const QuestionCardSchema = z.object({
    kind: z.literal("question").describe("The agent has asked you something and is waiting."),
    ...questionCard,
});
export const PermissionCardSchema = PermissionAskSchema.extend({
    kind: z.literal("permission").describe("The agent wants to use a tool it needs permission for."),
    ...permissionCard,
});
export const ParkedCardSchema = z.discriminatedUnion("kind", [PlanCardSchema, QuestionCardSchema, PermissionCardSchema]);
export type ParkedCard = z.infer<typeof ParkedCardSchema>;
