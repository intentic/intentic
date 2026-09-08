import { z } from "zod";
import { PermissionModeSchema } from "../schemas/agent.js";
import { LandConflictSchema } from "../schemas/agents.js";
import { RateLimitInfoSchema } from "../schemas/claude-gate.js";
import { FastModeStateSchema } from "../schemas/fast-mode.js";
import { AgentReplySchema, UsageWindowSchema } from "../schemas/plan-limits.js";
import { SubagentKindSchema, SubagentStatusSchema, SubagentVerificationSchema } from "../schemas/terminal.js";
import { AgentCommandSchema, browserHelpCard, capabilityOfferCard, CapabilityOutcomeSchema, ContextUsageSchema, credentialOfferCard, CredentialReceiptSchema, paymentOfferCard, PaymentReceiptSchema, PermissionCardSchema, PlanCardSchema, QuestionCardSchema, terminalHelpCard, TodoItemSchema, ToolCallContentSchema, ToolCallLocationSchema, ToolCallStatusSchema, ToolKindSchema } from "./cards.js";
import { TranscriptPatchSchema, TranscriptRowSchema, TurnNoteSchema } from "./transcript.js";

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
    // names paths that failed, `held` means nothing happened. `deps` covers undeclared dependencies.
    z.object({
        kind: z.literal("landed"),
        landed: z.boolean(),
        conflicts: z.array(LandConflictSchema).optional(),
        held: z.boolean().optional(),
        deps: z.object({ missing: z.number(), started: z.array(z.string()), deferred: z.boolean() }).optional(),
    }),
    // Notes the daemon prepends to the user's message before the model reads it, verbatim, one per note. Serialized
    // from the same typed notes the wire prompt uses, so disclosure cannot drift from what the model got.
    z.object({ kind: z.literal("preamble"), notes: z.array(TurnNoteSchema) }),
    // The SDK's init handshake; carries the model it actually resolved for the turn.
    z.object({ kind: z.literal("init"), model: z.string() }),
    // The pre-turn snapshot id, emitted once before the provider stream so the client can offer
    // restore-to-before-this-message. Absent on an isolated turn or when the tree was already clean.
    // `index` is the message's position in the transcript, which the rewind route addresses by; absent on a turn with
    // no conversation, where the id still powers a plain restore.
    z.object({ kind: z.literal("checkpoint"), id: z.string(), index: z.number().int().nonnegative().optional() }),
    // A mid-turn user message, framed when the daemon accepted it, so every client and the stored transcript agree on
    // when. `text` is the raw words typed, never the composed prompt; `sentAt` is the daemon's clock.
    z.object({ kind: z.literal("steer"), text: z.string(), sentAt: z.number(), attachments: z.array(z.string()).optional() }),
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
    // One frame per spawned child (Agent/Task subagent, or a driven Codex/Grok CLI), then `subagent_update` as it
    // works, mirroring `tool_call`/`tool_call_update`. `id` is the spawning call's id, so both land on one card.
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
    }),
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
    // The complexity judge's verdict for this turn, emitted once at turn start on every judged turn. `model` is set
    // only when a substitution applies; `routed` is what actually happened, never implied by the verdict alone.
    z.object({
        kind: z.literal("tier"),
        tier: z.enum(["fast", "standard"]),
        score: z.number(),
        rules: z.array(z.string()),
        // The cheaper model this turn ran on (`routed`) or would have run on (`held`); absent otherwise.
        model: z.string().optional(),
        routed: z.boolean(),
        // The user pinned this turn to their own pick, so a fast verdict moved nothing.
        held: z.boolean().optional(),
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
    // The four interactive cards; each parks the turn until `POST /agent/reply` resolves its `requestId`.
    PlanCardSchema,
    QuestionCardSchema,
    PermissionCardSchema,
    // The agent's browser needs a person. Not journalled for restore: the Chromium holding the page dies with the
    // container.
    z.object({ kind: z.literal("browser_help"), ...browserHelpCard }),
    // The agent's terminal needs a person. Not journalled for restore: the pane belongs to a process the restart kills.
    z.object({ kind: z.literal("terminal_help"), ...terminalHelpCard }),
    // A missing capability asking for the owner's setup. Raised outside the turn generator; not journalled for restore,
    // since its waiter (the CLI's held connection) dies with the daemon.
    z.object({ kind: z.literal("capability_offer"), ...capabilityOfferCard }),
    // How an accepted ask ended: `connected` (the capability came live, `id` is the agent's handle) or `unfinished`
    // (deadline passed, or the asking command died). A skip needs no outcome; `resolved` already says so.
    CapabilityOutcomeSchema.extend({ kind: z.literal("capability_outcome"), requestId: z.string() }),
    // A USDC payment awaiting the owner's click. Raised outside the turn generator; not journalled for restore, since
    // its waiter (the CLI's held connection) dies with the daemon.
    z.object({ kind: z.literal("payment_offer"), ...paymentOfferCard }),
    // How an approved payment ended: `paid` (endpoint confirmed, `transaction` is the onchain hash if stated) or
    // `failed` (refused or unsettled, nothing left the wallet). A skip needs no receipt.
    PaymentReceiptSchema.extend({ kind: z.literal("payment_receipt"), requestId: z.string() }),
    // A gated credential awaiting a named approver's click, not the owner. The daemon holds the exit parked until
    // release; raised outside the turn generator, not journalled, since its waiter dies with the daemon.
    z.object({ kind: z.literal("credential_offer"), ...credentialOfferCard }),
    // Who released it: `released` names the approver's verified address, `refused` means someone said no. Nothing is
    // pushed for a card nobody answered; `resolved` already says that.
    CredentialReceiptSchema.extend({ kind: z.literal("credential_receipt"), requestId: z.string() }),
    // The named card is released and the turn resumes; emitted the moment its waiter settles, since nothing else on
    // this stream marks a park's end. `reply` is what a rebuilt transcript freezes the card with.
    z.object({ kind: z.literal("resolved"), requestId: z.string(), reply: AgentReplySchema.optional() }),
    // The turn's permission mode whenever it changes: the user's pick at start, then every move the agent makes on its
    // own. The composer's mode selector follows this.
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
                "subscription-required",
                "agent-busy",
                // The sandbox has no memory left to run this turn, refused before anything spawned; transient, no
                // clock.
                "sandbox-memory-low",
                // The runtime hit its own iteration ceiling and stopped; the work may be half done, so the user
                // decides.
                "turn-cap",
                // The harness ended the turn without succeeding, with no modelled reason; the vendor's subtype rides
                // verbatim.
                "harness-incomplete",
                // The installed engine is too old for the model; the provider names the version required, on `engine`.
                "engine-version-floor",
            ])
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
        // Gated codes only: "scheduled" if this conversation arms the resume, "available" if one exists but isn't.
        autoResume: z.enum(["scheduled", "available"]).optional(),
        // rate_limit only: how re-running the exact held turn would go, and what it would cost.
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
            })
            .optional(),
        // provider-outage only: `retryAt` is the next attempt on backoff; `attempt`/`maxAttempts` bound it.
        outage: z.object({ retryAt: z.number(), attempt: z.number(), maxAttempts: z.number() }).optional(),
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
    "tier",
    "provider_retry",
    "account_usage",
    "context_usage",
    "mode",
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
