import type { ResourceType } from "@intentic/resources";
import {
    ActivityConnectionSchema,
    ActivityEventSchema,
    ActivityStatusSchema,
    AddInventoryInputSchema,
    AutomationApprovalSchema,
    AutomationRunSchema,
    AutomationSchema,
    AutomationSummarySchema,
    BuiltinPromptTextSchema,
    CapabilityKindSchema,
    CapabilityRecommendationSchema,
    CapabilityStateSchema,
    CapabilityStatusSchema,
    CapabilitySummarySchema,
    DraftSchema,
    DraftStatusSchema,
    DraftsListSchema,
    DraftSummarySchema,
    EnvironmentSchema,
    BundleExportSchema,
    GrantedRoleSchema,
    HostTunnelSchema,
    ImportReportSchema,
    InventoryEntrySchema,
    InventoryProviderSchema,
    LogFileEntrySchema,
    LogReadSchema,
    MarketplaceSchema,
    MemberRoleSchema,
    PanelSummarySchema,
    PushConfigSchema,
    RepoAppSchema,
    SandboxSettingsSchema,
    ServiceKindSchema,
    AgentChangeSchema,
    AgentChangesSchema,
    AgentRepoChangesSchema,
    FileDiffSchema,
    GitActionResultSchema,
    GitDiffSideSchema,
    GitBranchesSchema,
    GitBranchSchema,
    CommitResultSchema,
    GitChangeSchema,
    GitChangesSchema,
    GitCommitDiffSchema,
    GitCommitSchema,
    GitLogSchema,
    GitRemoteStateSchema,
    GitReposSchema,
    OriginAgentSchema,
    RepoChangesSchema,
    RepoPathsSchema,
    SnapshotChangeSchema,
    SnapshotDiffSchema,
    SnapshotSchema,
    SnapshotsListSchema,
    SnapshotTriggerSchema,
    TemplatesListSchema,
    TemplateSummarySchema,
    WorkspaceHealthSchema,
    WorkspaceHotspotSchema,
    WorkspaceKeyModuleSchema,
    WorkspaceSearchFreshnessSchema,
    WorkspaceSearchGroupSchema,
    WorkspaceSearchHitSchema,
    WorkspaceSearchQuerySchema,
    WorkspaceSearchResultSchema,
    WorkspaceSearchSpanSchema,
    WorkspaceSearchTagSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";

// The oRPC OpenAPI handler is mounted under this prefix on the server; the client
// link points at the same base so request URLs line up.
export const API_BASE_PATH = "/rpc";

// ---- daemon wire shapes: single source of truth is @intentic/sandbox-contract ----
//
// These used to be hand-mirrored here because the platform couldn't import the sandbox package. In the monorepo
// it can, so there is ONE definition: we re-export the daemon's own schemas + derive the types the platform has
// always exposed (some under the platform's historical names, e.g. WorkspaceTreeResponse = the daemon's
// WorkspaceTree). The web validates daemon responses against the SAME schemas the daemon produces them with.
export {
    ActivityConnectionSchema,
    ActivityEventSchema,
    ActivityListSchema,
    ActivityStatusSchema,
    AddInventoryInputSchema,
    AppEntrySchema,
    AppsListSchema,
    AutomationApprovalSchema,
    AutomationApprovalsListSchema,
    AutomationRunSchema,
    AutomationSchema,
    AutomationsListSchema,
    AutomationSummarySchema,
    BackendEntrySchema,
    CapabilitiesListSchema,
    BuiltinPromptTextSchema,
    CapabilityKindSchema,
    CapabilityRecommendationSchema,
    CapabilityStateSchema,
    CapabilityStatusSchema,
    CapabilitySummarySchema,
    DraftSchema,
    DraftStatusSchema,
    DraftsListSchema,
    DraftSummarySchema,
    EnvironmentSchema,
    BundleExportSchema,
    BundleExportsSchema,
    HostTunnelSchema,
    ImportReportSchema,
    InventoryEntrySchema,
    InventoryProviderSchema,
    InventoryValuesSchema,
    LogFileEntrySchema,
    LogReadSchema,
    LogsListSchema,
    MarketplaceSchema,
    PanelsListSchema,
    PanelSummarySchema,
    PushConfigSchema,
    RepoAppSchema,
    SandboxSettingsSchema,
    ServiceEntrySchema,
    ServiceKindSchema,
    TemplatesListSchema,
    TemplateSummarySchema,
    TerminalSessionSchema,
    TerminalsListSchema,
    TriggerSchema,
    WorkspaceChildrenSchema,
    WorkspaceFileSchema,
    WorkspaceSearchResultSchema,
    WorkspaceTreeEntrySchema,
    WorkspaceTreeSchema,
} from "@intentic/sandbox-contract";

export type InventoryProvider = z.infer<typeof InventoryProviderSchema>;
export type ServiceKind = z.infer<typeof ServiceKindSchema>;
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export type AddInventoryInput = z.infer<typeof AddInventoryInputSchema>;
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>;
export type CapabilityRecommendation = z.infer<typeof CapabilityRecommendationSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type ImportReport = z.infer<typeof ImportReportSchema>;
export type BundleExport = z.infer<typeof BundleExportSchema>;
export type Marketplace = z.infer<typeof MarketplaceSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
export type DraftsList = z.infer<typeof DraftsListSchema>;
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;
export type BuiltinPromptText = z.infer<typeof BuiltinPromptTextSchema>;
export type PanelSummary = z.infer<typeof PanelSummarySchema>;
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export type TemplatesList = z.infer<typeof TemplatesListSchema>;
export type RepoApp = z.infer<typeof RepoAppSchema>;
export type HostTunnel = z.infer<typeof HostTunnelSchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type ActivityConnection = z.infer<typeof ActivityConnectionSchema>;
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export type LogRead = z.infer<typeof LogReadSchema>;

// Workspace tree / file / children. The daemon's Zod schema infers `children` loosely (Record<string, unknown>[]
// — a z.lazy recursion limit), but the web renders a recursive tree, so the platform keeps the PRECISE recursive
// interface here. The daemon WorkspaceTree*Schema stay re-exported above for runtime parsing.
export interface WorkspaceTreeEntry {
    readonly name: string;
    // Root-relative path (forward slashes), fed straight back to the file route.
    readonly path: string;
    readonly type: "file" | "dir";
    readonly size?: number;
    // Ignored-by-tooling (node_modules, .git, .gitignore'd, browser profiles): the row is grayed.
    readonly ignored?: boolean;
    // Absent on a DIR that was listed but not descended into (ignored, or below the walk's breadth-first
    // budget) — the client lazy-loads it on expand. An empty dir has `children: []`, not `undefined`.
    readonly children?: readonly WorkspaceTreeEntry[];
}
export interface WorkspaceTreeResponse {
    readonly root: string;
    readonly tree: readonly WorkspaceTreeEntry[];
    // How many of the ROOT's own entries the budget cut (0 = complete); per-dir cuts are counted on each entry.
    readonly hidden: number;
}
// Children of one not-yet-descended dir, fetched lazily on expand (GET /workspace/children).
export interface WorkspaceChildrenResponse {
    readonly entries: readonly WorkspaceTreeEntry[];
    readonly hidden: number;
}
/* One WINDOW of a file's text. `size` is the whole file on disk, `offset`/`bytes` the byte range `content`
 * decodes from — so `offset > 0 || offset + bytes < size` means there is more, and `offset + bytes` is where
 * the next window starts. Byte counts, not `content.length`: they differ on non-ASCII, and the daemon reads
 * by byte. The viewer gates on `size` from here rather than on a tree entry's, which it may not have. */
export interface WorkspaceFileResponse {
    readonly path: string;
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
    // Which tree answered — the shared /work one, or the conversation's own checkout the request named
    // (`?agent=`). True despite a scope when that checkout doesn't carry the path, which is legitimate: a
    // checkout is not a superset of /work. The one thing the reader must not have to guess.
    readonly shared: boolean;
}
// What a NAMED file reference (agent prose, terminal output) resolves to: the workspace path it means, absent
// when nothing in the workspace ends in that reference.
export interface WorkspaceResolveResponse {
    readonly path?: string;
}

// Workspace search results (the daemon's fused-search wire shape). WorkspaceSearchMode is the verb enum in the query.
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export type WorkspaceSearchSpan = z.infer<typeof WorkspaceSearchSpanSchema>;
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;
export type WorkspaceSearchMode = z.infer<typeof WorkspaceSearchQuerySchema>["mode"];

// One repository's codebase health (GET /workspace/health): churn × complexity per file, index totals, and the
// import graph's key modules — the same resident engine that answers search, ranking instead of matching.
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;

// Workspace history (daemon-captured snapshots). Daemon names: Snapshot / SnapshotsList / SnapshotDiff —
// kept under the platform's historical *Response names as derived aliases.
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export type WorkspaceSnapshot = z.infer<typeof SnapshotSchema>;
export type SnapshotsResponse = z.infer<typeof SnapshotsListSchema>;
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export type SnapshotDiffResponse = z.infer<typeof SnapshotDiffSchema>;
// Shared by the snapshot file diff and the working-tree (Changes review) file diff.
export type FileDiffResponse = z.infer<typeof FileDiffSchema>;
// Which of the working tree's two diffs a Changes row opens — index-vs-HEAD or worktree-vs-index.
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;

// The Changes review (uncommitted work per repo, VSCode-SCM style).
export type GitChange = z.infer<typeof GitChangeSchema>;
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
// One repo's slice of an action that spans repos — the whole repo, or just the paths named. git can't span
// repos, so every batch verb in the Changes panel (stage, discard, commit, the AI draft) groups into these.
export type RepoPaths = z.infer<typeof RepoPathsSchema>;
// Who an agent id named in a repo's `origins` is — the review carries it, the fleet roster can't (archived).
export type OriginAgent = z.infer<typeof OriginAgentSchema>;
export type GitChangesResponse = z.infer<typeof GitChangesSchema>;
// What a commit answers with: whether it recorded anything, plus that repo's review row as the commit left it
// (absent ⇒ the repo has nothing left to show), so the panel replaces one repo instead of re-reading them all.
export type CommitResult = z.infer<typeof CommitResultSchema>;
export type GitCommit = z.infer<typeof GitCommitSchema>;
export type GitLogResponse = z.infer<typeof GitLogSchema>;
export type GitCommitDiffResponse = z.infer<typeof GitCommitDiffSchema>;
export type GitReposResponse = z.infer<typeof GitReposSchema>;
export type GitActionResult = z.infer<typeof GitActionResultSchema>;
// Web push: the VAPID public key a browser subscribes with, plus whether THIS browser is already registered.
export type PushConfig = z.infer<typeof PushConfigSchema>;
// Remote sync + branch management (the Changes panel's sync bar and the graph's branch switcher).
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;
export type GitBranch = z.infer<typeof GitBranchSchema>;
export type GitBranchesResponse = z.infer<typeof GitBranchesSchema>;
// The per-agent worktree review — one flat change set per repo, NOT the working tree's staged/unstaged shape.
// A row is the agent's cumulative change to that file, flagged with whether it has already landed in the main tree.
export type AgentChange = z.infer<typeof AgentChangeSchema>;
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
export type AgentChangesResponse = z.infer<typeof AgentChangesSchema>;

// ---- platform-native (owned by the platform; NOT daemon wire shapes) ----

export const UserSchema = z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    image: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

// Avatars and sandbox logos are stored inline as small data URLs (client-side canvas downscale) — this caps
// what the API will persist (~110 kB decoded; a 128px webp/jpeg is ~5-10 kB) so no multi-megabyte string
// lands in a row. Enforced by sandbox.update's input and the auth user.update hook.
export const ImageDataUrlSchema = z.string().startsWith("data:image/").max(150_000);

// Remove-by-name input for the inventory routes (one sandbox per user, so the name identifies the entry).
export const RemoveInventoryInputSchema = z.object({
    name: z.string().min(1),
});
export type RemoveInventoryInput = z.infer<typeof RemoveInventoryInputSchema>;

// ---- live actual-state plan: an on-demand read of the realized infrastructure ----
//
// The platform streams the in-sandbox `intentic deploy plan` (the engine's read+diff, no apply) over SSE, mapping each
// per-resource plan node + the terminal result. Distinct from the cached status.json snapshot: this re-reads
// live infra. `action` is the reconcile verdict — "noop" (in sync), "create" (absent / would create),
// "update" (drift, with a reason), "delete"/"prune" (would remove). Relayed (not oRPC) like /sandbox/provision.
export interface PlanStreamEvent {
    readonly type: "node" | "result" | "error" | "done";
    // For type "node": the resource id + its reconcile verdict against live infra.
    readonly id?: string;
    readonly resourceType?: string;
    readonly action?: string;
    readonly reason?: string;
    // For type "result": resources found live but absent from the desired graph.
    readonly orphans?: readonly string[];
    // For type "error".
    readonly message?: string;
}

// ---- sandboxes: the user's workspaces + shared access ----

// A sandbox as the browser sees it. `token` is the tunnel-hostname seed + the daemon's first-bind secret;
// `daemonUrl` + `lastSeenAt` (ISO) are reported by the daemon's announce — null until it first phones home.
// `role` is the caller's relationship to it (owner can manage access; member has access only). `providedTunnel`
// is server-computed: the reported daemonUrl lives under intentic's own zone (an intentic-provided tunnel), so
// the infra operator panel knows to mint host tunnels via the daemon's relay (POST /sandbox/host-tunnel) instead
// of asking for the user's Cloudflare token. `setupCodeClaimedAt` (ISO) is when a machine last redeemed the
// sandbox's CURRENT setup code — the setup wizard's only evidence that the pasted command actually ran, which
// is what lets it stop showing a spinner at someone who has not opened a terminal yet. sandbox.list returns
// owned ∪ shared.
// One broken check of a machine-side setup run, as the machine reported it: the check's name, what it
// found, and what to do about it — prose written for the person at the wizard and rendered verbatim.
// `remedy` may be empty: the flow's own failure messages carry their fix inline.
export const SetupReportFailureSchema = z.object({
    check: z.string().max(120),
    problem: z.string().max(2000),
    remedy: z.string().max(2000),
});
// Where the machine-side setup run stands — ic POSTs this to /setup/report on every stage transition and on
// any terminal failure, authenticated by possession of the live setup code (the claim's own trust). The
// stages are the connect flow's real phases, so the wizard can narrate honest progress during the minutes of
// invisible Docker work; a non-empty `failed` is a verdict, not progress. `at` (ISO) is stamped by the
// platform on receipt — the reporting machine's clock is never trusted.
export const SetupReportSchema = z.object({
    stage: z.enum([
        "preflight",
        "pulling-image",
        "creating-tunnel",
        "starting-sandbox",
        "starting-connector",
        "waiting-health",
        "verifying",
        "done",
    ]),
    failed: z.array(SetupReportFailureSchema).max(12),
    at: z.string(),
});
export type SetupReport = z.infer<typeof SetupReportSchema>;

// The clouds the setup wizard's cloud lane can provision a machine in — each is an adapter in the api's
// sandbox/cloud/. Hetzner and DigitalOcean are the paid x86 paths; Oracle is the Always-Free ARM path
// (A1.Flex inside the user's own free-tier allowance).
export const CloudProviderSchema = z.enum(["hetzner", "digitalocean", "oracle"]);
export type CloudProvider = z.infer<typeof CloudProviderSchema>;

// Where the cloud lane put a sandbox's machine — the non-secret residue of a provision, stamped on the row.
// serverName is the name visible in the provider's own console, which is exactly what the delete warning
// needs the user to go find.
export const SandboxCloudSchema = z.object({
    provider: CloudProviderSchema,
    serverName: z.string(),
    location: z.string(),
});
export type SandboxCloud = z.infer<typeof SandboxCloudSchema>;

export const SandboxSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    daemonUrl: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    setupCodeClaimedAt: z.string().nullable(),
    // The machine-side setup run's last word (see SetupReportSchema) — null until a report lands, cleared on
    // every mint like the claim stamp.
    setupReport: SetupReportSchema.nullable(),
    token: z.string(),
    // The caller's trust tier on this sandbox: `owner` for their own, the invite's granted role for a shared
    // one. What the web gates its affordances on; the daemon independently enforces the same tier as route
    // floors, so this is a rendering fact, never the security boundary.
    role: MemberRoleSchema,
    providedTunnel: z.boolean(),
    // Where the cloud lane created this sandbox's machine (sandbox.cloudProvision) — null for every other
    // creation path. Display metadata only, never a credential: the platform cannot reach the machine again
    // (the provider token was request-scoped), so this exists to SAY so — the switcher badge and the delete
    // dialog's "the machine in your <provider> account keeps running — remove it there" warning read it.
    cloud: SandboxCloudSchema.nullable(),
});
export type SandboxSummary = z.infer<typeof SandboxSummarySchema>;

// The sandbox's public base URL as the OWNER asserts it (sandbox.attach) instead of the daemon announcing it —
// the "I already run my sandbox behind a domain that works" path, where nothing ever phones home. https only:
// the web app is served over HTTPS, so a browser blocks every call to an http:// daemon as mixed content.
// Trailing slashes are dropped because each daemon call appends an absolute path (`${daemonUrl}/health`); a
// path prefix is kept, so a sandbox served under `https://example.com/sandbox` works behind the user's proxy.
export const DaemonUrlSchema = z
    .string()
    .max(255)
    .transform((value) => value.trim().replace(/\/+$/, ``))
    .refine((value) => {
        try {
            return new URL(value).protocol === "https:";
        } catch {
            return false;
        }
    }, "must be an https:// URL");

// ---- invites: sharing a sandbox with teammates by email ----

// A row in the owner's access roster: an email plus its derived state. `pending` = invited, link not yet
// accepted; `accepted` = an active member; `expired` = the invite link lapsed unaccepted (owner can resend).
// `expiresAt` is the link's expiry (ISO), absent once accepted or when there is none.
export const InviteStatusSchema = z.enum(["pending", "accepted", "expired"]);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;
export const InviteRecordSchema = z.object({
    email: z.string(),
    // The trust tier this invite grants (viewer/collaborator/maintainer — never owner). The daemon's members
    // list is the enforced copy; this row is what the roster renders and re-grades from.
    role: GrantedRoleSchema,
    status: InviteStatusSchema,
    invitedAt: z.string(),
    expiresAt: z.string().optional(),
});
export type InviteRecord = z.infer<typeof InviteRecordSchema>;
export const InviteListSchema = z.object({ members: z.array(InviteRecordSchema) });

// What the public accept page renders from an invite token (no session needed). `invalid` = no such token;
// otherwise the sandbox name + the invited address so the page can prompt sign-in as the right account. Name and
// email are omitted for an invalid token (nothing to show).
export const InvitePreviewStatusSchema = z.enum(["pending", "accepted", "expired", "invalid"]);
export const InvitePreviewSchema = z.object({
    status: InvitePreviewStatusSchema,
    sandboxName: z.string().optional(),
    invitedEmail: z.string().optional(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

// Zone discovery for the setup screen's picker. The Cloudflare token can reach more than one zone (domain), and
// the sandbox refuses to guess which one to provision under — so the user must choose before the install command
// is revealed. The browser can't list zones itself (Cloudflare's API sends no CORS headers), so the token is
// posted here for a SINGLE request-scoped call to Cloudflare and then discarded: it is never persisted, logged,
// or stored. This is the one place the token transits the platform (the narrowed secret-free invariant).
export const CfTokenSchema = z.object({ token: z.string().min(1) });
export const CfZonesSchema = z.object({ zones: z.array(z.string()) });
export type CfZones = z.infer<typeof CfZonesSchema>;

// The setup code: ONE short-lived value the copy-paste install command carries instead of raw tokens (nothing
// secret lands in shell history or the process list). The connect script redeems it at POST /setup/claim (a
// public non-oRPC route — the script has no session) for CONNECT_TOKEN plus, per target mode:
//   • intentic: the platform provisions the tunnel + DNS under its OWN zone (its API token never leaves the
//     server; the sandbox only ever sees the narrow per-tunnel connector token) → {TUNNEL_TOKEN, SANDBOX_HOSTNAME}.
//   • own: the user's zone/subdomain picks → {ZONE, SUBDOMAIN}. Their CF token NEVER enters the code — it stays
//     an env var on the command (the never-stored invariant).
// When desktop sync is requested at setup, the payload additionally carries {SYNC_DIR, SYNC_PAIR_TOKEN} — a
// platform-minted single-use pairing token the sandbox seeds at boot, so the connect script can enroll the sync
// agent without a second pasted command (the command itself stays identical either way).
// Re-claimable until expiry so a failed run stays re-runnable from the same copied command; re-minting overwrites.
export const SetupCodeTargetSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("intentic") }),
    z.object({ mode: z.literal("own"), zone: z.string().min(1), subdomain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i) }),
]);
export type SetupCodeTarget = z.infer<typeof SetupCodeTargetSchema>;
export const SetupCodeSchema = z.object({ code: z.string(), hostname: z.string(), expiresAt: z.string() });
export type SetupCode = z.infer<typeof SetupCodeSchema>;

// ---- the cloud lane: provision the machine itself, in the USER'S cloud account ----
//
// The command lane assumes a machine exists; this lane is for the user (a phone, most often) who has none.
// They paste a provider credential, pick a region and size, and the platform creates ONE VM in THEIR account
// whose first-boot script runs the exact published one-liner with the sandbox's live setup code — from there
// the ordinary claim → report → announce states narrate progress. The credential follows the CfTokenSchema
// contract exactly: request-scoped, used for the provider calls of that one request, then discarded — never
// persisted, logged, or stored. The platform keeps no way back into the machine; only SandboxCloudSchema's
// display facts survive.
//
// Oracle's credential is not a bearer token: OCI signs every request with an RSA API key. The console's
// "add API key" dialog emits a config snippet (user/tenancy OCID, fingerprint, region) — the user pastes
// that verbatim plus the key PEM, and the adapter parses both (a malformed paste is a BAD_REQUEST naming
// what's missing, not a signature failure later).
export const CloudCredentialsSchema = z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("hetzner"), token: z.string().min(1) }),
    z.object({ provider: z.literal("digitalocean"), token: z.string().min(1) }),
    z.object({ provider: z.literal("oracle"), config: z.string().min(1), privateKey: z.string().min(1) }),
]);
export type CloudCredentials = z.infer<typeof CloudCredentialsSchema>;

// One pickable region/size, priced from the provider's own catalog API at options time — live numbers, so the
// wizard never shows a stale price it hard-coded. Prices are monthly and in the provider's billing currency;
// Oracle's one shape carries 0/USD (inside the Always-Free allowance) with the caveat in the wizard's copy.
export const CloudLocationSchema = z.object({ id: z.string(), label: z.string() });
export const CloudSizeSchema = z.object({
    id: z.string(),
    label: z.string(),
    cpus: z.number(),
    memoryGb: z.number(),
    diskGb: z.number(),
    monthlyPrice: z.number(),
    currency: z.string(),
});
// Fetching the options doubles as the credential check: a bad paste fails here, before anything is created.
// defaults preselect the cheapest workable pick so the mobile flow is credential → Create.
export const CloudOptionsSchema = z.object({
    locations: z.array(CloudLocationSchema),
    sizes: z.array(CloudSizeSchema),
    defaultLocation: z.string(),
    defaultSize: z.string(),
});
export type CloudOptions = z.infer<typeof CloudOptionsSchema>;
export type CloudLocation = z.infer<typeof CloudLocationSchema>;
export type CloudSize = z.infer<typeof CloudSizeSchema>;

// ---- workspace state: the Overview / topology read-model ----
//
// A "view" is a projection of (desired-state graph ⊕ reconciliation drift). The platform reads the sandbox's
// resolved artifact (desired-state/desired-state.json — the compiled form of deploy.config.ts) and the last
// apply result (status.json) THROUGH the sandbox (its git file routes), and shapes this render-ready model
// server-side. The sandbox stays the source of truth (CLAUDE.md); only non-secret scalar inputs are surfaced,
// $secret/$ref values are dropped upstream.

// Coarse lenses the closed resource-type vocabulary buckets into, for grouping in the Overview.
export const ResourceGroupSchema = z.enum(["infra", "git", "deploy", "data", "notify", "other"]);
export type ResourceGroup = z.infer<typeof ResourceGroupSchema>;

// The coarse group each resolver resource-type buckets into — the single source the infra render models read
// (the web's local projection today; any server-side projection tomorrow) so a new kind can't silently land in
// the wrong bucket. Typed Record<ResourceType, …> via a type-only import (erased at runtime — no dep weight in
// the browser bundle), so a kind added to the OSS vocabulary is a compile error here until it's grouped. Kinds
// with no natural bucket sit in "other" (the prior projection default) on purpose.
const RESOURCE_GROUP: Record<ResourceType, ResourceGroup> = {
    host: "infra",
    cloudflare: "infra",
    tunnel: "infra",
    "cf-route": "infra",
    forgejo: "git",
    "forgejo-user": "git",
    "forgejo-org": "git",
    "forgejo-team": "git",
    "forgejo-runner": "git",
    repo: "git",
    "control-repo": "git",
    ci: "git",
    github: "git",
    "gh-repo": "git",
    "gh-ci": "git",
    gitlab: "git",
    "gl-repo": "git",
    "gl-ci": "git",
    komodo: "deploy",
    "komodo-periphery": "deploy",
    "komodo-server": "deploy",
    "komodo-user": "deploy",
    deployment: "deploy",
    postgres: "data",
    "postgres-database": "data",
    valkey: "data",
    "valkey-namespace": "data",
    signoz: "data",
    authentik: "data",
    "authentik-client": "data",
    garage: "data",
    "garage-bucket": "data",
    discord: "notify",
    "forgejo-notify": "notify",
    "komodo-notify": "notify",
    stripe: "other",
    outline: "other",
    paperless: "other",
    openproject: "other",
    invoiceninja: "other",
    infisical: "other",
    workspace: "other",
    backup: "other",
};

// The coarse group for a resource type; a string outside the closed vocabulary falls to "other".
export const groupOf = (type: string): ResourceGroup => RESOURCE_GROUP[type as ResourceType] ?? "other";

export const ResourceViewSchema = z.object({
    id: z.string(),
    // The resolver's closed kind vocabulary (host/forgejo/komodo/deployment/…), kept open here as a string.
    type: z.string(),
    title: z.string(),
    group: ResourceGroupSchema,
    // The service's public URL when derivable from a `domain`/`hostname` input, for deep-linking out.
    url: z.string().optional(),
    dependsOn: z.array(z.string()),
    // Non-secret scalar inputs only (string | number | boolean); secrets/refs are dropped.
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    // The per-resource reconcile action from status.json ("noop" | "create" | "update" | "delete" | …), or
    // "unknown" before the first apply / when the resource is absent from the last status.
    status: z.string(),
    // The human-readable drift cause from status.json's step (present for "update" steps); undefined otherwise.
    reason: z.string().optional(),
});
export type ResourceView = z.infer<typeof ResourceViewSchema>;

// Where the user logs into a provisioned service, from status.json's VALUE-FREE access entries (the CLI
// strips password values before committing). A generated password's value is fetched on demand through the
// daemon's owner-gated /secrets/reveal, keyed by `password.key`.
export const AccessEntrySchema = z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    username: z.string().optional(),
    password: z.object({ source: z.enum([`env`, `generated`]), key: z.string() }).optional(),
});
export type AccessEntry = z.infer<typeof AccessEntrySchema>;

export const WorkspaceStateSchema = z.object({
    resources: z.array(ResourceViewSchema),
    // From status.json (the last `intentic deploy apply`); undefined before the first apply.
    converged: z.boolean().optional(),
    iterations: z.number().optional(),
    access: z.array(AccessEntrySchema).optional(),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

// ---- apps: the live Komodo deployments, contextualized by the desired-state graph ----
//
// Surfaced by the in-sandbox `intentic deploy deployments` subcommand: it reads each `deployment` node's configured
// image/env/url from the graph and confirms liveness against the Komodo API; the browser reads the result
// from the daemon directly. `env` carries keys with non-secret scalar values; secret/ref values are blanked. Runtime
// detail (logs, container status) lives in Komodo's own UI — deep-linked via komodoDeploymentUrl (hybrid).
export const DeploymentSchema = z.object({
    // The graph node id (e.g. "app.production") — also the Komodo deployment name.
    name: z.string(),
    // The registry image CI pushes and Komodo runs: registry/owner/repo:tag.
    image: z.string(),
    tag: z.string(),
    domain: z.string().optional(),
    url: z.string().optional(),
    port: z.number().optional(),
    env: z.record(z.string(), z.string()),
    // Whether Komodo currently has this deployment registered (login + ListDeployments matched it).
    live: z.boolean(),
    komodoUrl: z.string(),
    komodoDeploymentUrl: z.string().optional(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;
