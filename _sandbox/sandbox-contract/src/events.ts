import { z } from "zod";
import { AgentHarnessSchema, AgentProviderSchema, PermissionModeSchema } from "./schemas/agent.js";
import { AgentSummarySchema, LandConflictSchema } from "./schemas/agents.js";
import { RateLimitInfoSchema } from "./schemas/claude-gate.js";
import { FastModeStateSchema } from "./schemas/fast-mode.js";
import { AccountUsageSchema, AgentReplySchema, ProviderRefusalSchema, UsageWindowSchema } from "./schemas/plan-limits.js";
import { CredentialGateKindSchema, CredentialGateScopeSchema, CredentialLaneSchema } from "./schemas/secrets.js";
import { ShareDetailSchema } from "./schemas/share.js";
import { MemberRoleSchema } from "./schemas/shared.js";
import { SubagentKindSchema, SubagentStatusSchema, SubagentVerificationSchema } from "./schemas/terminal.js";

// The wire shapes streamed from the daemon's event-iterator procedures. This is their canonical home: the
// daemon yields them and the browser client consumes them from the same schema, so the two can't drift (they
// used to be hand-duplicated across repos). Schemas, not bare types, because oRPC's `eventIterator(...)`
// validates each frame against them.

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

/* THE PROGRAM A COMMAND CARD IS HOLDING, as the thing it is rather than as prose about it.
 *
 * It used to ride in `description`, the field every other permission ask fills with a sentence, which left the
 * card with no way to know it was holding four hundred characters of shell: it rendered them as a paragraph,
 * wrapped mid-flag, and the fragment that caused the hold was somewhere in the middle of it.
 *
 * `spans` is where the pattern match fired, computed by the classifier at the moment it did (contract's
 * command-classes.ts, matchCommand) and carried rather than re-derived: a browser that re-ran the patterns
 * would be a second classifier, and the day the two disagreed the card would be marking a fragment the daemon
 * never saw. Offsets are into `text` AFTER truncation, so they are always paintable.
 *
 * IT IS NOT A CLAIM ABOUT WHY THE CARD EXISTS, and the card no longer presents it as one. The reason is the
 * judge's sentence in the title; these are the fragments TRIAGE noticed, all of the matched classes' rather
 * than whichever sorts first — the card used to show one class's and label them "Stopped for", so a command
 * that cleaned a build directory on its way to publishing offered `rm -rf …` as its reason under a sentence
 * about npm. Under the hard rule the title DOES name a class, so there the marks are that class's alone.
 *
 * `language` is a Shiki grammar id, and the two are the two execution backends the gate reads (command-gate's
 * EXECUTION_SOURCES): a shell line and a script. */
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

// One per-tool permission prompt (the SDK's canUseTool callback, surfaced as a card). The daemon passes the
// bridge's own rendered strings through rather than re-deriving them, so the prompt reads exactly as Claude
// Code words it. `alwaysLabel` is present only when the SDK offered rules to persist, without it the card
// shows allow-once / deny alone, because there is nothing an "always" answer could remember.
export const PermissionAskSchema = z.object({
    toolName: z.string().describe("Which tool it wants to use."),
    // "Claude wants to read foo.txt", the full prompt sentence, when the bridge rendered one.
    title: z.string().optional().describe("The whole question, as a sentence, exactly as the runtime words it."),
    // Short noun phrase for the allow button ("Read file").
    displayName: z.string().optional().describe("A short phrase for the button, such as read file."),
    description: z.string().optional().describe("More about what it is asking for."),
    // Why the prompt fired ('rule' | 'mode' | 'classifier' | …), shown as the card's muted subline.
    reason: z.string().optional().describe("Why it is asking at all: a rule, the current mode, something that looked risky."),
    // The file the request is about, when it is about one (workspace-root-relative).
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
    /* THE JUDGE'S OWN SENTENCE, WHERE THE TITLE IS SOMEBODY ELSE'S. On an ordinary command card the sentence IS
     * the title (the judge read the owner's policy and the program, and its account of why this needs asking is
     * the only account there is), so this is left off rather than printing the same words twice. It carries the
     * sentence on the two cards whose title says something the sentence cannot: the hard rule's, which names the
     * consequence that stopped it, and a machine command's, which names the computer.
     *
     * Written by the quick model from the program text and the policy, never by the agent being gated — a card
     * whose persuasive half was authored by the thing it is stopping argues for its own approval, and the turns
     * that raise cards are exactly the ones whose account of themselves may be a stranger's. */
    explain: z
        .string()
        .optional()
        .describe(
            "One plain sentence saying what the program does and why it is being asked about, where the title says something else. Written by the judge that read your safety policy, never by the agent being gated.",
        ),
});
export type PermissionAsk = z.infer<typeof PermissionAskSchema>;

/* ONE PRICED SERVICE RUN, OFFERED, the card the daemon raises when the agent asks to run a premium service
 * (platform/service-offer.ts). Everything with a number on it is the PLATFORM's answer, relayed verbatim from
 * the catalog it serves the daemon: the model that asked contributes `request` (the JSON it wants sent) and
 * `why` (its one line of rationale), and nothing else, which is what makes the price on the card impossible
 * to misquote, and the click on it the only way the run can happen. */
export const ServiceOfferSchema = z.object({
    // The service, as the platform lists it: `<slug>` is what the run names, the rest is the catalog row.
    slug: z.string().describe("Which service."),
    name: z.string().describe("What it is called."),
    publisher: z.string().describe("Who runs it."),
    description: z.string().describe("What it does."),
    creditsPerRun: z
        .number()
        .describe(
            "What one run costs. Stated by the platform rather than by the agent asking, which is what makes the price impossible to misquote.",
        ),
    /* Whether the platform still has this listing on probation, a new provider that passed admission's
     * mechanical gates but has not yet served enough runs cleanly to graduate. It rides the card because
     * probation is the honest form of "listed automatically, not vouched for": the member approving the
     * spend is the person who should know that, and the platform is the only party that can say it. */
    probation: z
        .boolean()
        .optional()
        .describe(
            "The listing is new and has not yet served enough runs cleanly to be trusted. The honest form of listed automatically but not vouched for, and the person approving the spend is who should know it.",
        ),
    // The owner's meter as the platform stated it with the catalog, what "N left today" renders from. Absent
    // when the platform sent none (it answers a meter only to a member, and membership was already checked
    // before this card went up, so in practice it is present; the field stays honest about the wire).
    credits: z
        .object({
            allowance: z.number().describe("How many credits the period gives."),
            remaining: z.number().describe("How many are left."),
            resetsAt: z.string().describe("When they refill."),
        })
        .optional()
        .describe("Your own meter, as the platform stated it."),
    // The request body the agent wants forwarded, verbatim, shown so the owner can see what leaves.
    request: z.string().describe("Exactly what would be sent, so you can see what leaves before agreeing to it."),
    // The agent's one-line case for spending, the only prose on the card that is the model's.
    why: z.string().optional().describe("The agent's case for spending, and the only words on this card that are the agent's."),
});
export type ServiceOffer = z.infer<typeof ServiceOfferSchema>;

/* WHAT A SERVICE STREAMS, the provider's event vocabulary, stated once here and imported by everyone who
 * touches it: the platform validates each line of a provider's NDJSON against this before relaying it, the
 * daemon turns `status` events into transcript frames, and the editor renders them under the offer card.
 * A run is `status` lines (each replaces the last, a spinner label, not a log) ending in exactly one
 * `result`, whose `data` is the answer the agent acts on. The union is where future event kinds land when
 * services start streaming richer transcript elements; today's two are the smallest honest set. */
export const ServiceStreamEventSchema = z.discriminatedUnion(`event`, [
    z.object({
        event: z.literal(`status`).describe("Progress. Each one replaces the last: a label, not a log."),
        text: z.string().describe("What it is doing."),
    }),
    z.object({
        event: z.literal(`result`).describe("The answer. Exactly one of these ends a run."),
        data: z.unknown().describe("The answer itself, in whatever shape that service returns."),
    }),
]);
export type ServiceStreamEvent = z.infer<typeof ServiceStreamEventSchema>;

/* ONE MISSING CAPABILITY, ASKED FOR, the card the daemon raises when the agent hits something this sandbox
 * is not connected to (capabilities/capability-offer.ts). `card` names the catalog card and `name` is that
 * card's own title, both resolved by the daemon from the catalog it validates the ask against, the model
 * that asked contributes `why` (its one line of rationale) and nothing else, which is what makes the card
 * impossible to misrepresent, and the click on it the only way anything gets connected. */
export const CapabilityOfferSchema = z.object({
    // The catalog card being asked for, and how the catalog itself titles it ("Notion", "GitHub", "Docker").
    card: z.string().describe("Which connection is being asked for."),
    name: z.string().describe("What it is called, as the catalogue titles it rather than as the agent named it."),
    // The agent's one-line case for connecting it, the only prose on the card that is the model's.
    why: z.string().optional().describe("The agent's case for connecting it, and the only words on this card that are the agent's."),
});
export type CapabilityOffer = z.infer<typeof CapabilityOfferSchema>;

/* The trailer the PLATFORM appends to every relayed run stream, never provider-authored: it is the ledger
 * speaking after the stream settled. `ok` means the run served and was charged (`remaining` is the meter
 * after); `refunded` means the provider's stream died before its `result` and the charge was reversed. */
export const ServiceRunReceiptSchema = z.object({
    event: z
        .literal(`receipt`)
        .describe("The last line of a run, added by the platform rather than by the service. The ledger speaking after the fact."),
    outcome: z.enum([`ok`, `refunded`]).describe("Whether it served and was charged, or died before answering and the charge was reversed."),
    credits: z.number().describe("What it cost."),
    remaining: z.number().optional().describe("What is left afterwards."),
});
export type ServiceRunReceipt = z.infer<typeof ServiceRunReceiptSchema>;

/* ONE OUTBOUND USDC PAYMENT, OFFERED, the card the daemon raises when the agent asks to pay an x402
 * endpoint out of the sandbox wallet (wallet/payment-offer.ts). Every number on it is the daemon's own
 * arithmetic over the ENDPOINT's parsed challenge and the wallet's own ledger, the model that asked
 * contributes `why` (its one line of rationale) and nothing else, which is what makes the price on the card
 * impossible to misquote, and the click on it the only way the money can move. */
export const PaymentOfferSchema = z.object({
    // The paid resource, as the endpoint's challenge stated it.
    url: z.string().describe("What is being paid for."),
    description: z.string().optional().describe("What the endpoint says it is."),
    // Where the money goes, verbatim off the challenge: recipient address, CAIP-2 network, token contract.
    payTo: z.string().describe("Where the money goes, taken verbatim from the endpoint's own demand."),
    network: z.string().describe("On which network."),
    asset: z.string().describe("In which token."),
    // The token's display name ("USDC"), dollar-pegged, which is what lets every amount below read as USD.
    assetName: z.string().describe("That token's name. It is pegged to the dollar, which is what lets every amount here read as dollars."),
    // The exact price in display units ("0.10"), the x402 exact scheme has no ranges, so this is the whole
    // spend, not a ceiling.
    amountUsd: z.string().describe("The exact price. Not a ceiling: this scheme has no ranges, so this is the whole spend."),
    // The wallet's meter as the daemon's ledger states it, what "spent today / cap" renders from.
    spentTodayUsd: z.string().describe("What has already gone out today."),
    dailyCapUsd: z.string().describe("What may go out in a day."),
    // The agent's one-line case for paying, the only prose on the card that is the model's.
    why: z.string().optional().describe("The agent's case for paying, and the only words on this card that are the agent's."),
});
export type PaymentOffer = z.infer<typeof PaymentOfferSchema>;

/* ONE GATED CREDENTIAL, ASKED FOR, the card the daemon raises when the agent reaches for a secret or a
 * connected account the owner put behind a named person (secrets/credential-gate.ts).
 *
 * Every field but `why` is the daemon's own: the subject and its approvers come off the gate policy the owner
 * wrote (which lives off the workspace, where the agent cannot edit it), the lane and detail come from the
 * exit that was about to spend the credential, and the scope is the policy's, not the asker's. The model
 * contributes one line of rationale and nothing else, which is what makes the card impossible to
 * misrepresent: a prompt-injected turn can ask for the production password and cannot make the card say it is
 * asking for the staging one.
 *
 * THE APPROVERS ARE ON THE CARD because the card is not addressed to "the owner" the way every other offer
 * here is — it is addressed to a LIST, the server checks the clicker's verified identity against it, and a
 * click from anybody else is refused with the card left standing. So the names have to be visible: a card
 * whose buttons do nothing for the person looking at it must say who it is waiting for. */
export const CredentialOfferSchema = z.object({
    // The gate's subject: a secret's reference name (`DATABASE_URL`) or a capability id (`reddit`).
    subject: z.string().describe("Which credential is being asked for."),
    kind: CredentialGateKindSchema,
    lane: CredentialLaneSchema,
    // Where it would go, in the reader's terms: the head of the agent's command line, the page's host, or the
    // capability's own name. Reference-form by construction on the secret lanes (resolution is what fires the
    // ask), so this can be shown without leaking anything.
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

// One provider-advertised slash command, an ACP agent's available_commands entry, or a Claude Code session's
// supportedCommands() (its built-ins plus the workspace's own .claude/commands and any plugin/skill commands).
// `hint` is the argument placeholder the popover shows after the name.
export const AgentCommandSchema = z.object({
    name: z.string().describe("What to type, without the leading slash."),
    description: z.string().describe("What it does."),
    hint: z.string().optional().describe("What its argument should look like, shown after the name."),
});
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

// GET /agent/commands, which provider's last-published list to read; absent = claude, matching AgentTurn.
export const AgentCommandsQuerySchema = z.object({
    agent: AgentProviderSchema.optional().describe("Whose commands to read. Leave it out for Claude."),
});
export const AgentCommandsSchema = z.object({
    commands: z.array(AgentCommandSchema).describe("The shortcut commands, as the provider last published them."),
});

// One TodoWrite/Task checklist item, surfaced live so the UI shows the agent's plan-of-work (Claude Code style).
export const TodoItemSchema = z.object({
    content: z.string().describe("The item, as the agent wrote it."),
    status: z.enum(["pending", "in_progress", "completed"]).describe("Where it is."),
    activeForm: z
        .string()
        .optional()
        .describe("How to phrase it while it is happening, so a screen can say what the agent is doing rather than what it plans to do."),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// Context-window fill for a conversation: how many tokens the latest request sent vs the model's window, so
// the UI can warn as the chat nears auto-compaction. Per-conversation, unlike the account-wide usage above.
export const ContextUsageSchema = z.object({
    tokens: z.number().describe("How much the latest request sent, all told."),
    contextWindow: z.number().describe("How much the model can hold. The gap between these two is how close the conversation is to being compacted."),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

// ACP-aligned tool taxonomy (Agent Client Protocol's ToolKind, verbatim): what a tool call *does*, driving
// the card icon and the live-writes bookkeeping regardless of which backend named the tool.
export const ToolKindSchema = z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

// A file a tool call touches. Workspace-root-relative, forward-slash (the tree/file route space), adapters
// normalize from the turn's cwd. `line` is 1-based.
export const ToolCallLocationSchema = z.object({
    path: z.string().describe("The file, as a workspace path, whatever directory the tool was run from."),
    line: z.number().optional().describe("Which line, counting from one."),
});
export type ToolCallLocation = z.infer<typeof ToolCallLocationSchema>;

// Structured tool output (ACP's ToolCallContent diff shape, verbatim). `diff` is hunk-level for Edit-style
// tools (old_string/new_string) and whole-file for Write; an absent oldText means a new file / unknown
// previous content. Sides are capped daemon-side; `truncated` marks a clipped side.
//
// `image` is a PICTURE THE TOOL PRODUCED, carried as a workspace path rather than as bytes. Browser screenshots
// already live under .intentic/records/artifacts/browser, and provider-generated images are copied into
// .intentic/records/artifacts/imagegen, so the client fetches either from /workspace/raw like any other file. Base64 on
// the wire would bloat the event stream and every stored transcript to show bytes the workspace already serves;
// the path also keeps the picture openable afterwards. Root-relative, forward-slash: the same route space as
// ToolCallLocation.
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

/* WHAT A PARKED CARD IS ABOUT: the document the turn wrote and is now asking a question against.
 *
 * A card asks for a decision; until this it carried no SUBJECT. The commonest shape of a real decision is "I
 * analysed this and wrote it up, now choose", and the write-up went into a file whose card had already folded
 * itself into `Write · +135 −0` twenty tool calls back. So the reader was asked to choose between options
 * describing a document the chat had never shown them.
 *
 * Carried BY VALUE rather than as a path, for the same reason the diff on a tool call is: the bytes are already
 * in hand when the card is raised, a path would make the card's meaning depend on a file that keeps changing
 * under it, and a restored or published transcript has no workspace to go read. The path rides along anyway, so
 * a document past the wire cap still has somewhere to send the reader.
 *
 * Nothing is asked of the MODEL for this. It calls `ask` exactly as before; the daemon knows what the turn
 * wrote, because every write came past it as a frame (documents.ts decides which of them is a document). A
 * harness that can see the answer must not spend prompt on asking the model to repeat it. */
export const CardDocumentSchema = z.object({
    path: z.string().describe("Where it lives, as a workspace path."),
    title: z.string().describe("What it is called: its opening heading, or its file name."),
    markdown: z.string().describe("The document itself."),
    truncated: z.boolean().optional().describe("It was clipped at the wire cap; the file on disk has more."),
    plan: z.boolean().optional().describe("It is one of the CLI's plan files, written to be approved rather than merely read."),
});
export type CardDocument = z.infer<typeof CardDocumentSchema>;

/* ONE CARD'S OWN FIELDS, spelled once. Three readers carry the same card and must agree on what it is: the
 * frame that raises it (AgentEventSchema below), the journal entry that keeps a parked one across a restart
 * (ParkedCardSchema), and the record row that keeps it for good (TranscriptRowSchema's card fields). A shape
 * declared inline in each was three shapes with one name. */
const REQUEST_ID = z.string().describe("What to send back when you answer.");
const planCard = {
    requestId: REQUEST_ID,
    text: z.string().describe("The plan itself."),
    // Present when the adjacent plan prose POINTS at a document instead of being one: the model wrote the real
    // plan to a file and summarised it there. Absent when the text already is the whole plan.
    document: CardDocumentSchema.optional().describe("The write-up this plan refers to, when the plan itself is a pointer to one."),
};
const questionCard = {
    requestId: REQUEST_ID,
    questions: z.array(AskQuestionSchema).describe("What it wants to know."),
    document: CardDocumentSchema.optional().describe("The document this turn wrote and is asking about, so the choice can be read beside it."),
};
const permissionCard = { requestId: REQUEST_ID };
// The agent's browser needs a person: it parked mid-sign-in on something it cannot clear itself (a captcha,
// a password it does not hold, a phone check). `session` names the browser session on /browsers, the card's
// one action is going THERE, where the live stage and Take control already are; the Browsers banner and this
// card resolve the same requestId. `account` is the capability the sign-in is for, so the card can say whose
// login is stuck even after the browser has navigated somewhere unrecognizable.
const browserHelpCard = {
    requestId: z.string(),
    session: z.string(),
    account: z.string(),
    message: z.string(),
};
// The agent's TERMINAL needs a person: a command it started is sitting at a prompt it cannot answer (a
// one-time password, a security-key touch, a confirm). `session` names the tmux session on the terminal
// panel, the card's one action is going THERE, where the live pane and its prompt already are, which is
// the same division of labour the browser card has with /browsers.
const terminalHelpCard = {
    requestId: z.string(),
    session: z.string(),
    message: z.string(),
};
const serviceOfferCard = { requestId: z.string(), offer: ServiceOfferSchema };
const capabilityOfferCard = { requestId: z.string(), offer: CapabilityOfferSchema };
const paymentOfferCard = { requestId: z.string(), offer: PaymentOfferSchema };
const credentialOfferCard = { requestId: z.string(), offer: CredentialOfferSchema };

/* HOW AN OFFER'S ACCEPTED HALF ENDED, the follow-up that lands on the card after the click. Each is the body of
 * the frame that reports it (`service_receipt`, `capability_outcome`, `payment_receipt`) and the field the
 * record keeps it in, one shape for both, so a receipt reopened tomorrow says exactly what the live card said. */
export const ServiceReceiptSchema = z.object({
    outcome: z.enum(["ok", "refunded", "refused"]),
    credits: z.number(),
    remaining: z.number().optional(),
});
export type ServiceReceipt = z.infer<typeof ServiceReceiptSchema>;
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
/* WHO RELEASED A GATED CREDENTIAL, or that a person refused it. `released` carries the approver's own address,
 * read off the VERIFIED identity on the reply rather than off anything the click claimed, which is what makes
 * the row an audit line rather than a rendering. There is no receipt for a card nobody answered: `resolved`
 * already says so, and inventing "refused" for a deadline would put words in a person's mouth. */
export const CredentialReceiptSchema = z.object({
    outcome: z.enum(["released", "refused"]),
    approvedBy: z.string().optional(),
});
export type CredentialReceipt = z.infer<typeof CredentialReceiptSchema>;

/* THE THREE RESTORABLE CARDS, named so the turn journal can hold them verbatim: a parked turn's raised cards
 * are written down beside its prompt (sandbox turn-journal.ts), and a daemon death under the park restores the
 * very same frames instead of ending the turn `interrupted`, the card the user was about to answer survives
 * the restart that killed the process holding it. The two handover cards are deliberately not among them:
 * `browser_help`'s Chromium and `terminal_help`'s waiting command both die with the container, so those parks
 * cannot be restored, only reported. */
const PlanCardSchema = z.object({
    kind: z.literal("plan").describe("The agent has written a plan and is waiting for a yes."),
    ...planCard,
});
const QuestionCardSchema = z.object({
    kind: z.literal("question").describe("The agent has asked you something and is waiting."),
    ...questionCard,
});
const PermissionCardSchema = PermissionAskSchema.extend({
    kind: z.literal("permission").describe("The agent wants to use a tool it needs permission for."),
    ...permissionCard,
});
export const ParkedCardSchema = z.discriminatedUnion("kind", [PlanCardSchema, QuestionCardSchema, PermissionCardSchema]);
export type ParkedCard = z.infer<typeof ParkedCardSchema>;

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
export const TranscriptServiceOfferSchema = z.object({
    ...serviceOfferCard,
    status: OfferStatusSchema.describe("Where the decision stands."),
    events: z.array(ServiceStreamEventSchema).optional().describe("The approved run's stream, in order (the service_event frames)."),
    receipt: ServiceReceiptSchema.optional().describe("How the approved run ended (the service_receipt frame)."),
});
export type TranscriptServiceOffer = z.infer<typeof TranscriptServiceOfferSchema>;
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
    serviceOffer: TranscriptServiceOfferSchema.optional().describe("The priced service run this row offered, the decision, and the receipt."),
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
    "serviceOffer",
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
        .object({ ran: z.boolean().describe("Whether the held turn got anywhere before it was refused, which is a different sentence from one refused at the door.") })
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

// One frame from an agent turn, relayed to the UI. `kind`-discriminated. The daemon normalizes the SDK's
// ~40 SDKMessage types down to this union: high-value block types get a dedicated frame
// (delta/thinking/tool_call/tool_call_update/todos/usage/rate_limit_info/account_usage/context_usage/init/compact); any SDK message
// without a UI mapping is dropped. `plan`/`question`/`permission` pause the turn until the user answers on the
// `POST /agent/reply` side channel, and `resolved` releases the one it names; `mode` reports the live
// permission posture as the agent changes it.
// `parentToolUseId` tags frames produced inside a subagent (Task tool); `subagent`/`subagent_update` report the
// subagent itself, keyed by the same tool_use id those tagged frames carry.
export const AgentEventSchema = z.discriminatedUnion("kind", [
    /* THE SESSION THIS TURN IS RUNNING, and the credential it belongs to.
     *
     * `account` is the account the daemon RESOLVED for the turn, which is not always the one the request named:
     * a turn that names none is given the connected account with the most headroom (agent/harness-credentials.ts),
     * so "the client's pick" and "who is paying" are different questions and only the daemon can answer the
     * second. It rides here because a session belongs to the credential that minted it — that pairing is what
     * decides whether the next message resumes this session or opens a fresh one — and a client that stamped its
     * own pick onto the session instead would announce a fresh session for the account that actually holds it.
     *
     * Absent when the turn ran on the container's env token or on a translator subscription, where there is no
     * stored account to name. */
    z.object({
        kind: z.literal("session"),
        sessionId: z.string(),
        account: z.string().optional().describe("Which stored account this session belongs to, as the daemon resolved it for the turn."),
    }),
    /* WHERE AN ISOLATED TURN IS STANDING: the conversation's worktree identity, its branch (agent/<id>) and
     * the ROOT repo's short base sha. First frame of the turn, before any provider frames, and again each time
     * the branch MOVES underneath it, which is why `base` names where the branch sits now rather than the
     * moment it was checked out.
     *
     * `unenforced` marks the degraded container: no CAP_SYS_ADMIN, so the turn's worktree could not be
     * bind-mounted over the workspace root and the harness is rewriting tool paths into it instead. That
     * fallback covers what arrives as tool input and not what a subprocess computes for itself, so the
     * operator needs to know, this state used to be one line in the daemon log at boot, and the way it got
     * noticed was files appearing in the main tree from agents that were supposed to be on branches. Repeated
     * on every emission, because it describes the turn and a client rebuilds its standing from the last frame.
     *
     * `sync` reports a rebase (agents/sync.ts) and rides here because this frame is already the turn's "where
     * you are standing" announcement. Present only when the branch was BEHIND the main line, `commits` is how
     * many main-line commits it gained, `blocked` names the repos whose rebase would not apply and was rolled
     * back. Both can be non-empty at once in a multi-repo composition. Two moments produce it: before the turn
     * starts, and after a card the turn parked on is answered, a question or a plan approval waits minutes
     * for a person, and the main line does not stop moving meanwhile. It is a notice and never a question: the
     * user is answering their agent, and the alternative to rebasing is not "stay safe" but "conflict at land
     * time", which interrupts them harder. */
    z.object({
        kind: z.literal("worktree"),
        branch: z.string(),
        base: z.string(),
        unenforced: z.boolean().optional(),
        sync: z.object({ commits: z.number(), blocked: z.array(z.string()) }).optional(),
        // The runner this turn executes on, when the conversation is placed remotely (runners/): the
        // transcript's own statement of where the work is happening. Absent ⇒ this sandbox.
        remote: z.string().optional(),
    }),
    // Emitted after a clean isolated turn whose delta auto-landed (or failed to): landed ⇒ the work is now
    // UNCOMMITTED changes in the main tree (the Changes panel is the review); conflicts ⇒ it stayed safely in
    // the worktree, and each named path carries WHY it would not apply (see LandConflictSchema) so the report
    // can say whether the user's own copy is at risk or the main line simply moved on underneath the agent.
    // held ⇒ auto-land is off for this agent: nothing was applied and nothing failed, the delta is waiting
    // on the branch for a deliberate Land (landed is false, conflicts absent).
    // `deps` rides along when the landed delta left the main tree declaring dependencies it does not have,
    // the residue of an agent adding one without installing it, which every LATER turn would inherit through
    // the overlay it mounts over the main checkout. The daemon reconciles it rather than asking anyone to
    // (workspace/reconcile-deps.ts); this is the receipt, and `deferred` is the honest answer while other turns
    // are still running, since an install cannot touch a tree they are mounted on.
    z.object({
        kind: z.literal("landed"),
        landed: z.boolean(),
        conflicts: z.array(LandConflictSchema).optional(),
        held: z.boolean().optional(),
        deps: z.object({ missing: z.number(), started: z.array(z.string()), deferred: z.boolean() }).optional(),
    }),
    /* WHAT THE DAEMON ADDED TO THE USER'S MESSAGE before the model read it, the exact words, not a summary of
     * them.
     *
     * A turn's prompt is not only what was typed: the daemon prepends notes the model needs and the user did not
     * write (agent/turn-preamble.ts owns the list, a rebase that moved the branch, dependencies that are behind,
     * workspace context retrieved for this very message, where an unenforced runtime's files really live). Those
     * notes change what the agent does, and for a long time the chat's only trace of any of them was one muted
     * line paraphrasing the rebase, so a user watching an agent act on instructions they could not see had no
     * way to find out what those instructions said. This frame is the fix: the note text verbatim, one entry per
     * note, rendered collapsed so it costs a click rather than a scroll.
     *
     * Emitted from the TYPED notes the wire prompt is serialized from at the same point (turn-preamble.ts,
     * composeWirePrompt), so the disclosure and what the model receives cannot drift: a note is in both or in
     * neither, and a note nobody thought to title cannot reach the wire unlabelled.
     *
     * ONE MOMENT, always: the notes went in front of the user's own message before the turn started, so they hang
     * off that message and are stored on it, the transcript fold reads this very frame out of the turn's own
     * frame log (sessions/turn-transcript.ts), which is how a reopened tab still has them. Nothing is injected
     * into a RUNNING turn, the rebase taken while a card sat waiting was the only thing that ever was, and it no
     * longer says anything to the model at all (agent/turn-preamble.ts). */
    z.object({ kind: z.literal("preamble"), notes: z.array(TurnNoteSchema) }),
    // The SDK's init handshake; carries the model it actually resolved for the turn.
    z.object({ kind: z.literal("init"), model: z.string() }),
    // The pre-turn workspace snapshot's id (the attribution-fence "user" capture), emitted once before the
    // provider stream so the client can offer "restore to before this message" on the turn's user bubble.
    // Absent on isolated turns (they snapshot nothing) and when the tree was already clean at turn start.
    /* The workspace checkpoint capturing the state as this turn FOUND it, what "go back to before this
     * message" restores. `index` is the message's position in the conversation's transcript, which the rewind
     * route addresses it by; absent on a turn with no conversation behind it (the bench, a one-shot), where
     * the id still powers a plain restore but there is no message to rewind to. */
    z.object({ kind: z.literal("checkpoint"), id: z.string(), index: z.number().int().nonnegative().optional() }),
    /* A MESSAGE THE USER SENT INTO THE TURN WHILE IT RAN, the mid-turn steer, at the point in the stream where
     * the daemon accepted it (agent/agent-steering.ts).
     *
     * A frame rather than a client-local write, because all three things that were wrong about the steer are the
     * same missing fact: nothing in the run's log said WHEN it arrived.
     *   - POSITION. The harness injects a steer between tool calls and the model simply keeps writing, with no
     *     `result` in between, so there is no `usage` boundary to retire the open bubble. The sending window
     *     appended the user's words at the END of its transcript while the turn kept typing into the bubble
     *     ABOVE them, and the answer to a question landed over the question.
     *   - EVERY OTHER WINDOW. A run is rendered by any number of attached clients; only the one that posted the
     *     steer knew about it, so the same conversation read differently in two places.
     *   - THE RECORD. The settled turn is written down from this log (sessions/turn-transcript.ts), and one that
     *     never held the steer wrote a transcript the message was missing from entirely, which also put the
     *     client's row count one ahead of the daemon's for the rest of the conversation, and those counts are
     *     what a fork copies a prefix of and a rewind addresses.
     *
     * `text` is what the user typed, never the composed prompt: the editor-context and attachment notes the
     * route wraps around it are protocol, and redrawing them as the user's words is the same lie the stored
     * prompt is unwrapped to avoid. `attachments` are workspace-relative, like the turn's own. `sentAt` is the
     * instant the turn took the message, carried so the bubble wears the same clock live and after a reopen,
     * a turn's own user row is stamped from the daemon's clock too, and a live bubble stamped from the
     * browser's would visibly jump when the record replaced it. */
    z.object({ kind: z.literal("steer"), text: z.string(), sentAt: z.number(), attachments: z.array(z.string()).optional() }),
    z.object({ kind: z.literal("delta"), text: z.string(), parentToolUseId: z.string().optional() }),
    // The prose block the `delta` frames were writing is finished. A turn emits several: the model says what
    // it is about to do, runs tools, reports what it found, runs more, then summarizes, each a separate text
    // block in the SDK stream. Without this boundary the client has no way to tell them apart and glues the
    // whole turn's narration into one paragraph run, so the client retires its current bubble here and lets
    // what follows (the tool calls this block introduced, or the next block of prose) open a fresh one.
    z.object({ kind: z.literal("text_end"), parentToolUseId: z.string().optional() }),
    z.object({ kind: z.literal("thinking"), text: z.string(), parentToolUseId: z.string().optional() }),
    // A tool call starting (or, for backends that only report completions, arriving whole). `content` carries
    // structured output known at call time, an Edit's diff is derived from its input, no result needed.
    z.object({
        kind: z.literal("tool_call"),
        id: z.string(),
        name: z.string(),
        category: ToolKindSchema,
        status: ToolCallStatusSchema,
        target: z.string().optional(),
        locations: z.array(ToolCallLocationSchema).optional(),
        content: z.array(ToolCallContentSchema).optional(),
        parentToolUseId: z.string().optional(),
    }),
    // A later state of a tool call, correlated by `id`. N updates per call: status transitions and/or fresh
    // content/locations, both REPLACE the prior value (snapshot semantics, not append); absent ⇒ unchanged.
    z.object({
        kind: z.literal("tool_call_update"),
        id: z.string(),
        status: ToolCallStatusSchema.optional(),
        content: z.array(ToolCallContentSchema).optional(),
        locations: z.array(ToolCallLocationSchema).optional(),
    }),
    // The agent just started running Bash in its live `agent-<id>` tmux session, the client surfaces that
    // terminal in the global panel. One per turn (the session is reused across a turn's commands, incl. subagents').
    z.object({ kind: z.literal("terminal"), session: z.string() }),
    // The agent just used a browser tool, its Chromium is coming up (or already is) behind a watchable
    // `browser-<id>` session, and the client surfaces it in the same panel as the terminals. One per turn, for
    // the same reason: one browser serves every browser call the turn makes.
    z.object({ kind: z.literal("browser"), session: z.string() }),
    /* THE AGENT STARTED ANOTHER AGENT, an Agent/Task subagent, or a Codex/Grok CLI it drove from its own Bash
     * (see SubagentSessionSchema). One `subagent` frame per child, then `subagent_update` as it works: the same
     * call/update pair `tool_call`/`tool_call_update` uses, and for the same reason, the fields that move
     * (status, spend, what it is doing) arrive many times and must REPLACE, while the fields that identify it are
     * said once.
     *
     * `id` is the SPAWNING TOOL CALL's id, the same id the client already nests the child's inner frames under
     * (`parentToolUseId`), so both frames land on the card that spawned the child by the lookup that is already
     * there (mapToolAnywhere). No second correlation, and nothing to get wrong.
     *
     * These exist because the SDK's task messages were dropped. A BACKGROUNDED child (the Agent tool's default)
     * emits its tool_use and then nothing until its result lands, which for a long child is minutes of a spinner
     * that cannot say whether anything is happening. */
    z.object({
        kind: z.literal("subagent"),
        id: z.string(),
        subagentKind: SubagentKindSchema,
        agentType: z.string().optional(),
        description: z.string().optional(),
        model: z.string().optional(),
        // Which provider serves a `spawned` child (SubagentSessionSchema.provider), absent for an SDK
        // subagent, whose provider is its parent's.
        provider: z.string().optional(),
        background: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal("subagent_update"),
        id: z.string(),
        status: SubagentStatusSchema.optional(),
        tokens: z.number().optional(),
        toolUses: z.number().optional(),
        lastTool: z.string().optional(),
        summary: z.string().optional(),
        error: z.string().optional(),
        // Whether anything checked the work the report describes (SubagentVerificationSchema). Rides the frame
        // that ENDS the child, beside the report itself, so the card carries both at once.
        verification: SubagentVerificationSchema.optional(),
    }),
    z.object({ kind: z.literal("todos"), items: z.array(TodoItemSchema) }),
    // The provider's own slash commands (ACP available_commands_update), replaced whole each time, the
    // composer's `/` popover lists them; invoking one is plain `/name …` prompt text (the ACP convention).
    z.object({ kind: z.literal("commands"), items: z.array(AgentCommandSchema) }),
    z.object({
        kind: z.literal("usage"),
        // The account that served this turn, the client attributes the totals to it (tagged by streamAgent).
        account: z.string().optional(),
        costUsd: z.number().optional(),
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        // Provider prompt-cache buckets for the turn: tokens served from cache (read) and written to cache
        // (creation). Optional per provider. Codex reports only cached input (read); runtimes/turns that
        // don't report a bucket omit it. Lets the client show cache hit rate = read / (read + input).
        cacheReadTokens: z.number().optional(),
        cacheCreationTokens: z.number().optional(),
        durationMs: z.number().optional(),
        numTurns: z.number().optional(),
    }),
    // The live gate: the provider's answer to "may this turn run", pushed mid-turn. Drives the rate-limited
    // notice, not the headroom readouts, see RateLimitInfoSchema.
    RateLimitInfoSchema.extend({ kind: z.literal("rate_limit_info"), account: z.string().optional() }),
    /* WHAT SPEED THIS TURN ACTUALLY RAN AT, and when it isn't the one asked for, why. Emitted only when the
     * answer CHANGES within a turn, so the ordinary case is one frame at init and nothing after it; a turn that
     * enters cooldown mid-flight (fast mode has its own rate-limit pool, separate from the model's) emits a
     * second.
     *
     * This frame exists because fast mode fails SILENTLY and for a lot of different reasons, the plan is free,
     * extra usage is off, the model doesn't offer it, the turn is routed through the translator and so isn't
     * first-party, an env var disables it, the pool is in cooldown. Asking for it and getting standard speed is
     * indistinguishable, from the outside, from asking for it and getting it: same frames, same text, a bill
     * that differs by 2x. A toggle whose effect can't be observed is worse than no toggle, so the daemon
     * reports the harness's own answer rather than the client's assumption.
     *
     * `reason` is forwarded VERBATIM as the string the harness reported (SDK: FastModeDisabledReason) rather
     * than re-typed as an enum here: the set is the vendor's and grows on their schedule, and a reason this
     * build hasn't heard of should reach the user as an unfamiliar word, not fail schema validation and take
     * the whole frame with it. The client maps the ones it knows to sentences and shows the rest as-is. */
    z.object({
        kind: z.literal("fast_mode"),
        state: FastModeStateSchema,
        // Absent when nothing is blocking fast mode, including on `state: "on"`, and on an `off` that simply
        // wasn't asked for.
        reason: z.string().optional(),
    }),
    /* WHAT THE COMPLEXITY JUDGE MADE OF THIS TURN, emitted once at turn start on every judged turn (that is,
     * whenever settings.autoTier is not "off"), for the same reason fast_mode exists: a mechanism that can
     * change what a turn runs on fails silently unless the daemon says what it decided. One tiny frame per
     * turn, deliberately on the standard verdicts too, because the client's composer preview needs the
     * conversation's LAST verdict (prompt-complexity.ts `afterHardTurn`) and a frame only on the interesting
     * turns would leave it guessing on the common ones.
     *
     * `tier`/`score`/`rules` are the verdict verbatim (judgeComplexity): the rules are the named-feature
     * vocabulary of ComplexityRule, carried as strings so a frame from a build with a rule this client hasn't
     * heard of still parses. `model` is present only when a substitution actually applies to THIS turn, which
     * is `routed` (mode on, verdict fast, something cheaper published) or `held` (the same turn the user pinned
     * to their pick, see AgentTurn.tierHold): measure mode never names one because naming it would cost the
     * catalog read shadow mode exists to avoid.
     *
     * `routed` is what HAPPENED, never implied by the verdict: a fast verdict in measure mode, under a hold, or
     * with nothing cheaper published all run the user's own pick and say `routed: false`. */
    z.object({
        kind: z.literal("tier"),
        tier: z.enum(["fast", "standard"]),
        score: z.number(),
        rules: z.array(z.string()),
        // The cheaper model this turn ran on (routed) or would have run on (held). Absent otherwise.
        model: z.string().optional(),
        routed: z.boolean(),
        // The user pinned this turn to their pick (AgentTurn.tierHold), so a fast verdict moved nothing.
        held: z.boolean().optional(),
    }),
    /* The turn is alive but WAITING on the provider: a request failed transiently (5xx, 529, a dropped socket)
     * and the harness is retrying it inside this same turn. A status, not a failure, nothing has been lost and
     * the turn may still finish normally, so the client renders it where "thinking" goes rather than in the
     * transcript.
     *
     * It exists because the retry budget is deliberately long (see CLAUDE_CODE_RETRY_WATCHDOG in
     * harness-credentials.ts): a turn can now sit silent for minutes riding out an outage, and silence reads as
     * a hang. The one action a user takes against an apparent hang is Stop, which is the only action that
     * actually loses the work, so the wait has to be visible, with its own next-attempt clock.
     *
     * `attempt` is the harness's own counter and `maxAttempts` is the bound that will actually be honoured,
     * which on the Claude path is the daemon's own cap on how deep a storm may get rather than the harness's
     * far longer budget (MAX_IN_TURN_RETRIES in sdk-stream.ts, which ends the turn at the cap and hands the
     * waiting to the outage breaker). `nextAttemptAt` (epoch ms) is when it will try
     * again, so the readout counts down instead of freezing on a number nobody can interpret. BOTH are optional
     * for the same reason, which is that each runtime publishes a different half of the wait and none of them
     * publishes all of it: Claude's harness reports the delay and the bound, Codex says which attempt it is on
     * and nothing else (codex-agent.ts), OpenCode names the next instant but no bound (grok-agent.ts). Inventing
     * the missing half would be a countdown, or a limit, the retry never agreed to. */
    z.object({
        kind: z.literal("provider_retry"),
        attempt: z.number(),
        maxAttempts: z.number().optional(),
        nextAttemptAt: z.number().optional(),
        // The HTTP status behind it when there was one (529 reads as capacity, 429 as a rate limit, 500 as a
        // fault, the client says which). Absent for a transport failure that never got a response, and for a
        // runtime that reports the refusal as prose rather than a code (grok-agent.ts reads it back off that).
        status: z.number().optional(),
    }),
    // Every plan-limit pool for the account that served the turn, read from the CLI's usage endpoint once the
    // turn settles. `account` tags which Claude account it belongs to, so the client keys headroom by account;
    // absent on an env-token turn, which has no account to attribute it to. No `measuredAt` on the wire: both
    // readers stamp it on receipt, which is the read time to within the hop.
    z.object({ kind: z.literal("account_usage"), account: z.string().optional(), windows: z.array(UsageWindowSchema) }),
    ContextUsageSchema.extend({ kind: z.literal("context_usage") }),
    z.object({ kind: z.literal("compact"), trigger: z.string(), preTokens: z.number().optional(), postTokens: z.number().optional() }),
    // The four interactive cards. Each parks the turn until `POST /agent/reply` resolves its `requestId`.
    PlanCardSchema,
    QuestionCardSchema,
    PermissionCardSchema,
    // The agent's browser needs a person (see browserHelpCard for what the card carries). Not journalled for
    // restore: the Chromium holding the page dies with the container.
    z.object({ kind: z.literal("browser_help"), ...browserHelpCard }),
    // The agent's TERMINAL needs a person (see terminalHelpCard). Not journalled for restore, and for the
    // browser card's reason one door along: the pane holding the prompt belongs to a process the restart kills.
    z.object({ kind: z.literal("terminal_help"), ...terminalHelpCard }),
    /* A premium service run awaiting the owner's click. Raised OUTSIDE the turn generator, the daemon's
     * services route parks the agent's own `services run` call and pushes this frame into the live run
     * (platform/service-offer.ts), so unlike the four cards above it is not journalled for restore: its
     * waiter is the CLI's held connection, which dies with the daemon, and a restored card would offer
     * buttons nothing is waiting behind. Settles through the same `POST /agent/reply` as every other card. */
    z.object({ kind: z.literal("service_offer"), ...serviceOfferCard }),
    /* One event off an approved run's stream, pushed as the provider emits it so the settled card shows the
     * run living rather than a spinner of unknowable length. Today that is `status` lines; `result` stays off
     * the transcript on purpose (it is the agent's answer to act on, not the card's to duplicate), the frame
     * carries the whole union so richer event kinds land here without a contract break. */
    z.object({ kind: z.literal("service_event"), requestId: z.string(), event: ServiceStreamEventSchema }),
    /* How an approved run ended, pushed after the platform answered so the card can settle as a receipt
     * rather than a promise: `ok` served and charged, `refunded` failed to answer and charged nothing,
     * `refused` the platform said no after the click (a raced-out allowance). `remaining` is the meter after,
     * when the platform stated one. Skip needs no receipt, nothing happened, and `resolved` already says so. */
    ServiceReceiptSchema.extend({ kind: z.literal("service_receipt"), requestId: z.string() }),
    /* A missing capability asking for the owner's setup, the agent hit something this sandbox is not
     * connected to and raised the card instead of describing manual steps. Raised OUTSIDE the turn generator
     * exactly like the service offer above (the daemon's ask route parks the agent's `capabilities request`
     * call and pushes this frame into the live run; capabilities/capability-offer.ts), so it is not
     * journalled for restore either: its waiter is the CLI's held connection, which dies with the daemon.
     * Settles through the same `POST /agent/reply` as every other card. */
    z.object({ kind: z.literal("capability_offer"), ...capabilityOfferCard }),
    /* How an accepted ask ended, pushed once the daemon stops watching for the connection: `connected`, the
     * capability came live while the agent waited (`id` is the connected instance, the agent's handle for it)
     *, or `unfinished`, the setup did not complete while anyone was waiting (the deadline passed, or the
     * asking command died). A skip needs no outcome frame, nothing was set up, and `resolved` already says
     * so. It is what settles the card's "waiting for you to finish setup" state on every surface. */
    CapabilityOutcomeSchema.extend({ kind: z.literal("capability_outcome"), requestId: z.string() }),
    /* A USDC payment awaiting the owner's click. Raised OUTSIDE the turn generator exactly like the service
     * offer above (the daemon's wallet route parks the agent's `wallet fetch` call and pushes this frame into
     * the live run; wallet/payment-offer.ts), so it is not journalled for restore either: its waiter is the
     * CLI's held connection, which dies with the daemon. Settles through the same `POST /agent/reply`. */
    z.object({ kind: z.literal("payment_offer"), ...paymentOfferCard }),
    /* How an approved (or auto-approved) payment ended, pushed after the endpoint answered so the card can
     * settle as a receipt rather than a promise: `paid`, the endpoint confirmed settlement (`transaction` is
     * the onchain hash when it stated one); `failed`, the payment was refused or settlement failed, in which
     * case the signed authorization expires unused and NOTHING left the wallet. A skip needs no receipt,
     * nothing moved, and `resolved` already says so. */
    PaymentReceiptSchema.extend({ kind: z.literal("payment_receipt"), requestId: z.string() }),
    /* A GATED CREDENTIAL awaiting a NAMED person's click, the one card on this stream that is not addressed to
     * the owner: the daemon holds an exit (a `{{secret:…}}` about to resolve, a browser field about to be
     * typed into, a connected account about to be mounted) parked until one of the gate's approvers releases
     * it (secrets/credential-gate.ts). Raised OUTSIDE the turn generator like the offers above — the exits run
     * inside a PreToolUse hook and inside the daemon's own `secrets request` route — so it is not journalled
     * for restore: its waiter is a held hook or a held connection, both of which die with the daemon, and the
     * next use after a restart simply asks again. Settles through the same `POST /agent/reply`, which is where
     * the clicker's identity is checked against `offer.approvers`. */
    z.object({ kind: z.literal("credential_offer"), ...credentialOfferCard }),
    /* WHO RELEASED IT, pushed the moment a person decided, so the settled card names them rather than saying
     * only that something was approved: `released` with the approver's verified address, or `refused` when a
     * person said no. Nothing is pushed for a card nobody answered — `resolved` already says that, and a
     * deadline is not a refusal by anybody. */
    CredentialReceiptSchema.extend({ kind: z.literal("credential_receipt"), requestId: z.string() }),
    // The card above named by `requestId` is released, the user answered (or dismissed it, or the turn was
    // stopped out from under it), so the turn is executing again. Emitted by whoever parked, the moment its
    // waiter settles, because the park's END is otherwise invisible on this stream: nothing else here says
    // "that card is done", and it cannot be inferred from the next frame that happens along. Frames DO arrive
    // while a turn is parked, the pausing tool's own `tool_call` regularly trails its card (the SDK queues
    // stream messages while dispatching an in-process MCP tool straight off the transport), and a card raised
    // beside a parallel tool call sits through that tool's whole life. See agents-registry.ts, which reads
    // this pair as the fleet's "needs you" state.
    //
    // `reply` says HOW it settled, and is what a transcript rebuilt from this log freezes the card with: a
    // reload replays the run from seq 0 and a second window renders it live, so both would otherwise restore
    // the card pending, offering buttons on a requestId nothing holds any more, under a transcript that has
    // already moved on. It rides verbatim, exactly as the client POSTed it; absent, nobody answered (the turn
    // was stopped, or died under the card), which is not a decision and must not replay as one.
    z.object({ kind: z.literal("resolved"), requestId: z.string(), reply: AgentReplySchema.optional() }),
    /* There was a `permission_note` frame here: a late sentence raced onto a command card that had already gone
     * out, because the explanation was optional and the card must not wait for a quick-model rung that might
     * take tens of seconds. It is gone with the setting that made it optional. The judge now decides the
     * verdict, so the sentence is not a decoration arriving afterwards — it is the REASON THE CARD EXISTS, and
     * a card cannot be raised before it is known. Nothing races, and `PermissionAsk.explain` is populated at
     * raise time (guard/command-gate.ts). */
    // The turn's permission mode, whenever it changes, the user's pick at turn start, then every move the
    // AGENT makes on its own (EnterPlanMode on a request that needs thinking through, ExitPlanMode once the
    // user approves). The composer's mode selector follows this, so the UI never lies about the live posture.
    z.object({ kind: z.literal("mode"), mode: PermissionModeSchema }),
    // `code` is a machine-readable discriminator for errors the UI reacts to programmatically (dropping a
    // dead session id so the next send self-heals). Absent on plain failures.
    z.object({
        kind: z.literal("error"),
        message: z.string(),
        code: z
            .enum([
                "session-not-found",
                "rate_limit",
                // Codex ran the turn but warned about it (fallback model metadata), a notice, not a failure.
                "codex-advisory",
                "codex-reauth",
                // The Claude subscription credential is dead (revoked, or its refresh token rejected) and only a
                // reconnect fixes it. Distinct from "no account connected": the account IS there, so the UI can
                // offer reconnect where the user already is and replay the message that bounced.
                "claude-reauth",
                // The API refused this turn's token MID-FLIGHT, nearly always one superseded by a rotation,
                // which Anthropic retires the moment its successor is minted. Distinct from claude-reauth: the
                // account is fine and the daemon re-mints on the spot, so this is usually a notice about a turn
                // that is coming back rather than a request for the user to do anything. `autoResume` says
                // which of the two: "scheduled" means the re-mint-and-re-run is armed, and its absence means
                // nothing is coming (the turn was already a resume, or it ran on a credential with nothing to
                // re-mint from), that is the case where reconnecting really is the fix.
                "claude-token-refused",
                /* THE ACCOUNT IS FINE AND STILL NOT ALLOWED TO RUN, an Anthropic organization that has turned
                 * Claude Code off for this seat. The token authenticates, the plan's own usage endpoint answers
                 * with real pools, and every turn is refused anyway, which is why it is its own code rather than
                 * a member of either neighbour: a spent allowance comes back on a clock and a refused credential
                 * comes back on a re-mint, and NEITHER of those is true here. Only an admin re-enabling access
                 * is, so nothing is re-run and nothing asks the user to reconnect, the one recovery that looks
                 * plausible and is guaranteed to waste their time. */
                "claude-not-entitled",
                /* The model provider itself failed transiently: 500/502/503, a 529 at capacity, a dropped
                 * socket, and the harness's own in-turn retries did not outlast it. Nothing about the workspace
                 * or the request is wrong, so the daemon remembers the turn and re-runs it on an escalating
                 * backoff (provider-health.ts): the frame is a notice about a turn that is coming back, and
                 * reaches the client as a plain failure only once the attempts are spent.
                 *
                 * ONE 4xx JOINS THEM, the provider refusing a request PARAMETER nothing here sends (its own
                 * cache-retention default, or one a proxy added). It wears a client error's status code and is
                 * still a provider fault: there is no request of the user's to fix, and the same send goes
                 * through moments later, so it recovers the same way (agent/failure-sentences.ts). */
                "provider-outage",
                // The platform-owned free-trial pool failed after its bounded key walk. Unlike provider-outage,
                // this is never auto-resumed: failed calls are refunded and the user's message is held to retry.
                "trial-unavailable",
                // The trial answered, but the selected upstream model/request cannot run through this sandbox.
                "trial-model-unavailable",
                // This account's platform-owned daily trial allowance is spent until its UTC reset.
                "trial-exhausted",
                // The harness read the message as a slash command it doesn't have, and discarded everything
                // after the name, the model never saw the message. Nothing was processed, so the client holds
                // the text back instead of leaving the user to retype it (same treatment as claude-reauth).
                "unknown-command",
                "grok-model-invalid",
                "codex-model-invalid",
                /* THE MODEL CANNOT HOLD A TURN OF THIS AGENT LOOP, so the daemon refused before sending
                 * (agent/context-budget.ts). Its own code because none of the neighbours describes it: nothing is
                 * disconnected, nothing is spent, nothing comes back on a clock, and re-sending the same request
                 * at the same model fails identically forever. What changes the outcome is the model or the
                 * server's context flag, so the message names both and the client HOLDS the words: they never
                 * reached anything, and losing them to a configuration fact would be the one part of this that
                 * was our fault. */
                "context-window-too-small",
                "subscription-required",
                "agent-busy",
                /* THE SANDBOX HAS NO MEMORY LEFT TO RUN THIS TURN, refused before anything was spawned
                 * (platform/memory-admission.ts). Its own code because it is the only refusal here that is
                 * about the BOX rather than the request: the prompt, the model and the credential are all
                 * fine, and the identical request succeeds once something inside frees room, which is the
                 * opposite of context-window-too-small next door. Transient without being on a clock, so
                 * there is no resetsAt to offer — what changes the outcome is a turn finishing or a session
                 * closing, and the message says so. The client HOLDS the words for the same reason
                 * context-window-too-small does: they never reached a provider, and losing them to a
                 * capacity fact the user did not cause would be ours to answer for. */
                "sandbox-memory-low",
                /* THE LOOP RAN OUT OF ITERATIONS, not out of work: the runtime hit its own turn ceiling and
                 * stopped. Nothing failed, nothing is disconnected and nothing is spent, which is exactly why
                 * it needs a code of its own rather than a sentence: it is the one ending that LOOKS like a
                 * finished turn from the outside, and a ledger that filed it as an ordinary error told a
                 * reader nothing they could act on.
                 *
                 * The recovery is the user's, not the daemon's: whatever the turn was doing is half done, and
                 * re-running it blind would either redo the finished half or resume work nobody looked at. */
                "turn-cap",
                /* THE HARNESS ENDED THE TURN WITHOUT SUCCEEDING and did not say why in terms anything here
                 * models: an internal execution error, or a result subtype a later vendor build invented. The
                 * sentence carries the subtype verbatim, because that word is the only thing separating two of
                 * these, and a code that meant "one of several unrelated things" would be worse than none. It
                 * is a real classification all the same: it says the failure came from the LOOP rather than
                 * from the provider, the credential or the request, which rules out every recovery next door. */
                "harness-incomplete",
                /* THE ENGINE IS TOO OLD FOR THE MODEL, and the provider says so in the same breath as the
                 * version that would work ("Claude Code 2.1.233 does not support this model; version 2.1.251
                 * or newer is required"). Its own code because the fix is unlike every neighbour's: nothing is
                 * disconnected, nothing is spent, no retry of any length helps, and the thing that has to
                 * change is not the request but the PROGRAM running it (schemas/engines.ts).
                 *
                 * It used to be unfixable from inside a sandbox at all — the engine came with the image, so a
                 * whole fleet failed every turn on this model until a new image reached it. Now the daemon can
                 * install the version the provider named, which is why this frame carries the numbers rather
                 * than only the sentence: `engine` is what the card's Update button acts on. The install is
                 * still a person's decision, because the version that satisfies a floor is by definition one
                 * nobody has blessed yet. */
                "engine-version-floor",
            ])
            .optional(),
        /* engine-version-floor only: which engine is too old, what it is running, and the floor the provider
         * demanded. On the wire because the recovery is a specific, offerable action — install at or above
         * `floor` — and a client that had only the sentence would have to parse prose to offer it. */
        engine: z
            .object({
                id: z.string().describe("Which engine (e.g. claude)."),
                running: z.string().optional().describe("The version that was refused, when the provider named it."),
                floor: z.string().describe("The lowest version the provider will accept."),
            })
            .optional(),
        // rate_limit only: when the exhausted window reopens (epoch seconds, from the stream's own
        // rate_limit_event or the account's persisted usage windows). Absent when the reset instant is unknown
        // (nothing to schedule against).
        resetsAt: z.number().optional(),
        /* Where the daemon's resume of THIS turn stands, for the three codes that have one (provider-outage,
         * claude-token-refused, rate_limit). "scheduled" = the resume is armed and this turn comes back by
         * itself; "available" = the daemon remembered the failed turn and arming THIS conversation
         * (AgentSummarySchema's resumeAfterOutage / resumeAfterLimit) picks up that same resume, which is what
         * the offer banner hangs off, gated codes only, since a credential renewal is never gated on a posture
         * at all. The two words are read against the effective posture (the conversation's override, else the
         * sandbox default), so a chat armed on its own says "scheduled" while the unarmed board around it says
         * "available". Absent means there is nothing automatic to resume: a limit whose reset instant nobody
         * published has nothing to schedule against, and a refused credential has none once re-minting it has
         * already been tried and failed.
         *
         * A SPENT ALLOWANCE USED TO BE ABSENT HERE BY RULE, and the rule was right about the default and wrong
         * about the ceiling. The budget is the user's, so nothing fires unless they said so, which is what the
         * posture is; what the old absence also cost was the case a press cannot reach, a 2am wall on a board
         * nobody is watching. Both words are now honest for it: unarmed says "available", which is an offer,
         * and armed says "scheduled", which the card counts down to. */
        autoResume: z.enum(["scheduled", "available"]).optional(),
        /* THE DAEMON IS STILL HOLDING THIS EXACT TURN, so the way on is to RE-RUN it rather than to send
         * something after it. rate_limit only, and the counterpart to `autoResume` rather than a member of it:
         * that field answers "is a machine bringing this back", which for a spent allowance is a posture the
         * user sets and defaults to no (the allowance is their own budget to spend, turn-resume.ts). This
         * answers the question that was never asked, "and if the user says go, what happens", which had exactly
         * one possible answer for as long as it went unasked: a new user message reading "Continue".
         *
         * BOTH ANSWERS RUN THROUGH THIS FIELD, which is why it is not folded into the one above: an armed
         * conversation's scheduled fire and an unarmed one's press are the same held turn re-run the same way,
         * and the only difference is who says go.
         *
         * That answer was wrong in a way the chat could not show. The press is not a new instruction, it is the
         * same one again, and appending it said otherwise to the only reader that matters: the provider session
         * grew one "Continue" per press, each with a synthetic "No response requested." above it, so a chat that
         * bounced four times handed the model four turns in which it appeared to have declined to answer. With
         * this field the press re-runs the held turn instead, which is idempotent by construction (a second press
         * finds a live turn and supersedes nothing) and leaves the transcript one row for one press.
         *
         * `ran` is whether the held turn got anywhere before it was refused, and it changes both what the model
         * is told (RESUME_NOTES.limit vs .refused, and telling a model to carry on from work that never happened
         * is how it comes to invent some) and what the strip can honestly say. A spent allowance refuses the
         * FIRST request most of the time, so false is the common case, not the corner. */
        held: z.object({ ran: z.boolean() }).optional(),
        /* provider-outage only: the shape of the wait. `retryAt` (epoch seconds) is when the next attempt is
         * due, not a fixed cadence, because an outage has no reset instant to aim at and hammering a provider
         * that is down only spends tokens on refusals, so each attempt waits longer than the last
         * (provider-health.ts owns the schedule).
         *
         * `attempt`/`maxAttempts` are on the wire so the notice can say the automation is BOUNDED. A retry that
         * gives no account of how long it will keep going is the kind users switch back off the week they turn
         * it on; one that says "attempt 2 of 6" is one they leave on. */
        outage: z.object({ retryAt: z.number(), attempt: z.number(), maxAttempts: z.number() }).optional(),
    }),
    z.object({ kind: z.literal("done") }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/* THE FRAMES THAT ARE FACTS ABOUT THE TURN rather than words in it: which session it runs, where it stands,
 * what it costs, how it failed. Everything else an AgentEvent can say is transcript, and reaches a client as
 * rows and patches (TranscriptPatchSchema) after the daemon has folded it; these reach it as themselves,
 * because there is nothing to fold, a client keeps them as state beside the transcript. A frame can be both,
 * a `worktree` that rebased writes a notice AND says where the branch is, so the two lists overlap, and the
 * fold and this list each take the half that is theirs. */
export const TURN_FACT_KINDS = [
    "session",
    "worktree",
    "init",
    "terminal",
    "browser",
    "commands",
    "usage",
    "rate_limit_info",
    "fast_mode",
    "tier",
    "provider_retry",
    "account_usage",
    "context_usage",
    "mode",
    "error",
] as const;
export type TurnFact = Extract<AgentEvent, { kind: (typeof TURN_FACT_KINDS)[number] }>;
export const isTurnFact = (event: AgentEvent): event is TurnFact => (TURN_FACT_KINDS as readonly string[]).includes(event.kind);
// The same members AgentEventSchema declares, picked out rather than declared twice: a fact's shape is the
// frame's shape, and a second spelling of it would be the drift the list above exists to prevent.
type AgentEventMember = (typeof AgentEventSchema.options)[number];
const factMembers = AgentEventSchema.options.filter((member) => (TURN_FACT_KINDS as readonly string[]).includes(member.shape.kind.value)) as unknown as [
    AgentEventMember,
    ...AgentEventMember[],
];
export const TurnFactSchema = z.discriminatedUnion("kind", factMembers) as unknown as z.ZodType<TurnFact>;

/* The /agent/attach stream: a head carrying the run's rows so far, then every change to them and every fact
 * about the turn as each lands, then `end` when the run is over, nothing more coming. A stream that closes
 * WITHOUT `end` was dropped mid-run; the client re-attaches and takes the head's rows again, whole, which is
 * what makes attaching idempotent: a window never re-folds what it has already drawn, it replaces it.
 *
 * Facts REPLAY on every attach (their seq is at or below the head's), because a window joining late still has
 * to learn which session the turn runs and where its branch stands; patches are only ever live (their seq is
 * above the head's), because the head already holds their result. */
export const AttachFrameSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("attached").describe("The first frame, identifying the run you have joined and handing you its transcript so far."),
        run: z.string().describe("The run's id."),
        startedAt: z.number().describe("When it started, in milliseconds, so a window joining late can show how long it has been going."),
        seq: z.number().describe("How many frames the run has produced so far. A fact at or below this number is being replayed; a patch is never."),
        rows: z
            .array(TranscriptRowSchema)
            .describe("The turn's rows as they stand: what was asked, and everything the agent has said and done since. Draw these, then apply the patches that follow."),
    }),
    z.object({
        kind: z.literal("patch").describe("One change to the run's rows."),
        seq: z.number().describe("Its position in the run, counting from one."),
        patch: TranscriptPatchSchema,
    }),
    z.object({
        kind: z.literal("fact").describe("One thing about the turn that is not a row: its session, its branch, its cost, a failure."),
        seq: z.number().describe("Its position in the run, counting from one. At or below the head's number, it is being replayed."),
        fact: TurnFactSchema,
    }),
    z.object({
        kind: z
            .literal("end")
            .describe(
                "The run is over and every frame has been delivered. A stream that closes without this was dropped mid-run, so re-attach rather than assuming the turn finished.",
            ),
    }),
]);
export type AttachFrame = z.infer<typeof AttachFrameSchema>;

/* WHAT A RESUMED TURN'S PROMPT SAYS IT IS. The daemon re-runs a turn something underneath it killed (turn-resume.ts)
 * by sending the original prompt again behind one of these sentences, so the model knows what interrupted it.
 *
 * They live on the wire rather than in the daemon because the CLIENT has to recognise them too: an attach head
 * carries the run's prompt verbatim, and a window joining a resumed run would otherwise render the note as a
 * message the USER wrote, the same words the user already said one run up, with a machine's preamble on them.
 * Recognising the prefix is what lets that window reuse the bubble that is already there instead. */
// The instruction the three whole-turn re-runs share: what follows the note is the original request, repeated.
// `answered` deliberately does not carry it, what follows THAT note is not a repetition but the user's answer,
// and telling the model to "continue from that point instead of starting over" about words it has never seen
// is how a resume reads as the user contradicting themselves.
const REPEATED =
    "The interrupted request is repeated below, where part of it was already completed in this session, continue from that point instead of starting over.";
export const RESUME_NOTES = {
    auth: `The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically. ${REPEATED}`,
    outage: `The model provider was briefly unavailable and interrupted this conversation; this turn resumed automatically. ${REPEATED}`,
    restart: `The sandbox restarted while this turn was running, which stopped it, and this turn resumed automatically once it came back. ${REPEATED}`,
    /* A SPENT ALLOWANCE STRANDS A TURN IN THREE SHAPES, and they must not share a note.
     *
     * `limit` is the mid-turn one and reads like its three neighbours above: the session holds real work, and
     * carrying on from it is exactly right.
     *
     * `switched` is that same mid-turn stranding picked back up on a DIFFERENT account (or provider, or
     * harness), which is what the composer's account switcher does between the refusal and the press. A session
     * belongs to the credential that minted it, so this one cannot resume: it opens a fresh session seeded from
     * the daemon's record. REPEATED's "already completed in this session" is therefore false where it counts —
     * the work is in the carried-across conversation, not in this session's own history — and a model told to
     * look for it there finds nothing and starts over silently.
     *
     * `refused` is the turn the provider turned away at the door, before the model read one word of it, and it
     * is the COMMONER of the two, because an allowance that is already spent refuses the first request it is
     * asked. REPEATED is actively wrong for it: "part of it was already completed in this session, continue from
     * that point instead of starting over" is an instruction to continue from work that does not exist, and a
     * model handed that instruction answers it by inventing the work. So it says the opposite, plainly.
     *
     * Both are unlike their neighbours in one way worth stating: nothing resumed automatically. A spent
     * allowance is the user's own budget and stays their call to spend (turn-resume.ts), so what re-ran this
     * turn was a person pressing Continue. */
    limit: `The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again. ${REPEATED}`,
    switched:
        "The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again on a different account, which starts a fresh session. The conversation so far has been carried across above, including the part of the request that was already completed: continue from that point instead of starting over.",
    refused:
        "The model provider refused the previous attempt at this request outright, because its usage allowance was spent: no part of the request below was read or acted on, and nothing has been done towards it. It has been sent again, and starts from the beginning.",
    // A turn that was PARKED on the user when the daemon died: nothing re-runs at boot, the card is restored
    // instead, and this is the turn their answer starts (turn-resume.ts). What rides below the note is the
    // answer itself, so the model picks the session back up at exactly the decision it had handed over.
    answered:
        "The sandbox restarted while this conversation was waiting for the user to respond; it is back, and their response follows below: continue from where the session left off.",
} as const;

// The prompt a resume actually sends: the note (each carries its own account of what the words below are),
// then them.
export const withResumeNote = (prompt: string, note: string): string =>
    Object.values(RESUME_NOTES).some((known) => prompt.startsWith(known)) ? prompt : `${note}\n\n${prompt}`;

// The user's own words inside a resumed prompt, the note and its explanation stripped back off. Returns the
// prompt unchanged when it is not a resume, so a caller can hand every attach head through it.
export const withoutResumeNote = (prompt: string): string => {
    const note = Object.values(RESUME_NOTES).find((known) => prompt.startsWith(known));
    return note === undefined ? prompt : prompt.slice(prompt.indexOf("\n\n") + 2);
};

export type ResumeReason = keyof typeof RESUME_NOTES;

/* HOW A RESUMED TURN READS TO THE PERSON, the same interruption the note above tells the model, said in the
 * transcript's own voice instead.
 *
 * Stripping the note out of the user's words is only half the job, and for years it was the only half anyone
 * did: what a reopened conversation showed was a paragraph of machine prose stapled to the front of a message
 * the user had already sent once, directly under their own copy of it. Both halves of that are wrong, it was
 * never their sentence, and the words under it are a REPEAT rather than something new they said.
 *
 * So the two shapes below, which is the whole of what a reader has to be told:
 *
 * `notice`, the three whole-turn re-runs. The words under the note are already in the transcript one turn up,
 * so the repeat is dropped entirely and the interruption takes its place as a muted line, sitting with the
 * failure line it resolves ("Failed to authenticate…") and reading like every other thing that HAPPENED to a
 * turn rather than like something anybody typed.
 *
 * `note`, the answered case, where what rides under the note is the user's actual answer to a card and belongs
 * in the transcript as their words. Nothing is dropped; the explanation rides that message as a collapsed row,
 * the same disclosure every other daemon-written note gets (TurnNote). */
export type ResumeDisclosure = { readonly kind: "notice"; readonly text: string } | { readonly kind: "note"; readonly note: TurnNote };

const RESUME_DISCLOSURES: Record<ResumeReason, ResumeDisclosure> = {
    auth: { kind: "notice", text: "Claude sign-in renewed, this turn picked up where it left off." },
    outage: { kind: "notice", text: "The model provider came back, this turn picked up where it left off." },
    restart: { kind: "notice", text: "The sandbox came back, this turn picked up where it left off." },
    /* THE THREE NOBODY AUTOMATED, said in the passive voice the other three earn honestly and these do not: a
     * person pressed Continue. Which is the whole reason these rows exist at all. A press used to append the word
     * "Continue" as a message of its own, so a chat that bounced off a spent allowance four times read back as
     * the user saying "Continue" four times to an agent that had answered none of them, and the provider session
     * the model actually reads accumulated all four (plus a synthetic "No response requested." per press). One
     * row for one press was never the problem; a row that claims the user said something new is.
     *
     * `switched` names the account because that is the fact the reader needs: they pressed the same button they
     * pressed a minute ago, and the difference between the press that bounced and the press that worked is who
     * served it. The line is also the only place a retired session is accounted for. */
    limit: { kind: "notice", text: "Sent again after the allowance ran out mid-turn, picking up where it left off." },
    switched: { kind: "notice", text: "Sent again on the switched account after the allowance ran out mid-turn, in a fresh session." },
    refused: { kind: "notice", text: "Sent again after the allowance refused it: nothing had run." },
    answered: { kind: "note", note: { title: "Picked back up after a sandbox restart", text: RESUME_NOTES.answered } },
};

// What a stored prompt's resume note should be SHOWN as; undefined when the prompt is not a resume at all, so
// every reader of a stored prompt can ask without first testing whether it is one.
export const resumeDisclosure = (prompt: string): ResumeDisclosure | undefined => {
    const reason = (Object.keys(RESUME_NOTES) as ResumeReason[]).find((key) => prompt.startsWith(RESUME_NOTES[key]));
    return reason === undefined ? undefined : RESUME_DISCLOSURES[reason];
};

// One parsed line from `intentic … --output ndjson` (engine events, provider `log`, the terminal `result`).
// Open-ended by design, the sandbox consumes the wire shape, not @intentic/engine's types, so a string
// `kind` plus arbitrary extra fields pass through. The apply-events tail (intentic.contract `applyEvents`) rides
// this same loose shape with three daemon/CLI-minted sentinel kinds alongside the engine ones: {kind:"start"}
// (first line, written when the run's file is reset), {kind:"exit",code} (last line, on the CLI process exit),
// and {kind:"heartbeat"} (interleaved by the tail while idle to keep the held-open stream alive).
export const IntenticLineSchema = z.looseObject({ kind: z.string() });
export type IntenticLine = z.infer<typeof IntenticLineSchema>;

// The daemon's liveness heartbeat frame: the browser holds the events stream open and trips a watchdog if the
// frames stop (the tunnel drops the proxied response when the origin dies).
export const HeartbeatSchema = z.object({ kind: z.literal("heartbeat") });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// One step of the daemon's boot chain. `key` is the stable id the daemon declares it under, `label` the words
// the browser shows. A step that FAILED is still a step that finished, the boot chain is log-and-continue by
// design (see main.ts), so a failure degrades one subsystem rather than holding the gate closed forever.
export const BootStepSchema = z.object({
    key: z.string(),
    label: z.string(),
    state: z.enum(["pending", "running", "done", "failed"]),
    // Elapsed ms, once the step has finished.
    ms: z.number().optional(),
});
export type BootStep = z.infer<typeof BootStepSchema>;

/* WHERE THE DAEMON IS IN ITS BOOT. The listeners come up before the state they serve has converged (main.ts:
 * "listen first, converge behind the gate"), which is what stops a restart from reading as an outage, but it
 * also means the daemon spends the first seconds of every boot both reachable and unable to answer, and until
 * this frame existed the browser had no way to tell that apart from a healthy sandbox. It painted an operable
 * workspace off its persisted cache and then parked every request the user made against the readiness gate.
 *
 * The step list is declared UP FRONT and sent whole, pending entries included, so the browser can say "4 of 11,
 * loading the conversation registry" rather than "something is happening", a boot that takes minutes has one
 * slow step, and naming it is the whole point. Snapshot-not-diff, like every other roster on this stream. */
export const BootProgressSchema = z.object({
    // False only while the chain is still converging. The browser holds every daemon read until this is true.
    ready: z.boolean(),
    // Epoch ms the daemon started converging, so the browser can show a total elapsed that survives a reconnect.
    startedAt: z.number(),
    steps: z.array(BootStepSchema),
});
export type BootProgress = z.infer<typeof BootProgressSchema>;

// Pushed on every step transition and once more when the gate opens. Rides /events, which answers before the
// gate precisely so this can be delivered while everything else waits.
export const BootSchema = z.object({ kind: z.literal("boot"), ...BootProgressSchema.shape });
export type Boot = z.infer<typeof BootSchema>;

// The stream's first frame: the workspace's stable identity, minted at the first boot of an empty /work. The
// browser remembers it per sandbox id and drops that sandbox's persisted query cache when it changes, a wiped
// and recreated workspace (cleanup.sh + reconnect keeps the same sandbox id) must not be painted from the
// previous workspace's cache. `build` is the same guard against a different axis: the daemon's own compiled
// tree, so an image update (or a `pnpm build:sandbox` swap in dev) drops what the browser cached from the
// PREVIOUS build instead of hydrating payloads the new one no longer shapes that way.
//
// It also advertises `routes`, the contract route names (`vpn.list`, `kimi.models`) this daemon actually
// implements, from ITS build of the contract. A browser is routinely newer than the daemon it talks to (a
// released app plane serves whatever image each user last pulled; in local dev the web app is always ahead of
// the last `pnpm build:sandbox`), and that stays fully supported, the browser just compares the two sets so a
// route the daemon predates surfaces as a named, explained gap instead of a bare 404 nobody can attribute.
//
// `shapes` answers the half `routes` structurally cannot: a route BOTH builds have, whose payload changed
// between them. Names match, so nothing 404s, the call goes out and a field the browser expects is simply
// missing from the answer. It is a map of route name → a fingerprint of that route's input and output schema
// (see routes.ts), so a difference is a named route rather than "something, somewhere, moved". Beside `routes`
// rather than folded into it: existence covers every route, shape covers only the ones that can be expressed.
//
// Every added field is optional: a daemon built before one simply says nothing, and the browser's fallback is
// the pre-existing behaviour, routes all assumed present, shapes all assumed to agree, the daemon assumed
// ready, the cache left alone. That is also why `routes` keeps its bare-string-array shape: an image already in
// the wild sends exactly that, and a breaking change here would fail the hello frame's own parse and take the
// whole event stream down for precisely the skew this frame exists to describe.
export const HelloSchema = z.object({
    kind: z.literal("hello"),
    workspaceId: z.string(),
    routes: z.array(z.string()).optional(),
    shapes: z.record(z.string(), z.string()).optional(),
    build: z.string().optional(),
    boot: BootProgressSchema.optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

// The FULL discovered repo set (sorted root-relative ids), pushed whenever it changes, a clone, a scaffold,
// or a deleted repo re-frames it. The watcher descent-ignores .git, so no workspaceChanged path pattern can
// detect a repo appearing; the daemon diffs its own discovery instead. Snapshot-not-diff, last frame wins.
export const ReposChangedSchema = z.object({ kind: z.literal("reposChanged"), repos: z.array(z.string()) });
export type ReposChanged = z.infer<typeof ReposChangedSchema>;

// A batch of workspace paths that just changed on disk (created/edited/deleted), pushed on the same /events
// stream as the heartbeat so the browser refreshes the tree + any open file live, the agent edits files
// out-of-band (its own Write/Edit/Bash tools), so there's no HTTP mutation to hang an invalidate on. Paths are
// root-relative, forward-slash (the tree/file route space). An empty array means "something changed, refetch the
// tree", a burst too large to enumerate, or a reconnect recovery where we don't know what was missed.
export const WorkspaceChangedSchema = z.object({ kind: z.literal("workspaceChanged"), paths: z.array(z.string()) });
export type WorkspaceChanged = z.infer<typeof WorkspaceChangedSchema>;

/* THE REPOS WHOSE REFS JUST MOVED, a commit, a checkout, a branch or tag, a rebase started or aborted.
 *
 * A third push for the same reason as the two above, and the reason is structural: a repo's git dir does not
 * live under /work at all (it is relocated onto /history so an isolated turn's worktree can stand in for the
 * workspace root, see git/repo-git-dirs.ts), and the file watcher descent-ignores `.git` besides. So no
 * `workspaceChanged` path can ever say "a ref moved", and a surface built on the commit graph would otherwise
 * be exactly as fresh as the last thing the user clicked.
 *
 * It matters most for the work the user did NOT do: the agent commits, rebases and lands out-of-band, with no
 * HTTP mutation in any browser to hang an invalidation on. Ids are root-relative, "root" being the /work repo.
 * Diff-not-snapshot, unlike reposChanged: this names what moved, and a repo absent from a frame is a repo that
 * did not move rather than one that stopped existing. */
export const RefsChangedSchema = z.object({ kind: z.literal("refsChanged"), repos: z.array(z.string()) });
export type RefsChanged = z.infer<typeof RefsChangedSchema>;

/* WHICH RUNNING THINGS JUST MOVED, a session opened or exited, a dev server bound its port, a browser closed,
 * a subagent reported in.
 *
 * The fourth push, and the one that covers what the other three structurally cannot: none of this state is on
 * disk, so no `workspaceChanged` path can name it, and none of it is a ref or a repo. Before it, every view of a
 * running thing polled on its own timer, which is to say each browser asked, forever, a question only the
 * daemon could answer and almost always answered "no change".
 *
 * Diff-not-snapshot, and deliberately thin: the frame carries the DOMAIN that moved, never the roster itself.
 * Invalidation only reaches a query something is observing, so a tab showing none of these pays a frame and no
 * request, whereas a roster on the wire would bill every connected browser the full list whether or not
 * anything on screen renders it. Which query keys a domain stands for is runtime-state.ts's table. */
export const RuntimeChangedSchema = z.object({ kind: z.literal("runtimeChanged"), domains: z.array(z.string()) });
export type RuntimeChanged = z.infer<typeof RuntimeChangedSchema>;

// One connected browser tab of a sandbox member. Identity fields come from the caller's verified Google ID
// token; activity fields from the tab's own /system/presence reports. No timestamps on the wire, an entry's
// lifetime IS its /events connection's lifetime, so there is nothing to age out or compare clocks over.
export const PresenceUserSchema = z.object({
    // Per-CONNECTION id, minted by the browser for each /events attempt, never reused across reconnects.
    clientId: z.string(),
    email: z.string(),
    name: z.string().optional(),
    picture: z.string().optional(),
    // The caller's trust tier, resolved by the authorizer at connection time. On the roster so every member
    // can see who may do what, and so a tab knows its OWN role without an owner-only lookup.
    role: MemberRoleSchema,
    idle: z.boolean(),
    // Route/view name the tab is on ("workspace", "automations", "ext:<id>/<key>", …).
    view: z.string().optional(),
    // The chat conversation the tab has active.
    sessionId: z.string().optional(),
    // The workspace file the tab has open (root-relative, forward-slash).
    path: z.string().optional(),
});
export type PresenceUser = z.infer<typeof PresenceUserSchema>;

// The FULL roster of connected members, broadcast on every change, snapshots, not diffs, so a reconnecting
// browser is consistent from its first frame and ordering never matters (last frame wins).
export const PresenceSchema = z.object({ kind: z.literal("presence"), users: z.array(PresenceUserSchema) });
export type Presence = z.infer<typeof PresenceSchema>;

// The FULL fleet roster, broadcast on every registry change, same snapshot-not-diff contract as presence:
// a reconnecting browser is consistent from its first frame. NOT simply "last frame wins", though: `rev` is the
// registry revision the snapshot was taken at, and the browser applies a frame only if it is newer than the one
// it already holds. Snapshots race two other sources of the same fact, an explicit GET /agents and the
// browser's own optimistic writes, and an unordered full replace lets the slowest of them win, which is how an
// archived card came back. See AgentsListSchema and useAgents.ts.
export const AgentsSchema = z.object({ kind: z.literal("agents"), agents: z.array(AgentSummarySchema), rev: z.number() });
export type Agents = z.infer<typeof AgentsSchema>;

/* AN ACCOUNT'S HEADROOM JUST MOVED, the reading itself, keyed the way the daemon's store keys it (a Claude
 * account id, or `${provider}:${authFile}` for a routed subscription).
 *
 * The fifth push, and the one that lets every ring, rail and picker row stop refetching on mount. A reading
 * lands on the daemon for one of four reasons, a turn settled, a plan refused, a screen asked, a provider
 * pushed, and until this frame existed only the window that caused it ever heard: every other window drew the
 * number it had loaded that morning until something in it happened to remount. Snapshot-not-diff per account,
 * last frame wins, and a browser that missed one simply holds the older reading, which is what `measuredAt`
 * is for. `usage` absent ⇒ the account's snapshot was cleared (it was disconnected). */
export const AccountUsageChangedSchema = z.object({
    kind: z.literal("accountUsage"),
    // The provider whose row this account is, because the key alone does not say (a native id is bare).
    provider: z.string(),
    account: z.string(),
    usage: AccountUsageSchema.optional(),
});
export type AccountUsageChanged = z.infer<typeof AccountUsageChangedSchema>;

// A provider's last refusal was recorded or settled. The observed half of "can I run on this" (see
// ProviderRefusalSchema), pushed for the same reason the reading above is: a refusal at 4am used to reach a
// window only when it next reloaded its account rows. `refusal` absent ⇒ settled, nothing stands.
export const ProviderRefusalChangedSchema = z.object({ kind: z.literal("providerRefusal"), provider: z.string(), refusal: ProviderRefusalSchema.optional() });
export type ProviderRefusalChanged = z.infer<typeof ProviderRefusalChangedSchema>;

// The /events stream union: the hello identity frame, then liveness heartbeats interleaved with boot progress,
// workspace-change batches, repo-set snapshots, ref-move batches, runtime-domain nudges, presence + fleet
// roster snapshots, and account headroom / refusal changes. oRPC validates every yielded frame against this,
// so all kinds must live here.
export const SystemEventSchema = z.discriminatedUnion("kind", [
    HelloSchema,
    HeartbeatSchema,
    BootSchema,
    WorkspaceChangedSchema,
    ReposChangedSchema,
    RefsChangedSchema,
    RuntimeChangedSchema,
    PresenceSchema,
    AgentsSchema,
    AccountUsageChangedSchema,
    ProviderRefusalChangedSchema,
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;
