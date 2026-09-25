import { z } from "zod";
import { CONVERSATION_ID } from "../ids/conversation-ids.js";
import { ModelRoleSchema } from "../models/model-roles.js";
import { NATIVE_PROVIDERS } from "../models/provider-specs.js";
import { AgentPlacementSchema } from "../protocol/runner-protocol.js";
import { MENTION_LIMIT } from "../text/mentions.js";
import { entryId } from "./internal.js";
// Agent runtimes the daemon can serve: native providers have dedicated adapters, `endpoint/<id>` names an installed
// endpoint capability, anything else is an ACP agent capability id. A bare string, not an enum, so an unknown id is a
// clean error, not a contract change.
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
// Provider naming a catalog in providers.contract.ts; an enum, not the open string above, since only native providers
// have a daemon-held catalog to look up. An unknown id is a 400 here, not an empty list.
export const NativeProviderParamSchema = z.object({ provider: z.enum(NATIVE_PROVIDERS) });
// The harness (agentic loop) a turn runs on, orthogonal to the provider.
export const AgentHarnessSchema = z.enum(["native", "claude-code"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
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
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;
// The class of thing asking to start a session, the admission policy's key space; derived daemon-side, never sent by a
// client. Chat and loops are absent since both begin with the owner's own click.
export const WakeSourceSchema = z.enum(["schedule", "event", "listener", "webchat", "issues", "workspace", "workflow"]);
export type WakeSource = z.infer<typeof WakeSourceSchema>;
// One admission verdict the owner can configure: let it run, hold it for approval, or refuse it outright.
export const AdmissionRuleSchema = z.enum(["allow", "hold", "deny"]);
export type AdmissionRule = z.infer<typeof AdmissionRuleSchema>;
// Where a command would run; the same string means different things on each machine (rm -rf /usr is recoverable here,
// fatal on a laptop). Read with a locus (command-classes.ts CommandContext); callers must state one rather than
// default.
export const CommandLocusSchema = z.enum([
    // This sandbox's own shell: a disposable container, /work a git worktree, /history every other agent's.
    "sandbox",
    // One of the owner's own computers, reached through the machine agent. Nothing here is disposable.
    "device",
]);
export type CommandLocus = z.infer<typeof CommandLocusSchema>;
// What kind of thing a shell command is, the command gate's key space under the admission floor; gates one command
// inside an already-running session. Six classes, chosen because each is hard or impossible to undo somewhere.
export const CommandClassSchema = z.enum([
    // Rewrites or discards committed work: force-push, hard reset, force-delete a branch, clean -f, filter-branch.
    "git.destructive",
    // Moves a checkout to another branch. Only ever matches in a tree the conversation SHARES with its owner: inside
    // its own copy a conversation may stand where it likes, and the drift that causes is reported, not refused.
    "git.branch-switch",
    // Recursive-force deletion (`rm -rf`), and its spelling in a script (`fs.rm(p, { recursive: true })`).
    "files.destructive",
    // State nothing recovers at this locus; which roots count (/, /history in the sandbox) depends on the locus.
    "system.destructive",
    // A container volume or its data; the sandbox's blast radius (nested engine) differs sharply from a device's.
    "container.state",
    // Reads credential material: a secret reference, or a file confirmed to actually hold one.
    "secrets.access",
    // Publishes outward and irreversibly: npm/pnpm/yarn/cargo publish, gh release create, docker push.
    "package.publish",
    // A network program (curl, nc, ssh, scp, …) or interpreter one-liner aimed at a non-loopback or run-time-built
    // destination, the general exfiltration channel under the per-provider actionRules.
    "network.outbound",
]);
export type CommandClass = z.infer<typeof CommandClassSchema>;
// Workspace-wide admission floor per wake source, consulted on every outside-driven wake; composes with per-automation
// overrides most-restrictive-wins. `workflow` is allow|deny only, since a hold there is indistinguishable from a CI
// runner's timeout.
export const AdmissionPolicySchema = z.object({
    schedule: AdmissionRuleSchema.default("allow"),
    event: AdmissionRuleSchema.default("allow"),
    listener: AdmissionRuleSchema.default("allow"),
    webchat: AdmissionRuleSchema.default("allow"),
    // Defaults to hold, unlike the others: a bug-report wake has full repo powers and a stranger's stack trace as its
    // brief.
    issues: AdmissionRuleSchema.default("hold"),
    workspace: AdmissionRuleSchema.default("allow"),
    workflow: z.enum(["allow", "deny"]).default("allow"),
});
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;
// How tool calls are gated, the Claude Agent SDK's PermissionMode narrowed to the three the composer offers. Both a
// turn input and the payload of the `mode` frame, since the agent can move itself between them mid-turn. The SDK's
// acceptEdits is not one of them: only `default` asks a person here, so it would differ from bypassPermissions in name
// alone.
export const PermissionModeSchema = z.enum(["default", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
// Where a conversation was cut from, the durable half of a fork, carried on the registry entry. `index` is the message
// the cut sat above in the source, so its transcript can put the mark back.
export const ForkedFromSchema = z.object({
    conversationId: ConversationIdSchema,
    index: z.number().int().nonnegative(),
    // Which files this fork opened on; kept so the fork can still say it later, not only right after the click.
    files: z.enum(["then", "now"]),
});
export type ForkedFrom = z.infer<typeof ForkedFromSchema>;
// The turn's fields before the cross-field refinements below, so a subset (TurnProfileSchema) can be picked from them.
const AgentTurnFieldsSchema = z.object({
    prompt: z.string().describe("What to say to the agent. May be empty if you are only attaching files."),
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
        .max(80)
        .optional()
        .describe("A title for a conversation this turn is opening. Ignored for a conversation that already has one."),
    // Already uploaded via /workspace/upload; Claude reads them via Read, Codex gets images as native input.
    attachments: z
        .array(z.string().min(1))
        .max(20)
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
    // Which agentic loop runs the turn, absent = provider's own; "claude-code" forces the SDK loop for any
    // provider.
    harness: AgentHarnessSchema.optional().describe("Which agentic loop runs the turn. Leave it out to use each provider's own."),
    // Intent, not a guess: absent continues on the conversation's own account, or picks by serviceability where there is
    // none on this provider yet (agent/providers/accounts/routing.ts).
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
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
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
/* ONE ENTRY OF ONE ROLE'S MODEL LIST (settings.modelRoles): the standing version of the pick above, and not merely which model but HOW it is to be run. */
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
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
// Why a queue holds its messages rather than letting them go when the conversation is free.
export const QueuePauseSchema = z.enum(["stopped", "refused"]);
export type QueuePause = z.infer<typeof QueuePauseSchema>;
// What waits for a conversation's next turn: messages that arrived while a turn that could not take them ran, and
// held ones. Conversation state, the same for every window and kept across a restart.
export const ConversationQueueSchema = z.object({
    items: z.array(QueuedMessageSchema).describe("What waits, in the order it goes out."),
    revision: z.number().int().nonnegative().describe("Moves with every change to the queue, so of two copies the higher is the newer."),
    paused: QueuePauseSchema.optional().describe(
        "Why nothing goes out by itself: somebody stopped the turn, or the turn these messages started was refused before it ran. Resuming, or sending another message, lets them go.",
    ),
});
export type ConversationQueue = z.infer<typeof ConversationQueueSchema>;
// What resuming a queue did: started a turn with what waited, when nothing else ran.
export const QueueResumedSchema = z.object({
    run: z.string().optional().describe("The turn the waiting messages started. Absent when a turn was already running, and they go after it."),
});
export type QueueResumed = z.infer<typeof QueueResumedSchema>;
// Attaches to a conversation's newest run (live, or finished within retention); no cursor to resume from, the head
// carries all rows. `run` names what the client was watching, so a newer run's head id tells it to catch up.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema.describe("Which conversation to watch."),
    run: z
        .string()
        .optional()
        .describe(
            "The run you were watching. The stream opens on the conversation's newest run whatever you name: if a newer turn has started since, the head names that one instead, and its rows are that turn's.",
        ),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;
