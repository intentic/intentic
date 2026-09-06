import { z } from "zod";
import { PermissionModeSchema } from "../schemas/agent.js";
import { LandConflictSchema } from "../schemas/agents.js";
import { RateLimitInfoSchema } from "../schemas/claude-gate.js";
import { FastModeStateSchema } from "../schemas/fast-mode.js";
import { AgentReplySchema, UsageWindowSchema } from "../schemas/plan-limits.js";
import { SubagentKindSchema, SubagentStatusSchema, SubagentVerificationSchema } from "../schemas/terminal.js";
import { AgentCommandSchema, browserHelpCard, capabilityOfferCard, CapabilityOutcomeSchema, ContextUsageSchema, credentialOfferCard, CredentialReceiptSchema, paymentOfferCard, PaymentReceiptSchema, PermissionCardSchema, PlanCardSchema, QuestionCardSchema, serviceOfferCard, ServiceReceiptSchema, ServiceStreamEventSchema, terminalHelpCard, TodoItemSchema, ToolCallContentSchema, ToolCallLocationSchema, ToolCallStatusSchema, ToolKindSchema } from "./cards.js";
import { TranscriptPatchSchema, TranscriptRowSchema, TurnNoteSchema } from "./transcript.js";

/* EVERY FRAME AN AGENT TURN STREAMS, as one `kind`-discriminated union, plus the two views of it the readers
 * need: the FACTS about the turn (which session, where it stands, what it cost) and the attach stream a window
 * joins a running turn through.
 *
 * The union is long and stays one file on purpose: it is a single closed vocabulary, and a seam through the
 * middle of it would be a place for two halves to disagree about what a frame is. */

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
     * out, because the explanation was optional and the card must not wait for a one-shot helper rung that might
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
                /* THE MODEL IS REAL, LISTED, AND NOT THIS PLAN'S TO RUN. A routed provider's catalog is the set
                 * the vendor publishes, not the set the connected subscription pays for, so a picker row can be
                 * a model the upstream refuses on sight ("Your current subscription does not have access to
                 * kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.").
                 *
                 * Its own code because every neighbour's recovery is wrong for it. It is not `provider-outage`,
                 * though that is what it wore: the translator answers a refused model with a 503, the harness
                 * reads a 5xx as an outage, and rides it out for the whole in-turn retry budget — two minutes of
                 * a spinner for a request that was refused in five milliseconds and will be refused identically
                 * forever, followed by an auto-resume schedule for a turn that cannot come back. It is not
                 * `*-model-invalid` either: nothing is misspelled and reloading the catalog re-offers the same
                 * row, because the vendor really does serve it — to somebody else.
                 *
                 * What changes the outcome is picking another model or buying the plan, so the sentence is the
                 * upstream's own (it names the tier), the client holds the words, and the daemon files the model
                 * as refused so the picker stops offering it (usage/model-refusals.ts). */
                "model-unavailable",
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
