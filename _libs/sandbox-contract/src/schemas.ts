import { ExtensionManifestSchema } from "@intentic/extension-api";
import { z } from "zod";

// All request/response wire schemas for the sandbox daemon. Inputs that carry a `{param}` in their route path
// (repo / id / name) merge the path param into the same flat object — oRPC fills the path placeholder from the
// matching key and routes the rest to the body (POST/PUT) or query (GET).

// ---- shared ----

// Success ack for routes that only report completion (push / disconnect / self-host register). A turn paused on
// a plan/question that no longer exists, or a missing repo/path, is an ORPCError thrown by the handler instead.
export const OkSchema = z.object({ ok: z.literal(true) });

// The three workspace repos, by role. Kept as a bare string on the wire (not an enum) so an unknown repo is a
// handler-thrown NOT_FOUND — matching the daemon's prior 404 — rather than an input-validation rejection.
export const RepoParamSchema = z.object({ repo: z.string() });

// ---- agent ----

export const SessionTranscriptMessageSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string() });

export const AgentTurnSchema = z
    .object({
        prompt: z.string(),
        // Workspace-relative paths of files the user attached, already uploaded via /workspace/upload
        // (the browser puts them under .intentic/attachments/<uuid>/<name>). The daemon hands them to the
        // provider: Claude reads them from disk via its Read tool; Codex gets images as native inputs.
        attachments: z.array(z.string().min(1)).max(20).optional(),
        // Which agent runtime serves the turn; absent = claude. A sessionId only resumes on the provider that
        // minted it (Claude Code sessions vs Codex threads vs Grok/OpenCode sessions are separate stores) —
        // a mid-conversation provider/account switch sends `history` instead of resuming.
        agent: z.enum(["claude", "codex", "grok"]).optional(),
        // Which connected account of that provider serves the turn; absent = the provider's first account.
        account: z.string().optional(),
        sessionId: z.string().optional(),
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
    });
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

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
export const GrokDeviceStartSchema = z.object({ url: z.string(), code: z.string() });
// xAI's live model catalog, read from OpenCode's provider.list() (the runtime source of truth) so the picker
// never drifts from xAI's renames. `label` is the model's display name; `default` is OpenCode's default model
// id for the provider (absent ⇒ the client falls back to the empty model, letting OpenCode choose).
export const GrokModelSchema = z.object({ id: z.string(), label: z.string() });
export const GrokModelsSchema = z.object({ models: z.array(GrokModelSchema), default: z.string().optional() });

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
//   lspTools          — loads the `lsp` skill so the agent uses the baked LSP CLI (rename + diagnostics over the
//                        TS language server); off ⇒ the skill isn't present so the agent doesn't reach for it.
//   hashlineEdits     — swaps the native Read/Edit/Write for hash-anchored edits on the Claude path (stale-file
//                        guard + fewer output tokens); off ⇒ the native file tools.
// All default off (see the store's DEFAULTS), so a sandbox behaves identically until the owner opts in.

export const SandboxSettingsSchema = z.object({
    searchPastChats: z.boolean(),
    stableSystemPrompt: z.boolean(),
    lspTools: z.boolean(),
    hashlineEdits: z.boolean(),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

// ---- intentic CLI ----

export const IntenticRunSchema = z.object({ args: z.array(z.string()) });

// ---- git ----

export const CommitSchema = RepoParamSchema.extend({ message: z.string().min(1) });
export const PushSchema = RepoParamSchema.extend({ branch: z.string().min(1) });
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1) });
export const GitFileWriteSchema = RepoParamSchema.extend({ path: z.string().min(1), content: z.string() });
export const GitStatusSchema = z.object({ branch: z.string(), dirty: z.boolean(), files: z.array(z.string()) });
export const GitFilesSchema = z.object({ files: z.array(z.string()) });
export const GitFileSchema = z.object({ path: z.string(), content: z.string() });
export const CommitResultSchema = z.object({ committed: z.boolean() });

// ---- history: daemon-owned workspace snapshots (diff + restore) ----
// The daemon snapshots /work into bare git dirs on /history (outside the agent's reach) after every turn and on
// an interval. A "snapshot" groups one commit per scope (root + each nested repo) under a shared id.

export const SnapshotTriggerSchema = z.enum(["turn", "interval", "manual", "pre-restore", "restore", "user"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export const SnapshotSchema = z.object({
    id: z.string(),
    // Committer time, ms since epoch.
    at: z.number(),
    trigger: SnapshotTriggerSchema,
    // The scopes that changed in this snapshot: "root" or "repositories/<name>".
    scopes: z.array(z.string()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const SnapshotsListSchema = z.object({ snapshots: z.array(SnapshotSchema) });
export const SnapshotIdSchema = z.object({ id: z.string().min(1) });
// `base` (optional) diffs the snapshot against an earlier one — the aggregate change since then, for review.
export const SnapshotDiffQuerySchema = SnapshotIdSchema.extend({ base: z.string().min(1).optional() });
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
    base: z.string().min(1).optional(),
});
// Both sides of a file at a snapshot vs its parent; an absent side means the file was added/deleted. Binary or
// oversized content is flagged instead of shipped.
export const SnapshotFileDiffSchema = z.object({
    before: z.string().optional(),
    after: z.string().optional(),
    binary: z.boolean().optional(),
    truncated: z.boolean().optional(),
});
export type SnapshotFileDiff = z.infer<typeof SnapshotFileDiffSchema>;
// Manual snapshot result: id is absent when nothing changed since the last snapshot.
export const SnapshotResultSchema = z.object({ id: z.string().optional() });

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
// ---- iq search ----

// The iq search result — one wire shape for `iq --json` stdout, the daemon's /workspace/search route, and the
// web client. Groups are relevance-ranked (best first, never path order); each hit carries the match-reason
// tags the fused engines contributed. `start`/`end` are char offsets within `text` so clients highlight without
// re-finding the needle.
export const IqSearchQuerySchema = z.object({
    query: z.string().min(2).max(512),
    // Search verbs only — anchor/git verbs (outline, context, log, who, …) are CLI-only surface.
    mode: z.enum(["q", "find", "files", "def", "refs", "sym", "ast", "ask"]).optional(),
    includeIgnored: z.stringbool().optional(),
    limit: z.coerce.number().int().positive().optional(),
    after: z.string().optional(),
});
export const IqTagSchema = z.object({
    kind: z.enum(["def", "text", "sem", "bm25", "rerank", "path", "import", "call", "type", "write", "fuzzy", "heuristic"]),
    score: z.number().optional(),
});
export type IqTag = z.infer<typeof IqTagSchema>;
export const IqHitSchema = z.object({
    line: z.number(),
    text: z.string(),
    start: z.number().optional(),
    end: z.number().optional(),
    tags: z.array(IqTagSchema),
    // Enclosing symbol ("createWidget (fn)") — parent-document context so the reader often needs no follow-up.
    context: z.string().optional(),
});
export type IqHit = z.infer<typeof IqHitSchema>;
export const IqGroupSchema = z.object({ path: z.string(), score: z.number(), hits: z.array(IqHitSchema) });
export type IqGroup = z.infer<typeof IqGroupSchema>;
// `building` = index still filling (progress 0..1, e.g. embeddings pending); `stale` = revalidation was skipped
// (cursor replay). ageMs = time since the index last matched the disk state.
export const IqFreshnessSchema = z.object({
    state: z.enum(["fresh", "building", "stale"]),
    ageMs: z.number().optional(),
    progress: z.number().optional(),
});
export type IqFreshness = z.infer<typeof IqFreshnessSchema>;
export const IqResultSchema = z.object({
    mode: z.string(),
    total: z.number(),
    shown: z.number(),
    groups: z.array(IqGroupSchema),
    freshness: IqFreshnessSchema,
    truncated: z.boolean(),
    cursor: z.string().optional(),
    hint: z.string().optional(),
    // Code-graph neighbors of the top hits (definition anchors + ready-made follow-up commands).
    related: z.array(z.string()).optional(),
    // Run provenance for benchmarking: retrieval stages DISABLED this invocation (absent = full pipeline).
    features: z.array(z.string()).optional(),
});
export type IqResult = z.infer<typeof IqResultSchema>;

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
export const AppsListSchema = z.object({ apps: z.array(RepoAppSchema) });
export type AppsList = z.infer<typeof AppsListSchema>;
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
// Per-provider CLI-tool config. A `cli` capability gives the AGENT an authenticated command-line tool (not a
// deployed-app credential like `integration`): the secret + any non-secret URL are stored here and injected
// into the agent's env each turn (see cliEnvOf), and a .claude/skills/<id> cheatsheet teaches the agent to use
// it via curl. Discriminated by provider so each provider's fields are typed and future providers slot in.
export const CliConfigSchema = z.discriminatedUnion("provider", [
    z.object({
        provider: z.literal("discord"),
        botToken: z.string().min(1),
        // Voice transcription knobs (whisper.cpp). Defaults applied at use site: model `medium`, language
        // `auto`. An explicit ISO 639-1 voiceLanguage pins whisper's detection (short utterances flicker on
        // auto); `en` additionally selects the English-specialized ggml-*.en model.
        voiceModel: z.enum(["tiny", "base", "small", "medium", "large-v3-turbo"]).optional(),
        voiceLanguage: z.string().optional(),
    }),
    // `git` toggles real git access (clone/pull/push in the terminal + for the agent): on apply the daemon writes
    // an https credential line and, if `token` can register an ssh key, wires native ssh too — otherwise ssh-form
    // remotes are rerouted over https so git still works. "off" (or absent) keeps the connection curl-API-only.
    z.object({ provider: z.literal("github"), token: z.string().min(1), git: z.enum(["on", "off"]).optional() }),
    z.object({ provider: z.literal("gitlab"), token: z.string().min(1), url: z.string().url(), git: z.enum(["on", "off"]).optional() }),
    z.object({ provider: z.literal("sentry"), token: z.string().min(1), url: z.string().url(), org: z.string().optional() }),
    z.object({ provider: z.literal("redmine"), url: z.string().url(), apiKey: z.string().min(1) }),
    z.object({ provider: z.literal("outline"), url: z.string().url(), apiKey: z.string().min(1) }),
    z.object({
        provider: z.literal("imap"),
        host: z.string().min(1),
        port: z.coerce.number(),
        username: z.string().min(1),
        password: z.string().min(1),
    }),
    z.object({ provider: z.literal("signoz"), url: z.string().url(), apiKey: z.string().min(1) }),
    z.object({
        provider: z.literal("postgres"),
        host: z.string().min(1),
        port: z.coerce.number(),
        user: z.string().min(1),
        password: z.string().min(1),
        database: z.string().min(1),
    }),
    z.object({
        provider: z.literal("mysql"),
        host: z.string().min(1),
        port: z.coerce.number(),
        user: z.string().min(1),
        password: z.string().min(1),
        database: z.string().min(1),
    }),
]);
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
export const ExtensionSummarySchema = z.object({
    id: entryId,
    manifest: ExtensionManifestSchema,
    commit: z.string(),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;
export const ExtensionsListSchema = z.object({ extensions: z.array(ExtensionSummarySchema) });
// The extension's contributes.settings values, persisted daemon-side (.intentic/extension-settings.json) keyed
// by the manifest-derived extension id — the checkout stays pristine, so a re-clone update never loses them.
export const ExtensionSettingsSchema = z.object({ settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) });
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
// `listener` fires from the daemon's own realtime connection to the provider (e.g. the Discord gateway) — no
// cron, no token, never reachable via /fire. channelId narrows to one channel; absent ⇒ every channel the
// bot can read. eventType narrows to one kind of event (a Discord message, a live voice utterance batch, or a
// finished voice transcript); absent ⇒ all event kinds the source emits. mentioned narrows message events to
// those that @mention one of the workspace's bots or reply to a bot's message; absent ⇒ all messages. Both
// provider and eventType enums grow with each realtime source.
// `webchat` is the exception: it has no daemon-held connection. An embeddable widget POSTs a visitor's message
// to /webchat/<id>/message and the agent's reply streams back over SSE. Its address is the public automation
// id, so allowedOrigins (the widget's embed sites) + a per-conversation rate limit are its abuse boundary —
// no secret token can live in a browser.
export const TriggerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("schedule"), cron: z.string().min(1) }),
    z.object({ kind: z.literal("event"), token: z.string().min(1).optional() }),
    z.object({
        kind: z.literal("listener"),
        provider: z.enum(["discord", "webchat"]),
        channelId: z.string().min(1).optional(),
        eventType: z.enum(["message", "voice_utterance", "voice_transcript"]).optional(),
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
    // Which Claude model the wake runs on (opus/sonnet/haiku); absent ⇒ the account/subscription default.
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
// runner executes user-triggered flows in (capability adds, infra check). The `{name}` kill-route param is a
// bare string validated in the handler (a bad name is a BAD_REQUEST) since the same charset gates a
// `tmux kill-session -t` shell-out.
export const TerminalSessionSchema = z.object({
    name: z.string(),
    label: z.string().optional(),
    kind: z.enum(["shell", "panel", "agent", "job"]),
    running: z.boolean(),
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

// Live connection health, probed per provider capability (not stored): gateway state from the client pool,
// lastError from the newest system-error event in the recent log.
export const ActivityConnectionSchema = z.object({
    capabilityId: z.string(),
    provider: z.string(),
    gateway: z.enum(["ready", "connecting", "disconnected"]),
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
