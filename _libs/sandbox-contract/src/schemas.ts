import { ExtensionManifestSchema } from "@intentic/extension-api";
import { z } from "zod";

// All request/response wire schemas for the sandbox daemon. Inputs that carry a `{param}` in their route path
// (repo / id / name) merge the path param into the same flat object — oRPC fills the path placeholder from the
// matching key and routes the rest to the body (POST/PUT) or query (GET).

// ---- shared ----

// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({ ok: z.literal(true) });

// Which repo a git route targets: "root" (the /work workspace repo) or a directory name under
// /work/repositories (the three roles + extra clones). Kept as a bare string on the wire (not an enum) so an
// unknown repo is a handler-thrown NOT_FOUND — matching the daemon's prior 404 — rather than an
// input-validation rejection.
export const RepoParamSchema = z.object({ repo: z.string() });

// ---- agent ----

export const SessionTranscriptMessageSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });

// The agent runtimes the daemon can serve (the provider adapters) — the vocabulary every surface that picks
// an agent shares (chat turns, automations). See AgentTurnSchema.agent for the dispatch semantics.
export const AgentProviderSchema = z.enum(["claude", "codex", "grok"]);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

// The harness (agentic loop) a turn runs on, orthogonal to the provider. See AgentTurnSchema.harness.
export const AgentHarnessSchema = z.enum(["native", "claude-code"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;

export const AgentTurnSchema = z
    .object({
        prompt: z.string(),
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
        // retire sessions). Keys the fleet registry entry and the conversation's worktree. Constrained because
        // it lands in branch names (agent/<id>) and filesystem paths — the regex is the injection guard.
        conversationId: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
            .optional(),
        // When true, the turn runs in the conversation's isolated git worktree (created lazily on first use)
        // instead of the shared /work tree — the parallel-agents mode. Requires conversationId.
        isolated: z.boolean().optional(),
        // The client-held transcript of a conversation that just switched provider/account: seeds the FIRST
        // turn of the replacement session. The daemon folds it into the prompt as one role-attributed context
        // preamble for every runtime. Mutually exclusive with sessionId — a resumed session has its context.
        history: z.array(SessionTranscriptMessageSchema).max(200).optional(),
        // The browser sends the chosen model per turn; the provider token is the sandbox's own stored credential.
        model: z.string().optional(),
        // When true, run the always-plan flow (propose → approve → execute). Reasoning controls are optional.
        plan: z.boolean().optional(),
        effort: z.string().optional(),
        thinking: z.boolean().optional(),
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
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

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
export const AgentAttentionSchema = z.object({ plan: z.boolean(), question: z.boolean(), conflict: z.boolean() });
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
    attention: AgentAttentionSchema,
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export const AgentsListSchema = z.object({ agents: z.array(AgentSummarySchema) });
export const AgentIdSchema = z.object({ id: z.string().min(1) });
export const AgentFileDiffQuerySchema = z.object({ id: z.string().min(1), repo: z.string().min(1), path: z.string().min(1) });
// land's outcome: per-repo conflicts (dirty-main overlaps or merge conflicts); landed only when every repo
// with changes merged cleanly. Conflicted repos keep their worktree state — nothing is lost.
export const LandResultSchema = z.object({
    landed: z.boolean(),
    conflicts: z.array(z.object({ repo: z.string(), paths: z.array(z.string()) })).optional(),
});
export type LandResult = z.infer<typeof LandResultSchema>;

// ---- routed-provider subscriptions ----

// The providers whose model can run UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
// which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. The `claude` provider is
// absent — native Anthropic OAuth serves it directly, without the translator.
export const KeyedProviderSchema = z.enum(["codex", "grok"]);
export type KeyedProvider = z.infer<typeof KeyedProviderSchema>;

// Which routed-provider subscriptions are connected in the translator (per provider). Drives the
// "connected / connect subscription" state in Sandbox ▸ Agent.
export const TranslatorAccountsSchema = z.object({ codex: z.boolean(), grok: z.boolean() });
export type TranslatorAccounts = z.infer<typeof TranslatorAccountsSchema>;

// Side-channel bodies: the UI posts these to resolve a turn paused on a plan approval / question.
export const DecisionSchema = z.object({ decisionId: z.string().min(1), approve: z.boolean(), feedback: z.string().optional() });
export const AnswerSchema = z.object({
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string())).optional(),
    cancelled: z.boolean().optional(),
});

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
export const CodexDeviceStartSchema = z.object({
    userCode: z.string(),
    deviceAuthId: z.string(),
    interval: z.number(),
    verificationUri: z.string(),
});
export const CodexDevicePollSchema = z.object({ deviceAuthId: z.string().min(1), userCode: z.string().min(1), label: z.string().optional() });
// The poll answer: `pending` while the user is still signing in; the created account once done.
export const CodexPollResultSchema = z.object({ pending: z.boolean(), account: OauthAccountSchema.optional() });
// xAI Grok (via OpenCode) uses subscription OAuth via the headless device-code method. `start` returns the
// `url` the user opens (xAI's verification_uri_complete, which pre-fills the code) and `code` — the same
// one-time code, surfaced so the card matches x.ai exactly. There is no paste-back: OpenCode polls to
// completion and the UI polls `/grok/accounts`.
// ponytail: OpenCode holds one xAI auth per data dir, so Grok stays single-account — the list is 0 or 1. Per
// account would need an OpenCode server per data dir; add when there's demand.
// A device-code login start: the verification URL + the one-time code the user enters there. Shared by the
// native Grok flow (via OpenCode) and the routed-provider subscription connect (codex/grok via CLIProxyAPI).
export const DeviceStartSchema = z.object({ url: z.string(), code: z.string() });
// A provider's model catalog, resolved daemon-side from live discovery with a persisted last-known-good list and
// a seed floor (Grok via opencode.ts xaiModels, Codex via codex-models.ts, Claude via the Agent SDK's
// supportedModels) — never empty, so the picker is never blank. `label` is the humanized display name; `default`
// is the model a fresh chat on that provider seeds (always present). Shared by /grok/models, /codex/models,
// /claude/models. `efforts` is the reasoning-effort tiers the model accepts (Claude reports them per model);
// empty ⇒ the client's default tiers.
export const ModelSchema = z.object({ id: z.string(), label: z.string(), efforts: z.array(z.string()).optional() });
export const ModelsSchema = z.object({ models: z.array(ModelSchema), default: z.string() });

// ---- sessions ----

export const SessionIdParamSchema = z.object({ id: z.string() });
export const SessionSummarySchema = z.object({ id: z.string(), title: z.string(), updatedAt: z.number() });
export const SessionsListSchema = z.object({ sessions: z.array(SessionSummarySchema) });
export const SessionTranscriptSchema = z.object({ messages: z.array(SessionTranscriptMessageSchema) });

// ---- settings: per-sandbox agent settings (.intentic/settings.json) ----
// Small user-owned config the /settings routes edit and streamAgent reads — all opt-in booleans the owner
// toggles in the UI (so each can be A/B benchmarked):
//   searchPastChats   — gates the search_past_chats agent tool (off ⇒ not registered, agent can't read prior chats).
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
//                        (the rtk binary from its installed extension, rewritten at the PreToolUse hook) — an
//                        A/B backend switch, so native and rtk can be benchmarked head-to-head.
// The booleans default off, skills defaults [] (no skill loaded), outputCleaners defaults "off" (cleaning off),
// outputHoldout 0, filterBackend "native" — a fresh sandbox starts with cleaning and iq off until the owner enables them.

export const SandboxSettingsSchema = z.object({
    searchPastChats: z.boolean(),
    stableSystemPrompt: z.boolean(),
    skills: z.array(z.string()),
    hashlineEdits: z.boolean(),
    terseOutput: z.boolean(),
    iqSearch: z.boolean(),
    outputCleaners: z.string(),
    outputHoldout: z.number().min(0).max(1),
    filterBackend: z.enum(["native", "rtk"]),
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

export const CommitSchema = RepoParamSchema.extend({
    message: z.string().min(1),
    // Repo-relative paths to commit; absent ⇒ commit everything changed in the repo.
    paths: z.array(z.string().min(1)).max(500).optional(),
});
export const DiscardSchema = RepoParamSchema.extend({
    // Repo-relative paths to discard; absent ⇒ discard every uncommitted change in the repo.
    paths: z.array(z.string().min(1)).max(500).optional(),
});
export const PushSchema = RepoParamSchema.extend({ branch: z.string().min(1) });
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitFileWriteSchema = RepoParamSchema.extend({ path: z.string().min(1), content: z.string() });
export const GitFileDiffQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitStatusSchema = z.object({ branch: z.string(), dirty: z.boolean(), files: z.array(z.string()) });
export const GitFilesSchema = z.object({ files: z.array(z.string()) });
export const GitFileSchema = z.object({ path: z.string(), content: z.string() });
export const CommitResultSchema = z.object({ committed: z.boolean() });
// One uncommitted change in a repo's working tree (status vs HEAD, untracked included).
export const GitChangeSchema = z.object({
    // Repo-relative path with forward slashes; for "renamed" the NEW path (`from` carries the old one).
    path: z.string(),
    status: z.enum(["added", "modified", "deleted", "renamed", "type-changed"]),
    from: z.string().optional(),
});
export type GitChange = z.infer<typeof GitChangeSchema>;
export const RepoChangesSchema = z.object({
    // The {repo} param the per-repo git routes accept: "root" or a directory name under repositories/.
    repo: z.string(),
    // Absent on an unborn HEAD (a repo initialized but never committed).
    branch: z.string().optional(),
    changes: z.array(GitChangeSchema),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
// The aggregated review set across every repo (root + repositories/*); only repos with changes appear.
export const GitChangesSchema = z.object({ repos: z.array(RepoChangesSchema) });
export type GitChanges = z.infer<typeof GitChangesSchema>;

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
// (Implementation detail, not part of the contract: the daemon backs this route by shelling the baked search CLI
// and parsing its JSON; the engine is interchangeable behind this shape.) Groups are relevance-ranked (best
// first, never path order); each hit carries the match-reason tags the fused engines contributed. `start`/`end`
// are char offsets within `text` so clients highlight without re-finding the needle.
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

// ---- workspace repos ----

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
// A WireGuard tunnel the agent's traffic rides. `config` is the pasted .conf ([Interface] + [Peer]) — it holds
// the private key, so it's a secret like an mcp token. `enabled` is the on/off toggle (its default is set by
// the app repo's catalog entry): "on" ⇒ apply brings the tunnel up and the daemon restores it on boot; "off" ⇒
// the conf is stored but the tunnel stays down. The id doubles as the wg interface name, hence the union arm
// below caps it at Linux's 15-char IFNAMSIZ limit.
export const VpnConfigSchema = z.object({ config: z.string().min(1), enabled: z.enum(["on", "off"]).default("on") });
// In-sandbox Docker Engine + Compose, so `pnpm db:up` (dev databases) works like a local dev machine. Bringing
// the tooling in needs a privileged runtime, so — like vpn — the daemon composes a Dockerfile fragment + the
// `--privileged` run flag into the environment overlay, applied by an owner-run rebuild. `enabled` toggles
// whether the daemon starts dockerd (on boot + on apply).
export const DockerConfigSchema = z.object({ enabled: z.enum(["on", "off"]).default("on") });
// A logged-in browser session the AGENT drives via Playwright MCP tools — for social platforms whose APIs can't
// cover "all the actions" (X reads are paywalled; X community-join and YouTube community-posts have no API). No
// secret in the manifest: the session lives in a persisted Chromium profile under .intentic/browser/<platform>,
// established once through the guided-login WebSocket (/system/browser-login). Chromium itself rides this kind's
// Dockerfile fragment, applied on an owner rebuild. One capability = one platform (the id doubles as the profile).
export const BrowserPlatformSchema = z.enum(["reddit", "x", "youtube"]);
export const BrowserConfigSchema = z.object({ platform: BrowserPlatformSchema });
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type VpnConfig = z.infer<typeof VpnConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
export type BrowserPlatform = z.infer<typeof BrowserPlatformSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

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
    z.object({ id: entryId.max(15), kind: z.literal("vpn"), config: VpnConfigSchema }),
    z.object({ id: entryId, kind: z.literal("docker"), config: DockerConfigSchema }),
    z.object({ id: entryId, kind: z.literal("browser"), config: BrowserConfigSchema }),
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
// Every git repo under /work/repositories is one list row: its runnable-panel runtime status (a `dev` script at
// operator/ or the repo root; the daemon runs it, auto-assigns a free port, and the preview proxy routes
// preview-<repo>-<sandboxId>.<zone> to it) PLUS content facts — evidence the web app's extensions run their
// detect() over, computed daemon-side in one pass so the browser never scans /work file-by-file.

export const PanelSummarySchema = z.object({
    // The repository directory name under /work/repositories (also the preview subdomain label).
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

// ---- terminal ----
// EVERY attachable tmux session in the sandbox — the web app's ONE global terminal panel (the interactive I/O
// is the /system/terminal WebSocket, not oRPC): `shell` = a web-* session the user opened (numbered pill),
// `panel` = a panel-* dev-server session (labeled by its panel key, started via Start; running:false =
// untracked, e.g. a finished one-shot job's lingering shell), `agent` = an agent-* session the Claude agent's
// Bash commands run in (live-watchable, AI-marked in the UI), `job` = a job-* session the daemon's terminal
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

// ---- secrets: user-supplied env-var secrets the daemon writes to repositories/desired-state/.env ----
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

// Intentic-provided host SSH tunnel: minting it needs intentic's PLATFORM Cloudflare account, so the daemon
// can't do it directly — it relays to the platform authenticated by the connect token (the announce pattern).
// The panel embeds the returned connector token + hostname in its connect-host one-liner.
export const HostTunnelInputSchema = z.object({ hostName: z.string().min(1) });
export const HostTunnelSchema = z.object({ hostname: z.string(), tunnelToken: z.string() });

// ---- activity: the agent-activity audit log (historyRoot/activity.jsonl) ----
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

// ---- usage: per-account token/cost totals ----
// Aggregated from the activity log's turn.completed events (their `usage` extra), grouped by provider+account.
// Totals cover the retained log window (the log prunes to its most recent entries), not all-time.
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
