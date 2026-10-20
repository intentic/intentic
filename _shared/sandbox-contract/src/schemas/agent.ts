import { TurnErrandSchema } from "./speaker.js";
import { z } from "zod";
import { CONVERSATION_ID, CONVERSATION_TITLE_MAX } from "../ids/conversation-ids.js";
import { canonicalHarness } from "../models/agent-catalog.js";
import { ModelRoleSchema } from "../models/model-roles.js";
import { NATIVE_PROVIDERS } from "../models/provider-specs.js";
import { AgentPlacementSchema } from "../protocol/doors/runner-protocol.js";
import { MENTION_LIMIT } from "../text/mentions.js";
import { entryId } from "./internal.js";
import { FRESH_OF_DESCRIPTION, FreshOfSchema, freshOfIssues } from "./conversation-links.js";
// Agent runtimes the daemon can serve: native providers have dedicated adapters, `endpoint/<id>` names an installed
// endpoint capability, anything else is an ACP agent capability id. A bare string, not an enum, so an unknown id is a
// clean error, not a contract change.
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
// Provider naming a catalog in providers.contract.ts; an enum, not the open string above, since only native providers
// have a daemon-held catalog to look up. An unknown id is a 400 here, not an empty list.
export const NativeProviderParamSchema = z.object({ provider: z.enum(NATIVE_PROVIDERS) });
// The harness (agentic loop) a turn runs on, orthogonal to the provider. `native` is an alias for whichever loop the
// provider runs by default; every other value names a loop outright. `vendor` is the provider's own agent where that is
// none of the named host loops (Cursor's SDK, the Devin CLI, an installed ACP agent). Which loops a provider offers is
// its row's `loops` (models/provider-specs.ts); values are only ever appended, since stored turns and pins carry them.
export const AgentHarnessSchema = z.enum(["native", "claude-code", "codex", "opencode", "pi", "muse", "vendor"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
// A loop named outright, as a provider row offers it; `native` only ever resolves to one of these (loopOf).
export type AgentLoop = Exclude<AgentHarness, "native">;
// One repo at one immutable commit; used both as the checkout instruction and as handoffs' comparison base, so a
// multi-repo run has one provenance record instead of a hard-coded branch name.
export const RepoBaseSchema = z.object({ repo: z.string(), base: z.string().min(1) });
export type RepoBase = z.infer<typeof RepoBaseSchema>;
// What the user has open in the editor, attached only when they opt in (composer chip, off by default); folded into the
// prompt so deictic prompts ("fix this") resolve.
export const EditorContextSchema = z.object({
    file: z.string().min(1).describe("The file open in the editor, as a workspace path."),
    startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("First line of the selection, counting from one. Leave both out when the whole file is the context."),
    endLine: z.number().int().min(1).optional().describe("Last line of the selection, counting from one."),
    // Truncated client-side to the cap before it's sent.
    selection: z
        .string()
        .max(20_000)
        .optional()
        .describe("The selected text itself. Cut it down before sending if it is long: this is context, not an upload."),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;
// Client-minted stable conversation id; the regex is an injection guard, since isolated conversations also use it in
// branch names and filesystem paths.
export const ConversationIdSchema = z.string().regex(CONVERSATION_ID);
// Where a conversation came from when nobody typed it into the browser: an automation wake carrying an outside message.
// Set daemon-side by the receiving dispatcher; the browser never sends one.
export const AgentOriginSchema = z.object({
    // The automation whose configured prompt opened the conversation.
    automationId: z.string(),
    // Listener provider that received the message, or "webhook" for an event trigger; open string, sources are
    // extension-declared.
    provider: z.string(),
    // External thread it arrived on (Discord channel id, widget conversation id); absent for webhooks.
    channelId: z.string().optional(),
    // The thread inside that channel (a Discord thread, a Slack thread's root ts), when the conversation is one; what is
    // said back between turns goes into it rather than onto the channel.
    threadId: z.string().optional(),
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;
// How tool calls are gated, the Claude Agent SDK's PermissionMode narrowed to the three the composer offers. Both a
// turn input and the payload of the `mode` frame, since the agent can move itself between them mid-turn. The SDK's
// acceptEdits is not one of them: only `default` asks a person here, so it would differ from bypassPermissions in name
// alone.
export const PermissionModeSchema = z.enum(["default", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
// How one conversation relates to another (a fork's cut, a fresh session's origin): conversation-links.ts.
export * from "./conversation-links.js";
// The turn's fields before the cross-field refinements below, so a subset (TurnProfileSchema) can be picked from them.
// How many files one turn may carry. A batch of a person's queued messages joins their files, so the admission splits a
// batch rather than build a turn past this (turn-admission.ts, together): a turn the daemon makes must parse back.
export const ATTACHMENT_LIMIT = 20;

const AgentTurnFieldsSchema = z.object({
    prompt: z.string().describe("What to say to the agent. May be empty if you are only attaching files."),
    errand: TurnErrandSchema.optional().describe(
        "What the words are for, when the app or the sandbox composed them rather than a person typing them: a land conflict to resolve, a failed CI run to fix. Shown as the sandbox's words, not yours. Leave it out for your own words.",
    ),
    // Minted by the sender so a send whose answer was lost can be sent again without being delivered twice.
    messageId: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
            "Your id for this message. Sending again under an id the sandbox already took is answered with what it did with it the first time, never a second delivery. Leave it out and the sandbox names the message itself.",
        ),
    // Seeds a fresh registry entry's title; an existing entry's title always wins over this.
    title: z
        .string()
        .max(CONVERSATION_TITLE_MAX)
        .optional()
        .describe("A title for a conversation this turn is opening. Ignored for a conversation that already has one."),
    // Already uploaded via /workspace/upload; Claude reads them via Read, Codex gets images as native input.
    attachments: z
        .array(z.string().min(1))
        .max(ATTACHMENT_LIMIT)
        .optional()
        .describe("Files to hand the agent along with the prompt, as workspace paths. Upload them first."),
    // Read out of the prompt's own `@path` tokens rather than chosen: a tokenizer over pasted text guesses, so a
    // miss here is dropped and only a chosen attachment can refuse the turn.
    mentions: z
        .array(z.string().min(1))
        .max(MENTION_LIMIT)
        .optional()
        .describe(
            "Workspace paths the prompt mentions with `@`. Unlike attachments, one that escapes the workspace or names no file is ignored rather than refused.",
        ),
    // Which provider serves the turn, absent = claude; a sessionId resumes only on the provider that minted it.
    agent: AgentProviderSchema.optional().describe("Which model provider serves this turn. Leave it out for Claude."),
    // Which agentic loop runs the turn, absent = provider's own; a loop the provider doesn't offer runs its own too
    // (withRuntimeDefaults), rather than refusing a turn a stale composer setting named.
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs the turn. Leave it out to use each provider's own."),
    // Intent, not a guess: absent continues on the conversation's own account, or picks by serviceability where there is
    // none on this provider yet (conversations/registry/routing.ts).
    account: z
        .string()
        .optional()
        .describe(
            "Which of that provider's connected accounts pays for the turn. Leave it out to continue on the account the conversation runs on, or, for its first turn on this provider, to take whichever account can serve with the most room. To move a running conversation, use `switchAccount`.",
        ),
    // Distinct from `account` (who pays): whose name the turn posts as; absent means something different for each
    // mode.
    actsAs: entryId.optional().describe("Which persona the turn speaks as out in the world. Not the same as which account pays for it."),
    sessionId: z.string().optional().describe("Resume this provider session instead of starting a fresh one."),
    // Stable id surviving provider/account/harness switches; keys the registry entry, the turn run, and the
    // worktree when isolated.
    conversationId: ConversationIdSchema.optional().describe(
        "The conversation this turn belongs to. You choose it, it survives model switches, and it is how you address the conversation later. Naming one that does not exist opens it.",
    ),
    // Runs in the conversation's own git worktree (created lazily) instead of shared /work; requires
    // conversationId.
    isolated: z
        .boolean()
        .optional()
        .describe(
            "Work in this conversation's own private copy of the repos rather than the shared tree, so several agents can work at once. Needs a conversation id.",
        ),
    // Decided like `isolated`: the first turn's choice, latched. A persona's own start folder wins over it.
    startIn: z
        .string()
        .max(200)
        .optional()
        .describe(
            "Which folder the conversation opens in, relative to the workspace root; the project it belongs to. Decided on the first turn. A persona that names its own start folder wins.",
        ),
    // Decided like `isolated`: the request's choice on the first turn, the registry's after. `runner` implies
    // isolation; absent means local.
    placement: AgentPlacementSchema.optional().describe(
        "Where this conversation runs: this sandbox (leave it out), or a paired runner by id. Decided on the first turn; later turns follow the conversation.",
    ),
    // Pins a new isolated conversation's worktree to these commits; a workflow step's candidates share one snapshot
    // and skip the ordinary rebase.
    worktreeBase: z
        .array(RepoBaseSchema)
        .min(1)
        .max(50)
        .optional()
        .describe(
            "Pin a new private copy to these exact commits instead of today's workspace. Used when several agents must start from identical files.",
        ),
    // Overrides landing for this turn only; a workflow step sets false so candidates can't leak in before synthesis
    // compares them.
    autoLand: z
        .boolean()
        .optional()
        .describe(
            "Whether this turn's work merges into the workspace when it finishes. Overrides the conversation's own setting for this turn only.",
        ),
    // Which per-job model list answers when nobody named a model or provider (turn-resume.ts); names the job, not a
    // tier, and never overrides an explicit pick.
    runRole: ModelRoleSchema.optional().describe(
        "What started this turn, when it was not a person typing: which of the sandbox's per-job model lists answers for it. Only used when the turn names no model of its own.",
    ),
    // Set only by the daemon's own dispatchers, never a client; requires conversationId to record it on.
    origin: AgentOriginSchema.optional().describe(
        "Set by the sandbox alone: this turn opened a conversation on behalf of a message from outside rather than a person.",
    ),
    // No `history` field: a provider/account/harness switch carries no transcript over the wire; the daemon seeds
    // the new session from its own conversationId-keyed record.
    // Where a fork was cut from, on its first turn only; requires conversationId, and files:"then" implies
    // isolated.
    forkOf: z
        .object({
            conversationId: ConversationIdSchema.describe("The conversation this one was cut from."),
            keep: z.number().int().nonnegative().describe("How many of that conversation's messages to copy in before this turn runs."),
            files: z
                .enum(["then", "now"])
                .describe(
                    'Which files the fork opens on: "now" is the workspace as it stands, "then" is the files as they were at the cut, which needs a private copy.',
                ),
        })
        .optional()
        .describe("Where this conversation was cut from, on its first turn only. Only the client knows this, so only the client can say it."),
    // A fresh session's origin, on its first turn only; requires an isolated conversationId the registry has never seen.
    freshOf: FreshOfSchema.optional().describe(FRESH_OF_DESCRIPTION),
    // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
    model: z.string().optional().describe("Which model to use. Leave it out for the provider's default."),
    // Audience only, never model routing: `runRole` is what fills a model in. A run somebody pressed and is
    // watching leaves this off, however little of it a person typed.
    unattended: z
        .boolean()
        .optional()
        .describe(
            "Nobody is watching this turn: a schedule, a queue or another agent started it and no chat is open on it. A card that needs a person is refused rather than raised, plan mode and the terminal hand-off are withheld, and the sandbox's signed-in accounts stay out of it unless a persona carries them.",
        ),
    // Outside content caused this turn, naming the source; distinct from `unattended` (whether anyone is watching).
    outsideWake: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Content from outside caused this turn, and what to call the source. It is what makes the sandbox treat the turn as carrying somebody else's words.",
        ),
    // How tool calls are gated for this turn (the SDK's permissionMode, verbatim):
    // plan: propose → approve → execute; the proposing half asks nothing, it only withholds writes
    // default: prompts per tool on the permission side channel, the one mode that interrupts anybody
    // bypassPermissions: runs everything
    // The agent can move itself between modes mid-turn, riding back as a `mode` frame.
    permissionMode: PermissionModeSchema.optional().describe(
        "How tool calls are gated: ask before each tool, propose a plan first, or run everything. The agent can move itself between these mid-turn.",
    ),
    // Narrows the turn to these tool names (the SDK option, not the daemon's MCP `tools`/servers); absent means
    // everything the runtime has.
    allowedTools: z
        .array(z.string().min(1))
        .optional()
        .describe(
            "Narrow the turn to these tools. Leave it out for everything the runtime has. For a turn driven by an outside message this list is the real boundary, because prompt wording is only advice.",
        ),
    effort: z.string().optional().describe("How hard the model should think, where the provider offers a choice."),
    thinking: z.boolean().optional().describe("Whether to show the model's reasoning as it works."),
    // Requests the harness serve this turn faster at a higher price; a request, not a promise, the `fast_mode`
    // frame reports what happened.
    fast: z
        .boolean()
        .optional()
        .describe(
            "Ask for the same work at a higher rate for a higher price. A request rather than a promise: the answer says what actually happened.",
        ),
    // Set by the composer on the one turn whose model the Auto judge chose; the daemon only records it.
    autoPicked: z
        .boolean()
        .optional()
        .describe(
            "Whether this turn's model was chosen for you by reading the conversation's opening message, rather than picked by hand. Recorded so the choice can be judged later against what you did next.",
        ),
    // The opt-in editor context chip: what the user is looking at, folded into the prompt daemon-side.
    editorContext: EditorContextSchema.optional().describe(
        'What the user has open in their editor, folded into the prompt so that pointing words like "this" resolve.',
    ),
    // The composer's scheduled send: a time the person chose, or a spent account's reopen they would rather wait for than
    // send into a refusal. Held in the conversation's queue, never started early; the queue's `until` is this.
    sendAt: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "Hold this message until then (epoch milliseconds) instead of starting a turn now: a time you chose, or the reopen of an allowance you know is spent. It waits in the conversation's queue, where it can be sent early, reworded, rescheduled or removed, and goes by itself at that instant, even for a conversation this message opens or one whose turn is running now. Ignored when already past; at most a month ahead.",
        ),
    // Why `sendAt` is the instant it is, when it is not a time somebody chose: the composer booked the message for the
    // spent allowance's reopen. Kept with the booking (`reopenOf` on the queue), so every window can tell an allowance
    // wait from an appointment without matching instants against whatever the usage feed says now.
    sendAtReopen: z
        .literal(true)
        .optional()
        .describe(
            "Says `sendAt` is the reopen of the allowance this message would be refused by, not a time you chose. Recorded with the booking (the queue's `reopenOf` names the account it waits for), so every window can say the message waits on an allowance, and see when the conversation has moved somewhere with room. Only with `sendAt`.",
        ),
    // The other scheduled send: work that builds on another agent's, held until that agent's work is in the workspace.
    // Held in the queue like `sendAt`; the queue's `after` is this. Never both: a hold waits on exactly one thing.
    sendAfter: ConversationIdSchema.optional().describe(
        "Hold this message until the conversation named here has finished and all of its work has landed in the workspace, instead of starting a turn now: for work that builds on another agent's. It waits in this conversation's queue, where it can be sent early, reworded, rescheduled or removed. Sent at once when that conversation has nothing running and nothing left to land.",
    ),
    // Decided like `isolated`: the opening turn's answer, latched on the entry it opens. A maintainer's alone, since the
    // standing answer it sets is what `agents.autoLand` sets, and that route is a maintainer's.
    conversationAutoLand: z
        .boolean()
        .optional()
        .describe(
            "Whether this conversation's finished work merges into the workspace by itself from now on: its own answer to the sandbox-wide setting, the one `agents.autoLand` changes later. Read only from the message that opens the conversation, and only from a maintainer. Unlike `autoLand`, it holds for every later turn.",
        ),
});
export const AgentTurnSchema = AgentTurnFieldsSchema
    // An attachment-only send (no text) is legal; an entirely empty turn is not.
    .refine((turn) => turn.prompt.trim().length > 0 || (turn.attachments?.length ?? 0) > 0, {
        message: "prompt or attachments required",
    })
    .refine((turn) => turn.isolated !== true || turn.conversationId !== undefined, {
        message: "isolated requires conversationId",
    })
    .refine((turn) => turn.worktreeBase === undefined || (turn.isolated === true && turn.conversationId !== undefined), {
        message: "worktreeBase requires an isolated conversationId",
    })
    .refine((turn) => turn.origin === undefined || turn.conversationId !== undefined, {
        message: "origin requires conversationId",
    })
    .refine((turn) => turn.forkOf === undefined || turn.conversationId !== undefined, {
        message: "forkOf requires conversationId",
    })
    // "then" needs a checkout of its own; rolling back the shared tree under everyone else is what it must never mean.
    .refine((turn) => turn.forkOf?.files !== "then" || turn.isolated === true, {
        message: 'forkOf.files "then" requires isolated',
    })
    .superRefine(freshOfIssues)
    .refine((turn) => turn.sendAt === undefined || turn.sendAfter === undefined, {
        message: "sendAt and sendAfter are two different holds: name one",
    })
    .refine((turn) => turn.sendAfter === undefined || turn.sendAfter !== turn.conversationId, {
        message: "a conversation cannot wait for its own work to land",
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
// What `agent.run` takes: a turn, plus the one field only a request carries and no stored turn keeps. A daemon from before
// `continues` reads past it and takes `prompt` as the words, which is why a client still sends some.
export const AgentRunSchema = AgentTurnSchema.safeExtend({
    continues: z
        .literal(true)
        .optional()
        .describe(
            "Carry the conversation on from where its last turn stopped instead of saying anything: nothing of yours is added to the conversation, and `prompt` is ignored. A turn the sandbox still holds runs again as it was; otherwise the agent is told to continue in its own session. Refused while a turn is running.",
        ),
});
// What a turn naming no provider or loop runs on, stated once. Applied where a request comes in (the daemon's turn port),
// so nothing downstream defaults them again: the engine takes a turn with both named (withRuntimeDefaults).
/** A turn with its provider and loop named, as the engine takes it past the door. */
export type RoutedAgentTurn = AgentTurn & { readonly agent: AgentProvider; readonly harness: AgentHarness };
export const DEFAULT_PROVIDER: AgentProvider = "claude";
export const DEFAULT_HARNESS: AgentHarness = "native";
// A loop the provider does not offer is not the loop that runs (capabilitiesOf answers its own runtime either way), so the
// turn is named for the one that does: one composer setting left on Claude Code must not stamp "claude-code" on a Cursor,
// Google or Devin turn's profile, transcript and ledger row.
// Naming the provider's default loop outright is the same turn as naming none, so it is stamped `native` too: one turn,
// one spelling, whichever way the request put it.
export const withRuntimeDefaults = <T extends { readonly agent?: AgentProvider | undefined; readonly harness?: AgentHarness | undefined }>(
    turn: T,
): T & { readonly agent: AgentProvider; readonly harness: AgentHarness } => {
    const agent = turn.agent ?? DEFAULT_PROVIDER;
    return { ...turn, agent, harness: canonicalHarness(agent, turn.harness) };
};
// Which turn this is, as opposed to what it says: who serves it and how (agent, harness, account, model and its knobs),
// as whom (actsAs), where (isolated), whether anyone watches (unattended) and for which job (runRole). A turn that
// continues another (a resume, a wake, a nudge, a child's follow-up) carries this whole, never a hand-picked part.
export const TurnProfileSchema = AgentTurnFieldsSchema.pick({
    agent: true,
    harness: true,
    account: true,
    model: true,
    effort: true,
    thinking: true,
    fast: true,
    actsAs: true,
    isolated: true,
    unattended: true,
    runRole: true,
});
export type TurnProfile = z.infer<typeof TurnProfileSchema>;
const PROFILE_KEYS = Object.keys(TurnProfileSchema.shape) as readonly (keyof TurnProfile)[];
// Read as `=== true` everywhere, so false and absent are one value; carrying a false would state a placement or an
// audience the turn never named.
const TRUE_ONLY: ReadonlySet<keyof TurnProfile> = new Set(["isolated", "unattended"]);
/* THE PROFILE A TURN STATES: absent stays absent (no `undefined` keys), and a `=== true` flag travels only when set. */
export const profileOf = (turn: TurnProfile): TurnProfile =>
    Object.fromEntries(
        PROFILE_KEYS.flatMap((key) => {
            const value = turn[key];
            return value === undefined || (TRUE_ONLY.has(key) && value !== true) ? [] : [[key, value]];
        }),
    ) as TurnProfile;
/* A MODEL CHOSEN FOR ONE SURFACE-STARTED RUN, what the caret on the shared run button (<AgentRunButton>) sends along with the click that starts it. */
export const AgentRunPickSchema = z
    .object({
        agent: z.string().min(1).describe("Which provider."),
        model: z
            .string()
            .min(1)
            .describe("Which of its models. Both or neither, because a model name only means anything to the provider that serves it."),
        account: z
            .string()
            .optional()
            .describe(
                "Which connected account of that provider pays, by its daemon-minted id. Leave it out to take whichever account can serve with the most room.",
            ),
        harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out to use the provider's own."),
        effort: z
            .string()
            .optional()
            .describe("How hard that model should think, where it offers a choice. Leave it out to take the model's own default."),
        thinking: z.boolean().optional().describe("Whether this model reasons before it answers, where that is a choice it offers."),
        fast: z.boolean().optional().describe("Ask for this model's work at a higher rate for a higher price. A request rather than a promise."),
    })
    .optional();
export type AgentRunPick = z.infer<typeof AgentRunPickSchema>;
/* THE PICK A RUN BUTTON HOLDS, AS THE WIRE SPELLS IT. */
export const runPickOf = (choice: {
    readonly provider: string;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: string | undefined;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}): NonNullable<AgentRunPick> => ({
    agent: choice.provider,
    model: choice.model,
    ...(choice.account === undefined ? {} : { account: choice.account }),
    ...(choice.harness === undefined ? {} : { harness: choice.harness as AgentHarness }),
    ...(choice.effort === undefined ? {} : { effort: choice.effort }),
    ...(choice.thinking === undefined ? {} : { thinking: choice.thinking }),
    ...(choice.fast === undefined ? {} : { fast: choice.fast }),
});
/* ONE ENTRY OF ONE SETUP'S MODEL LIST (settings.modelSetups): the standing version of the pick above, and not merely which model but HOW it is to be run. */
export const ModelPinSchema = z.object({
    provider: AgentProviderSchema.describe("Which provider serves this work."),
    model: z.string().min(1).describe("Which of its models. Both halves, because a model name only means anything to the provider that serves it."),
    effort: z
        .string()
        .optional()
        .describe("How hard this model should think, where it offers a choice. Leave it out to take the model's own default."),
    thinking: z.boolean().optional().describe("Whether this model reasons before it answers, where that is a choice it offers."),
    fast: z.boolean().optional().describe("Ask for this model's work at a higher rate for a higher price. A request rather than a promise."),
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out to use the provider's own."),
});
export type ModelPin = z.infer<typeof ModelPinSchema>;
// POST /agent's ack: the daemon-minted id of the detached run it started. The turn runs daemon-side regardless of any
// client connection; every window renders it via /agent/attach.
export const StartedTurnSchema = z.object({
    run: z
        .string()
        .describe(
            "The id of the run that just started. Hand it back when you attach: the stream always opens on the conversation's newest run, so a different id there means another turn has started since.",
        ),
});
export type StartedTurn = z.infer<typeof StartedTurnSchema>;
// What the sandbox did with one message, keyed by the id its sender gave it: the same id sent again gets this answer
// back as a duplicate, never a second delivery.
export const MessageReceiptSchema = z.object({
    delivered: z
        .enum(["started", "steered", "queued"])
        .describe(
            "What became of the message: it started a turn, it was said into the turn already running, or it waits in the conversation's queue for the next one.",
        ),
    run: z
        .string()
        .optional()
        .describe(
            "The run the message is in: the turn it started, or the one it was said into. Hand it back when you attach. Absent while the message waits in the queue.",
        ),
    duplicate: z
        .literal(true)
        .optional()
        .describe("The sandbox had already taken a message under this id: this is what became of it, and nothing new happened."),
});
export type MessageReceipt = z.infer<typeof MessageReceiptSchema>;
// Who a message to a conversation is from: a person (a composer, an API caller), the sandbox itself (a watch that fired,
// a job that ended, a land that broke something), or another agent (a child reporting back).
export const MessageVoiceSchema = z.enum(["person", "sandbox", "agent"]);
export type MessageVoice = z.infer<typeof MessageVoiceSchema>;
// The account a message booked for an allowance's reopen waits on: what it waits out, which the booking's instant alone
// cannot say once the chat has moved somewhere with room.
export const QueuedReopenSchema = z.object({
    agent: AgentProviderSchema.describe("The provider whose allowance it waits out."),
    account: z
        .string()
        .optional()
        .describe("Which of its accounts. Absent when none was named, and every account of the provider read spent."),
});
export type QueuedReopen = z.infer<typeof QueuedReopenSchema>;
// Who a person's waiting message goes on, as its request names it now.
export const QueuedServingSchema = z.object({
    agent: AgentProviderSchema.describe("The provider."),
    harness: AgentHarnessSchema.describe("The agentic loop."),
    model: z.string().optional().describe("The model. Absent when it named none, and takes the conversation's own."),
    effort: z.string().optional().describe("How hard it thinks, where the model offers a choice."),
    account: z.string().optional().describe("The account that pays for it. Absent when it named none, and goes on the conversation's own."),
});
export type QueuedServing = z.infer<typeof QueuedServingSchema>;
// One message waiting for the conversation's next turn, as every window shows it.
export const QueuedMessageSchema = z.object({
    id: z.string().describe("The message's id: what its sender named it, or what the sandbox did."),
    text: z.string().describe("The words, as they will go out."),
    attachments: z.array(z.string()).optional().describe("Files that go with it, as workspace paths."),
    voice: MessageVoiceSchema.describe("Who it is from: a person, the sandbox itself, or another agent."),
    queuedAt: z.number().describe("When it joined the queue, in milliseconds."),
    revision: z
        .number()
        .int()
        .nonnegative()
        .describe("The queue's revision when this message was last written. An edit or a removal names it, and is refused if the message has changed since."),
    until: z
        .number()
        .optional()
        .describe("When this message goes out by itself, in milliseconds: it was scheduled for that time. Each message keeps its own booking."),
    after: ConversationIdSchema.optional().describe(
        "The conversation whose finished work must land before this message goes out by itself, in place of `until`.",
    ),
    reopenOf: QueuedReopenSchema.optional().describe(
        "The allowance this message's `until` waits out: it was booked for that account's reopen, by the composer or by the sandbox holding words it would not send into a spent allowance, rather than for a time somebody chose. Absent on any other booking, and from sandboxes older than the field.",
    ),
    serves: QueuedServingSchema.optional().describe(
        "Who serves the turn this message starts: the provider, loop, model, effort and account it was sent under, or was moved to since (`agent.queueReroute`, an account switch). Only on a person's words; the sandbox's and an agent's own go on wherever the conversation runs when they go. Absent from sandboxes older than the field.",
    ),
    continues: z
        .literal(true)
        .optional()
        .describe(
            "A continuation, not words: when it goes, the conversation carries on from where its last turn stopped, as `agent.run` with `continues` does, and nothing is added to it as anybody's message. `text` is empty. A turn that starts in the conversation before it goes makes it moot, and it is dropped.",
        ),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
// Why a queue holds its messages rather than letting them go when the conversation is free.
export const QueuePauseSchema = z.enum(["stopped", "refused", "scheduled"]);
export type QueuePause = z.infer<typeof QueuePauseSchema>;
// What waits for a conversation's next turn: messages that arrived while a turn that could not take them ran, and
// held ones. Conversation state, the same for every window and kept across a restart.
export const ConversationQueueSchema = z.object({
    items: z.array(QueuedMessageSchema).describe("What waits, in the order it goes out."),
    revision: z.number().int().nonnegative().describe("Moves with every change to the queue, so of two copies the higher is the newer."),
    paused: QueuePauseSchema.optional().describe(
        "Why the messages with no booking of their own do not go out by themselves: somebody stopped the turn, or the turn they started was refused before it ran. Resuming lets them go, and so does sending another message. `scheduled` holds nothing: it says messages are booked, and `until` or `after` is the soonest of their bookings, for clients older than per-message bookings. When any message carries its own `until` or `after`, read those instead.",
    ),
    until: z
        .number()
        .optional()
        .describe("The soonest booked message's time, in milliseconds. Only on a queue paused as `scheduled`; each message carries its own."),
    after: ConversationIdSchema.optional().describe(
        "The conversation the first booked message waits for, when none waits for a time. Only on a queue paused as `scheduled`, in place of `until`.",
    ),
});
export type ConversationQueue = z.infer<typeof ConversationQueueSchema>;
// What taking a waiting message back left: the queue, and whether the conversation went with the message. A conversation
// its scheduled message opened, in which nothing has happened since, exists only for that message.
export const QueueTakenBackSchema = ConversationQueueSchema.extend({
    unopened: z
        .boolean()
        .optional()
        .describe(
            "True when the message was the only thing in a conversation it had opened by being scheduled: no turn ran and nothing else waits. The conversation went with it, so its card is off the board and its id is free to open again. Absent otherwise, and from sandboxes older than the field.",
        ),
});
export type QueueTakenBack = z.infer<typeof QueueTakenBackSchema>;
// What resuming a queue did: started a turn with what waited, when nothing else ran.
export const QueueResumedSchema = z.object({
    run: z.string().optional().describe("The turn the waiting messages started. Absent when a turn was already running, and they go after it."),
    queue: ConversationQueueSchema.optional().describe(
        "The queue the release left: what still waits once the turn took what it could. Absent from sandboxes older than the field.",
    ),
    reason: z
        .string()
        .optional()
        .describe(
            "Why nothing went out though messages still wait, in a sentence: a spent allowance whose window is shut, a recovery the sandbox runs first, a paused queue. Absent when something went out, when they simply go after a running turn, and from sandboxes older than the field.",
        ),
});
export type QueueResumed = z.infer<typeof QueueResumedSchema>;
