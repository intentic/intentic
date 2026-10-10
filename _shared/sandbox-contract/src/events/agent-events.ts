import { z } from "zod";
import { PermissionModeSchema } from "../schemas/agent.js";
import { TurnErrandSchema } from "../schemas/speaker.js";
import { LandConflictSchema } from "../schemas/agents.js";
import { ContextTrimSchema } from "../schemas/context-trim.js";
import { RateLimitInfoSchema } from "../schemas/providers/claude-gate.js";
import { FastModeStateSchema } from "../schemas/providers/fast-mode.js";
import { NeedSchema } from "../schemas/needs.js";
import { PromptCacheOpeningSchema, PromptFingerprintSchema } from "../schemas/keep-warm.js";
import { AgentReplySchema, UsageWindowSchema } from "../schemas/providers/plan-limits.js";
import { SubagentKindSchema, SubagentStatusSchema, SubagentVerificationSchema } from "../schemas/terminal.js";
import { RetryLadderSchema } from "../schemas/turn-break.js";
import { HandedOffSchema, HandoffOfferSchema } from "../schemas/providers/handoff.js";
import { AgentCommandSchema, browserHelpRequest, capabilityOfferRequest, CapabilityOutcomeSchema, ContextUsageSchema, credentialOfferRequest, CredentialReceiptSchema, pageAskRequest, PageSchema, paymentOfferRequest, PaymentReceiptSchema, PermissionRequestSchema, PlanRequestSchema, QuestionRequestSchema, terminalHelpRequest, TodoItemSchema, ToolCallContentSchema, ToolCallLocationSchema, ToolCallStatusSchema, ToolKindSchema } from "./requests.js";
import { TranscriptPatchSchema, TranscriptRowSchema, TurnNoteSchema } from "./transcript.js";
import { agentNoticeEvent, agentStatusEvent } from "./agent-ui.js";

// Every frame an agent turn streams, as one `kind`-discriminated union: turn facts (session, standing, cost) and the
// attach stream a window joins through. One closed vocabulary, kept in one file.

// One frame per emission, `kind`-discriminated; the daemon maps SDK message types onto this closed set, dropping any
// without a UI mapping. `plan`/`question`/`permission` pause until `resolved` names the same requestId.
export const AgentEventSchema = z.discriminatedUnion("kind", [
    // The session this turn runs on and the account it belongs to. `account` is the daemon's resolved account, not
    // necessarily the one the request named; absent on an env-token or translator-subscription turn.
    z.object({
        kind: z.literal("session"),
        sessionId: z.string(),
        account: z.string().optional().describe("Which stored account this session belongs to, as the daemon resolved it for the turn."),
    }),
    // Where an isolated turn stands: worktree branch and the root repo's base sha, repeated each emission. `unenforced`
    // marks a degraded container rewriting tool paths; `sync` reports a mid-turn rebase.
    z.object({
        kind: z.literal("worktree"),
        branch: z.string(),
        base: z.string(),
        unenforced: z.boolean().optional(),
        sync: z.object({ commits: z.number(), blocked: z.array(z.string()) }).optional(),
        // The runner this turn executes on, when the conversation is placed remotely; absent means this sandbox.
        remote: z.string().optional(),
    }),
    // After a clean isolated turn's delta lands or not: `landed` puts it uncommitted in the main tree, `conflicts`
    // names paths that failed, `held` means nothing happened. `deps` covers undeclared dependencies. `into` names the
    // parent conversation a spawned child's work went into instead of the main tree, as an in-process subagent's edits
    // go into its parent's checkout.
    z.object({
        kind: z.literal("landed"),
        landed: z.boolean(),
        conflicts: z.array(LandConflictSchema).optional(),
        held: z.boolean().optional(),
        deps: z.object({ missing: z.number(), started: z.array(z.string()), deferred: z.boolean() }).optional(),
        into: z.string().optional(),
    }),
    // Notes the daemon prepends to the user's message before the model reads it, verbatim, one per note. Serialized
    // from the same typed notes the wire prompt uses, so disclosure cannot drift from what the model got.
    z.object({ kind: z.literal("preamble"), notes: z.array(TurnNoteSchema) }),
    // The other half of `preamble`: what a window too small for a full turn left OUT. A note that never rode has no
    // message to be drawn beside, so this is the only place the reader can learn the turn ran thin.
    ContextTrimSchema.extend({ kind: z.literal("context_trim") }),
    // How a turn a spent allowance held continued the conversation: the whole session, a trimmed copy, or a summary.
    HandedOffSchema.extend({ kind: z.literal("handoff") }),
    // The SDK's init handshake; carries the model it actually resolved for the turn.
    // `prompt` names the parts the cache is keyed on, so a later turn can say which of them changed.
    z.object({ kind: z.literal("init"), model: z.string(), prompt: PromptFingerprintSchema.optional() }),
    // The pre-turn snapshot id, emitted once before the provider stream so the client can offer
    // restore-to-before-this-message. Absent on an isolated turn or when the tree was already clean.
    // `index` is the message's position in the transcript, which the rewind route addresses by; absent on a turn with
    // no conversation, where the id still powers a plain restore.
    z.object({ kind: z.literal("checkpoint"), id: z.string(), index: z.number().int().nonnegative().optional() }),
    // A mid-turn message on the daemon's clock; `voice` is absent only for the person at the composer.
    z.object({
        kind: z.literal("steer"),
        text: z.string(),
        sentAt: z.number(),
        attachments: z.array(z.string()).optional(),
        voice: z.enum(["sandbox", "agent"]).optional(),
        // What a composed message is for, stamped on the row it becomes (TranscriptRow.errand).
        errand: TurnErrandSchema.optional(),
        // The message's own id, stamped on the row it becomes (TranscriptRow.messageId).
        messageId: z.string().optional(),
    }),
    z.object({ kind: z.literal("delta"), text: z.string(), parentToolUseId: z.string().optional() }),
    // Closes the prose block `delta` frames were writing; a turn emits several as it narrates, and without this
    // boundary the client cannot tell them apart.
    z.object({ kind: z.literal("text_end"), parentToolUseId: z.string().optional() }),
    z.object({ kind: z.literal("thinking"), text: z.string(), parentToolUseId: z.string().optional() }),
    // A tool call starting, or arriving whole for a backend that only reports completions. `content` carries structured
    // output already known at call time (e.g. an Edit's diff, derived from input).
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
    // A later state of a call, correlated by `id`. Status and/or fresh content/locations REPLACE the prior value
    // (snapshot, not append); an absent field is unchanged.
    z.object({
        kind: z.literal("tool_call_update"),
        id: z.string(),
        status: ToolCallStatusSchema.optional(),
        content: z.array(ToolCallContentSchema).optional(),
        locations: z.array(ToolCallLocationSchema).optional(),
    }),
    // The agent started running Bash in its live `agent-<id>` tmux session; one per turn, reused across all of a turn's
    // commands including subagents'.
    z.object({ kind: z.literal("terminal"), session: z.string() }),
    // The agent used a browser tool; one per turn, since one Chromium serves every browser call the turn makes.
    z.object({ kind: z.literal("browser"), session: z.string() }),
    // One frame per subagent a turn starts, whichever mechanism starts it, then `subagent_update` as it works, mirroring
    // `tool_call`/`tool_call_update`. `id` is its roster id: the spawning call's own id for an in-process subagent (the
    // runtime's Agent/Task tool), its own conversation id for a spawned one, whose card is the call whose result names
    // that id (transcript-fold.ts). Either way both frames land on the card of the call that started it.
    z.object({
        kind: z.literal("subagent"),
        id: z.string(),
        subagentKind: SubagentKindSchema,
        agentType: z.string().optional(),
        description: z.string().optional(),
        model: z.string().optional(),
        // Which provider serves a spawned child; absent for an SDK subagent, whose provider is its parent's.
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
        // Whether anything checked the work this report describes; rides the frame that ends the child.
        verification: SubagentVerificationSchema.optional(),
    }),
    z.object({ kind: z.literal("todos"), items: z.array(TodoItemSchema) }),
    // The provider's own slash commands, replaced whole each time; the composer's `/` popover lists them, invoking one
    // is plain `/name …` prompt text.
    z.object({ kind: z.literal("commands"), items: z.array(AgentCommandSchema) }),
    z.object({
        kind: z.literal("usage"),
        // The account that served this turn, so the client attributes totals to it.
        account: z.string().optional(),
        costUsd: z.number().optional(),
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        // Provider prompt-cache buckets (read/write); optional per provider, lets the client compute a hit rate.
        cacheReadTokens: z.number().optional(),
        cacheCreationTokens: z.number().optional(),
        durationMs: z.number().optional(),
        numTurns: z.number().optional(),
        // The stream's first request only; a sum of frames keeps the first frame's, never adds them.
        openingCacheReadTokens: z.number().optional(),
        openingCacheCreationTokens: z.number().optional(),
        promptFingerprint: z.string().optional(),
    }),
    // What the turn's first request found in the prompt cache, sent as soon as it is known.
    PromptCacheOpeningSchema.extend({ kind: z.literal("prompt_cache") }),
    // The provider's live answer to whether this turn may run, pushed mid-turn; drives the rate-limited notice, not the
    // headroom readouts.
    RateLimitInfoSchema.extend({ kind: z.literal("rate_limit_info"), account: z.string().optional() }),
    // The turn's actual speed, emitted only when it changes (once at init, again on mid-turn cooldown). `reason` is
    // forwarded verbatim as the harness's own string, not a fixed enum, so an unfamiliar reason still parses.
    z.object({
        kind: z.literal("fast_mode"),
        state: FastModeStateSchema,
        // Absent when nothing blocks fast mode, including `state: "on"`, and an `off` that was never asked for.
        reason: z.string().optional(),
    }),
    // The turn is alive but retrying a transient provider failure in this same turn; a status, not a failure, shown
    // where thinking goes. `attempt`/`maxAttempts`/`nextAttemptAt` are each optional, runtimes report different halves.
    z.object({
        kind: z.literal("provider_retry"),
        attempt: z.number(),
        maxAttempts: z.number().optional(),
        nextAttemptAt: z.number().optional(),
        // The HTTP status behind the retry, when there was one (529 capacity, 429 rate limit, 500 fault).
        status: z.number().optional(),
    }),
    // Every plan-limit pool for the account that served the turn, read once the turn settles. `account` keys headroom
    // by account; absent on an env-token turn. No `measuredAt` on the wire: both readers stamp receipt time.
    z.object({ kind: z.literal("account_usage"), account: z.string().optional(), windows: z.array(UsageWindowSchema) }),
    ContextUsageSchema.extend({ kind: z.literal("context_usage") }),
    z.object({ kind: z.literal("compact"), trigger: z.string(), preTokens: z.number().optional(), postTokens: z.number().optional() }),
    // An agent's own project-dependency install was let through the command gate: where it writes, and which projects
    // it works on, so the chat says so before its output arrives. Said by every runtime the gate stands in front of.
    z.object({
        kind: z.literal("install"),
        reach: z
            .enum(["own-copy", "main-tree"])
            .describe("Where it writes: this conversation's own copy of the tree, or the main tree every conversation reads."),
        projects: z
            .array(z.string())
            .describe("The projects it works on, workspace-relative, the workspace root as an empty string; empty when none could be named."),
    }),
    // What a runtime's own extensions show (events/agent-ui.ts): a keyed status entry, live state replayed to a late
    // joiner and dropped when the turn ends, and a notice, folded into the transcript as a notice row.
    z.object(agentStatusEvent),
    z.object(agentNoticeEvent),
    // The four interactive cards; each parks the turn until `POST /agent/reply` resolves its `requestId`.
    PlanRequestSchema,
    QuestionRequestSchema,
    PermissionRequestSchema,
    // The agent's browser needs a person. Not journalled for restore: the Chromium holding the page dies with the
    // container.
    z.object({ kind: z.literal("browser_help"), ...browserHelpRequest }),
    // The agent's terminal needs a person. Not journalled for restore: the pane belongs to a process the restart kills.
    z.object({ kind: z.literal("terminal_help"), ...terminalHelpRequest }),
    // A missing capability asking for the owner's setup. Raised outside the turn generator; not journalled for restore,
    // since its waiter (the CLI's held connection) dies with the daemon.
    z.object({ kind: z.literal("capability_offer"), ...capabilityOfferRequest }),
    // How an accepted ask ended: `connected` (the capability came live, `id` is the agent's handle) or `unfinished`
    // (deadline passed, or the asking command died). A skip needs no outcome; `resolved` already says so.
    CapabilityOutcomeSchema.extend({ kind: z.literal("capability_outcome"), requestId: z.string() }),
    // A USDC payment awaiting the owner's click. Raised outside the turn generator; not journalled for restore, since
    // its waiter (the CLI's held connection) dies with the daemon.
    z.object({ kind: z.literal("payment_offer"), ...paymentOfferRequest }),
    // How an approved payment ended: `paid` (endpoint confirmed, `transaction` is the onchain hash if stated) or
    // `failed` (refused or unsettled, nothing left the wallet). A skip needs no receipt.
    PaymentReceiptSchema.extend({ kind: z.literal("payment_receipt"), requestId: z.string() }),
    // A gated credential awaiting a named approver's click, not the owner. The daemon holds the exit parked until
    // release; raised outside the turn generator, not journalled, since its waiter dies with the daemon.
    z.object({ kind: z.literal("credential_offer"), ...credentialOfferRequest }),
    // Who released it: `released` names the approver's verified address, `refused` means someone said no. Nothing is
    // pushed for a card nobody answered; `resolved` already says that.
    CredentialReceiptSchema.extend({ kind: z.literal("credential_receipt"), requestId: z.string() }),
    // Something the agent asked a person for (docs/architecture/needs.md). Parks nothing: the turn carries on, the need
    // outlives it in the needs store, and its card draws the store's live state by `need.id`.
    z.object({ kind: z.literal("need"), need: NeedSchema }),
    // A page the agent showed (its `show_page` tool): drawn inline where the turn stands, in a sealed frame. Parks
    // nothing. A page whose id an earlier one already holds is a redraw, and the earlier row folds to a line.
    z.object({ kind: z.literal("page"), page: PageSchema }),
    // A page the agent showed to be answered (`ask_page`): parks the turn until the page sends its answer back, or the
    // person dismisses it. Not journalled for restore: the tool call waiting on it dies with the daemon.
    z.object({ kind: z.literal("page_ask"), ...pageAskRequest }),
    // A page as the model is still writing it, for the chat to draw as it arrives: `text` is what came at `at` in the
    // page's markup, so a window that missed nothing appends and one joining late replays them in order. Live state, not
    // transcript: `done` ends it (the page itself, or the call's failure, takes over), and every draft goes with the turn.
    z.object({
        kind: z.literal("page_draft"),
        callId: z.string().describe("The tool call writing it."),
        at: z.number().int().nonnegative().describe("Where in the page's markup this text starts."),
        text: z.string().describe("The next stretch of the page's markup."),
        title: z.string().optional().describe("The page's title, once the call has written it."),
        done: z.boolean().optional().describe("The draft is over: the page is published, or the call failed."),
    }),
    // The named card is released and the turn resumes; emitted the moment its waiter settles, since nothing else on
    // this stream marks a park's end. `reply` is what a rebuilt transcript freezes the card with.
    z.object({ kind: z.literal("resolved"), requestId: z.string(), reply: AgentReplySchema.optional() }),
    // Every move off the mode the turn was sent in, the agent's own (EnterPlanMode, an approved plan) included; a turn
    // that stays in its mode emits none, since the composer's selector already shows the pick it follows.
    z.object({ kind: z.literal("mode"), mode: PermissionModeSchema }),
    // `code` is a machine-readable discriminator for errors the UI reacts to (e.g. dropping a dead session id so the
    // next send self-heals); absent on plain failures.
    z.object({
        kind: z.literal("error"),
        message: z.string(),
        code: z
            .enum([
                "session-not-found",
                "rate_limit",
                // Codex ran the turn but warned about it (fallback model metadata); a notice, not a failure.
                "codex-advisory",
                "codex-reauth",
                // An ACP capability requires its own loginCommand, not a native provider account reconnect.
                "acp-auth-required",
                // The Claude subscription credential is dead; only a reconnect fixes it, unlike no account connected.
                "claude-reauth",
                // The API refused this turn's token mid-flight, usually superseded by a rotation already re-minting.
                "claude-token-refused",
                // The account authenticates and has real usage pools, but the org disabled Claude Code for this seat.
                "claude-not-entitled",
                // The provider failed transiently and in-turn retries did not outlast it; the daemon retries on
                // backoff.
                "provider-outage",
                // The platform-owned free-trial pool failed after its bounded key walk; the failed call is refunded.
                "trial-unavailable",
                // The trial answered, but the selected upstream model/request cannot run through this sandbox.
                "trial-model-unavailable",
                // This account's platform-owned daily trial allowance is spent until its UTC reset.
                "trial-exhausted",
                // The harness read the message as a slash command it doesn't have; the model never saw it.
                "unknown-command",
                "grok-model-invalid",
                "codex-model-invalid",
                // The model is real and listed, but this plan's subscription does not have access to it.
                "model-unavailable",
                // The model cannot hold a turn this size, refused before sending; retrying the same request never
                // helps.
                "context-window-too-small",
                // The model can only write one-shot jobs (Model.helperOnly: its server says it cannot call tools, or
                // it is the quick-jobs local model), refused before sending; the words wait for another model.
                "model-helper-only",
                // The privacy shield is on, the provider is untrusted, and the runtime is one it cannot read by content at
                // all (an ACP agent, Pi), refused before sending; the words wait for a covered provider.
                "privacy-unshielded",
                // The protected execution-domain policy is unsupported or unreadable; refused before any model/helper ran.
                "agent-domain-refused",
                // The privacy shield found personal data in instructions the runtime loads itself, past every channel it
                // could mask (Cursor's project rules, AGENTS.md), refused before sending; the words wait for the owner to
                // let the provider read this conversation, trust it, or take the data out of those files.
                "privacy-instructions",
                // The session outgrew the model's context window mid-turn; resuming that session only overflows again,
                // so the daemon re-runs the turn once in a fresh session carrying the hand-off.
                "context-overflow",
                "subscription-required",
                "agent-busy",
                // The sandbox is short of memory, held before anything spawned: a person once per spell, after which
                // their sends run; background work on every short reading. Transient, no clock.
                "sandbox-memory-low",
                // The runtime hit its own iteration ceiling and stopped; the work may be half done, so the user
                // decides.
                "turn-cap",
                // The harness ended the turn without succeeding, with no modelled reason; the vendor's subtype rides
                // verbatim.
                "harness-incomplete",
                // The installed engine is too old for the model; the provider names the version required, on `engine`.
                "engine-version-floor",
                // The provider's safety classifier stopped the turn partway, often a false positive on ordinary work.
                // Held for a person: retry on the same model without the stopped response, or go on with another.
                "safeguard-flagged",
            ])
            .optional(),
        // safeguard-flagged only: what the classifier named, and where a retry resumes the session from.
        refusal: z
            .object({
                category: z.string().optional().describe("The classifier's category as the provider named it (cyber, bio, reasoning_extraction, …), when it did."),
                resumeAt: z
                    .string()
                    .optional()
                    .describe("The last session entry before the stopped response: a retry resumes the session there, so the model never sees what was stopped."),
            })
            .optional(),
        // Which engine, the version refused, and the floor the provider requires; lets the client offer an install.
        engine: z
            .object({
                id: z.string().describe("Which engine (e.g. claude)."),
                running: z.string().optional().describe("The version that was refused, when the provider named it."),
                floor: z.string().describe("The lowest version the provider will accept."),
            })
            .optional(),
        // rate_limit only: epoch seconds when the exhausted window reopens; absent when the reset instant is unknown.
        resetsAt: z.number().optional(),
        // The daemon's word, never the window's guess: which account a reconnect badge or a spent pool belongs to.
        account: z.string().optional().describe("Which of the provider's accounts served (or was refused for) the turn, where the sandbox holds it."),
        // Gated codes only: "scheduled" if this conversation arms the resume, "available" if one exists but isn't.
        autoResume: z.enum(["scheduled", "available"]).optional(),
        // "scheduled" only: epoch seconds the booked send actually fires. Distinct from `resetsAt` (the provider's fact
        // about the allowance) since a ladder rung can fall short of it, and a stopped turn has no allowance at all.
        nextAt: z.number().optional(),
        // A held turn, whatever wall stopped it: how re-running the exact turn would go, and what it would cost.
        held: z
            .object({
                ran: z.boolean(),
                // What each way of continuing costs: `contextTokens` re-reads context, `handoffTokens` pays a session's
                // brief.
                contextTokens: z.number().optional(),
                handoffTokens: z.number().optional(),
                // Set when the owner's policy is already moving this turn to the named account, instead of offering a
                // press.
                moving: z.string().optional(),
                // The ways this turn can continue once its cache is cold, the one the sandbox suggests, and the one a
                // person picked (schemas/providers/handoff.ts). Absent where there is nothing to carry.
                handoff: HandoffOfferSchema.optional(),
            })
            .optional(),
        // provider-outage only, while the breaker has tries left: epoch seconds its backoff next lets one through.
        outage: z.object({ retryAt: z.number() }).optional(),
        // Laddered walls only (an outage, a stopped turn): how far the automatic re-runs have got.
        retries: RetryLadderSchema.optional(),
        // sandbox-memory-low only: the cgroup reading the refusal was decided on, so a client can offer to raise the
        // cap rather than only restate the sentence. Resident and swapped are apart for the reason the message keeps
        // them apart — their sum can exceed the cap, since the ceiling bounds resident pages and not swapped anon.
        memory: z
            .object({
                limitBytes: z.number().describe("The cgroup's ceiling: what a raise would move."),
                residentBytes: z.number().describe("memory.current, the resident charge alone."),
                swapBytes: z.number().describe("memory.swap.current; 0 when swap is off or unaccounted."),
            })
            .optional(),
        // Nobody was at the composer when this turn was refused. The codes that ran nothing otherwise read as "held
        // for you to send again", which on an automation, a loop or a watch wake names a message no one typed and a
        // composer no one is looking at.
        unattended: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("done") }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// Frames that are facts about the turn, not transcript; a `worktree` rebase can be both notice and standing.
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
    "provider_retry",
    "account_usage",
    "context_usage",
    "mode",
    "agent_status",
    "page_draft",
    "error",
] as const;
export type TurnFact = Extract<AgentEvent, { kind: (typeof TURN_FACT_KINDS)[number] }>;
export const isTurnFact = (event: AgentEvent): event is TurnFact => (TURN_FACT_KINDS as readonly string[]).includes(event.kind);
// The same members AgentEventSchema declares, picked out rather than re-declared, so there is one place a fact's shape
// can drift from the frame's.
type AgentEventMember = (typeof AgentEventSchema.options)[number];
const factMembers = AgentEventSchema.options.filter((member) => (TURN_FACT_KINDS as readonly string[]).includes(member.shape.kind.value)) as unknown as [
    AgentEventMember,
    ...AgentEventMember[],
];
export const TurnFactSchema = z.discriminatedUnion("kind", factMembers) as unknown as z.ZodType<TurnFact>;

// The /agent/attach stream: a head with rows so far, then patches and facts as they land, then `end`. Facts replay on
// every attach so a late joiner learns the turn's standing; patches never do.
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
