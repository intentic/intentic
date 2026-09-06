import { z } from "zod";
import { AgentProviderSchema } from "../schemas/agent.js";
import { CredentialGateKindSchema, CredentialGateScopeSchema, CredentialLaneSchema } from "../schemas/secrets.js";

/* THE CARDS A TURN RAISES, and how each one is answered. A card is the daemon asking the person something
 * mid-turn — approve this plan, answer this question, allow this tool, accept this priced run, connect this
 * capability, release this credential — and every one of them pauses the turn until a reply arrives on the
 * `POST /agent/reply` side channel.
 *
 * These are the SHAPES, shared by the three readers that must agree about them: the daemon that raises the
 * card, the browser that draws it, and the transcript that records how it was settled (transcript.ts). */

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
     * consequence that stopped it, and a machine command's, which names the device.
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
export const planCard = {
    requestId: REQUEST_ID,
    text: z.string().describe("The plan itself."),
    // Present when the adjacent plan prose POINTS at a document instead of being one: the model wrote the real
    // plan to a file and summarised it there. Absent when the text already is the whole plan.
    document: CardDocumentSchema.optional().describe("The write-up this plan refers to, when the plan itself is a pointer to one."),
};
export const questionCard = {
    requestId: REQUEST_ID,
    questions: z.array(AskQuestionSchema).describe("What it wants to know."),
    document: CardDocumentSchema.optional().describe("The document this turn wrote and is asking about, so the choice can be read beside it."),
};
export const permissionCard = { requestId: REQUEST_ID };
// The agent's browser needs a person: it parked mid-sign-in on something it cannot clear itself (a captcha,
// a password it does not hold, a phone check). `session` names the browser session on /browsers, the card's
// one action is going THERE, where the live stage and Take control already are; the Browsers banner and this
// card resolve the same requestId. `account` is the capability the sign-in is for, so the card can say whose
// login is stuck even after the browser has navigated somewhere unrecognizable.
export const browserHelpCard = {
    requestId: z.string(),
    session: z.string(),
    account: z.string(),
    message: z.string(),
};
// The agent's TERMINAL needs a person: a command it started is sitting at a prompt it cannot answer (a
// one-time password, a security-key touch, a confirm). `session` names the tmux session on the terminal
// panel, the card's one action is going THERE, where the live pane and its prompt already are, which is
// the same division of labour the browser card has with /browsers.
export const terminalHelpCard = {
    requestId: z.string(),
    session: z.string(),
    message: z.string(),
};
export const serviceOfferCard = { requestId: z.string(), offer: ServiceOfferSchema };
export const capabilityOfferCard = { requestId: z.string(), offer: CapabilityOfferSchema };
export const paymentOfferCard = { requestId: z.string(), offer: PaymentOfferSchema };
export const credentialOfferCard = { requestId: z.string(), offer: CredentialOfferSchema };

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
