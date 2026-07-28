import { ExtensionManifestSchema } from "@intentic/extension-api";
import { z } from "zod";

// All request/response wire schemas for the sandbox daemon. Inputs that carry a `{param}` in their route path
// (repo / id / name) merge the path param into the same flat object — oRPC fills the path placeholder from the
// matching key and routes the rest to the body (POST/PUT) or query (GET).

// ---- shared ----

// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({ ok: z.literal(true) });

// Which repo a git route targets: "root" (the /work workspace repo) or a repo id — the repo's root-relative
// dir, which may be nested ("clients/foo"; URL-encoded in the path param). Kept as a bare string on the wire
// (not an enum) so an unknown repo is a handler-thrown NOT_FOUND — matching the daemon's prior 404 — rather
// than an input-validation rejection.
export const RepoParamSchema = z.object({ repo: z.string() });

// ---- agent ----

export const SessionTranscriptMessageSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });
export type SessionTranscriptMessage = z.infer<typeof SessionTranscriptMessageSchema>;

// The agent runtimes the daemon can serve — the vocabulary every surface that picks an agent shares (chat
// turns, automations). The NATIVE providers have dedicated adapters (and their ids are reserved); any
// other value is the id of an installed `agent`-kind capability served over ACP (Agent Client Protocol).
// Kept as a bare string on the wire (not an enum) so an unknown id is a clean error frame from the agent
// route — the same bet RepoParamSchema makes — and adding an ACP agent needs no contract change.
export const NATIVE_PROVIDERS = ["claude", "codex", "grok", "kimi", "gemini"] as const;
export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];
export const AgentProviderSchema = z.string().min(1);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

// The harness (agentic loop) a turn runs on, orthogonal to the provider. See AgentTurnSchema.harness.
export const AgentHarnessSchema = z.enum(["native", "claude-code"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;

// What the user is looking at in the editor, attached to a turn only when they explicitly opt in (the
// composer chip — off by default). The daemon folds it into the prompt as a context note, so deictic
// prompts ("fix this") resolve without an @-mention. Selection is bounded — it's context, not an upload.
export const EditorContextSchema = z.object({
    // Workspace-relative path of the file open in the editor.
    file: z.string().min(1),
    // 1-based line range of the selection; absent when the whole file is the context.
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    // The selected text itself, truncated client-side to the cap.
    selection: z.string().max(20_000).optional(),
});
export type EditorContext = z.infer<typeof EditorContextSchema>;

// The client-minted stable conversation identity. Constrained because it lands in branch names (agent/<id>)
// and filesystem paths — the regex is the injection guard. Shared by the turn input and the attach input.
const ConversationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

// Where a conversation came from when nobody typed it into the browser: an automation wake carrying a message
// from OUTSIDE the sandbox (a Discord mention, a web-chat visitor, a webhook). Such a wake runs as an ordinary
// isolated conversation — registry entry, worktree, chat tab, land flow — and this is the only thing that
// distinguishes it on the surface: the card's provenance line and the reason its first prompt is not the
// user's. Set daemon-side by the dispatcher that received the message; the browser never sends one.
export const AgentOriginSchema = z.object({
    // The automation whose configured prompt opened the conversation.
    automationId: z.string(),
    // The listener provider that received the message ("discord", "webchat", …) or "webhook" for an event
    // trigger. An open string for the same reason Trigger.provider is: sources are extension-declared.
    provider: z.string(),
    // The external thread it arrived on — a Discord channel id, a widget conversation id. Absent for webhooks.
    channelId: z.string().optional(),
    // Who sent it, as the source names them.
    author: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

// How tool calls are gated — the Claude Agent SDK's PermissionMode, narrowed to the four the composer offers
// (the SDK also has 'dontAsk'/'auto', which have no UI here). The user picks one per turn AND the agent can
// move itself between them mid-turn, so this is both a turn input and the payload of the `mode` frame.
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const AgentTurnSchema = z
    .object({
        prompt: z.string(),
        // The client's display title for the conversation — seeds a FRESH registry entry (so a renamed draft's
        // first turn keeps its user-chosen title); an existing entry's title always wins.
        title: z.string().max(80).optional(),
        // Workspace-relative paths of files the user attached, already uploaded via /workspace/upload
        // (the browser puts them under .intentic/attachments/<uuid>/<name>). The daemon hands them to the
        // provider: Claude reads them from disk via its Read tool; Codex gets images as native inputs.
        attachments: z.array(z.string().min(1)).max(20).optional(),
        // Which provider (model + account) serves the turn; absent = claude. A sessionId only resumes on the
        // provider that minted it (Claude Code sessions vs Codex threads vs Grok/OpenCode sessions are separate
        // stores) — a mid-conversation provider/account/harness switch sends `history` instead of resuming.
        agent: AgentProviderSchema.optional(),
        // Which harness (agentic loop) runs the turn, orthogonal to the provider above. Absent = "native": each
        // provider on its own runtime (Claude Code SDK / Codex CLI / opencode) with its subscription OAuth.
        // "claude-code" forces the Claude Code Agent SDK loop for ANY provider — codex/grok then drive their model
        // through the sandbox's bundled Anthropic↔OpenAI translator, which needs that provider's API key (its
        // subscription OAuth can't reach a gateway). For the claude provider the two are identical.
        harness: AgentHarnessSchema.optional(),
        // Which connected account of that provider serves the turn; absent = the provider's first account.
        account: z.string().optional(),
        sessionId: z.string().optional(),
        // The client-minted stable conversation identity (survives provider/account/harness switches, which
        // retire sessions). Keys the fleet registry entry, the conversation's worktree, and the turn run.
        conversationId: ConversationIdSchema.optional(),
        // When true, the turn runs in the conversation's isolated git worktree (created lazily on first use)
        // instead of the shared /work tree — the parallel-agents mode. Requires conversationId.
        isolated: z.boolean().optional(),
        // Set ONLY by the daemon's own automation dispatchers: this turn opens a conversation on behalf of an
        // outside message rather than a user. Recorded on the registry entry so the fleet can say where the
        // agent came from. Requires conversationId — there is nothing to record it on otherwise.
        origin: AgentOriginSchema.optional(),
        // The client-held transcript of a conversation that just switched provider/account: seeds the FIRST
        // turn of the replacement session. The daemon folds it into the prompt as one role-attributed context
        // preamble for every runtime. Mutually exclusive with sessionId — a resumed session has its context.
        history: z.array(SessionTranscriptMessageSchema).max(200).optional(),
        // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
        model: z.string().optional(),
        // How tool calls are gated for this turn (the SDK's permissionMode, verbatim). 'plan' runs the
        // propose → approve → execute flow; 'default' prompts per tool on the permission side channel;
        // 'acceptEdits' auto-accepts file edits; 'bypassPermissions' runs everything. The agent can move
        // itself between modes mid-turn (EnterPlanMode/ExitPlanMode), which rides back as a `mode` frame.
        permissionMode: PermissionModeSchema.optional(),
        effort: z.string().optional(),
        thinking: z.boolean().optional(),
        // The opt-in editor context chip: what the user is looking at, folded into the prompt daemon-side.
        editorContext: EditorContextSchema.optional(),
    })
    // An attachment-only send (no text) is legal; an entirely empty turn is not.
    .refine((turn) => turn.prompt.trim().length > 0 || (turn.attachments?.length ?? 0) > 0, {
        message: "prompt or attachments required",
    })
    .refine((turn) => turn.sessionId === undefined || turn.history === undefined, {
        message: "history and sessionId are mutually exclusive",
    })
    .refine((turn) => turn.isolated !== true || turn.conversationId !== undefined, {
        message: "isolated requires conversationId",
    })
    .refine((turn) => turn.origin === undefined || turn.conversationId !== undefined, {
        message: "origin requires conversationId",
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

// POST /agent's ack: the daemon-minted id of the detached turn run it started. The turn executes daemon-side
// regardless of any client connection; every window — the initiator included — renders it via /agent/attach.
export const StartedTurnSchema = z.object({ run: z.string() });
export type StartedTurn = z.infer<typeof StartedTurnSchema>;

// Attach to a conversation's turn run (live, or finished within the retention window). `run`+`after` is the
// resume cursor of a client whose stream dropped: frames after `after` replay when `run` still names the
// current run; a mismatch (a newer turn started meanwhile) replays that run from its first frame instead.
export const AttachTurnSchema = z.object({
    conversationId: ConversationIdSchema,
    run: z.string().optional(),
    after: z.number().int().min(0).optional(),
});
export type AttachTurn = z.infer<typeof AttachTurnSchema>;

// ---- agents: the parallel-conversation fleet ----
// A "fleet agent" is a conversation with a registry entry — every isolated conversation, keyed by its
// conversationId. Isolated ones own a git worktree (branch agent/<id> in every workspace repo); the fleet
// surface shows all of them with live status/activity/cost so the user can drive N agents in parallel.

// idle/running/awaiting are the turn lifecycle (awaiting = paused on a plan approval or question); landed /
// conflict are outcomes of the land flow; error is a terminal turn failure surfaced on the card.
export const AgentStatusSchema = z.enum(["idle", "running", "awaiting", "landed", "conflict", "error"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
// The card's live activity snippet: the last tool the agent used (with its target) and the in-progress todo.
export const AgentActivitySchema = z.object({
    tool: z.string().optional(),
    target: z.string().optional(),
    todo: z.string().optional(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;
// Which "needs you" flags are raised — the fleet badge aggregates these across all agents.
export const AgentAttentionSchema = z.object({
    plan: z.boolean(),
    question: z.boolean(),
    permission: z.boolean(),
    conflict: z.boolean(),
});
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;
export const AgentSummarySchema = z.object({
    // The conversationId.
    id: z.string(),
    sessionId: z.string().optional(),
    // First prompt, sanitized to one bounded line.
    title: z.string().optional(),
    status: AgentStatusSchema,
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    model: z.string().optional(),
    account: z.string().optional(),
    // The worktree branch (agent/<id>); absent for a non-isolated (main-tree) conversation.
    branch: z.string().optional(),
    // Present when the conversation was opened by an outside message rather than by the user (see
    // AgentOriginSchema) — the card's provenance line. Absent ⇒ the user started it.
    origin: AgentOriginSchema.optional(),
    // The ROOT repo's short base sha — the checkout moment's display identity. Per-repo bases stay
    // daemon-internal (agents.diff already reports against them).
    base: z.string().optional(),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    contextTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    activity: AgentActivitySchema.optional(),
    // Present while a turn runs: its start, ms since epoch.
    startedAt: z.number().optional(),
    updatedAt: z.number(),
    // When the agent was last OPENED, ms since epoch — the unread badge's reference point (`updatedAt >
    // seenAt` ⇒ the agent has done something you haven't looked at). Absent ⇒ never opened. Daemon-side on
    // purpose: read state is a fact about the WORK, not about one browser profile, so clearing site data or
    // picking up the phone must not resurrect every badge.
    seenAt: z.number().optional(),
    attention: AgentAttentionSchema,
    // Completed turns and lifetime tool calls — the card's msgs/tools counters.
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    // The agent's cumulative output (base → branch tip across every repo), refreshed on each land —
    // the card's "12 files · +412 −96" readout. Independent of what has landed.
    diff: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }).optional(),
    // When the agent was ARCHIVED (ms epoch) — off the board, but nothing lost: its checkout was retired
    // (worktree removed) while the agent/<id> branch, the transcript, and every counter stayed. Absent ⇒ live
    // on the board. Archived agents are excluded from the roster the fleet renders; `agents.archived` lists
    // them, `agents.unarchive` brings one back, and the next turn re-attaches its worktree from the branch.
    archivedAt: z.number().optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
// `rev` is the registry revision this roster was read at — a counter the daemon bumps on every registry change.
// It is what makes the browser's optimistic writes safe: the fleet is published as full snapshots (last frame
// wins), so without an ordering stamp a roster READ before a mutation but delivered after it silently puts the
// mutated agents back. The browser drops any roster older than the newest it has applied, and holds its own
// pending change until a roster at or past the revision that applied it arrives. See useAgents.ts.
export const AgentsListSchema = z.object({ agents: z.array(AgentSummarySchema), rev: z.number() });
export const AgentIdSchema = z.object({ id: z.string().min(1) });
// archive's input: the agents to take off the board. Absent `ids` ⇒ every finished agent that is archivable
// right now (the lane header's "Clear"); unarchive always names its ids (a restore, or a bulk archive's undo).
export const AgentArchiveSchema = z.object({ ids: z.array(z.string().min(1)).max(500).optional() });
export const AgentIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
// What actually MOVED, and deliberately NOT the roster afterwards. Two archives in flight at once each finish
// holding a full-roster snapshot from a different instant, so a client that swapped one in wholesale would let
// the slower response resurrect what the faster one just filed away — a delta composes where a snapshot races.
// Whole summaries rather than ids because the receiving side has to SHOW them (the archive list, and the agent
// detail page addressed by id); the ids "Undo" needs come off them for free.
// The agents an archive/unarchive actually moved, plus the registry revision that applied the move — the
// browser holds its optimistic add/remove of exactly these ids until it sees a roster at or past `rev`.
export const AgentsMovedSchema = z.object({ moved: z.array(AgentSummarySchema), rev: z.number() });
export type AgentsMoved = z.infer<typeof AgentsMovedSchema>;
// rename's input: the user-chosen display title (bounded like sanitizeTitle's cap).
export const AgentRenameSchema = z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(80) });
export const AgentFileDiffQuerySchema = z.object({ id: z.string().min(1), repo: z.string().min(1), path: z.string().min(1) });
/* WHY a path would not land. The distinction is the whole difference between an actionable report and a dead
 * end, because the three have nothing in common but their symptom:
 *   `workspace` — you have uncommitted edits on that path. Yours is the copy at risk; commit or stash it.
 *   `diverged`  — the main tree's COMMITTED content moved under the agent since it branched. Nothing of
 *                 yours is at risk; the agent's delta is simply written against an older file.
 *   `binary`    — git cannot three-way merge the file at all, so no automatic resolution exists.
 * The old report named only the first, which is the rarest of the three. */
export const LandConflictReasonSchema = z.enum(["workspace", "diverged", "binary"]);
export type LandConflictReason = z.infer<typeof LandConflictReasonSchema>;
export const LandConflictPathSchema = z.object({ path: z.string(), reason: LandConflictReasonSchema });

/* land's outcome, per repo of the composition. `paths` is the set that genuinely failed to apply — NOT the
 * whole delta, which is what the first version reported whenever it could not pin the cause down, turning
 * four real conflicts into a wall of fourteen. `clean` counts what would land regardless, so the UI can say
 * how much is being held back by how little, and offer to take it. An empty `paths` with `clean: 0` is the
 * repo-unavailable case: the main checkout is gone, and no path-level account exists. */
export const LandConflictSchema = z.object({
    repo: z.string(),
    paths: z.array(LandConflictPathSchema),
    clean: z.number(),
});
export type LandConflict = z.infer<typeof LandConflictSchema>;

// land's outcome; landed only when every repo with changes applied cleanly. Conflicted repos keep their
// worktree state — nothing is lost, and "Land now" stays available. `resolving` is populated only by a
// `merge` land: the paths written into the workspace carrying conflict markers, which the user finishes by
// hand in their own editor exactly as they would any merge.
export const LandResultSchema = z.object({
    landed: z.boolean(),
    conflicts: z.array(LandConflictSchema).optional(),
    resolving: z.array(z.object({ repo: z.string(), paths: z.array(z.string()) })).optional(),
});
export type LandResult = z.infer<typeof LandResultSchema>;

/* land's input. `check` is the safe default and the historical behaviour: the delta is applied only if ALL of
 * it applies, so a refusal leaves the workspace byte-identical. `merge` is the escape hatch the conflict
 * report offers — a three-way apply that lands every clean path and leaves the rest with conflict markers to
 * resolve in place. It is opt-in because it WRITES on failure, which is the one thing `check` promises not
 * to do. */
export const LandModeSchema = z.enum(["check", "merge"]);
export type LandMode = z.infer<typeof LandModeSchema>;
export const AgentLandSchema = z.object({ id: z.string().min(1), mode: LandModeSchema.optional() });

// ---- routed-provider subscriptions ----

// The providers whose model can run UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
// which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. The `claude` provider is
// absent — native Anthropic OAuth serves it directly, without the translator. Codex and Grok also have a native
// runtime and so carry the harness axis; `gemini` is routed-only (Google publishes no Anthropic-protocol
// endpoint and this sandbox bakes no Gemini runtime), so a Gemini turn is always a Claude Code turn.
export const KeyedProviderSchema = z.enum(["codex", "grok", "gemini"]);
export type KeyedProvider = z.infer<typeof KeyedProviderSchema>;

// Which routed-provider subscriptions are connected in the translator (per provider). Drives the
// "connected / connect subscription" state in Sandbox ▸ Agent.
export const TranslatorAccountsSchema = z.object({ codex: z.boolean(), grok: z.boolean(), gemini: z.boolean() });
export type TranslatorAccounts = z.infer<typeof TranslatorAccountsSchema>;

// The side-channel body that un-parks a turn waiting on the user. Every interactive card — plan approval,
// clarifying questions, a per-tool permission prompt — parks on the SAME registry keyed by `requestId`, so
// one route resolves all three; the `kind` says which card answered and carries its payload.
export const AgentReplySchema = z.discriminatedUnion("kind", [
    // ExitPlanMode approval. `mode` is the posture to execute the approved plan in — auto-accept edits
    // (acceptEdits), approve each one (default), or run everything (bypassPermissions); it rides back to the SDK
    // as a session setMode. Absent, the turn returns to the posture it STARTED in, so an agent that put itself
    // into plan mode does not cost the user the permissions they granted. Rejection feedback loops back into the
    // model as the denial reason.
    z.object({
        kind: z.literal("plan"),
        requestId: z.string().min(1),
        approve: z.boolean(),
        mode: PermissionModeSchema.optional(),
        feedback: z.string().optional(),
    }),
    // AskUserQuestion picks: question text → chosen option label(s) (+ any free-text "Other"). `cancelled`
    // is the dismissal, which tells the model to proceed on sensible defaults rather than leaving it parked.
    z.object({
        kind: z.literal("question"),
        requestId: z.string().min(1),
        answers: z.record(z.string(), z.array(z.string())).optional(),
        cancelled: z.boolean().optional(),
    }),
    // A per-tool permission prompt. 'once' allows this call only; 'always' allows the whole TOOL for the rest
    // of the session (plus the SDK's own narrower suggestions), which is what the card's label promises;
    // 'deny' blocks it and feeds `feedback` back as the reason.
    z.object({
        kind: z.literal("permission"),
        requestId: z.string().min(1),
        decision: z.enum(["once", "always", "deny"]),
        feedback: z.string().optional(),
    }),
]);
export type AgentReply = z.infer<typeof AgentReplySchema>;
// Steering: a user message delivered INTO the running turn (injected between tool calls, Claude Code style),
// keyed by the conversation whose turn is in flight. NOT_FOUND when no steerable turn is running — the client
// then holds the message in its queue and sends it as the next turn instead. Carries everything a turn's own
// prompt can carry (files, the editor-context chip), because "add more while it works" is worth nothing if it
// only takes bare text: the daemon folds the same notes into the injected message that a fresh turn gets.
export const SteerSchema = z
    .object({
        conversationId: z.string().min(1),
        text: z.string().max(20_000),
        attachments: z.array(z.string().min(1)).max(20).optional(),
        editorContext: EditorContextSchema.optional(),
    })
    // An attachment-only steer (a screenshot dropped in mid-turn) is legal; an entirely empty one is not.
    .refine((steer) => steer.text.trim().length > 0 || (steer.attachments?.length ?? 0) > 0, {
        message: "text or attachments required",
    });
// True cancel for the conversation's in-flight turn — aborts the agent daemon-side, unlike closing the
// /agent fetch (which sends no cancel frame).
export const StopTurnSchema = z.object({ conversationId: z.string().min(1) });

// ---- claude subscription usage ----
// The GATE signal: whether the provider is letting turns through right now, and — when it is refusing — which
// window is binding and when it lifts. This is the SDK's rate_limit_event, mapped one-to-one, and it is only
// ever about the CURRENT moment. It is deliberately NOT the thing the headroom displays read: the event names a
// single window (whichever the CLI considered binding), which is how "weekly 1%" ended up standing in for an
// account that was really at 98% on another weekly pool.
export const RateLimitInfoSchema = z.object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    resetsAt: z.number().optional(), // epoch seconds
    rateLimitType: z.string().optional(), // 'five_hour' | 'seven_day' | 'seven_day_opus' | ...
    utilization: z.number().optional(), // 0-100, how much of the window is used
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

// One plan-limit pool. `kind` is the provider's own key ('five_hour' | 'seven_day' | 'seven_day_opus' |
// 'seven_day_sonnet' | 'model:Fable' | …) rather than an enum we'd have to keep in step with the provider: an
// unrecognised pool is shown under its raw key, which is far better than being silently folded into a
// neighbour. `label` is the provider's OWN display name where it supplies one (the per-model buckets do) — it
// wins over anything we'd infer, because the model names in a plan's limits are the provider's to rename.
// `resetsAt` is epoch SECONDS (matching the SDK's frame).
export const UsageWindowSchema = z.object({
    kind: z.string(),
    label: z.string().optional(),
    utilization: z.number(), // 0-100
    resetsAt: z.number().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

// An account's headroom: EVERY window the provider reports, read together, plus when the reading was taken.
// All of them, not the binding one, because "which pool is binding" changes between turns and a reader
// comparing accounts needs the same pools on every row. Sourced from the CLI's own usage endpoint at turn end
// (see claudeUsageWindows) — a control request, so it costs no tokens.
//
// Within one window utilization only climbs, so an un-reset window stays a valid FLOOR however old it is; past
// its `resetsAt` it describes a pool that no longer exists and the store drops it. `measuredAt` is epoch MS
// (matching connectedAt) — deliberately a different unit from the windows' seconds.
export const AccountUsageSchema = z.object({
    windows: z.array(UsageWindowSchema),
    measuredAt: z.number(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

// ---- provider oauth ----
// Claude uses the PKCE authorize-URL + paste-back handshake (start → exchange). Codex uses OpenAI's device-code
// flow (start → poll): the browser signs in at verificationUri and enters userCode; the daemon polls until done.
// A sandbox can hold several accounts per provider side by side: `id` is the daemon-minted store key, `label`
// the user's display name (auto-filled from the sign-in identity where the token carries one). Tokens never
// ride this shape — connection status is existence in the list.

export const OauthAccountSchema = z.object({
    id: z.string(),
    label: z.string(),
    scope: z.string().optional(),
    connectedAt: z.number(), // epoch ms
    // Set only when the account's stored credential can no longer be refreshed (revoked/expired refresh token)
    // — the user must reconnect. Absent ⇒ healthy or not-yet-probed; `detail` carries the reason for the UI.
    // Provider-agnostic; only Codex probes it today (Claude refreshes on-demand, Grok's tokens are OpenCode's).
    needsReauth: z.boolean().optional(),
    detail: z.string().optional(),
    // The account's last known subscription-usage snapshot, so the picker can show what's left on each account
    // before the user commits a turn to one. Claude-only (it is the sole provider whose stream reports a usage
    // window) and absent until that account has run a turn — an unmeasured account reads as unknown, never 0%.
    usage: AccountUsageSchema.optional(),
});
export type OauthAccount = z.infer<typeof OauthAccountSchema>;
export const OauthAccountListSchema = z.object({ accounts: z.array(OauthAccountSchema) });
// Address one account of a provider (disconnect, and the turn's `account`).
export const AccountIdSchema = z.object({ id: z.string().min(1) });
// The completing calls carry the user-chosen label (blank ⇒ the daemon derives one from the sign-in identity
// or a provider default).
export const OauthExchangeSchema = z.object({
    code: z.string().min(1),
    verifier: z.string().min(1),
    state: z.string().min(1),
    label: z.string().optional(),
});
export const AuthorizeChallengeSchema = z.object({ authorizeUrl: z.string(), verifier: z.string(), state: z.string() });
// Kimi (Moonshot) authenticates with an API key, not OAuth: the user pastes a key from their Moonshot account
// and the sandbox stores it as an account (one key per account, several accounts side by side). `label` is the
// user's display name (blank ⇒ the daemon derives a default). The key never rides back out — connection status
// is existence in `/kimi/accounts`.
export const KimiConnectSchema = z.object({ apiKey: z.string().min(1), label: z.string().optional() });
// xAI Grok (via OpenCode) uses subscription OAuth via the headless device-code method. `start` returns the
// `url` the user opens (xAI's verification_uri_complete, which pre-fills the code) and `code` — the same
// one-time code, surfaced so the card matches x.ai exactly. There is no paste-back: OpenCode polls to
// completion and the UI polls `/grok/accounts`.
// ponytail: OpenCode holds one xAI auth per data dir, so Grok stays single-account — the list is 0 or 1. Per
// account would need an OpenCode server per data dir; add when there's demand.
// A device-code login start: the verification URL + the one-time code the user enters there. The native Grok
// flow (via OpenCode) — see TranslatorStartSchema for the routed-provider connect, which adds `state`.
export const DeviceStartSchema = z.object({ url: z.string(), code: z.string() });
// A routed-provider subscription login start (codex/grok/gemini via CLIProxyAPI). Codex and Grok mint a
// one-time device `code` the user enters at the provider's site, and CLIProxyAPI polls to completion on its
// own — the card only waits. Google publishes no device flow: the user approves in a browser and is redirected
// to a loopback URL this sandbox never receives, so `code` is empty and the card asks them to paste that URL
// back (see TranslatorCompleteSchema). Which half a provider uses is READ from the response rather than
// hardcoded per provider, so the card needs no provider table.
export const TranslatorStartSchema = z.object({ url: z.string(), code: z.string(), state: z.string() });
// The paste-back half of a redirect login: the URL the provider sent the browser to, carrying the grant as
// ?code=&state=. `state` ties it to the handshake that issued it — the translator rejects a mismatch.
export const TranslatorCompleteSchema = z.object({
    provider: KeyedProviderSchema,
    redirectUrl: z.string().min(1),
    state: z.string().min(1),
});
// A provider's model catalog, resolved daemon-side from live discovery with a persisted last-known-good list and
// a seed floor (Grok via opencode.ts xaiModels, Codex via codex-models.ts, Claude via the Agent SDK's
// supportedModels) — never empty, so the picker is never blank. `label` is the humanized display name; `default`
// is the model a fresh chat on that provider seeds (always present). Shared by /grok/models, /codex/models,
// /claude/models. `efforts` is the reasoning-effort tiers the model accepts (Claude reports them per model);
// empty ⇒ the client's default tiers.
//
// EVERY field here is provider-reported — nothing about a model is curated in this repo, so a new release or a
// renamed family flows to the UI with no code change. Providers differ in how much they publish: the Claude
// Agent SDK reports a display name, a capability description, effort tiers, and capability flags, while the
// OpenAI-compatible /v1/models endpoints (codex/grok/kimi) report ids only — those rows render label-only, and
// that absence is the honest answer rather than something to paper over with a hand-written table.
//
// ORDER IS MEANINGFUL: `models` arrives in the provider's own preference order, which is what the picker sorts
// by, and `default` is the provider's own default. Neither is re-ranked locally.
export const ModelBadgeSchema = z.enum(["reasoning", "fast"]);
export type ModelBadge = z.infer<typeof ModelBadgeSchema>;
export const ModelSchema = z.object({
    id: z.string(),
    label: z.string(),
    efforts: z.array(z.string()).optional(),
    description: z.string().optional(),
    badges: z.array(ModelBadgeSchema).optional(),
});
export type Model = z.infer<typeof ModelSchema>;
export const ModelsSchema = z.object({ models: z.array(ModelSchema), default: z.string() });

// ---- sessions ----

export const SessionIdParamSchema = z.object({ id: z.string() });
export const SessionSummarySchema = z.object({ id: z.string(), title: z.string(), updatedAt: z.number() });
export const SessionsListSchema = z.object({ sessions: z.array(SessionSummarySchema) });

// ---- settings: per-sandbox agent settings (.intentic/settings.json) ----
// Small user-owned config the /settings routes edit and streamAgent reads — all opt-in booleans the owner
// toggles in the UI (so each can be A/B benchmarked):
//   stableSystemPrompt — keeps the system prompt byte-stable across turns (the delegation note rides the user
//                        message instead of the preset `append`) so the provider prompt cache survives.
//   skills            — names of baked-tool skills to load into .claude/skills so the agent reaches for them
//                        (e.g. "lsp" — TS rename + diagnostics over the language service); a name absent ⇒ its
//                        skill file isn't written, so the agent doesn't reach for it. Data-driven: a new baked
//                        tool is one daemon-side registry entry, not a new settings field.
//   hashlineEdits     — swaps the native Read/Edit/Write for hash-anchored edits on the Claude path (stale-file
//                        guard + fewer output tokens); off ⇒ the native file tools.
//   terseOutput       — appends a concise-response steer to the end of the system prompt (a stable suffix, so it
//                        composes with stableSystemPrompt) to cut the model's OWN output tokens.
//   iqSearch          — loads the image-baked iq Claude Code plugin (skill + SessionStart nudge) so the agent
//                        prefers the iq CLI over grep/find/Glob; off ⇒ plugin not loaded, native search tools
//                        only. Opt-in (default off); the browser Search box uses iq regardless.
//   outputCleaners    — the Bash output-cleaner spec (agent-output-filter): "off" = filter disabled (default),
//                        "" = all cleaners on, else an iq-style allow-list / default-minus
//                        spec ("git,pnpm" = only those; "-cap" = all except). Threaded to the filter via env.
//   outputHoldout     — measurement control: a fraction [0,1] of Bash commands whose output bypasses cleaning
//                        (recorded raw as `heldOut`), so the savings report compares a real cleaned-vs-raw
//                        population instead of an estimate. 0 = no holdout (default).
//   filterBackend     — which cleaner runs the compression: "native" (agent-output-filter, default) or "rtk"
//                        (the image-baked rtk binary, rewritten at the PreToolUse hook) — an
//                        A/B backend switch, so native and rtk can be benchmarked head-to-head.
// The booleans default off, skills defaults [] (no skill loaded), outputCleaners defaults "off" (cleaning off),
// outputHoldout 0, filterBackend "native" — a fresh sandbox starts with cleaning and iq off until the owner enables them.
//
// Every field carries that default IN THE SCHEMA, so a settings object written before a field existed still
// parses — the absent key reads as its default. That is not a compatibility layer, it is the seam this shape
// spans: the browser ships with the platform while the daemon ships inside the user's sandbox image, so a web
// build is routinely NEWER than the daemon answering it. Requiring the key instead makes the whole settings
// surface fail to parse the moment a toggle is added — which reaches the user as a page of switches that are
// silently dead, not as an error. It also means an older on-disk manifest keeps the owner's other picks rather
// than being discarded whole.
export const SandboxSettingsSchema = z.object({
    stableSystemPrompt: z.boolean().default(false),
    skills: z.array(z.string()).default([]),
    hashlineEdits: z.boolean().default(false),
    terseOutput: z.boolean().default(false),
    iqSearch: z.boolean().default(false),
    outputCleaners: z.string().default("off"),
    outputHoldout: z.number().min(0).max(1).default(0),
    filterBackend: z.enum(["native", "rtk"]).default("native"),
    /* The model behind the one-click helpers that are not a conversation — today the commit box's autofill.
     * `${provider}:${modelId}`, or EMPTY for Auto, which is the default and the interesting case: Auto is
     * resolved from whatever accounts are connected at the moment it is read (resolveQuickModel), so it can
     * never name a provider this sandbox has no credential for and it improves by itself when one is added.
     * Storing a resolved id here instead would go stale exactly like a pinned model does. */
    quickModel: z.string().default(""),
    // How long a finished agent stays on the board before it is archived automatically (days; 0 ⇒ never).
    // Unlike every other flag here this one defaults ON, because the lane it governs is the board's only
    // terminal state: without a sweep the Finished lane grows for the life of the sandbox, and each card it
    // holds is a live worktree checkout, not just a row.
    agentRetentionDays: z.number().min(0).max(365).default(3),
    // When a turn dies on the Claude subscription's usage limit, re-run it automatically once the limit
    // window resets (a minute after, so a skewed clock can't retry into the same closed window). Off by
    // default: an unattended retry spends the fresh window without the user in the room, so the daemon
    // records every limit-hit either way and the chat OFFERS the toggle at the moment it would have helped —
    // enabling it then still resumes the turn that just bounced.
    autoResumeOnLimit: z.boolean().default(false),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

// ---- output-cleaner savings report (rtk-`gain`-style) ----
// Aggregated from historyRoot/logs/filter-stats.jsonl (one row per agent Bash command). `perCleaner` attributes
// which cleaner ids fired across commands; `holdout` is the measured control (commands the holdout bypassed) vs
// the cleaned population — a real saved-% rather than an estimate; `gaps` are high-volume commands that matched
// no cleaner (the next handler to write). Empty/zeroed when no commands have run yet.
export const CleanerSavingsSchema = z.object({
    commands: z.number(),
    rawTokens: z.number(),
    emittedTokens: z.number(),
    savedPct: z.number(),
    perCleaner: z.array(z.object({ id: z.string(), commands: z.number() })),
    holdout: z.object({ cleaned: z.number(), heldOut: z.number(), measuredSavedPct: z.number().optional() }),
    gaps: z.array(z.object({ command: z.string(), tokens: z.number() })),
});
export type CleanerSavings = z.infer<typeof CleanerSavingsSchema>;

// ---- intentic CLI ----

export const IntenticRunSchema = z.object({ args: z.array(z.string()) });

// ---- git ----

// What a commit records — two shapes, each a real git spelling:
//   all: true   ⇒ stage every change in the repo, then commit (`commit -a`; VSCode's "stage all and commit")
//   absent      ⇒ commit whatever is staged (plain `git commit`)
//
// There is deliberately no `paths`. The index IS git's mechanism for choosing what a commit contains, so a
// second path-selection channel alongside it can only disagree with it: a `commit --only` over a partially
// staged file records the WORKTREE content while the row the user picked showed the INDEX content. Staging is
// the selection; this endpoint only ever records it.
export const CommitSchema = RepoParamSchema.extend({
    message: z.string().min(1),
    all: z.boolean().optional(),
});
export const DiscardSchema = RepoParamSchema.extend({
    // Repo-relative paths to discard; absent ⇒ discard every uncommitted change in the repo.
    paths: z.array(z.string().min(1)).max(500).optional(),
});
// Index moves. Both are per-path and never touch the worktree, so they are always safe and need no checkpoint.
export const GitStageSchema = RepoParamSchema.extend({ paths: z.array(z.string().min(1)).max(500) });
// `branch` defaults to the checked-out one. There is deliberately no "set upstream" flag: the daemon publishes
// (`push -u`) exactly when the branch has no upstream yet, which is never destructive and is the only way the
// result is coherent — see pushBranch.
export const PushSchema = RepoParamSchema.extend({ branch: z.string().min(1).optional() });
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitFileWriteSchema = RepoParamSchema.extend({ path: z.string().min(1), content: z.string() });
// Which of the working tree's diffs to open — the same split the Changes panel lists under. A path that is
// staged AND edited again has genuinely different diffs, so the side is required rather than defaulted: a
// caller that doesn't say which one it means doesn't know what it is showing.
//   staged     ⇒ index vs HEAD      (what a bare `git commit` would record)
//   unstaged   ⇒ worktree vs index  (untracked ⇒ no before side)
//   conflicted ⇒ HEAD vs worktree   (what you had vs what the merge left, markers included — an unmerged path
//                                    has no stage 0, so the index is not a side it can be diffed against)
export const GitDiffSideSchema = z.enum(["staged", "unstaged", "conflicted"]);
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;
export const GitFileDiffQuerySchema = RepoParamSchema.extend({ path: z.string().min(1), side: GitDiffSideSchema });
export const GitStatusSchema = z.object({ branch: z.string(), dirty: z.boolean(), files: z.array(z.string()) });
export const GitFilesSchema = z.object({ files: z.array(z.string()) });
export const GitFileSchema = z.object({ path: z.string(), content: z.string() });
export const CommitResultSchema = z.object({ committed: z.boolean() });

/* AI-drafted commit message. Workspace-wide, not per repo, because the commit box's target IS a set of repos
 * sharing one message — so the draft has to see every one of their diffs to describe what the commit actually
 * records. `repos` and `all` mirror the panel's own commit target exactly: `all` reads the WORKTREE (what
 * "Commit all" would sweep), absent reads the INDEX (what a bare commit records). Getting that wrong would
 * describe changes the commit isn't going to contain. */
export const CommitMessageDraftSchema = z.object({
    repos: z.array(z.string().min(1)).min(1).max(50),
    all: z.boolean().optional(),
});
// The draft plus WHICH model wrote it, so the surface can name it rather than claiming an anonymous "AI" —
// that name is also the only place the resolved quick model is visible before anyone opens settings.
export const CommitMessageSchema = z.object({
    message: z.string(),
    provider: z.string(),
    model: z.string(),
});
export type CommitMessageDraft = z.infer<typeof CommitMessageSchema>;
// One change to a file — an uncommitted working-tree change (status vs HEAD, untracked included), an agent
// worktree's delta vs its base, or a file in a commit. `additions`/`deletions` are the numstat line counts,
// undefined for a binary file (git reports "-"/"-") or an untracked file (no HEAD blob to diff against).
export const GitChangeSchema = z.object({
    // Repo-relative path with forward slashes; for "renamed" the NEW path (`from` carries the old one).
    path: z.string(),
    // "conflicted" is git's unmerged state (`U`), and it is not a kind of modification: the index holds "ours"
    // and "theirs" at stages 2/3 with NO stage 0, so there is nothing a commit could record for this path and
    // git refuses to commit while one exists. It belongs to neither side — see RepoChanges.conflicted.
    status: z.enum(["added", "modified", "deleted", "renamed", "type-changed", "conflicted"]),
    from: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
});
export type GitChange = z.infer<typeof GitChangeSchema>;

// Where a repo's checked-out branch stands against its remote. Every field is optional-or-zero because every
// one of them is legitimately absent in a healthy repo: no remote configured yet, a branch created locally and
// never pushed, a detached HEAD. `ahead` = commits only we have; `behind` = commits only the upstream has,
// which is meaningful only as of the last fetch — the panel's Fetch button is what refreshes it.
export const GitRemoteStateSchema = z.object({
    // The remote this branch pushes to: its OWN remote when it tracks one, else the first `git remote` lists
    // (where a never-pushed branch would publish). Those differ in a fork — `origin` and `upstream` both
    // configured — and pushing to the wrong one succeeds while leaving `ahead` stuck. Absent ⇒ no remote.
    remote: z.string().optional(),
    // The checked-out branch; absent on a detached HEAD or an unborn repo.
    branch: z.string().optional(),
    // The tracking ref ("origin/main"); absent ⇒ this branch has no upstream, so the next push publishes it.
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
});
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;

// A ref name (branch/tag), validated structurally — git enforces the rest of ref-name legality itself.
const RefNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .max(200);

// One local branch, for the switcher. `at` is its tip's committer time in ms (the list sorts newest-first).
export const GitBranchSchema = z.object({
    name: z.string(),
    current: z.boolean(),
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
    // The configured upstream no longer exists on the remote (a merged PR's deleted branch) — distinct from
    // "no upstream", and the signal that this local branch is safe to delete.
    gone: z.boolean().optional(),
    at: z.number(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;
export const GitBranchesSchema = z.object({ branches: z.array(GitBranchSchema) });
// Create at `start` (a sha or ref; absent ⇒ HEAD); `checkout` switches to it immediately (`git switch -c`).
export const GitBranchCreateAtSchema = RepoParamSchema.extend({
    name: RefNameSchema,
    start: z.string().min(1).optional(),
    checkout: z.boolean().optional(),
});
// `force` is the deliberate retry after git refuses to drop an unmerged branch.
export const GitBranchDeleteSchema = RepoParamSchema.extend({ name: RefNameSchema, force: z.boolean().optional() });

export const RepoChangesSchema = z.object({
    // The {repo} param the per-repo git routes accept: "root" or a repo id (its root-relative dir).
    repo: z.string(),
    // Absent on an unborn HEAD (a repo initialized but never committed).
    branch: z.string().optional(),
    // Unmerged paths — a merge, rebase, cherry-pick or pull that git could not finish. First, because until
    // they are resolved nothing else in this repo can be committed at all: git refuses outright. Held apart
    // from the two sides rather than listed in them, because "staged or not" is not a question an unmerged path
    // has an answer to. Staging one (`git add`) is exactly how you tell git it is resolved.
    conflicted: z.array(GitChangeSchema),
    // The two sides git actually models, kept apart because a path can appear on BOTH with different statuses
    // (a staged edit that was then edited again — the classic `MM`). `staged` is index-vs-HEAD: exactly what a
    // bare `git commit` would record. `unstaged` is worktree-vs-index plus untracked files. Each side's
    // additions/deletions describe the diff it is listed under, never a conflation of the two.
    staged: z.array(GitChangeSchema),
    unstaged: z.array(GitChangeSchema),
    // Where this repo stands against its remote; `ahead`/`behind` are 0 with no remote or no upstream.
    remote: GitRemoteStateSchema.optional(),
    // WHICH AGENT PUT IT THERE: repo-relative path → the agent ids that landed it, newest land first. Keyed by
    // PATH rather than carried on each GitChange because a path can be listed on two sides at once (staged and
    // edited again) and its origin is the same fact for both. Only agents can appear here — a main-tree turn,
    // a terminal edit and your own typing never pass through land, so they are simply absent (see
    // agents/origins.ts), which is why the panel badges an agent and says nothing at all for anyone else.
    // Ids, not titles: every client already mirrors the fleet registry and can resolve one to the other.
    origins: z.record(z.string(), z.array(z.string())).optional(),
    // Why the repo could not be scanned at all, condensed to git's own one-line reason ("fatal: bad object HEAD").
    // A repo left torn by a canceled or failed upload used to be dropped from the response entirely, so it just
    // vanished from the panel with nothing to act on; it now arrives with empty change lists and this set instead.
    error: z.string().optional(),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
// The aggregated review set across every repo (root + every discovered repo); a repo appears when it has changes,
// when it is out of sync with its remote, or when it failed to scan.
export const GitChangesSchema = z.object({ repos: z.array(RepoChangesSchema) });
export type GitChanges = z.infer<typeof GitChangesSchema>;

// One file an agent touched, plus whether that change is ALREADY in the main tree. The review lists the
// agent's CUMULATIVE output (base → worktree), not just the not-yet-landed remainder, because landing is not
// the end of the review: a clean turn auto-lands within milliseconds, and a list scoped to the remainder shows
// the user an empty panel for work they never got to look at. `landed` is what still separates the two — the
// remainder is what "Land now" would apply, and the panel filters on exactly this flag.
export const AgentChangeSchema = GitChangeSchema.extend({ landed: z.boolean() });
export type AgentChange = z.infer<typeof AgentChangeSchema>;

// An agent conversation-worktree's delta vs its recorded base — deliberately NOT RepoChanges. There is no index
// side to speak of here: the question a fleet review answers is "what did this agent write", which is one flat
// set. Sharing the working-tree shape would have forced a meaningless empty `staged` on every
// row and invited the panel to render a staging affordance that cannot work on a worktree the user never checks out.
export const AgentRepoChangesSchema = z.object({
    repo: z.string(),
    branch: z.string().optional(),
    changes: z.array(AgentChangeSchema),
});
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
/* The review, plus WHY the last land refused — because a conflict is discovered by the daemon (a clean turn
 * auto-lands the moment it finishes) and acted on in the browser, possibly hours later, on a surface the user
 * reaches by clicking the card's "Resolve conflict". Carrying the report only in the land RESPONSE meant the
 * one path that opens the review already knowing there is a conflict was the one path that could not show it:
 * the panel opened with an empty report, no explanation, and no merge affordance — a dead end at the exact
 * moment the UI had promised something to resolve. It rides the review because that is the surface that
 * resolves it, and it refreshes with it: every land invalidates this query, so the report is never staler
 * than the last attempt. */
export const AgentChangesSchema = z.object({ repos: z.array(AgentRepoChangesSchema), conflicts: z.array(LandConflictSchema).optional() });
export type AgentChanges = z.infer<typeof AgentChangesSchema>;

// ---- git history graph (the "Git Graph" view over a repo's real commits) ----
// A hex sha (full or git-abbreviated): the only shape the graph ever sends back, so the per-commit routes
// constrain to it rather than accepting an arbitrary git revision expression.
const ShaSchema = z.string().regex(/^[0-9a-f]{4,64}$/);
// One commit in the graph. `parents` (0 = root, 1 = normal, 2+ = merge) drive the lane layout, computed
// client-side. `refs` are the branch/tag decorations at this commit (tags keep their `tag: ` prefix; the bare
// "HEAD" marker is lifted into `head` instead). `at` is author time in ms since epoch; `short` is git's
// abbreviated sha; `body` is the message minus its subject line.
export const GitCommitSchema = z.object({
    sha: z.string(),
    short: z.string(),
    parents: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    author: z.string(),
    email: z.string(),
    at: z.number(),
    refs: z.array(z.string()),
    head: z.boolean(),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;
// One repo's log: commits newest-first across ALL refs (branch topology is the point of a graph), plus the
// checked-out branch (absent on a detached HEAD or an unborn repo).
export const GitLogSchema = z.object({ repo: z.string(), branch: z.string().optional(), commits: z.array(GitCommitSchema) });
export type GitLog = z.infer<typeof GitLogSchema>;
export const GitLogQuerySchema = RepoParamSchema.extend({ limit: z.coerce.number().int().positive().max(2000).optional() });
// Every real git repo under /work as root-relative dir ids ("root" is implicit — the /work repo itself).
export const GitReposSchema = z.object({ repos: z.array(z.string()) });
export type GitRepos = z.infer<typeof GitReposSchema>;
export const GitCommitDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema });
// A commit's changed files (vs its first parent; a root commit vs the empty tree) — the graph's detail tree
// renders these (line stats included) and reuses the diff UI on click. Just GitChanges: the line stats live on
// GitChange now, so working-tree and commit files share one shape.
export const GitCommitDiffSchema = z.object({ files: z.array(GitChangeSchema) });
export type GitCommitDiff = z.infer<typeof GitCommitDiffSchema>;
export const GitCommitFileDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema, path: z.string().min(1) });
// Git write actions from the graph's commit context menu (VSCode "Git Graph" parity). Non-destructive: branch
// and tag just add a ref (HEAD + worktree untouched, no checkpoint). Sequence ops (revert / cherry-pick /
// merge / rebase / drop) add or replay commits and are auto-checkpointed daemon-side; a conflict aborts and
// reports `ok:false` (an expected outcome, not a throw). Checkout and reset move HEAD (reset --hard discards
// the worktree) — also auto-checkpointed. A `{repo, sha}` names the target commit for every commit-scoped
// action; a ref name (branch/tag) is validated structurally, git enforces the rest of ref-name legality
// (RefNameSchema is declared above, with the branch schemas that first use it).
export const GitBranchCreateSchema = RepoParamSchema.extend({ sha: ShaSchema, name: RefNameSchema });
export const GitTagCreateSchema = RepoParamSchema.extend({ sha: ShaSchema, name: RefNameSchema });
export const GitCheckoutSchema = RepoParamSchema.extend({ ref: RefNameSchema });
export const GitResetSchema = RepoParamSchema.extend({ sha: ShaSchema, mode: z.enum(["soft", "mixed", "hard"]) });
export const GitCommitActionSchema = RepoParamSchema.extend({ sha: ShaSchema });
export const GitActionResultSchema = z.object({ ok: z.boolean(), reason: z.string().optional() });
export type GitActionResult = z.infer<typeof GitActionResultSchema>;

// ---- history: daemon-owned workspace snapshots (diff + restore) ----
// The daemon snapshots /work into bare git dirs on /history (outside the agent's reach). A "snapshot" groups
// one commit per scope (root + each nested repo) under a shared id. Only checkpoint triggers (turn / user /
// pre-restore / restore) are listed; "interval" captures are a hidden safety net that dissolves into the next
// visible checkpoint's diff.

export const SnapshotTriggerSchema = z.enum(["turn", "interval", "pre-restore", "restore", "user"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export const SnapshotSchema = z.object({
    id: z.string(),
    // Committer time, ms since epoch.
    at: z.number(),
    trigger: SnapshotTriggerSchema,
    // Human-readable checkpoint label — the turn's prompt for "turn" snapshots; absent otherwise.
    label: z.string().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const SnapshotsListSchema = z.object({ snapshots: z.array(SnapshotSchema) });
export const SnapshotIdSchema = z.object({ id: z.string().min(1) });
export const SnapshotChangeSchema = z.object({
    scope: z.string(),
    // Scope-relative path with forward slashes.
    path: z.string(),
    status: z.enum(["added", "modified", "deleted", "type-changed"]),
});
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export const SnapshotDiffSchema = z.object({ changes: z.array(SnapshotChangeSchema) });
export const SnapshotFileDiffQuerySchema = z.object({
    id: z.string().min(1),
    scope: z.string().min(1),
    path: z.string().min(1),
});
// Both sides of a file diff — a snapshot vs its parent, or a working tree vs HEAD; an absent side means the
// file was added/deleted. Binary or oversized content is flagged instead of shipped.
export const FileDiffSchema = z.object({
    before: z.string().optional(),
    after: z.string().optional(),
    binary: z.boolean().optional(),
    truncated: z.boolean().optional(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

// ---- workspace tree + files ----

// One node of the full /work filesystem tree the agent sees (untracked + generated files included), distinct
// from the git-tracked listing. `path` is root-relative with forward slashes so it feeds straight back to the
// file route. Recursive via zod's getter form (so the type is inferred, not hand-annotated).
export const WorkspaceTreeEntrySchema = z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "dir"]),
    size: z.number().optional(),
    // Set on a dir whose child list was cut short by the entry cap — some of its items aren't in `children`.
    truncated: z.boolean().optional(),
    // Ignored-by-tooling (node_modules, .git, .gitignore'd paths, browser profiles): the client grays the row.
    // An ignored DIR is listed without `children` — the client lazy-loads it via /workspace/children on expand.
    ignored: z.boolean().optional(),
    get children() {
        return z.array(WorkspaceTreeEntrySchema).optional();
    },
});
export type WorkspaceTreeEntry = z.infer<typeof WorkspaceTreeEntrySchema>;
export const WorkspaceTreeSchema = z.object({
    root: z.string(),
    tree: z.array(WorkspaceTreeEntrySchema),
    // True when the root's own entries were cut by the entry cap (per-dir cuts are flagged on each dir entry).
    truncated: z.boolean(),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;
// Lazy-load one directory's children — for an ignored dir the tree walk didn't descend into. Every returned entry
// is itself `ignored` (it lives under an ignored subtree); child dirs again carry no `children`, so they lazy-load
// on their own expand. `truncated` ⇒ the dir's child list was cut by the entry cap.
export const WorkspaceChildrenQuerySchema = z.object({ path: z.string().min(1) });
export const WorkspaceChildrenSchema = z.object({
    entries: z.array(WorkspaceTreeEntrySchema),
    truncated: z.boolean(),
});
export type WorkspaceChildren = z.infer<typeof WorkspaceChildrenSchema>;
export const WorkspaceFileQuerySchema = z.object({ path: z.string().min(1) });
export const WorkspaceFileSchema = z.object({ path: z.string(), content: z.string() });
// Resolve a file reference an agent (or a compiler, or a terminal) NAMED to the workspace path it means. Prose
// paths are routinely partial — a model that has been discussing `_apps/web/src` writes
// `pages/workspace/Foo.vue` — so a clickable mention has to be matched as a path SUFFIX against the real tree,
// not read as root-relative. `path` is absent when nothing in the workspace ends in that reference.
export const WorkspaceResolveQuerySchema = z.object({ path: z.string().min(1).max(512) });
export const WorkspaceResolveSchema = z.object({ path: z.string().optional() });
// Direct file management over the /work tree (delete / new folder / rename+move / copy). Byte writes + the
// editor's text save go through the plain POST /workspace/upload route (a body doesn't fit oRPC), not here.
export const WorkspaceDirSchema = z.object({ path: z.string().min(1) });
export const WorkspaceMoveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
// Deterministic (no-LLM) classification of the dropped workspace: each repo dir and loose file sorted into one
// coarse bucket. Read-only — the browser turns it into a proposed layout and applies the accepted moves via the
// existing /workspace/move route. `reason` records the winning signal (magic:<mime>, ext:<ext>,
// repository:<marker>, text-content, unknown) so the proposal is explainable.
export const WorkspaceBucketSchema = z.enum(["repositories", "documents", "media", "archives", "other"]);
export type WorkspaceBucket = z.infer<typeof WorkspaceBucketSchema>;
export const WorkspaceClassificationSchema = z.object({
    classifications: z.array(z.object({ path: z.string(), bucket: WorkspaceBucketSchema, reason: z.string() })),
});
export type WorkspaceClassification = z.infer<typeof WorkspaceClassificationSchema>;
// ---- workspace search ----

// The workspace-search wire shape — shared by the daemon's /workspace/search route and the web client.
// (Implementation detail, not part of the contract: the daemon backs this route with a resident in-process iq
// engine; the engine is interchangeable behind this shape.) Groups are relevance-ranked (best first, never path
// order); each hit carries the match-reason tags the fused engines contributed. `start`/`end` are char offsets
// within `text` so clients highlight without re-finding the needle.
export const WorkspaceSearchQuerySchema = z.object({
    query: z.string().min(2).max(512),
    // Search verbs only — anchor/git verbs (outline, context, log, who, …) are CLI-only surface.
    mode: z.enum(["q", "find", "files", "def", "refs", "sym", "ast", "ask"]).optional(),
    includeIgnored: z.stringbool().optional(),
    limit: z.coerce.number().int().positive().optional(),
    after: z.string().optional(),
});
export const WorkspaceSearchTagSchema = z.object({
    kind: z.enum(["def", "text", "sem", "bm25", "rerank", "path", "import", "call", "type", "write", "fuzzy", "heuristic"]),
    score: z.number().optional(),
});
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export const WorkspaceSearchHitSchema = z.object({
    line: z.number(),
    text: z.string(),
    start: z.number().optional(),
    end: z.number().optional(),
    tags: z.array(WorkspaceSearchTagSchema),
    // Enclosing symbol ("createWidget (fn)") — parent-document context so the reader often needs no follow-up.
    context: z.string().optional(),
});
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export const WorkspaceSearchGroupSchema = z.object({ path: z.string(), score: z.number(), hits: z.array(WorkspaceSearchHitSchema) });
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
// `building` = index still filling (progress 0..1, e.g. embeddings pending); `stale` = revalidation was skipped
// (cursor replay). ageMs = time since the index last matched the disk state.
export const WorkspaceSearchFreshnessSchema = z.object({
    state: z.enum(["fresh", "building", "stale"]),
    ageMs: z.number().optional(),
    progress: z.number().optional(),
});
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export const WorkspaceSearchResultSchema = z.object({
    mode: z.string(),
    total: z.number(),
    shown: z.number(),
    groups: z.array(WorkspaceSearchGroupSchema),
    freshness: WorkspaceSearchFreshnessSchema,
    truncated: z.boolean(),
    cursor: z.string().optional(),
    hint: z.string().optional(),
    // Code-graph neighbors of the top hits (definition anchors + ready-made follow-up commands).
    related: z.array(z.string()).optional(),
    // Run provenance for benchmarking: retrieval stages DISABLED this invocation (absent = full pipeline).
    features: z.array(z.string()).optional(),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;

// ---- codebase health: one repository's structure and risk, in numbers ----

// The repo-level companion to the management panel and the git-history graph: what the same resident engine's
// `hotspots` (churn × complexity) and `map` (PageRank over the import graph) verbs rank, as figures a panel can
// plot instead of lines a terminal prints.
//
// Every field is a COUNT that can be recounted in the files themselves — commits, branch points, exported
// symbols. Deliberately no composite "maintainability grade": those aren't comparable across projects and can't
// be checked, and a repo-health surface that launders counts into a letter is worse than none.
// How many hotspot files and key modules a report carries when the caller names no limit. A leaderboard, not an
// inventory: past a screenful the ranking stops being the point, and the reader should be reading the files.
export const HEALTH_LIMIT = 20;
export const WorkspaceHealthQuerySchema = z.object({
    // "root" (the /work repo) or a nested repo's root-relative dir — the same {repo} ids the git routes take.
    repo: z.string().min(1),
    // Churn window (2d, 12h, 1w, 3m). Absent = all of history, which is what a hotspot ranking wants by default.
    since: z.string().max(16).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
});
// One file that is BOTH churning and tangled. `score` is the product the ranking sorts by — carried explicitly
// so the panel plots the number it ranks by rather than recomputing it.
export const WorkspaceHotspotSchema = z.object({
    path: z.string(),
    commits: z.number(),
    adds: z.number(),
    dels: z.number(),
    complexity: z.number(),
    score: z.number(),
    // Epoch ms of the latest commit touching the file, within the window.
    latestMs: z.number(),
});
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
// A file of the import graph's ranked skeleton — order IS the rank, so no rank number rides along.
export const WorkspaceKeyModuleSchema = z.object({ path: z.string(), exports: z.number() });
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export const WorkspaceHealthSchema = z.object({
    repo: z.string(),
    totals: z.object({
        files: z.number(),
        symbols: z.number(),
        // Summed branch points across the scoped files.
        complexity: z.number(),
        // How many files qualify as hotspots at all — the lists below are capped, this is not.
        hotspots: z.number(),
    }),
    hotspots: z.array(WorkspaceHotspotSchema),
    modules: z.array(WorkspaceKeyModuleSchema),
    // Same index-freshness signal the search route reports: a panel drawn off a half-built index says so.
    freshness: WorkspaceSearchFreshnessSchema,
});
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;

// ---- workspace setup (dependency readiness) ----

// One project under /work and whether its dependencies are actually installed. A drop omits node_modules/.venv
// on purpose, so a freshly imported project is present-but-unusable until this says "ready" — the import UI,
// the agent's post-edit type-check, and the agent's turn context all gate on it.
// `dir` is root-relative ("" = the workspace root itself); `manager` is the real binary (pnpm/npm/uv/…);
// `evidence` is the file that decided it ("pnpm-lock.yaml"), so the UI can show WHY, not just what.
// state: ready | installing | needs-setup | unsupported (manager absent from this sandbox — `manager` names it).
export const ProjectSetupSchema = z.object({
    dir: z.string(),
    ecosystem: z.enum(["node", "python"]),
    manager: z.string(),
    command: z.string(),
    evidence: z.string(),
    state: z.enum(["ready", "installing", "needs-setup", "unsupported"]),
});
export type ProjectSetup = z.infer<typeof ProjectSetupSchema>;
export const WorkspaceSetupSchema = z.object({ projects: z.array(ProjectSetupSchema) });
export type WorkspaceSetup = z.infer<typeof WorkspaceSetupSchema>;
// Install these projects' dependencies. Dirs already ready, already installing, or whose manager is missing are
// skipped server-side, so a stale client list can't spawn redundant installs — `started` is what actually ran.
export const WorkspaceInstallSchema = z.object({ dirs: z.array(z.string()).min(1) });
export const WorkspaceInstallResultSchema = z.object({ started: z.array(z.string()) });

// ---- workspace repos ----

// Every discovered repo's id (root-relative dir under /work), sorted — roles included.
export const ReposListSchema = z.object({ repos: z.array(z.string()) });
export const CloneRepoSchema = z.object({ name: z.string().min(1), cloneUrl: z.string().min(1), branch: z.string().optional() });
export const CloneResultSchema = z.object({ name: z.string(), path: z.string() });
// Per-repo result of a workspace sync (fetch + guarded fast-forward). `status` mirrors GitSyncResult plus the
// turn-orchestration outcomes skipped/error; behind/ahead/head/message are present per status (see RepoSyncOutcome).
export const RepoSyncSchema = z.object({
    repo: z.string(),
    status: z.enum(["updated", "current", "dirty", "diverged", "no-remote", "skipped", "error"]),
    behind: z.number().optional(),
    ahead: z.number().optional(),
    head: z.string().optional(),
    message: z.string().optional(),
});
export const WorkspaceSyncSchema = z.object({ repos: z.array(RepoSyncSchema) });
// Add one or more named app instances into an EXISTING monorepo. Each entry pairs a template key from the
// source repo's templates.json manifest (e.g. "api", "web", "landing") with a user-chosen instance name
// (e.g. "shop-api"); {repo} names the target monorepo.
export const AppInstanceInputSchema = z.object({
    template: z.string().min(1),
    name: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/),
});
export type AppInstanceInput = z.infer<typeof AppInstanceInputSchema>;
export const AddAppsSchema = z.object({
    repo: z.string(),
    apps: z.array(AppInstanceInputSchema).min(1),
});

// Run vitest for one or more repo-relative project dirs in a named one-shot tmux panel session
// (panel-<repo>--<session>), driven by the apps extension's Run-tests actions. `session` is a slug suffix
// (an app/package name as `<name>__test`, or `tests` for the library section); `dirs` are repo-relative
// package dirs, where "" targets the repo root.
export const RunTestsSchema = z.object({
    repo: z.string(),
    session: z.string(),
    dirs: z.array(z.string()).min(1),
});

// One addable app type the configured source repo offers (from its templates.json), listed for the operator
// panel's Add-app picker: the manifest key + its label/description.
export const TemplateSummarySchema = z.object({ key: z.string(), label: z.string(), description: z.string() });
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export const TemplatesListSchema = z.object({ templates: z.array(TemplateSummarySchema) });
export type TemplatesList = z.infer<typeof TemplatesListSchema>;

// One app instance currently in a monorepo, with its own preview dev server + live status (started/stopped
// from the apps extension). `app` is the user-chosen instance name (the _apps/ dir); `template` is the
// manifest key it was created from (api/web/landing). previewUrl is
// https://preview-<repo>--<app>-<sandboxId>.<zone> (absent on loopback — no zone or no connect token).
export const RepoAppSchema = z.object({
    app: z.string(),
    template: z.string(),
    previewUrl: z.string().optional(),
    running: z.boolean(),
    healthy: z.boolean(),
});
export type RepoApp = z.infer<typeof RepoAppSchema>;
export const AppsListSchema = z.object({ apps: z.array(RepoAppSchema) });
export type AppsList = z.infer<typeof AppsListSchema>;
// One workspace package in a pnpm monorepo, discovered from pnpm-workspace.yaml's packages globs. `dir` is the
// repo-relative package dir (e.g. "_apps/web"); `group` is its top-level dir segment (e.g. "_apps"), the
// dependencies view's coloring axis.
export const WorkspacePackageSchema = z.object({ name: z.string(), dir: z.string(), group: z.string() });
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;
export const WorkspaceDepTypeSchema = z.enum(["prod", "dev", "peer"]);
export type WorkspaceDepType = z.infer<typeof WorkspaceDepTypeSchema>;
// A workspace-internal dependency edge: `from` DEPENDS ON `to` (from's package.json lists to), typed by which
// dependency block declared it. Pure data — layout/direction is the client's concern.
export const WorkspaceDepEdgeSchema = z.object({ from: z.string(), to: z.string(), type: WorkspaceDepTypeSchema });
export type WorkspaceDepEdge = z.infer<typeof WorkspaceDepEdgeSchema>;
export const WorkspaceGraphSchema = z.object({ packages: z.array(WorkspacePackageSchema), edges: z.array(WorkspaceDepEdgeSchema) });
export type WorkspaceGraph = z.infer<typeof WorkspaceGraphSchema>;
// Path params for the per-repo apps routes: the monorepo name (validated in the handler like PanelRepoParam)
// and, for per-app preview control (start/stop), the app key (api/web/landing).
export const RepoAppsParamSchema = z.object({ repo: z.string() });
export const AppParamSchema = z.object({
    repo: z.string(),
    app: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/),
});

// ---- inventory: the i.have.* / i.want.service entries in deploy.config.ts's managed region ----
// The daemon renders/parses these; the browser edits them through the inventory routes. Moved here from the
// daemon's deploy-config.ts so the daemon and the browser validate against ONE schema (no cross-repo dupes).

export const InventoryProviderSchema = z.enum(["host", "cloudflare", "github", "gitlab", "stripe"]);
export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export const ServiceKindSchema = z.enum(["signoz", "outline", "paperless", "openproject", "invoiceninja", "infisical"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
// Non-secret option values the user provides; secret options (sshKey, apiToken, apiKey) are emitted as env()
// references and never travel over the wire.
export const InventoryValuesSchema = z.record(z.string(), z.union([z.string(), z.number()]));
// `const <name>` binding in deploy.config.ts, so it must be a valid identifier.
const inventoryName = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
export const BackendEntrySchema = z.object({
    kind: z.literal("backend"),
    provider: InventoryProviderSchema,
    name: z.string(),
    values: InventoryValuesSchema,
});
export const ServiceEntrySchema = z.object({
    kind: z.literal("service"),
    service: ServiceKindSchema,
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
// i.want.app — a deployable app built from source. Single production environment on `main`; `values.domain` is
// where it's exposed. Multi-env/teams/use wiring is hand-authored outside the managed region.
export const AppEntrySchema = z.object({
    kind: z.literal("app"),
    name: z.string(),
    values: InventoryValuesSchema,
    on: z.string(),
    expose: z.string(),
});
export const InventoryEntrySchema = z.discriminatedUnion("kind", [BackendEntrySchema, ServiceEntrySchema, AppEntrySchema]);
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export const AddInventoryInputSchema = z.discriminatedUnion("kind", [
    BackendEntrySchema.extend({ name: inventoryName }),
    ServiceEntrySchema.extend({ name: inventoryName }),
    AppEntrySchema.extend({ name: inventoryName }),
]);
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;
export const InventoryNameParamSchema = z.object({ name: z.string() });
export const InventoryListSchema = z.object({ entries: z.array(InventoryEntrySchema) });

// A deploy-target host self-registering via the connect-host script's POST /enroll (connect-token auth). The SSH
// key (+ optional Cloudflare token) is written to desired-state/.env; the host (+ cf) is upserted into inventory.
export const EnrollHostInputSchema = z.object({
    name: inventoryName,
    user: z.string().min(1),
    address: z.string().min(1),
    port: z.coerce.number().default(22),
    via: z.enum(["direct", "cloudflared"]).default("cloudflared"),
    sshKey: z.string().min(1),
    cfToken: z.string().optional(),
    // The zone the connect script resolved alongside cfToken — recorded on the i.have.cloudflare entry so
    // resolve validates against it (no re-discovery) and the Add-service dialog offers `<subdomain>.<zone>`.
    cfZone: z.string().optional(),
});
export type EnrollHostInput = z.infer<typeof EnrollHostInputSchema>;

// ---- capabilities: the sandbox's unified capability manifest (.intentic/capabilities.json) ----
// Everything a user adds to a sandbox is a capability with an idempotent apply + a status check. The manifest is
// the source of truth for what's active; `mcp`-kind entries also feed the agent's MCP servers each turn. DevOps
// is the capability that scaffolds the intent/desired-state repos — until it's active the sandbox is empty.

export const CapabilityKindSchema = z.enum([
    "devops",
    "monorepo",
    "mcp",
    "service",
    "integration",
    "cli",
    "plugin",
    "extension",
    "ssh",
    "vpn",
    "docker",
    "browser",
    "agent",
]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export const CapabilityStateSchema = z.enum(["active", "pending", "error", "inactive"]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

// A manifest entry id (capabilities + automations) — also the `mcp__<id>__…` server name for mcp capabilities,
// so it's a safe identifier.
const entryId = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

// Per-kind config. Secrets (an mcp token) live here and are denylisted like tools.json.
export const McpConfigSchema = z.object({ url: z.string().url(), token: z.string().optional() });
export const ServiceConfigSchema = z.object({
    service: ServiceKindSchema,
    domain: z.string().min(1),
    on: z.string().min(1),
    expose: z.string().min(1),
});
// External-app credential injected into DEPLOYED apps (i.have.stripe → STRIPE_API_KEY from env). Agent-facing
// connectors are `cli` capabilities instead (see below), not integrations.
export const IntegrationConfigSchema = z.object({ provider: z.literal("stripe") });
// A `cli` capability gives the AGENT an authenticated command-line tool (not a deployed-app credential like
// `integration`): the credential + any non-secret URL are stored here and injected into the agent's env each
// turn (see cliEnvOf), and a .claude/skills/<id> cheatsheet teaches the agent to use it via curl. The provider
// data (fields, env, skill, image fragment) is DATA in an installed extension's `contributes.connectors`, not a
// per-provider schema arm — so the config is `provider` + arbitrary string fields, validated against the
// connector's declared fields at add-time (see the sandbox's connector-registry) rather than by this schema.
export const CliConfigSchema = z.object({ provider: z.string().min(1) }).catchall(z.string());
// A Claude Code plugin from a git repo. The daemon only owns the checkout; the Agent SDK's plugin loader reads
// its internals (skills/agents/hooks/commands/.mcp.json). `path` = subdirectory for plugins that live inside a
// marketplace/monorepo checkout. `token` = https auth for private repos (never echoed; becomes hasToken).
export const PluginConfigSchema = z.object({
    url: z.string().url(),
    // Branch / tag / commit sha to pin; absent = the default branch's HEAD.
    ref: z.string().min(1).optional(),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional(),
    token: z.string().min(1).optional(),
});
// An intentic extension from a git repo (an intentic-extension.json checkout — UI bundle + agent contributions
// + processes). Unlike `plugin`, `ref` is a REQUIRED full commit sha: extension code runs trusted in the
// owner's browser, so the owner approves exactly the code that runs — pin by construction, updates are explicit
// re-adds at a new sha. `path`/`token` as in PluginConfigSchema.
export const ExtensionConfigSchema = z.object({
    url: z.string().url(),
    ref: z.string().regex(/^[0-9a-f]{40}$/, "ref must be a full 40-character commit sha"),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional(),
    token: z.string().min(1).optional(),
});
// A remote machine the AGENT can reach over SSH. One capability = one machine; the id is its ssh-config Host
// alias, so the agent runs `ssh <id> "…"`. The handler writes a per-machine config block + a 0600 key/password
// file under ~/.ssh (see the ssh handler), so — unlike `cli` — nothing is injected into the agent's env, and
// several machines never collide. Discriminated by auth so exactly one credential shape is required.
export const SshConfigSchema = z.discriminatedUnion("auth", [
    z.object({
        auth: z.literal("key"),
        host: z.string().min(1),
        port: z.coerce.number().default(22),
        user: z.string().min(1),
        privateKey: z.string().min(1),
    }),
    z.object({
        auth: z.literal("password"),
        host: z.string().min(1),
        port: z.coerce.number().default(22),
        user: z.string().min(1),
        password: z.string().min(1),
    }),
]);
// ---- vpn ----
// A VPN the agent's traffic rides. One capability = one tunnel, discriminated by `provider` so a new protocol
// is a new arm (plus a driver in the daemon's vpn/), never a reinterpretation of an existing field:
//   wireguard — a pasted .conf, brought up with wg-quick.
//   fortinet  — a FortiGate SSL-VPN (what FortiClient's <sslvpn> connections speak), dialled with openconnect
//               --protocol=fortinet. openconnect is the client rather than openfortivpn because it routes over
//               tun instead of pppd: it needs exactly the tun + NET_ADMIN grant this kind already carries, and
//               no /dev/ppp device (which the runtime allowlist does not — and should not — include).
//   ipsec     — an IKEv1/IKEv2 tunnel with a pre-shared key and optional XAuth (FortiClient's <ipsecvpn>
//               connections), run by strongSwan. `aggressive` mirrors FortiClient's dial-up default.
// Connecting is NOT a config field: connect/disconnect are live operations (see vpn.contract.ts) that both the
// user and the agent drive, so a stored tunnel's up/down state is read from the OS, never from the manifest.
// `autoConnect` is the only persisted intent — whether the daemon dials this tunnel again on boot.
export const VpnProviderSchema = z.enum(["wireguard", "fortinet", "ipsec"]);
export type VpnProvider = z.infer<typeof VpnProviderSchema>;

const autoConnect = z.enum(["on", "off"]).default("on");

// FortiClient wraps every stored credential in its own "EncX <hex>" (older builds: "Enc <hex>") encryption,
// keyed to the machine that exported the config — it is NOT recoverable from the file. Pasting one is an easy
// mistake to make, because in the XML it sits exactly where the credential belongs, and the failure it causes
// is unreadable: phase 1 negotiates fine and IKE then reports "calculated HASH does not match HASH payload",
// which says nothing about where the bad value came from. Rejecting it here turns that into a sentence at the
// point of entry. (The FortiClient importer already drops these — this catches a hand-paste.)
// Exported so the add form can flag it inline on blur instead of only on a rejected round-trip — one
// definition of what "this is ciphertext, not a credential" means, shared by the browser and the daemon.
export const isForticlientCiphertext = (value: string): boolean => /^Enc[X]?\s+[0-9A-Fa-f]{8,}$/.test(value.trim());

const notForticlientCiphertext = <T extends z.ZodType<string>>(field: T, label: string): T =>
    field.refine((value) => !isForticlientCiphertext(value), {
        message: `That looks like a value copied straight out of a FortiClient config — FortiClient encrypts it with a key tied to the machine that exported it, so it can't be used here. Enter the actual ${label} (ask whoever administers the gateway).`,
    }) as unknown as T;

export const WireguardVpnConfigSchema = z.object({
    provider: z.literal("wireguard"),
    // The pasted .conf ([Interface] + [Peer]) — it holds the private key, so it's this arm's secret field.
    config: z.string().min(1),
    autoConnect,
});
export const FortinetVpnConfigSchema = z.object({
    provider: z.literal("fortinet"),
    // Gateway host only; the port is its own field so a pasted "host:port" can be split on import.
    server: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    username: z.string().min(1),
    password: notForticlientCiphertext(z.string().min(1), "password"),
    // A FortiGate on a self-signed/private-CA certificate: openconnect pins this digest
    // ("sha256:…", copied from its own refusal message) instead of trusting a CA. Absent ⇒ normal CA validation.
    trustedCert: z.string().min(1).optional(),
    // Some gateways scope a login to a realm/group (openconnect --usergroup, FortiClient's tunnel realm).
    realm: z.string().min(1).optional(),
    autoConnect,
});
export const IpsecVpnConfigSchema = z.object({
    provider: z.literal("ipsec"),
    server: z.string().min(1),
    presharedKey: notForticlientCiphertext(z.string().min(1), "pre-shared key"),
    // The local IKE identity (FortiClient's <localid>) — dial-up FortiGates key their phase-1 selection off it.
    localId: z.string().min(1).optional(),
    remoteId: z.string().min(1).optional(),
    // XAuth (FortiClient's <xauth>) — absent for PSK-only tunnels.
    username: z.string().min(1).optional(),
    password: notForticlientCiphertext(z.string().min(1), "XAuth password").optional(),
    ikeVersion: z.enum(["1", "2"]).default("1"),
    // Perfect Forward Secrecy for phase 2. Must match the gateway EXACTLY: it decides whether a KE payload is
    // sent in quick mode, and a mismatch fails with NO_PROPOSAL_CHOSEN only after phase 1 and XAuth have
    // succeeded — which reads like anything but a phase 2 problem. FortiClient stores it as <pfs> under
    // <ipsec_settings> and defaults it on, so that is the default here too.
    pfs: z.enum(["on", "off"]).default("on"),
    // The Diffie-Hellman group, as FortiClient numbers them. ONE field for both phases on purpose: in IKEv1
    // strongSwan sends a single KE payload in quick mode and the phase-2 group ends up following phase 1, so
    // offering a phase-1 list that starts with a different group than the gateway wants for phase 2 fails with
    // NO_PROPOSAL_CHOSEN no matter what the esp= line says. 14 (modp2048) is FortiClient's phase-2 default;
    // it is <dhgroup> under <ipsec_settings> in an export.
    dhGroup: z.enum(["2", "5", "14", "15", "16", "19", "20"]).default("14"),
    // IKEv1 aggressive mode: insecure by construction, and exactly what FortiGate dial-up with a group PSK
    // requires — hence opt-in per connection rather than a global strongSwan setting.
    aggressive: z.enum(["on", "off"]).default("on"),
    autoConnect,
});
export const VpnConfigSchema = z.discriminatedUnion("provider", [WireguardVpnConfigSchema, FortinetVpnConfigSchema, IpsecVpnConfigSchema]);
// A logged-in browser session the AGENT drives via Playwright MCP tools — for social platforms whose APIs can't
// cover "all the actions" (X reads are paywalled; X community-join and YouTube community-posts have no API). No
// secret in the manifest: the session lives in a persisted Chromium profile under .intentic/browser/<platform>,
// established once through the guided-login WebSocket (/system/browser-login). Chromium itself rides this kind's
// Dockerfile fragment, applied on an owner rebuild. One capability = one platform (the id doubles as the profile).
export const BrowserPlatformSchema = z.enum(["reddit", "x", "youtube"]);
export const BrowserConfigSchema = z.object({ platform: BrowserPlatformSchema });
// An ACP (Agent Client Protocol) agent served as a chat provider: the daemon spawns `command` as a long-lived
// subprocess speaking JSON-RPC over stdio, and the capability id becomes the provider id in the chat picker
// (see AgentProviderSchema). `command` is split on whitespace — no shell quoting. `env` is a pasted KEY=VALUE
// block (one per line); credentials ride here, so the whole block is the secret field (echoed as hasSecret) —
// the vpn-conf precedent. `loginCommand` is an interactive login the user completes in a visible terminal
// (device-code flows); the agent persists credentials in its own store inside the container. `name` is the
// picker's display label; absent = the id.
export const AcpAgentConfigSchema = z.object({
    command: z.string().min(1),
    name: z.string().min(1).optional(),
    env: z.string().optional(),
    loginCommand: z.string().min(1).optional(),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type WireguardVpnConfig = z.infer<typeof WireguardVpnConfigSchema>;
export type FortinetVpnConfig = z.infer<typeof FortinetVpnConfigSchema>;
export type IpsecVpnConfig = z.infer<typeof IpsecVpnConfigSchema>;
export type VpnConfig = z.infer<typeof VpnConfigSchema>;
export type BrowserPlatform = z.infer<typeof BrowserPlatformSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;

export const CapabilitySchema = z.discriminatedUnion("kind", [
    z.object({ id: entryId, kind: z.literal("devops"), config: z.object({}) }),
    // A pnpm+turbo monorepo the user scaffolds as its own repo; the `id` is the repo name. No config — apps are
    // added into it afterwards from its operator panel.
    z.object({ id: entryId, kind: z.literal("monorepo"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("mcp"), config: McpConfigSchema }),
    z.object({ id: entryId, kind: z.literal("service"), config: ServiceConfigSchema }),
    z.object({ id: entryId, kind: z.literal("integration"), config: IntegrationConfigSchema }),
    z.object({ id: entryId, kind: z.literal("cli"), config: CliConfigSchema }),
    z.object({ id: entryId, kind: z.literal("plugin"), config: PluginConfigSchema }),
    z.object({ id: entryId, kind: z.literal("extension"), config: ExtensionConfigSchema }),
    z.object({ id: entryId, kind: z.literal("ssh"), config: SshConfigSchema }),
    // No IFNAMSIZ cap on the id: the tunnel's interface name is DERIVED (see the daemon's vpn/vpn-paths.ts
    // interfaceName) rather than being the id itself, so a descriptive name is free.
    z.object({ id: entryId, kind: z.literal("vpn"), config: VpnConfigSchema }),
    // The in-sandbox Docker Engine (baked into the base image, dormant by default). No config: the capability's
    // whole effect is its fragment's `--privileged` runtime directive + running dockerd. No remove — the engine's
    // state (/var/lib/docker) and whatever runs on it make a silent de-privilege more destructive than useful.
    z.object({ id: entryId, kind: z.literal("docker"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("browser"), config: BrowserConfigSchema }),
    z.object({ id: entryId, kind: z.literal("agent"), config: AcpAgentConfigSchema }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilityStatusSchema = z.object({ state: CapabilityStateSchema, detail: z.string().optional() });
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
// The list row: manifest entry + live status. Secrets are never returned (an mcp token becomes hasToken).
export const CapabilitySummarySchema = z.object({
    id: z.string(),
    kind: CapabilityKindSchema,
    status: CapabilityStatusSchema,
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export const CapabilitiesListSchema = z.object({ capabilities: z.array(CapabilitySummarySchema) });
export const CapabilityIdParamSchema = z.object({ id: z.string() });
// POST /capabilities/{id}/secret body: replace just the capability's secret field (its key is per-kind, see the
// sandbox's secretField) and re-run its idempotent apply — the /secrets page's edit path.
export const CapabilitySecretInputSchema = z.object({ id: z.string(), value: z.string().min(1) });
// POST /capabilities/{id}/login response: the interactive tmux session running the agent's loginCommand,
// which the web surfaces in the terminal panel for the user to complete the sign-in.
export const CapabilityLoginSchema = z.object({ session: z.string() });

// ---- vpn: live tunnel state + connect/disconnect ----
// The manifest says which VPNs EXIST; this says which are UP right now. Every field is read back from the OS
// (wg show / ip / openconnect's pidfile / swanctl), never remembered by the daemon — so a tunnel the agent
// dropped from a shell and one the UI dropped read identically, and a daemon restart loses nothing.

export const VpnStateSchema = z.enum([
    // The tunnel is up and carrying traffic.
    "connected",
    // Dialling: openconnect authenticated but the interface has no address yet, or strongSwan is negotiating.
    "connecting",
    // Configured and idle — the normal resting state for a tunnel nobody asked for.
    "disconnected",
    // The tunnel's client isn't installed yet: the capability's image fragment needs an owner-run rebuild.
    "unavailable",
    // The last dial failed; `detail` carries the client's own message.
    "failed",
]);
export type VpnState = z.infer<typeof VpnStateSchema>;

export const VpnLinkSchema = z.object({
    id: z.string(),
    provider: VpnProviderSchema,
    state: VpnStateSchema,
    // The gateway this tunnel dials — host:port for fortinet, the [Peer] endpoint for wireguard, the IKE peer
    // for ipsec. Display only; never a secret.
    gateway: z.string().optional(),
    // The tun/wg interface carrying the tunnel, once it exists.
    interface: z.string().optional(),
    // The address the gateway assigned this sandbox — the single most useful "am I on the VPN?" fact.
    address: z.string().optional(),
    // The CIDRs routed into the tunnel ("0.0.0.0/0" = full tunnel). Empty until the link is up.
    routes: z.array(z.string()).default([]),
    // DNS servers the tunnel pushed, when it pushed any.
    dns: z.array(z.string()).default([]),
    // Epoch ms the link came up — the UI renders "connected 14m ago". Absent unless connected.
    since: z.number().optional(),
    // Whether the daemon re-dials this tunnel on boot (the manifest's autoConnect).
    autoConnect: z.boolean(),
    // Why it is failed/unavailable, or an extra note on a healthy link. Never carries credentials.
    detail: z.string().optional(),
});
export type VpnLink = z.infer<typeof VpnLinkSchema>;
export const VpnListSchema = z.object({ links: z.array(VpnLinkSchema) });

// POST /vpn/{id}/connect body. `otp` is a one-time 2FA code, supplied per dial and NEVER stored — a FortiGate
// with token auth rejects the dial without it, and the daemon surfaces that as a retry-with-a-code error.
export const VpnConnectInputSchema = z.object({ id: z.string(), otp: z.string().min(1).optional() });
export const VpnIdParamSchema = z.object({ id: z.string() });

// POST /vpn/import-forticlient: parse an exported FortiClient configuration (the XML FortiClient writes from
// File → Settings → Backup) into addable connections. Credentials in that file are wrapped in FortiClient's
// proprietary "EncX …" encryption, which is NOT reversible here — so a parsed connection carries the endpoint
// and, when it was stored in the clear, the username; the password is always typed by the user afterwards.
export const ForticlientImportInputSchema = z.object({ xml: z.string().min(1) });
export const ForticlientConnectionSchema = z.object({
    // FortiClient's connection name, slugged into a legal capability id.
    id: z.string(),
    // The original <name>, shown so the user recognises the connection they picked.
    label: z.string(),
    provider: VpnProviderSchema,
    server: z.string(),
    port: z.number(),
    // Present only when FortiClient stored it unencrypted; an EncX-wrapped username is dropped, not guessed.
    username: z.string().optional(),
    description: z.string().optional(),
    // ipsec-only, and only when the file stored them in the clear.
    localId: z.string().optional(),
    aggressive: z.boolean().optional(),
    // Phase-2 settings, read from <ipsec_settings> — the pair that decides whether quick mode can succeed.
    pfs: z.boolean().optional(),
    dhGroup: z.string().optional(),
    // What the user still has to supply for this connection to dial (always at least the password).
    needs: z.array(z.string()),
});
export type ForticlientConnection = z.infer<typeof ForticlientConnectionSchema>;
export const ForticlientImportSchema = z.object({ connections: z.array(ForticlientConnectionSchema) });

// Browse a Claude Code plugin marketplace (a git repo with .claude-plugin/marketplace.json). POST so the
// optional token for a private marketplace never rides a URL or an access log.
export const MarketplaceRequestSchema = z.object({ url: z.string().url(), token: z.string().min(1).optional() });
// One marketplace entry; `install` is the entry's source resolved onto PluginConfig shape (url/ref/path), so
// picking an entry just pre-fills the plugin form. Absent = a source the daemon can't clone (e.g. npm).
export const MarketplacePluginSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    // "extension" marks an intentic-extension entry (installs as the `extension` capability, sha-pinned);
    // absent/"plugin" = a Claude Code plugin. Claude Code ignores unknown marketplace fields, so one
    // marketplace repo serves both consumers.
    kind: z.enum(["plugin", "extension"]).optional(),
    install: z.object({ url: z.string(), ref: z.string().optional(), path: z.string().optional() }).optional(),
});
export type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;
export const MarketplaceSchema = z.object({ name: z.string(), plugins: z.array(MarketplacePluginSchema) });
export type Marketplace = z.infer<typeof MarketplaceSchema>;

// ---- extensions: installed extension-kind capabilities resolved to their manifests ----
// What the web extension host boots from: each row is an extension capability whose checkout still parses —
// the approved manifest (contribution declarations), and the checked-out commit (the code identity; the bundle
// route's ETag). A rotted checkout is skipped here; its capability row still shows status.
// The routing handle: a git-installed extension uses its capability entry id; an image-baked one has no
// capability entry and is addressed by the manifest-derived publisher.name — hence the dot in the pattern.
const extensionId = z
    .string()
    .min(1)
    .max(121)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const ExtensionSummarySchema = z.object({
    id: extensionId,
    manifest: ExtensionManifestSchema,
    commit: z.string(),
    // Image-baked first-party extension (no git checkout, not removable) vs a git-installed capability — the
    // web hides the uninstall affordance for baked ones.
    builtin: z.boolean(),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;
export const ExtensionsListSchema = z.object({ extensions: z.array(ExtensionSummarySchema) });
// The extension's contributes.settings values, persisted daemon-side (.intentic/extension-settings.json) keyed
// by the manifest-derived extension id — the checkout stays pristine, so a re-clone update never loses them.
// Secret-marked values are stripped from `settings`; `secretsSet` lists the secret keys that DO hold a value,
// so the UI renders "•••• (set)" without ever receiving the secret back.
export const ExtensionSettingsSchema = z.object({
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    secretsSet: z.array(z.string()),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
export const ExtensionSettingsInputSchema = z.object({
    id: z.string(),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
// One declared background process (contributes.processes) — status/start/stop, addressed by the capability
// entry id + the manifest's process name. Undeclared names are NOT_FOUND, the manifest-honesty rule again.
export const ExtensionProcessParamSchema = z.object({ id: z.string(), name: z.string() });
export const ExtensionProcessStatusSchema = z.object({
    name: z.string(),
    running: z.boolean(),
    port: z.number().optional(),
    previewUrl: z.string().optional(),
});
export type ExtensionProcessStatus = z.infer<typeof ExtensionProcessStatusSchema>;

// ---- automations: scheduled agent wake-ups (.intentic/automations.json) ----
// An automation wakes the agent autonomously: the daemon's scheduler fires each enabled automation on its
// trigger, runs the optional guard command (a shell command in the workspace; non-zero exit skips the wake),
// then runs one agent turn with the prompt. The manifest is user config; run history is daemon-recorded.

// `schedule` fires on its cron; `event` fires when an external system POSTs /automations/{id}/fire?token=…
// (a plain Hono route — webhook bodies are arbitrary). The token is the webhook's own auth (senders can't do
// Google ID tokens): optional on input — the daemon generates one on upsert — and always present in stored and
// listed automations, so the owner's UI can render the copyable URL.
// `listener` fires from a realtime source's connection to the provider (an extension's gateway process holds
// it, e.g. Discord) — no cron, no token, never reachable via /fire. channelId narrows to one channel; absent ⇒
// every channel the bot can read. eventType narrows to one kind of event (a Discord message, a live voice
// utterance batch, or a finished voice transcript); absent ⇒ all event kinds the source emits. mentioned
// narrows message events to those that @mention one of the workspace's bots or reply to a bot's message;
// absent ⇒ all messages. `provider` and `eventType` are open strings — a realtime source is now extension-
// declared (contributes.listener), so the daemon validates a listener trigger at upsert against `webchat` ∪ the
// installed extensions' declared providers/eventTypes rather than a hardcoded enum here.
// `webchat` is the exception: it has no gateway. An embeddable widget POSTs a visitor's message to
// /webchat/<id>/message and the agent's reply streams back over SSE. Its address is the public automation id, so
// allowedOrigins (the widget's embed sites) + a per-conversation rate limit are its abuse boundary — no secret
// token can live in a browser.
// `workspace` fires from the sandbox's OWN codebase instead of the outside world — see WorkspaceEventKindSchema.

// What the daemon emits as the fleet works, and what a `workspace` trigger names. These are the events a code
// CHORE runs on (continuous review, post-land checks): the daemon is both producer and consumer, so unlike
// `event` there is no token and no route — nothing outside the sandbox can reach them.
//
// The two OVERLAP on the common path: a clean turn auto-lands, firing both. A chore should name exactly one.
// `turn.settled` fires once per isolated turn whatever its outcome, so it also covers the errored and
// conflicted turns most worth a second pair of eyes, and it fires while the user is still looking at the diff —
// before they decide to land. `agent.landed` fires only when work actually reached the main tree, including an
// explicit Land from the review panel long after the turn ended.
export const WorkspaceEventKindSchema = z.enum(["turn.settled", "agent.landed"]);
export type WorkspaceEventKind = z.infer<typeof WorkspaceEventKindSchema>;

// The payload a workspace-triggered wake carries: one JSON object, in $AUTOMATION_PAYLOAD for the guard and
// appended to the prompt for the turn.
//
// `repos` names the change to look at as an OPEN span — `git -C <dir> diff <from>`, with no upper bound. Each
// `from` is where that repo stood before the turn (its last landed tip, or the base it branched from); the
// other end is deliberately the working tree rather than a sha, because a turn that ERRORED left its work
// uncommitted in the worktree and a commit-to-commit span would report it as nothing at all. `dir` is that
// repo's dir inside the agent's own checkout, so a chore reads the agent's work without touching /work.
//
// No diffstat rides along on purpose: the registry's counts are refreshed at land, so an errored or conflicted
// turn would carry stale numbers, and a guard that wants a size threshold gets the true one from
// `git -C <dir> diff --numstat <from>` for the price of one spawn.
export const WorkspaceEventSchema = z.object({
    event: WorkspaceEventKindSchema,
    agentId: z.string(),
    title: z.string().optional(),
    branch: z.string(),
    outcome: z.enum(["landed", "conflict", "idle", "error"]),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
});
export type WorkspaceEvent = z.infer<typeof WorkspaceEventSchema>;

export const TriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("schedule"), cron: z.string().min(1) }),
    z.object({ kind: z.literal("event"), token: z.string().min(1).optional() }),
    z.object({
        kind: z.literal("listener"),
        provider: z.string().min(1),
        channelId: z.string().min(1).optional(),
        eventType: z.string().min(1).optional(),
        mentioned: z.boolean().optional(),
        // webchat only: the website origins allowed to POST to the widget endpoint. Absent/empty ⇒ none admitted.
        allowedOrigins: z.array(z.string()).optional(),
    }),
    // `repo` narrows to events whose span touches one workspace repo ("root" or a repo id); absent ⇒ any.
    z.object({ kind: z.literal("workspace"), event: WorkspaceEventKindSchema, repo: z.string().min(1).optional() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const AutomationSchema = z.object({
    id: entryId,
    trigger: TriggerSchema,
    // Shell command run in the workspace root before waking; exit 0 ⇒ wake, non-zero ⇒ the run is "skipped".
    guard: z.string().min(1).optional(),
    prompt: z.string().min(1),
    // Which provider adapter serves the wake; absent ⇒ claude. Same dispatch as a chat turn (AgentTurnSchema.agent).
    agent: AgentProviderSchema.optional(),
    // Which harness (agentic loop) runs the wake; absent ⇒ native. Same semantics as AgentTurnSchema.harness.
    harness: AgentHarnessSchema.optional(),
    // Which model the wake runs on (see agent-catalog.ts modelsFor); absent ⇒ the provider's default.
    model: z.string().optional(),
    // When true, a fire doesn't wake the agent — it's held in the approvals queue until the owner approves.
    requireApproval: z.boolean().optional(),
    // A code CHORE: maintenance of THIS codebase rather than a reaction to the outside world. Purely a
    // classification — the daemon fires a chore exactly like any other automation — but it cannot be derived
    // from the trigger, which is why it is stored: a nightly `pnpm audit` sweep and a nightly Stripe poll are
    // both `schedule`, and belong on different shelves. Absent ⇒ an ordinary automation.
    chore: z.boolean().optional(),
    enabled: z.boolean(),
});
export type Automation = z.infer<typeof AutomationSchema>;

// A wake held for owner approval (.intentic/approvals/<id>.json, one file per held wake). It snapshots the
// trigger payload so an approved run replays exactly what fired, even across a daemon restart. The id is minted
// by the daemon (an entryId-safe filename).
export const AutomationApprovalSchema = z.object({
    id: entryId,
    automationId: z.string(),
    // The event/listener payload the wake would have carried; absent for schedule triggers.
    payload: z.string().optional(),
    // The provenance + title the held wake would have opened its conversation with — snapshotted alongside the
    // payload so an approved external wake surfaces on the fleet exactly as an auto one would have.
    origin: AgentOriginSchema.optional(),
    title: z.string().optional(),
    createdAt: z.number(),
});
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;
export const AutomationApprovalsListSchema = z.object({ approvals: z.array(AutomationApprovalSchema) });
export const AutomationApprovalIdParamSchema = z.object({ id: z.string() });

export const AutomationRunSchema = z.object({
    at: z.number(),
    // skipped = the guard said no; error = the guard passed but the agent turn surfaced an error.
    outcome: z.enum(["completed", "skipped", "error"]),
    detail: z.string().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// The list row: the stored automation + its recent runs + the next scheduled fire (absent when disabled).
export const AutomationSummarySchema = AutomationSchema.extend({
    runs: z.array(AutomationRunSchema),
    nextRun: z.number().optional(),
});
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export const AutomationsListSchema = z.object({ automations: z.array(AutomationSummarySchema) });
export const AutomationIdParamSchema = z.object({ id: z.string() });

// ---- drafts: agent-proposed posts awaiting owner approval (.intentic/drafts/<id>.json) ----
// One JSON file per draft. The AGENT creates drafts with its normal file tools — it can't call daemon routes,
// the same split as the environment proposal — while the daemon edits/deletes them on the owner's behalf, so
// the two writers never share a file. The id IS the filename (entryId charset ⇒ path-safe); the body never
// carries it. Posting is the agent's job too (there is no typed publish path): a "publish approved drafts"
// automation wakes the agent for due drafts, which posts via the platform skills and flips the status.

export const DraftStatusSchema = z.enum(["proposed", "approved", "posting", "posted", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

// The on-disk file body. proposed (agent) → approved (owner) → posting (publisher, set BEFORE acting so a dead
// turn can't double-post) → posted | failed. Reject = delete the file; retry = re-approve a failed draft.
export const DraftSchema = z.object({
    // Which skill posts it: "x" | "reddit" | "youtube" | "discord" | … — a bare string so new platforms need
    // no contract change; an unknown platform simply fails at posting time.
    platform: z.string().min(1),
    content: z.string().min(1),
    // Reddit posts / YouTube uploads need one.
    title: z.string().optional(),
    // Where on the platform: subreddit / Discord channel id / community.
    target: z.string().optional(),
    // Workspace-relative attachment paths, e.g. ".intentic/drafts/media/chart.png".
    media: z.array(z.string()).optional(),
    // Suggested post time (epoch ms, the at/nextRun convention). Optional — the agent may propose without a
    // date and the owner sets one at approval; an approved draft with no date posts as soon as it's picked up.
    scheduledAt: z.number().optional(),
    // Agent-written files only need platform + content; status defaults, the rest are optional, so a
    // well-formed proposal never lands in `invalid` just for omitting bookkeeping fields.
    status: DraftStatusSchema.default("proposed"),
    createdAt: z.number().optional(),
    postedAt: z.number().optional(),
    // Why posting failed; set with status "failed".
    error: z.string().optional(),
});
export type Draft = z.infer<typeof DraftSchema>;

// The list row / upsert input: the file body plus its filename id.
export const DraftSummarySchema = DraftSchema.extend({ id: entryId });
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
// `invalid` = filenames that failed to parse. Agent-written files are a trust boundary — without this a typo'd
// draft would silently never post.
export const DraftsListSchema = z.object({ drafts: z.array(DraftSummarySchema), invalid: z.array(z.string()) });
// entryId, not a bare string: the id becomes a filename under .intentic/drafts/.
export const DraftIdParamSchema = z.object({ id: entryId });

// ---- panels: per-repository dev servers + the content facts extensions detect on ----
// Every discovered git repo under /work is one list row: its runnable-panel runtime status (a `dev` script at
// operator/ or the repo root; the daemon runs it, auto-assigns a free port, and the preview proxy routes
// preview-<panelKey>-<sandboxId>.<zone> to it) PLUS content facts — evidence the web app's extensions run their
// detect() over, computed daemon-side in one pass so the browser never scans /work file-by-file.

export const PanelSummarySchema = z.object({
    // The repo id: its root-relative dir under /work (slashes become `--` in the preview subdomain label).
    repo: z.string(),
    // Whether the repo ships a runnable dev server (a package.json `dev` script at operator/ or the root).
    hasPanel: z.boolean(),
    running: z.boolean(),
    // A plain probe of the running panel's port; false when not running.
    healthy: z.boolean(),
    // The dev server's OS-assigned port; absent when not running.
    port: z.number().optional(),
    // https://preview-<repo>-<sandboxId>.<zone>; absent when the sandbox has no zone or connect token (loopback/tests).
    previewUrl: z.string().optional(),
    // The workspace role this repo dir occupies (the three fixed dirs); absent for extra clones.
    role: z.enum(["intent", "desired-state", "app"]).optional(),
    // Content facts: deploy.config.ts (the intent ledger's day-one marker), desired-state.json (present after
    // the first resolve), .intentic/ui/index.html (a sandboxed directory UI), pnpm-workspace.yaml +
    // turbo.json (a pnpm+turbo monorepo), and vitest evidence (a root vitest.config.ts, or "vitest" in the
    // root manifest / workspace catalog).
    deployConfig: z.boolean(),
    desiredState: z.boolean(),
    directoryUi: z.boolean(),
    monorepo: z.boolean(),
    vitest: z.boolean(),
});
export type PanelSummary = z.infer<typeof PanelSummarySchema>;
export const PanelsListSchema = z.object({ panels: z.array(PanelSummarySchema) });
export type PanelsList = z.infer<typeof PanelsListSchema>;
// The {repo} path param on the start/stop/terminals routes (a bare string: unknown repo is a handler NOT_FOUND).
export const PanelRepoParamSchema = z.object({ repo: z.string() });

// ---- ports: every listening TCP socket in the sandbox + explicit port forwarding ----
// Anything run in a terminal (a turbo TUI fanning out dev servers, `python -m http.server`, an agent's ad-hoc
// process) binds ports the daemon never assigned — the panel machinery can't see them. The /ports routes are
// the generic complement: `list` reports the live listeners (procfs scan, on demand), `forward` makes one
// reachable at port-<slot>-<sandboxId>.<zone> through the preview proxy. Forwarding is an explicit gesture —
// previews are public, so nothing is exposed until the owner (or an agent acting for them) asks.

export const PortSummarySchema = z.object({
    port: z.number(),
    // The loopback address the listener actually answers at inside the sandbox — a `localhost` bind can land
    // on ::1 only (Vite). The preview proxy and the desktop mirror (Mutagen forward) both dial this.
    host: z.enum(["127.0.0.1", "::1"]),
    // Whether the proxy can actually reach the listener at `host`. False for a bind to a loopback alias like
    // Docker's embedded DNS (127.0.0.11), which answers only at its own address, not 127.0.0.1 — such rows are
    // listed for transparency but the Ports view hides Preview and forwarding them is refused.
    forwardable: z.boolean(),
    // Which bucket the Ports view files it under: `workspace` = user-run (dev servers in repos, terminal
    // processes, published container ports) — the previewable set; `system` = the sandbox's own machinery
    // (agent runtimes, translator, dockerd, sshd), listed for transparency but nobody previews it.
    kind: z.enum(["workspace", "system"]),
    // The owning process, resolved from procfs; absent when no /proc/*/fd entry matched the socket's inode.
    pid: z.number().optional(),
    // How the row is labeled: the process argv joined with spaces ("node /work/app/node_modules/.bin/vite"),
    // falling back to the kernel `comm` name when argv is empty, or a synthesized name for attributable
    // infrastructure the pid walk can't reach ("Docker embedded DNS"). Absent only when wholly unattributable.
    command: z.string().optional(),
    // The process working directory (how the UI attributes a port to a repo).
    cwd: z.string().optional(),
    forwarded: z.boolean(),
    // https://port-<slot>-<sandboxId>.<zone>; present only while forwarded AND the sandbox has a zone + id.
    previewUrl: z.string().optional(),
});
export type PortSummary = z.infer<typeof PortSummarySchema>;
export const PortsListSchema = z.object({ ports: z.array(PortSummarySchema) });
export type PortsList = z.infer<typeof PortsListSchema>;

export const PortParamSchema = z.object({ port: z.number().int().min(1).max(65535) });
// `previewUrl` is absent on a loopback/no-tunnel sandbox — the slot is mapped, but no public hostname exists.
export const PortForwardResultSchema = z.object({ previewUrl: z.string().optional() });
export type PortForwardResult = z.infer<typeof PortForwardResultSchema>;

// ---- terminal ----
// EVERY attachable tmux session in the sandbox — the web app's ONE global terminal panel (the interactive I/O
// is the /system/terminal WebSocket, not oRPC): `shell` = a web-* session the user opened (numbered pill),
// `panel` = a panel-* dev-server session (labeled by its panel key, started via Start; running:false =
// untracked, e.g. a finished one-shot job's lingering shell), `agent` = an agent-* session the Claude agent's
// Bash commands run in (live-watchable, AI-marked in the UI; running:false once every window is a finished
// command's dead pane, which is what lets the panel sweep it), `job` = a job-* session the daemon's terminal
// runner executes user-triggered flows in (capability adds, infra check), `process` = a managed background
// process riding a panel session (an extension's declared processes, dockerd) — surfaced in the panel's
// background-processes popover with read-only log views, never as a killable tab; running is the actual
// process (a lingering shell after a crash reads false). A process row that maps to an installed extension's
// declared process carries extensionId+processName, the address for its /extensions start/stop routes. The
// `{name}` kill-route param is a bare string validated in the handler (a bad name is a BAD_REQUEST) since the
// same charset gates a `tmux kill-session -t` shell-out.
export const TerminalSessionSchema = z.object({
    name: z.string(),
    label: z.string().optional(),
    kind: z.enum(["shell", "panel", "agent", "job", "process"]),
    running: z.boolean(),
    extensionId: z.string().optional(),
    processName: z.string().optional(),
});
export const TerminalsListSchema = z.object({ sessions: z.array(TerminalSessionSchema) });
export type TerminalsList = z.infer<typeof TerminalsListSchema>;
export const TerminalNameParamSchema = z.object({ name: z.string() });

// ---- environment: the overlay Dockerfile extending the sandbox image ----
// The approved file is DAEMON-COMPOSED: pinned FROM + capability fragments + the owner-approved custom section.
// The agent writes the proposal file (.intentic/environment.Dockerfile — custom-section content only, no FROM)
// with its normal file tools; the owner approves it in the browser, which stores it as the custom file and
// recomposes the approved artifact whose sha256 the rebuild executor pins. Status is derived, never stored:
// applied = sha256(approved) === appliedHash; pending rebuild = approved present but hashes differ; proposed =
// proposal present with a hash different from custom's.

const environmentFileSchema = z.object({ content: z.string(), hash: z.string() });
export const EnvironmentSchema = z.object({
    proposal: environmentFileSchema.optional(),
    // The owner-approved agent-written custom section (.intentic/environment.custom.Dockerfile).
    custom: environmentFileSchema.optional(),
    approved: environmentFileSchema.optional(),
    // sha256 of the overlay the running container was built from (SANDBOX_ENVIRONMENT_HASH); absent = stock image.
    appliedHash: z.string().optional(),
    // config.sandbox.name — the UI derives the rebuild one-liner's slug from it.
    container: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const EnvironmentApproveSchema = z.object({ hash: z.string().min(1) });

// ---- secrets: user-supplied env-var secrets the daemon writes to desired-state/.env ----
// The web posts a Cloudflare token / GitHub PAT / another-host SSH key straight to the sandbox daemon (never
// through the platform); `apply` reloads .env each run so a new secret is picked up with NO restart. `list`
// returns KEYS ONLY — the values never leave the sandbox; `reveal` is the one deliberate, owner-only exception.
export const SecretSetSchema = z.object({
    key: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128),
    value: z.string().min(1),
});
export const SecretKeysSchema = z.object({ keys: z.array(z.string()) });
export const SecretKeyParamSchema = z.object({ key: z.string() });
export const SecretRevealSchema = z.object({ value: z.string() });

// One entry per secret the sandbox knows about, across every store: intent env secrets and intentic-generated
// passwords (from the desired-state repo), capability credentials, and AI-provider accounts. Values never ride
// this shape — `revealable` says whether `reveal` can return one (everything but provider accounts).
export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider entries; capability instance id
    // otherwise. Unique within the inventory — several accounts of one provider each get their own entry.
    key: z.string(),
    kind: z.enum(["env", "generated", "capability", "provider"]),
    // Display name for provider entries: "<ProviderName> · <accountLabel>". Absent on env/generated entries.
    label: z.string().optional(),
    status: z.enum(["missing", "set", "connected"]),
    // The artifact resources referencing this secret ({$secret} refs); [] for capability/provider entries.
    requiredBy: z.array(z.object({ resourceId: z.string(), type: z.string() })),
    // Human-readable provenance, e.g. "desired-state/.env" — the UI's "where does this live" line.
    storedAt: z.string(),
    revealable: z.boolean(),
    // Forgejo Actions replication state, present only after adopt on env|generated entries.
    ci: z.object({ synced: z.boolean(), pushedAt: z.string().optional() }).optional(),
});
export type SecretInventoryEntry = z.infer<typeof SecretInventoryEntrySchema>;
export const SecretInventorySchema = z.object({ entries: z.array(SecretInventoryEntrySchema) });

// ---- system ----

// version: what this daemon runs (baked). latest/updateAvailable: the daemon compares its version to the
// latest published `stable` release so the web can offer a non-blocking update (see system/version-check.ts).
export const InfoSchema = z.object({
    name: z.string().optional(),
    image: z.string().optional(),
    version: z.string().optional(),
    latest: z.string().optional(),
    updateAvailable: z.boolean().optional(),
});

// A daemon-minted session (system.session): the steady-state browser credential, exchanged for a verified
// Google ID token so Google UI is a sign-in moment instead of an hourly renewal. `expiresAt` is epoch ms —
// the browser renews ahead of it without parsing the token; `email` is who the daemon verified.
export const DaemonSessionSchema = z.object({ token: z.string(), expiresAt: z.number(), email: z.string() });
export type DaemonSession = z.infer<typeof DaemonSessionSchema>;

// Intentic-provided host SSH tunnel: minting it needs intentic's PLATFORM Cloudflare account, so the daemon
// can't do it directly — it relays to the platform authenticated by the connect token (the announce pattern).
// The panel embeds the returned connector token + hostname in its connect-host one-liner.
export const HostTunnelInputSchema = z.object({ hostName: z.string().min(1) });
export const HostTunnelSchema = z.object({ hostname: z.string(), tunnelToken: z.string() });

// ---- activity: the activity audit log (historyRoot/activity.jsonl) ----
// One provider-agnostic event per agent↔provider interaction, appended by the daemon only (never the agent —
// the log lives under historyRoot, outside /work, so the agent can't read or rewrite its own trail). Discord
// is the first source; other cli providers reuse the same shape.

export const ActivityEventSchema = z.object({
    id: z.string(),
    // Epoch ms; also the paging cursor.
    at: z.number(),
    // "discord", …; absent on provider-less system events (a cron automation.run).
    provider: z.string().optional(),
    // Which provider account handled the turn — the attribution key for per-account usage totals. Absent on
    // provider-less events and turns that ran on the provider's default account.
    account: z.string().optional(),
    direction: z.enum(["in", "out", "system"]),
    // in: message.received | voice_utterance.received | voice_transcript.received
    // out: message.send | reaction.add | messages.read | api.call (unclassified provider endpoint)
    // system: gateway.login_failed | dispatch.failed | voice.session_started | voice.session_ended | automation.run
    //         | turn.started | turn.plan | turn.error | turn.completed (agent turn lifecycle; provider = claude/codex)
    type: z.string(),
    channelId: z.string().optional(),
    // Inbound author display name.
    author: z.string().optional(),
    // Full message text (inbound) or sent payload content (outbound).
    content: z.string().optional(),
    // Outbound HTTP method + endpoint path (tokens ride headers, never URLs).
    method: z.string().optional(),
    endpoint: z.string().optional(),
    // The agent turn that made/handled it — the join key between an inbound wake and its outbound calls.
    sessionId: z.string().optional(),
    automationIds: z.array(z.string()).optional(),
    outcome: z.enum(["ok", "error"]).optional(),
    error: z.string().optional(),
    // Source-specific detail: guildId, attachments, transcript path, participants…
    extra: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityQuerySchema = z.object({
    provider: z.string().optional(),
    limit: z.coerce.number().min(1).max(500).default(100),
    // `at` cursor, exclusive — newest-first paging.
    before: z.coerce.number().optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;
export const ActivityListSchema = z.object({ events: z.array(ActivityEventSchema) });

// Live connection health, probed per provider capability (not stored): gateway state from the client pool
// (idle = the gateway is up but has no enabled listener automation to connect for — distinct from a
// connection that should be up but isn't), lastError from the newest system-error event in the recent log.
export const ActivityConnectionSchema = z.object({
    capabilityId: z.string(),
    provider: z.string(),
    gateway: z.enum(["ready", "connecting", "disconnected", "idle"]),
    lastError: z.string().optional(),
});
export const ActivityStatusSchema = z.object({
    connections: z.array(ActivityConnectionSchema),
    // The daemon's live voice session, when one is up.
    voice: z.object({ channelId: z.string(), channelName: z.string(), startedAt: z.number(), participants: z.array(z.string()) }).optional(),
});
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

// ---- usage: the durable spend ledger ----
// One row per attributed turn, appended at turn end and NEVER pruned. This exists because the activity log
// can't answer a money question: it prunes to its most recent entries, so a month's spend is unanswerable and
// — worse for a cost readout — the totals SHRINK as newer turns evict older ones. The ledger keeps the raw
// per-turn facts and the rollup projects them on read, so a new grouping (by day, by model, by conversation)
// needs no new storage and no migration.
export const UsageTurnSchema = z.object({
    // Epoch ms at turn end. Kept alongside `day` so a future timezone-aware rollup is a pure change over data
    // already on disk.
    at: z.number(),
    // The UTC calendar day (YYYY-MM-DD) `at` fell in — precomputed so a rollup never re-derives a timezone.
    day: z.string(),
    provider: z.string(),
    // Absent on an env-token turn, which has no account to attribute to (same rule as the activity log).
    account: z.string().optional(),
    // The model the turn ACTUALLY ran, resolved past the client's pick and every provider default. Absent only
    // when the provider's own subscription default served it without the daemon naming one.
    model: z.string().optional(),
    harness: z.string(),
    // The conversation this turn belonged to, so spend can join to a fleet agent. Absent on a main-tree turn.
    conversationId: z.string().optional(),
    // The provider's own turn count for the request (a Claude "turn" can be several under the hood), so turns
    // and cost stay comparable across providers. 1 when the provider reported none.
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
});
export type UsageTurn = z.infer<typeof UsageTurnSchema>;

// The ledger grouped by day × provider × account × model × harness × conversation — the finest grouping any
// dashboard panel needs, and a handful of rows per active day instead of one per turn, so a year of history is
// well under a MB over the tunnel. Every panel (spend per day, cost by model, cost by agent, cache hit rate) is
// a projection of these.
// The conversation is in the KEY, not merely along for the ride, because cost-by-agent has to answer within the
// same window as every other panel on the screen. The fleet registry also carries a per-agent total, but only a
// cumulative, all-time one — reading it beside a "last 7 days" filter would print an all-time number under a
// windowed heading, which is the shrinking-totals bug wearing a different hat.
export const UsageRollupRowSchema = z.object({
    day: z.string(),
    provider: z.string(),
    account: z.string().optional(),
    model: z.string().optional(),
    harness: z.string(),
    conversationId: z.string().optional(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
    durationMs: z.number(),
});
export type UsageRollupRow = z.infer<typeof UsageRollupRowSchema>;
// Inclusive UTC day bounds (YYYY-MM-DD). Both absent ⇒ the whole ledger.
export const UsageRollupQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
});
export type UsageRollupQuery = z.infer<typeof UsageRollupQuerySchema>;
export const UsageRollupSchema = z.object({ rows: z.array(UsageRollupRowSchema) });

// ---- usage: per-account token/cost totals ----
// The account picker's headroom readout, folded from the ledger above (all-time, not a log window), grouped by
// provider+account. `account` is the attribution key, so env-token turns are excluded rather than pooled under
// a blank id — an unattributed turn belongs to no account's total.
export const UsageAccountSchema = z.object({
    provider: z.string(),
    account: z.string(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    costUsd: z.number(),
});
export type UsageAccount = z.infer<typeof UsageAccountSchema>;
export const UsageSummarySchema = z.object({ accounts: z.array(UsageAccountSchema) });

// ---- logs: daemon-owned debug logs (historyRoot/logs) ----
// Terminal pipe-pane captures (terminals/), intentic CLI run logs (intentic-runs/), and the daemon's own pino
// file (daemon.log) — written by the daemon/tmux only, under historyRoot so the agent can't rewrite them.

export const LogFileEntrySchema = z.object({
    // Path relative to the logs root, e.g. "terminals/web-1-%0.log" or "daemon.log".
    name: z.string(),
    sizeBytes: z.number(),
    // Epoch ms mtime.
    modifiedAt: z.number(),
});
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export const LogsListSchema = z.object({ files: z.array(LogFileEntrySchema) });

// `name` rides the query (log names contain slashes, which don't fit a path segment); `bytes` is the tail
// size — the newest bytes win when the file is larger.
export const LogReadQuerySchema = z.object({
    name: z.string().min(1),
    bytes: z.coerce.number().min(1).max(1_048_576).default(65_536),
});
export const LogReadSchema = z.object({
    name: z.string(),
    sizeBytes: z.number(),
    // The tail text; truncated when the file holds more than the requested bytes.
    text: z.string(),
    truncated: z.boolean(),
});
export type LogRead = z.infer<typeof LogReadSchema>;

// A tab's self-report of what it is looking at, keyed by its /events connection's clientId. Full replace,
// not a merge — an absent field means "cleared", so a tab leaving a file drops the path with the same report.
export const PresenceReportSchema = z.object({
    clientId: z.string(),
    idle: z.boolean(),
    view: z.string().optional(),
    sessionId: z.string().optional(),
    path: z.string().optional(),
});
export type PresenceReport = z.infer<typeof PresenceReportSchema>;

// ---- push: web-push notifications to the owner's devices ----
// The daemon is the only tier that knows what the agent is doing, so it is the sender. Subscriptions are
// per-BROWSER (the endpoint is minted by that browser's push service — Google's, Mozilla's, Apple's), which
// is why they live here and not on the platform: the platform is off the command path and would have to be
// told about every turn to be useful.

// A browser's PushSubscription, in the exact shape `web-push` consumes — the browser produces it via
// PushManager.subscribe() and the client posts it back verbatim, so the daemon never reshapes it.
export const PushSubscriptionSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        // The client's public key and auth secret for payload encryption (RFC 8291). Opaque base64url here.
        p256dh: z.string().min(1),
        auth: z.string().min(1),
    }),
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

// What the service worker renders. `url` is the in-app route the notification opens (the click handler
// focuses an existing tab there rather than spawning a new one); `tag` collapses repeats — a second
// "waiting on you" for the same conversation REPLACES the first instead of stacking. Push payloads are
// capped by the push services themselves (~4KB after encryption), which is why nothing here carries a
// transcript or a diff — the notification is a pointer back into the workspace, not a delivery mechanism
// for content.
export const PushNotificationSchema = z.object({
    title: z.string().min(1),
    body: z.string(),
    url: z.string().optional(),
    tag: z.string().optional(),
    // Whether the notification stays on screen until dismissed. Set for the "agent is blocked on you" cases,
    // where a notification that auto-dismisses is a request that silently went unanswered.
    requireInteraction: z.boolean().optional(),
});
export type PushNotification = z.infer<typeof PushNotificationSchema>;

// The VAPID public key a browser needs to subscribe, plus whether this browser's endpoint is already known —
// so the settings toggle can render its true state instead of trusting the browser's permission alone (a
// granted permission with no server-side row would notify nothing).
export const PushConfigSchema = z.object({ publicKey: z.string(), subscribed: z.boolean() });
export const PushEndpointSchema = z.object({ endpoint: z.string().url() });
// The optional `endpoint` says WHICH browser is asking; without it `subscribed` could only speak for the
// sandbox as a whole, which is never the question the settings toggle needs answered.
export const PushConfigQuerySchema = z.object({ endpoint: z.string().url().optional() });

// What a test send actually achieved. `{ ok: true }` would be a lie the one place it matters most: the button
// exists to prove a chain the user cannot inspect, so "the daemon accepted the request" is not the answer to
// the question being asked. A count separates "your OS swallowed it" from "nothing was sent at all".
export const PushTestSchema = z.object({ delivered: z.number().int().nonnegative() });
export type PushTest = z.infer<typeof PushTestSchema>;
