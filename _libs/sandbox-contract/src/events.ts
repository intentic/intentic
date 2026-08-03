import { z } from "zod";
import {
    AgentProviderSchema,
    AgentReplySchema,
    AgentSummarySchema,
    FastModeStateSchema,
    LandConflictSchema,
    PermissionModeSchema,
    RateLimitInfoSchema,
    SubagentKindSchema,
    SubagentStatusSchema,
    UsageWindowSchema,
} from "./schemas.js";

// The wire shapes streamed from the daemon's event-iterator procedures. This is their canonical home: the
// daemon yields them and the browser client consumes them from the same schema, so the two can't drift (they
// used to be hand-duplicated across repos). Schemas, not bare types, because oRPC's `eventIterator(...)`
// validates each frame against them.

// One interactive question the agent asks via the `ask` tool (mirrors AskUserQuestion's input shape).
export const AskOptionSchema = z.object({
    label: z.string(),
    description: z.string(),
    preview: z.string().optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskQuestionSchema = z.object({
    question: z.string(),
    header: z.string(),
    multiSelect: z.boolean(),
    options: z.array(AskOptionSchema),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

// One per-tool permission prompt (the SDK's canUseTool callback, surfaced as a card). The daemon passes the
// bridge's own rendered strings through rather than re-deriving them, so the prompt reads exactly as Claude
// Code words it. `alwaysLabel` is present only when the SDK offered rules to persist — without it the card
// shows allow-once / deny alone, because there is nothing an "always" answer could remember.
export const PermissionAskSchema = z.object({
    toolName: z.string(),
    // "Claude wants to read foo.txt" — the full prompt sentence, when the bridge rendered one.
    title: z.string().optional(),
    // Short noun phrase for the allow button ("Read file").
    displayName: z.string().optional(),
    description: z.string().optional(),
    // Why the prompt fired ('rule' | 'mode' | 'classifier' | …) — shown as the card's muted subline.
    reason: z.string().optional(),
    // The file the request is about, when it is about one (workspace-root-relative).
    path: z.string().optional(),
    alwaysLabel: z.string().optional(),
});
export type PermissionAsk = z.infer<typeof PermissionAskSchema>;

// One provider-advertised slash command — an ACP agent's available_commands entry, or a Claude Code session's
// supportedCommands() (its built-ins plus the workspace's own .claude/commands and any plugin/skill commands).
// `hint` is the argument placeholder the popover shows after the name.
export const AgentCommandSchema = z.object({
    name: z.string(),
    description: z.string(),
    hint: z.string().optional(),
});
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

// GET /agent/commands — which provider's last-published list to read; absent = claude, matching AgentTurn.
export const AgentCommandsQuerySchema = z.object({ agent: AgentProviderSchema.optional() });
export const AgentCommandsSchema = z.object({ commands: z.array(AgentCommandSchema) });

// One TodoWrite/Task checklist item, surfaced live so the UI shows the agent's plan-of-work (Claude Code style).
export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string().optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// Context-window fill for a conversation: how many tokens the latest request sent vs the model's window, so
// the UI can warn as the chat nears auto-compaction. Per-conversation, unlike the account-wide usage above.
export const ContextUsageSchema = z.object({
    tokens: z.number(), // full input of the latest request (input + cache read + cache creation)
    contextWindow: z.number(), // the model's context window
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

// ACP-aligned tool taxonomy (Agent Client Protocol's ToolKind, verbatim): what a tool call *does*, driving
// the card icon and the live-writes bookkeeping regardless of which backend named the tool.
export const ToolKindSchema = z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

// A file a tool call touches. Workspace-root-relative, forward-slash (the tree/file route space) — adapters
// normalize from the turn's cwd. `line` is 1-based.
export const ToolCallLocationSchema = z.object({
    path: z.string(),
    line: z.number().optional(),
});
export type ToolCallLocation = z.infer<typeof ToolCallLocationSchema>;

// Structured tool output (ACP's ToolCallContent diff shape, verbatim). `diff` is hunk-level for Edit-style
// tools (old_string/new_string) and whole-file for Write; an absent oldText means a new file / unknown
// previous content. Sides are capped daemon-side; `truncated` marks a clipped side.
//
// `image` is a PICTURE THE TOOL PRODUCED, carried as a workspace path rather than as bytes: a browser
// screenshot is already on disk under .intentic/browser/output (the artifact hook put it there), so the client
// fetches it from /workspace/raw like any other file. Base64 on the wire would push a third of a megabyte
// through the event stream and into the stored transcript for every screenshot, to show something the
// workspace can already serve — and the path is what keeps the picture openable afterwards, which the inlined
// bytes would not be. Root-relative, forward-slash: the same route space as ToolCallLocation.
export const ToolCallContentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
        type: z.literal("diff"),
        path: z.string(),
        oldText: z.string().optional(),
        newText: z.string(),
        truncated: z.boolean().optional(),
    }),
    z.object({ type: z.literal("image"), path: z.string() }),
]);
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;

// ---- restored transcripts ----
// What /sessions/{id} replays into a reopened tab, and what the daemon's own conversation record stores. It has
// to REDRAW the transcript the user was looking at rather than merely paraphrase it, so it keeps the assistant's
// thinking and the tool cards its turn ran — which is also what lets a runtime handoff carry more than bare
// prose across to the replacement session (see runtime-history.ts). Reconstructed from the stored
// tool_use/tool_result blocks, so a restored card carries everything the live `tool_call` frame did except
// the streaming-only correlation fields.
//
// One restored tool card. A subagent's own calls and its thinking nest under the Agent card that spawned them,
// the same two fields (and the same recursion) the live ChatTool carries — so a reopened chat redraws the
// delegation it was showing instead of a leaf card with the whole child collapsed into its result text.
// z.lazy because the shape refers to itself: a subagent that delegates nests one level deeper.
export const RestoredToolCallSchema: z.ZodType<RestoredToolCall> = z.lazy(() =>
    z.object({
        id: z.string(),
        name: z.string(),
        category: ToolKindSchema,
        status: ToolCallStatusSchema,
        target: z.string().optional(),
        locations: z.array(ToolCallLocationSchema).optional(),
        content: z.array(ToolCallContentSchema).optional(),
        children: z.array(RestoredToolCallSchema).optional(),
        thinking: z.string().optional(),
    }),
);
// Mutable, unlike most of this file: both builders settle a card IN PLACE when its result arrives turns later
// (restoredTurn's `cards` map, readWorkspaceSession's `awaiting`), which is what saves them a second pass.
export interface RestoredToolCall {
    id: string;
    name: string;
    category: ToolKind;
    status: ToolCallStatus;
    target?: string | undefined;
    locations?: ToolCallLocation[] | undefined;
    content?: ToolCallContent[] | undefined;
    children?: RestoredToolCall[] | undefined;
    thinking?: string | undefined;
}

// One restored bubble. Each stored assistant message becomes its own, which is what reproduces the live
// interleaving — prose, the tool cards that prose introduced, then the next block of prose — rather than
// collapsing a turn's whole narration into a single bubble with its tools hanging off the end.
export const RestoredMessageSchema = z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    // Files the user attached to this turn (user bubbles only) as workspace-relative paths, recovered from
    // the stored prompt's attachment note — so a reopened tab redraws chips, not the injected protocol text.
    attachments: z.array(z.string()).optional(),
    /* The checkpoint this message can be rewound to (user bubbles only), filled in when the transcript is read
     * back. Not stored in the record itself — it is looked up per read from the daemon's rewind points, which
     * a rewind rewrites — so a reopened tab offers exactly the turns that are still there to go back to. */
    checkpointId: z.string().optional(),
    thinking: z.string().optional(),
    tools: z.array(RestoredToolCallSchema).optional(),
});
export type RestoredMessage = z.infer<typeof RestoredMessageSchema>;

export const SessionTranscriptSchema = z.object({ messages: z.array(RestoredMessageSchema) });
export const AgentTranscriptSchema = SessionTranscriptSchema.extend({ sessionId: z.string().optional() });

// One frame from an agent turn, relayed to the UI. `kind`-discriminated. The daemon normalizes the SDK's
// ~40 SDKMessage types down to this union: high-value block types get a dedicated frame
// (delta/thinking/tool_call/tool_call_update/todos/usage/rate_limit_info/account_usage/context_usage/init/compact); any SDK message
// without a UI mapping is dropped. `plan`/`question`/`permission` pause the turn until the user answers on the
// `POST /agent/reply` side channel, and `resolved` releases the one it names; `mode` reports the live
// permission posture as the agent changes it.
// `parentToolUseId` tags frames produced inside a subagent (Task tool); `subagent`/`subagent_update` report the
// subagent itself, keyed by the same tool_use id those tagged frames carry.
export const AgentEventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session"), sessionId: z.string() }),
    /* WHERE AN ISOLATED TURN IS STANDING: the conversation's worktree identity — its branch (agent/<id>) and
     * the ROOT repo's short base sha. First frame of the turn, before any provider frames, and again each time
     * the branch MOVES underneath it, which is why `base` names where the branch sits now rather than the
     * moment it was checked out.
     *
     * `unenforced` marks the degraded container: no CAP_SYS_ADMIN, so the turn's worktree could not be
     * bind-mounted over the workspace root and the harness is rewriting tool paths into it instead. That
     * fallback covers what arrives as tool input and not what a subprocess computes for itself, so the
     * operator needs to know — this state used to be one line in the daemon log at boot, and the way it got
     * noticed was files appearing in the main tree from agents that were supposed to be on branches. Repeated
     * on every emission, because it describes the turn and a client rebuilds its standing from the last frame.
     *
     * `sync` reports a rebase (agents/sync.ts) and rides here because this frame is already the turn's "where
     * you are standing" announcement. Present only when the branch was BEHIND the main line — `commits` is how
     * many main-line commits it gained, `blocked` names the repos whose rebase would not apply and was rolled
     * back. Both can be non-empty at once in a multi-repo composition. Two moments produce it: before the turn
     * starts, and after a card the turn parked on is answered — a question or a plan approval waits minutes
     * for a person, and the main line does not stop moving meanwhile. It is a notice and never a question: the
     * user is answering their agent, and the alternative to rebasing is not "stay safe" but "conflict at land
     * time", which interrupts them harder. */
    z.object({
        kind: z.literal("worktree"),
        branch: z.string(),
        base: z.string(),
        unenforced: z.boolean().optional(),
        sync: z.object({ commits: z.number(), blocked: z.array(z.string()) }).optional(),
    }),
    // Emitted after a clean isolated turn whose delta auto-landed (or failed to): landed ⇒ the work is now
    // UNCOMMITTED changes in the main tree (the Changes panel is the review); conflicts ⇒ it stayed safely in
    // the worktree, and each named path carries WHY it would not apply (see LandConflictSchema) so the report
    // can say whether the user's own copy is at risk or the main line simply moved on underneath the agent.
    // held ⇒ auto-land is off for this agent: nothing was applied and nothing failed — the delta is waiting
    // on the branch for a deliberate Land (landed is false, conflicts absent).
    // `deps` rides along when the landed delta left the main tree declaring dependencies it does not have —
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
    // The SDK's init handshake; carries the model it actually resolved for the turn.
    z.object({ kind: z.literal("init"), model: z.string() }),
    // The pre-turn workspace snapshot's id (the attribution-fence "user" capture), emitted once before the
    // provider stream so the client can offer "restore to before this message" on the turn's user bubble.
    // Absent on isolated turns (they snapshot nothing) and when the tree was already clean at turn start.
    /* The workspace checkpoint capturing the state as this turn FOUND it — what "go back to before this
     * message" restores. `index` is the message's position in the conversation's transcript, which the rewind
     * route addresses it by; absent on a turn with no conversation behind it (the bench, a one-shot), where
     * the id still powers a plain restore but there is no message to rewind to. */
    z.object({ kind: z.literal("checkpoint"), id: z.string(), index: z.number().int().nonnegative().optional() }),
    z.object({ kind: z.literal("delta"), text: z.string(), parentToolUseId: z.string().optional() }),
    // The prose block the `delta` frames were writing is finished. A turn emits several: the model says what
    // it is about to do, runs tools, reports what it found, runs more, then summarizes — each a separate text
    // block in the SDK stream. Without this boundary the client has no way to tell them apart and glues the
    // whole turn's narration into one paragraph run, so the client retires its current bubble here and lets
    // what follows (the tool calls this block introduced, or the next block of prose) open a fresh one.
    z.object({ kind: z.literal("text_end"), parentToolUseId: z.string().optional() }),
    z.object({ kind: z.literal("thinking"), text: z.string(), parentToolUseId: z.string().optional() }),
    // A tool call starting (or, for backends that only report completions, arriving whole). `content` carries
    // structured output known at call time — an Edit's diff is derived from its input, no result needed.
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
    // content/locations — both REPLACE the prior value (snapshot semantics, not append); absent ⇒ unchanged.
    z.object({
        kind: z.literal("tool_call_update"),
        id: z.string(),
        status: ToolCallStatusSchema.optional(),
        content: z.array(ToolCallContentSchema).optional(),
        locations: z.array(ToolCallLocationSchema).optional(),
    }),
    // The agent just started running Bash in its live `agent-<id>` tmux session — the client surfaces that
    // terminal in the global panel. One per turn (the session is reused across a turn's commands, incl. subagents').
    z.object({ kind: z.literal("terminal"), session: z.string() }),
    // The agent just used a browser tool — its Chromium is coming up (or already is) behind a watchable
    // `browser-<id>` session, and the client surfaces it in the same panel as the terminals. One per turn, for
    // the same reason: one browser serves every browser call the turn makes.
    z.object({ kind: z.literal("browser"), session: z.string() }),
    /* THE AGENT STARTED ANOTHER AGENT — an Agent/Task subagent, or a Codex/Grok CLI it drove from its own Bash
     * (see SubagentSessionSchema). One `subagent` frame per child, then `subagent_update` as it works: the same
     * call/update pair `tool_call`/`tool_call_update` uses, and for the same reason — the fields that move
     * (status, spend, what it is doing) arrive many times and must REPLACE, while the fields that identify it are
     * said once.
     *
     * `id` is the SPAWNING TOOL CALL's id — the same id the client already nests the child's inner frames under
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
        background: z.boolean().optional(),
        // A delegation's tmux session — the one live view a subagent doesn't have (SubagentSessionSchema).
        terminal: z.string().optional(),
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
    }),
    z.object({ kind: z.literal("todos"), items: z.array(TodoItemSchema) }),
    // The provider's own slash commands (ACP available_commands_update), replaced whole each time — the
    // composer's `/` popover lists them; invoking one is plain `/name …` prompt text (the ACP convention).
    z.object({ kind: z.literal("commands"), items: z.array(AgentCommandSchema) }),
    z.object({
        kind: z.literal("usage"),
        // The account that served this turn — the client attributes the totals to it (tagged by streamAgent).
        account: z.string().optional(),
        costUsd: z.number().optional(),
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        // Provider prompt-cache buckets for the turn: tokens served from cache (read) and written to cache
        // (creation). Optional per provider — Codex reports only cached input (read); runtimes/turns that
        // don't report a bucket omit it. Lets the client show cache hit rate = read / (read + input).
        cacheReadTokens: z.number().optional(),
        cacheCreationTokens: z.number().optional(),
        durationMs: z.number().optional(),
        numTurns: z.number().optional(),
    }),
    // The live gate: the provider's answer to "may this turn run", pushed mid-turn. Drives the rate-limited
    // notice, not the headroom readouts — see RateLimitInfoSchema.
    RateLimitInfoSchema.extend({ kind: z.literal("rate_limit_info"), account: z.string().optional() }),
    /* WHAT SPEED THIS TURN ACTUALLY RAN AT, and when it isn't the one asked for, why. Emitted only when the
     * answer CHANGES within a turn, so the ordinary case is one frame at init and nothing after it; a turn that
     * enters cooldown mid-flight (fast mode has its own rate-limit pool, separate from the model's) emits a
     * second.
     *
     * This frame exists because fast mode fails SILENTLY and for a lot of different reasons — the plan is free,
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
        // Absent when nothing is blocking fast mode — including on `state: "on"`, and on an `off` that simply
        // wasn't asked for.
        reason: z.string().optional(),
    }),
    /* The turn is alive but WAITING on the provider: a request failed transiently (5xx, 529, a dropped socket)
     * and the harness is retrying it inside this same turn. A status, not a failure — nothing has been lost and
     * the turn may still finish normally, so the client renders it where "thinking" goes rather than in the
     * transcript.
     *
     * It exists because the retry budget is deliberately long (see CLAUDE_CODE_RETRY_WATCHDOG in
     * harness-credentials.ts): a turn can now sit silent for minutes riding out an outage, and silence reads as
     * a hang. The one action a user takes against an apparent hang is Stop, which is the only action that
     * actually loses the work — so the wait has to be visible, with its own next-attempt clock.
     *
     * `attempt`/`maxAttempts` are the harness's own counters; `nextAttemptAt` (epoch ms) is when it will try
     * again, so the readout counts down instead of freezing on a number nobody can interpret. Optional because
     * only Claude's harness reports the delay: Codex says which attempt it is on and nothing else
     * (codex-agent.ts), and inventing a countdown for it would be a clock the retry never keeps. */
    z.object({
        kind: z.literal("provider_retry"),
        attempt: z.number(),
        maxAttempts: z.number(),
        nextAttemptAt: z.number().optional(),
        // The HTTP status behind it when there was one (529 reads as capacity, 500 as a fault — the client says
        // which). Absent for a transport failure that never got a response.
        status: z.number().optional(),
    }),
    // Every plan-limit pool for the account that served the turn, read from the CLI's usage endpoint once the
    // turn settles. `account` tags which Claude account it belongs to, so the client keys headroom by account;
    // absent on an env-token turn, which has no account to attribute it to. No `measuredAt` on the wire: both
    // readers stamp it on receipt, which is the read time to within the hop.
    z.object({ kind: z.literal("account_usage"), account: z.string().optional(), windows: z.array(UsageWindowSchema) }),
    ContextUsageSchema.extend({ kind: z.literal("context_usage") }),
    z.object({ kind: z.literal("compact"), trigger: z.string(), preTokens: z.number().optional(), postTokens: z.number().optional() }),
    // The three interactive cards. Each parks the turn until `POST /agent/reply` resolves its `requestId`.
    z.object({ kind: z.literal("plan"), requestId: z.string(), text: z.string() }),
    z.object({ kind: z.literal("question"), requestId: z.string(), questions: z.array(AskQuestionSchema) }),
    PermissionAskSchema.extend({ kind: z.literal("permission"), requestId: z.string() }),
    // The card above named by `requestId` is released — the user answered (or dismissed it, or the turn was
    // stopped out from under it), so the turn is executing again. Emitted by whoever parked, the moment its
    // waiter settles, because the park's END is otherwise invisible on this stream: nothing else here says
    // "that card is done", and it cannot be inferred from the next frame that happens along. Frames DO arrive
    // while a turn is parked — the pausing tool's own `tool_call` regularly trails its card (the SDK queues
    // stream messages while dispatching an in-process MCP tool straight off the transport), and a card raised
    // beside a parallel tool call sits through that tool's whole life. See agents-registry.ts, which reads
    // this pair as the fleet's "needs you" state.
    //
    // `reply` says HOW it settled, and is what a transcript rebuilt from this log freezes the card with: a
    // reload replays the run from seq 0 and a second window renders it live, so both would otherwise restore
    // the card pending — offering buttons on a requestId nothing holds any more, under a transcript that has
    // already moved on. It rides verbatim, exactly as the client POSTed it; absent, nobody answered (the turn
    // was stopped, or died under the card), which is not a decision and must not replay as one.
    z.object({ kind: z.literal("resolved"), requestId: z.string(), reply: AgentReplySchema.optional() }),
    // The turn's permission mode, whenever it changes — the user's pick at turn start, then every move the
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
                // Codex ran the turn but warned about it (fallback model metadata) — a notice, not a failure.
                "codex-advisory",
                "codex-reauth",
                // The Claude subscription credential is dead (revoked, or its refresh token rejected) and only a
                // reconnect fixes it. Distinct from "no account connected": the account IS there, so the UI can
                // offer reconnect where the user already is and replay the message that bounced.
                "claude-reauth",
                // The API refused this turn's token MID-FLIGHT — nearly always one superseded by a rotation,
                // which Anthropic retires the moment its successor is minted. Distinct from claude-reauth: the
                // account is fine and the daemon re-mints on the spot, so this is usually a notice about a turn
                // that is coming back rather than a request for the user to do anything. `autoResume` says
                // which of the two: "scheduled" means the re-mint-and-re-run is armed, and its absence means
                // nothing is coming (the turn was already a resume, or it ran on a credential with nothing to
                // re-mint from) — that is the case where reconnecting really is the fix.
                "claude-token-refused",
                // The model provider itself failed transiently — 500/502/503, a 529 at capacity, a dropped
                // socket — and the harness's own in-turn retries did not outlast it. Nothing about the workspace
                // or the request is wrong, so the daemon remembers the turn and re-runs it on an escalating
                // backoff (provider-health.ts): the frame is a notice about a turn that is coming back, and
                // reaches the client as a plain failure only once the attempts are spent.
                "provider-outage",
                // The harness read the message as a slash command it doesn't have, and discarded everything
                // after the name — the model never saw the message. Nothing was processed, so the client holds
                // the text back instead of leaving the user to retype it (same treatment as claude-reauth).
                "unknown-command",
                "grok-model-invalid",
                "codex-model-invalid",
                "subscription-required",
                "agent-busy",
            ])
            .optional(),
        // rate_limit only: when the exhausted window reopens (epoch seconds, from the stream's own
        // rate_limit_event or the account's persisted usage windows). Absent when the reset instant is unknown
        // (nothing to schedule against).
        resetsAt: z.number().optional(),
        // Where the daemon's resume of THIS turn stands, for the two codes that have one (provider-outage,
        // claude-token-refused). "scheduled" = the resume is armed and this turn comes back by itself;
        // "available" = the daemon remembered the failed turn and turning resumeAfterOutage on arms that same
        // resume, which is what the chat's offer banner hangs off — outage only, since a renewal is never gated
        // on a setting. Absent means there is nothing automatic to resume: a spent usage limit never has one,
        // and a refused credential has none once re-minting it has already been tried and failed.
        autoResume: z.enum(["scheduled", "available"]).optional(),
        /* provider-outage only: the shape of the wait. `retryAt` (epoch seconds) is when the next attempt is
         * due — not a fixed cadence, because an outage has no reset instant to aim at and hammering a provider
         * that is down only spends tokens on refusals, so each attempt waits longer than the last
         * (provider-health.ts owns the schedule).
         *
         * `attempt`/`maxAttempts` are on the wire so the notice can say the automation is BOUNDED. An
         * on-by-default retry that gives no account of how long it will keep going is the kind users switch off
         * defensively; one that says "attempt 2 of 6" is one they leave on. */
        outage: z.object({ retryAt: z.number(), attempt: z.number(), maxAttempts: z.number() }).optional(),
    }),
    z.object({ kind: z.literal("done") }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// The /agent/attach stream: a head frame identifying the run, then its AgentEvents stamped with their 1-based
// seq (the client's resume cursor), then `end` when the run is over — every frame delivered, nothing more
// coming. A stream that closes WITHOUT `end` was dropped mid-run; the client re-attaches with `after` = the
// last seq it holds. The head's `prompt`/`startedAt` let a window that didn't initiate the turn (a reload, a
// second window, another device) synthesize the user bubble and the elapsed readout; its `seq` is the log
// length at attach time — the replay/live boundary.
export const AttachFrameSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("attached"), run: z.string(), prompt: z.string(), startedAt: z.number(), seq: z.number() }),
    z.object({ kind: z.literal("frame"), seq: z.number(), event: AgentEventSchema }),
    z.object({ kind: z.literal("end") }),
]);
export type AttachFrame = z.infer<typeof AttachFrameSchema>;

/* WHAT A RESUMED TURN'S PROMPT SAYS IT IS. The daemon re-runs a turn something underneath it killed (turn-resume.ts)
 * by sending the original prompt again behind one of these sentences, so the model knows what interrupted it.
 *
 * They live on the wire rather than in the daemon because the CLIENT has to recognise them too: an attach head
 * carries the run's prompt verbatim, and a window joining a resumed run would otherwise render the note as a
 * message the USER wrote — the same words the user already said one run up, with a machine's preamble on them.
 * Recognising the prefix is what lets that window reuse the bubble that is already there instead. */
export const RESUME_NOTES = {
    auth: "The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically.",
    outage: "The model provider was briefly unavailable and interrupted this conversation; this turn resumed automatically.",
    restart: "The sandbox restarted while this turn was running, which stopped it, and this turn resumed automatically once it came back.",
} as const;

// The prompt a resume actually sends: the note, then why the words below are being repeated, then them.
export const withResumeNote = (prompt: string, note: string): string =>
    Object.values(RESUME_NOTES).some((known) => prompt.startsWith(known))
        ? prompt
        : `${note} The interrupted request is repeated below — where part of it was already completed in this session, continue from that point instead of starting over.\n\n${prompt}`;

// The user's own words inside a resumed prompt — the note and its explanation stripped back off. Returns the
// prompt unchanged when it is not a resume, so a caller can hand every attach head through it.
export const withoutResumeNote = (prompt: string): string => {
    const note = Object.values(RESUME_NOTES).find((known) => prompt.startsWith(known));
    return note === undefined ? prompt : prompt.slice(prompt.indexOf("\n\n") + 2);
};

// One parsed line from `intentic … --output ndjson` (engine events, provider `log`, the terminal `result`).
// Open-ended by design — the sandbox consumes the wire shape, not @intentic/engine's types — so a string
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
// the browser shows. A step that FAILED is still a step that finished — the boot chain is log-and-continue by
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
 * "listen first, converge behind the gate"), which is what stops a restart from reading as an outage — but it
 * also means the daemon spends the first seconds of every boot both reachable and unable to answer, and until
 * this frame existed the browser had no way to tell that apart from a healthy sandbox. It painted an operable
 * workspace off its persisted cache and then parked every request the user made against the readiness gate.
 *
 * The step list is declared UP FRONT and sent whole, pending entries included, so the browser can say "4 of 11,
 * loading the conversation registry" rather than "something is happening" — a boot that takes minutes has one
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
// browser remembers it per sandbox id and drops that sandbox's persisted query cache when it changes — a wiped
// and recreated workspace (cleanup.sh + reconnect keeps the same sandbox id) must not be painted from the
// previous workspace's cache. `build` is the same guard against a different axis: the daemon's own compiled
// tree, so an image update (or a `pnpm build:sandbox` swap in dev) drops what the browser cached from the
// PREVIOUS build instead of hydrating payloads the new one no longer shapes that way.
//
// It also advertises `routes` — the contract route names (`vpn.list`, `kimi.models`) this daemon actually
// implements, from ITS build of the contract. A browser is routinely newer than the daemon it talks to (a
// released app plane serves whatever image each user last pulled; in local dev the web app is always ahead of
// the last `pnpm build:sandbox`), and that stays fully supported — the browser just compares the two sets so a
// route the daemon predates surfaces as a named, explained gap instead of a bare 404 nobody can attribute.
//
// Every added field is optional: a daemon built before one simply says nothing, and the browser's fallback is
// the pre-existing behaviour — routes all assumed present, the daemon assumed ready, the cache left alone.
export const HelloSchema = z.object({
    kind: z.literal("hello"),
    workspaceId: z.string(),
    routes: z.array(z.string()).optional(),
    build: z.string().optional(),
    boot: BootProgressSchema.optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

// The FULL discovered repo set (sorted root-relative ids), pushed whenever it changes — a clone, a scaffold,
// or a deleted repo re-frames it. The watcher descent-ignores .git, so no workspaceChanged path pattern can
// detect a repo appearing; the daemon diffs its own discovery instead. Snapshot-not-diff, last frame wins.
export const ReposChangedSchema = z.object({ kind: z.literal("reposChanged"), repos: z.array(z.string()) });
export type ReposChanged = z.infer<typeof ReposChangedSchema>;

// A batch of workspace paths that just changed on disk (created/edited/deleted), pushed on the same /events
// stream as the heartbeat so the browser refreshes the tree + any open file live — the agent edits files
// out-of-band (its own Write/Edit/Bash tools), so there's no HTTP mutation to hang an invalidate on. Paths are
// root-relative, forward-slash (the tree/file route space). An empty array means "something changed, refetch the
// tree" — a burst too large to enumerate, or a reconnect recovery where we don't know what was missed.
export const WorkspaceChangedSchema = z.object({ kind: z.literal("workspaceChanged"), paths: z.array(z.string()) });
export type WorkspaceChanged = z.infer<typeof WorkspaceChangedSchema>;

/* THE REPOS WHOSE REFS JUST MOVED — a commit, a checkout, a branch or tag, a rebase started or aborted.
 *
 * A third push for the same reason as the two above, and the reason is structural: a repo's git dir does not
 * live under /work at all (it is relocated onto /history so an isolated turn's worktree can stand in for the
 * workspace root — see git/repo-git-dirs.ts), and the file watcher descent-ignores `.git` besides. So no
 * `workspaceChanged` path can ever say "a ref moved", and a surface built on the commit graph would otherwise
 * be exactly as fresh as the last thing the user clicked.
 *
 * It matters most for the work the user did NOT do: the agent commits, rebases and lands out-of-band, with no
 * HTTP mutation in any browser to hang an invalidation on. Ids are root-relative, "root" being the /work repo.
 * Diff-not-snapshot, unlike reposChanged: this names what moved, and a repo absent from a frame is a repo that
 * did not move rather than one that stopped existing. */
export const RefsChangedSchema = z.object({ kind: z.literal("refsChanged"), repos: z.array(z.string()) });
export type RefsChanged = z.infer<typeof RefsChangedSchema>;

// One connected browser tab of a sandbox member. Identity fields come from the caller's verified Google ID
// token; activity fields from the tab's own /system/presence reports. No timestamps on the wire — an entry's
// lifetime IS its /events connection's lifetime, so there is nothing to age out or compare clocks over.
export const PresenceUserSchema = z.object({
    // Per-CONNECTION id, minted by the browser for each /events attempt — never reused across reconnects.
    clientId: z.string(),
    email: z.string(),
    name: z.string().optional(),
    picture: z.string().optional(),
    idle: z.boolean(),
    // Route/view name the tab is on ("workspace", "automations", "ext:<id>/<key>", …).
    view: z.string().optional(),
    // The chat conversation the tab has active.
    sessionId: z.string().optional(),
    // The workspace file the tab has open (root-relative, forward-slash).
    path: z.string().optional(),
});
export type PresenceUser = z.infer<typeof PresenceUserSchema>;

// The FULL roster of connected members, broadcast on every change — snapshots, not diffs, so a reconnecting
// browser is consistent from its first frame and ordering never matters (last frame wins).
export const PresenceSchema = z.object({ kind: z.literal("presence"), users: z.array(PresenceUserSchema) });
export type Presence = z.infer<typeof PresenceSchema>;

// The FULL fleet roster, broadcast on every registry change — same snapshot-not-diff contract as presence:
// a reconnecting browser is consistent from its first frame. NOT simply "last frame wins", though: `rev` is the
// registry revision the snapshot was taken at, and the browser applies a frame only if it is newer than the one
// it already holds. Snapshots race two other sources of the same fact — an explicit GET /agents and the
// browser's own optimistic writes — and an unordered full replace lets the slowest of them win, which is how an
// archived card came back. See AgentsListSchema and useAgents.ts.
export const AgentsSchema = z.object({ kind: z.literal("agents"), agents: z.array(AgentSummarySchema), rev: z.number() });
export type Agents = z.infer<typeof AgentsSchema>;

// The /events stream union: the hello identity frame, then liveness heartbeats interleaved with boot progress,
// workspace-change batches, repo-set snapshots, ref-move batches, and presence + fleet roster snapshots. oRPC
// validates every yielded frame against this, so all kinds must live here.
export const SystemEventSchema = z.discriminatedUnion("kind", [
    HelloSchema,
    HeartbeatSchema,
    BootSchema,
    WorkspaceChangedSchema,
    ReposChangedSchema,
    RefsChangedSchema,
    PresenceSchema,
    AgentsSchema,
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;
