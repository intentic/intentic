import { z } from "zod";
import {
    AgentProviderSchema,
    AgentReplySchema,
    AgentSummarySchema,
    FastModeStateSchema,
    LandConflictSchema,
    MemberRoleSchema,
    PermissionModeSchema,
    RateLimitInfoSchema,
    ShareDetailSchema,
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

/* ONE PRICED SERVICE RUN, OFFERED — the card the daemon raises when the agent asks to run a premium service
 * (platform/service-offer.ts). Everything with a number on it is the PLATFORM's answer, relayed verbatim from
 * the catalog it serves the daemon: the model that asked contributes `request` (the JSON it wants sent) and
 * `why` (its one line of rationale), and nothing else — which is what makes the price on the card impossible
 * to misquote, and the click on it the only way the run can happen. */
export const ServiceOfferSchema = z.object({
    // The service, as the platform lists it: `<slug>` is what the run names, the rest is the catalog row.
    slug: z.string(),
    name: z.string(),
    publisher: z.string(),
    description: z.string(),
    creditsPerRun: z.number(),
    // The owner's meter as the platform stated it with the catalog — what "N left today" renders from. Absent
    // when the platform sent none (it answers a meter only to a member, and membership was already checked
    // before this card went up, so in practice it is present; the field stays honest about the wire).
    credits: z.object({ allowance: z.number(), remaining: z.number(), resetsAt: z.string() }).optional(),
    // The request body the agent wants forwarded, verbatim — shown so the owner can see what leaves.
    request: z.string(),
    // The agent's one-line case for spending — the only prose on the card that is the model's.
    why: z.string().optional(),
});
export type ServiceOffer = z.infer<typeof ServiceOfferSchema>;

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
// `image` is a PICTURE THE TOOL PRODUCED, carried as a workspace path rather than as bytes. Browser screenshots
// already live under .intentic/artifacts/browser, and provider-generated images are copied into
// .intentic/artifacts/imagegen, so the client fetches either from /workspace/raw like any other file. Base64 on
// the wire would bloat the event stream and every stored transcript to show bytes the workspace already serves;
// the path also keeps the picture openable afterwards. Root-relative, forward-slash: the same route space as
// ToolCallLocation.
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

/* ONE NOTE THE DAEMON PUT IN FRONT OF A USER'S MESSAGE, as both audiences see it: the model reads `text`, and
 * the chat draws `title` on a collapsed row that opens to that same `text`. Shared by the live frame and the
 * restored transcript so a note reads identically whether the tab watched it arrive or reopened an hour later. */
export const TurnNoteSchema = z.object({ title: z.string(), text: z.string() });
export type TurnNote = z.infer<typeof TurnNoteSchema>;

// One restored bubble. Each stored assistant message becomes its own, which is what reproduces the live
// interleaving — prose, the tool cards that prose introduced, then the next block of prose — rather than
// collapsing a turn's whole narration into a single bubble with its tools hanging off the end.
export const RestoredMessageSchema = z.object({
    /* `notice` is neither side of the conversation: it is something that HAPPENED to the turn, recorded so a
     * reopened session can say it. The one that matters is a refused turn — a provider that answers "your
     * organization has disabled Claude subscription access" produced no assistant text, so a transcript of the
     * two speakers alone ends on the user's message and the session reads as broken. It is the same muted line
     * the live client draws for the codes it does not turn red (ChatRole's `notice`). */
    role: z.enum(["user", "assistant", "notice"]),
    text: z.string(),
    /* WHEN THIS TURN WAS SENT, in epoch milliseconds (user rows only) — what the chat shows on the bubble it
     * belongs to. The turn's START, not the moment the record was written: a turn that ran for twenty minutes
     * was still sent when the user pressed send, and a stamp taken at settlement would say the conversation
     * happened at the times its answers finished.
     *
     * Only the user's row carries one, because it is the only row whose moment the daemon actually knows. A
     * turn's frames arrive with no clock of their own, so an assistant bubble could only ever be stamped with
     * the whole turn's start or end — a number that says nothing about when that particular block was written.
     * Rows recorded before this existed simply have none, and the chat draws nothing for them. */
    sentAt: z.number().optional(),
    // Files the user attached to this turn (user bubbles only) as workspace-relative paths, recovered from
    // the stored prompt's attachment note — so a reopened tab redraws chips, not the injected protocol text.
    attachments: z.array(z.string()).optional(),
    /* The checkpoint this message can be rewound to (user bubbles only), filled in when the transcript is read
     * back. Not stored in the record itself — it is looked up per read from the daemon's rewind points, which
     * a rewind rewrites — so a reopened tab offers exactly the turns that are still there to go back to. */
    checkpointId: z.string().optional(),
    thinking: z.string().optional(),
    tools: z.array(RestoredToolCallSchema).optional(),
    /* What the daemon added to this turn's message (user rows only) — the same notes the live `preamble` frame
     * carries, recovered from the stored prompt when the transcript is read back. The reader that strips them out
     * of the user's words is the one that hands them over here instead of dropping them on the floor.
     *
     * On the message rather than as a row of its own, and that is load-bearing twice: they ARE part of what was
     * sent, and a record row per turn preamble would break the one-row-per-bubble correspondence a branch counts
     * with (see the client's recordedRows — notices are drawn locally and never recorded). */
    notes: z.array(TurnNoteSchema).optional(),
});
export type RestoredMessage = z.infer<typeof RestoredMessageSchema>;

export const SessionTranscriptSchema = z.object({ messages: z.array(RestoredMessageSchema) });
export const AgentTranscriptSchema = SessionTranscriptSchema.extend({ sessionId: z.string().optional() });

/* WHAT A PUBLISHED CONVERSATION'S PAGE IS HANDED — the whole of it, baked into the page as one JSON block.
 *
 * A share has to keep working with nothing behind it: no daemon, no session, no sandbox that has to still be
 * running when the recipient finally opens the link. So the page carries its conversation rather than fetching
 * it, which also settles the security question by construction — a page with nothing to ask has no way to ask
 * for something it was not given.
 *
 * The messages are the SAME RestoredMessage rows the app replays a reopened tab from, already filtered to the
 * chosen detail level and with every picture path rewritten to the copy published beside the page. That
 * sameness is the point: the shared page renders them with the app's own components, so what a recipient sees
 * is what the owner saw. */
export const SharePayloadSchema = z.object({
    title: z.string(),
    // When the snapshot was taken, not when the conversation happened — see SharedConversation.sharedAt.
    sharedAt: z.number(),
    detail: ShareDetailSchema,
    messages: z.array(RestoredMessageSchema),
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;

/* THE THREE RESTORABLE CARDS, named so the turn journal can hold them verbatim: a parked turn's raised cards
 * are written down beside its prompt (sandbox turn-journal.ts), and a daemon death under the park restores the
 * very same frames instead of ending the turn `interrupted` — the card the user was about to answer survives
 * the restart that killed the process holding it. `browser_help` is deliberately not among them: the browser
 * session its card points at dies with the container, so that park cannot be restored, only reported. */
const PlanCardSchema = z.object({ kind: z.literal("plan"), requestId: z.string(), text: z.string() });
const QuestionCardSchema = z.object({ kind: z.literal("question"), requestId: z.string(), questions: z.array(AskQuestionSchema) });
const PermissionCardSchema = PermissionAskSchema.extend({ kind: z.literal("permission"), requestId: z.string() });
export const ParkedCardSchema = z.discriminatedUnion("kind", [PlanCardSchema, QuestionCardSchema, PermissionCardSchema]);
export type ParkedCard = z.infer<typeof ParkedCardSchema>;

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
    /* WHAT THE DAEMON ADDED TO THE USER'S MESSAGE before the model read it — the exact words, not a summary of
     * them.
     *
     * A turn's prompt is not only what was typed: the daemon prepends notes the model needs and the user did not
     * write (agent/turn-preamble.ts owns the list — a rebase that moved the branch, dependencies that are behind,
     * workspace context retrieved for this very message, where an unenforced runtime's files really live). Those
     * notes change what the agent does, and for a long time the chat's only trace of any of them was one muted
     * line paraphrasing the rebase — so a user watching an agent act on instructions they could not see had no
     * way to find out what those instructions said. This frame is the fix: the note text verbatim, one entry per
     * note, rendered collapsed so it costs a click rather than a scroll.
     *
     * `title` is the note's own opening header, which is what the stripper already anchors on — so the two
     * cannot drift, and a note nobody thought to title cannot reach the wire unlabelled.
     *
     * ONE MOMENT, always: the notes went in front of the user's own message before the turn started, so they hang
     * off that message and are stored on it, which is how a reopened tab still has them. Nothing is injected into
     * a RUNNING turn — the rebase taken while a card sat waiting was the only thing that ever was, and it no
     * longer says anything to the model at all (agent/turn-preamble.ts). */
    z.object({ kind: z.literal("preamble"), notes: z.array(TurnNoteSchema) }),
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
    // The four interactive cards. Each parks the turn until `POST /agent/reply` resolves its `requestId`.
    PlanCardSchema,
    QuestionCardSchema,
    PermissionCardSchema,
    // The agent's browser needs a person: it parked mid-sign-in on something it cannot clear itself (a captcha,
    // a password it does not hold, a phone check). `session` names the browser session on /browsers — the card's
    // one action is going THERE, where the live stage and Take control already are; the Browsers banner and this
    // card resolve the same requestId. `account` is the capability the sign-in is for, so the card can say whose
    // login is stuck even after the browser has navigated somewhere unrecognizable.
    z.object({
        kind: z.literal("browser_help"),
        requestId: z.string(),
        session: z.string(),
        account: z.string(),
        message: z.string(),
    }),
    /* A premium service run awaiting the owner's click. Raised OUTSIDE the turn generator — the daemon's
     * services route parks the agent's own `services run` call and pushes this frame into the live run
     * (platform/service-offer.ts) — so unlike the four cards above it is not journalled for restore: its
     * waiter is the CLI's held connection, which dies with the daemon, and a restored card would offer
     * buttons nothing is waiting behind. Settles through the same `POST /agent/reply` as every other card. */
    z.object({ kind: z.literal("service_offer"), requestId: z.string(), offer: ServiceOfferSchema }),
    /* How an approved run ended, pushed after the platform answered so the card can settle as a receipt
     * rather than a promise: `ok` served and charged, `refunded` failed to answer and charged nothing,
     * `refused` the platform said no after the click (a raced-out allowance). `remaining` is the meter after,
     * when the platform stated one. Skip needs no receipt — nothing happened, and `resolved` already says so. */
    z.object({
        kind: z.literal("service_receipt"),
        requestId: z.string(),
        outcome: z.enum(["ok", "refunded", "refused"]),
        credits: z.number(),
        remaining: z.number().optional(),
    }),
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
                /* THE ACCOUNT IS FINE AND STILL NOT ALLOWED TO RUN — an Anthropic organization that has turned
                 * Claude Code off for this seat. The token authenticates, the plan's own usage endpoint answers
                 * with real pools, and every turn is refused anyway, which is why it is its own code rather than
                 * a member of either neighbour: a spent allowance comes back on a clock and a refused credential
                 * comes back on a re-mint, and NEITHER of those is true here. Only an admin re-enabling access
                 * is, so nothing is re-run and nothing asks the user to reconnect — the one recovery that looks
                 * plausible and is guaranteed to waste their time. */
                "claude-not-entitled",
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
         * `attempt`/`maxAttempts` are on the wire so the notice can say the automation is BOUNDED. A retry that
         * gives no account of how long it will keep going is the kind users switch back off the week they turn
         * it on; one that says "attempt 2 of 6" is one they leave on. */
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
// The instruction the three whole-turn re-runs share: what follows the note is the original request, repeated.
// `answered` deliberately does not carry it — what follows THAT note is not a repetition but the user's answer,
// and telling the model to "continue from that point instead of starting over" about words it has never seen
// is how a resume reads as the user contradicting themselves.
const REPEATED =
    "The interrupted request is repeated below — where part of it was already completed in this session, continue from that point instead of starting over.";
export const RESUME_NOTES = {
    auth: `The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically. ${REPEATED}`,
    outage: `The model provider was briefly unavailable and interrupted this conversation; this turn resumed automatically. ${REPEATED}`,
    restart: `The sandbox restarted while this turn was running, which stopped it, and this turn resumed automatically once it came back. ${REPEATED}`,
    // A turn that was PARKED on the user when the daemon died: nothing re-runs at boot — the card is restored
    // instead, and this is the turn their answer starts (turn-resume.ts). What rides below the note is the
    // answer itself, so the model picks the session back up at exactly the decision it had handed over.
    answered:
        "The sandbox restarted while this conversation was waiting for the user to respond; it is back, and their response follows below — continue from where the session left off.",
} as const;

// The prompt a resume actually sends: the note (each carries its own account of what the words below are),
// then them.
export const withResumeNote = (prompt: string, note: string): string =>
    Object.values(RESUME_NOTES).some((known) => prompt.startsWith(known)) ? prompt : `${note}\n\n${prompt}`;

// The user's own words inside a resumed prompt — the note and its explanation stripped back off. Returns the
// prompt unchanged when it is not a resume, so a caller can hand every attach head through it.
export const withoutResumeNote = (prompt: string): string => {
    const note = Object.values(RESUME_NOTES).find((known) => prompt.startsWith(known));
    return note === undefined ? prompt : prompt.slice(prompt.indexOf("\n\n") + 2);
};

export type ResumeReason = keyof typeof RESUME_NOTES;

/* HOW A RESUMED TURN READS TO THE PERSON — the same interruption the note above tells the model, said in the
 * transcript's own voice instead.
 *
 * Stripping the note out of the user's words is only half the job, and for years it was the only half anyone
 * did: what a reopened conversation showed was a paragraph of machine prose stapled to the front of a message
 * the user had already sent once, directly under their own copy of it. Both halves of that are wrong — it was
 * never their sentence, and the words under it are a REPEAT rather than something new they said.
 *
 * So the two shapes below, which is the whole of what a reader has to be told:
 *
 * `notice` — the three whole-turn re-runs. The words under the note are already in the transcript one turn up,
 * so the repeat is dropped entirely and the interruption takes its place as a muted line, sitting with the
 * failure line it resolves ("Failed to authenticate…") and reading like every other thing that HAPPENED to a
 * turn rather than like something anybody typed.
 *
 * `note` — the answered case, where what rides under the note is the user's actual answer to a card and belongs
 * in the transcript as their words. Nothing is dropped; the explanation rides that message as a collapsed row,
 * the same disclosure every other daemon-written note gets (TurnNote). */
export type ResumeDisclosure = { readonly kind: "notice"; readonly text: string } | { readonly kind: "note"; readonly note: TurnNote };

const RESUME_DISCLOSURES: Record<ResumeReason, ResumeDisclosure> = {
    auth: { kind: "notice", text: "Claude sign-in renewed — this turn picked up where it left off." },
    outage: { kind: "notice", text: "The model provider came back — this turn picked up where it left off." },
    restart: { kind: "notice", text: "The sandbox came back — this turn picked up where it left off." },
    answered: { kind: "note", note: { title: "Picked back up after a sandbox restart", text: RESUME_NOTES.answered } },
};

// What a stored prompt's resume note should be SHOWN as; undefined when the prompt is not a resume at all, so
// every reader of a stored prompt can ask without first testing whether it is one.
export const resumeDisclosure = (prompt: string): ResumeDisclosure | undefined => {
    const reason = (Object.keys(RESUME_NOTES) as ResumeReason[]).find((key) => prompt.startsWith(RESUME_NOTES[key]));
    return reason === undefined ? undefined : RESUME_DISCLOSURES[reason];
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
// `shapes` answers the half `routes` structurally cannot: a route BOTH builds have, whose payload changed
// between them. Names match, so nothing 404s — the call goes out and a field the browser expects is simply
// missing from the answer. It is a map of route name → a fingerprint of that route's input and output schema
// (see routes.ts), so a difference is a named route rather than "something, somewhere, moved". Beside `routes`
// rather than folded into it: existence covers every route, shape covers only the ones that can be expressed.
//
// Every added field is optional: a daemon built before one simply says nothing, and the browser's fallback is
// the pre-existing behaviour — routes all assumed present, shapes all assumed to agree, the daemon assumed
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

/* WHICH RUNNING THINGS JUST MOVED — a session opened or exited, a dev server bound its port, a browser closed,
 * a subagent reported in.
 *
 * The fourth push, and the one that covers what the other three structurally cannot: none of this state is on
 * disk, so no `workspaceChanged` path can name it, and none of it is a ref or a repo. Before it, every view of a
 * running thing polled on its own timer — which is to say each browser asked, forever, a question only the
 * daemon could answer and almost always answered "no change".
 *
 * Diff-not-snapshot, and deliberately thin: the frame carries the DOMAIN that moved, never the roster itself.
 * Invalidation only reaches a query something is observing, so a tab showing none of these pays a frame and no
 * request — whereas a roster on the wire would bill every connected browser the full list whether or not
 * anything on screen renders it. Which query keys a domain stands for is runtime-state.ts's table. */
export const RuntimeChangedSchema = z.object({ kind: z.literal("runtimeChanged"), domains: z.array(z.string()) });
export type RuntimeChanged = z.infer<typeof RuntimeChangedSchema>;

// One connected browser tab of a sandbox member. Identity fields come from the caller's verified Google ID
// token; activity fields from the tab's own /system/presence reports. No timestamps on the wire — an entry's
// lifetime IS its /events connection's lifetime, so there is nothing to age out or compare clocks over.
export const PresenceUserSchema = z.object({
    // Per-CONNECTION id, minted by the browser for each /events attempt — never reused across reconnects.
    clientId: z.string(),
    email: z.string(),
    name: z.string().optional(),
    picture: z.string().optional(),
    // The caller's trust tier, resolved by the authorizer at connection time. On the roster so every member
    // can see who may do what — and so a tab knows its OWN role without an owner-only lookup.
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
// workspace-change batches, repo-set snapshots, ref-move batches, runtime-domain nudges, and presence + fleet
// roster snapshots. oRPC validates every yielded frame against this, so all kinds must live here.
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
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;
