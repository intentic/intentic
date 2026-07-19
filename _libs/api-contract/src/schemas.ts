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
    CapabilityKindSchema,
    CapabilityStateSchema,
    CapabilityStatusSchema,
    CapabilitySummarySchema,
    CleanerSavingsSchema,
    DraftSchema,
    DraftStatusSchema,
    DraftsListSchema,
    DraftSummarySchema,
    EnvironmentSchema,
    HostTunnelSchema,
    InventoryEntrySchema,
    InventoryProviderSchema,
    LogFileEntrySchema,
    LogReadSchema,
    MarketplacePluginSchema,
    MarketplaceSchema,
    PanelSummarySchema,
    RepoAppSchema,
    SandboxSettingsSchema,
    ServiceKindSchema,
    FileDiffSchema,
    GitChangeSchema,
    GitChangesSchema,
    GitCommitDiffSchema,
    GitCommitSchema,
    GitLogSchema,
    GitReposSchema,
    RepoChangesSchema,
    SnapshotChangeSchema,
    SnapshotDiffSchema,
    SnapshotSchema,
    SnapshotsListSchema,
    SnapshotTriggerSchema,
    TemplatesListSchema,
    TemplateSummarySchema,
    WorkspaceSearchFreshnessSchema,
    WorkspaceSearchGroupSchema,
    WorkspaceSearchHitSchema,
    WorkspaceSearchQuerySchema,
    WorkspaceSearchResultSchema,
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
    CapabilityKindSchema,
    CapabilityStateSchema,
    CapabilityStatusSchema,
    CapabilitySummarySchema,
    CleanerSavingsSchema,
    DraftSchema,
    DraftStatusSchema,
    DraftsListSchema,
    DraftSummarySchema,
    EnvironmentSchema,
    HostTunnelSchema,
    InventoryEntrySchema,
    InventoryProviderSchema,
    InventoryValuesSchema,
    LogFileEntrySchema,
    LogReadSchema,
    LogsListSchema,
    MarketplacePluginSchema,
    MarketplaceSchema,
    PanelsListSchema,
    PanelSummarySchema,
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
export type Environment = z.infer<typeof EnvironmentSchema>;
export type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;
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
export type CleanerSavings = z.infer<typeof CleanerSavingsSchema>;
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
    // Set on a dir whose child list was cut short by the entry cap — some of its items aren't in `children`.
    readonly truncated?: boolean;
    // Ignored-by-tooling (node_modules, .git, .gitignore'd, browser profiles): the row is grayed. An ignored DIR
    // carries no `children` — the client lazy-loads it via /workspace/children on expand.
    readonly ignored?: boolean;
    readonly children?: readonly WorkspaceTreeEntry[];
}
export interface WorkspaceTreeResponse {
    readonly root: string;
    readonly tree: readonly WorkspaceTreeEntry[];
    // True when the root's own entries were cut by the entry cap (per-dir cuts are flagged on each dir entry).
    readonly truncated: boolean;
}
// Children of one ignored dir, fetched lazily on expand (GET /workspace/children).
export interface WorkspaceChildrenResponse {
    readonly entries: readonly WorkspaceTreeEntry[];
    readonly truncated: boolean;
}
export interface WorkspaceFileResponse {
    readonly path: string;
    readonly content: string;
}

// Workspace search results (the daemon's fused-search wire shape). WorkspaceSearchMode is the verb enum in the query.
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;
export type WorkspaceSearchMode = z.infer<typeof WorkspaceSearchQuerySchema>["mode"];

// Workspace history (daemon-captured snapshots). Daemon names: Snapshot / SnapshotsList / SnapshotDiff —
// kept under the platform's historical *Response names as derived aliases.
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export type WorkspaceSnapshot = z.infer<typeof SnapshotSchema>;
export type SnapshotsResponse = z.infer<typeof SnapshotsListSchema>;
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export type SnapshotDiffResponse = z.infer<typeof SnapshotDiffSchema>;
// Shared by the snapshot file diff and the working-tree (Changes review) file diff.
export type FileDiffResponse = z.infer<typeof FileDiffSchema>;

// The Changes review (uncommitted work per repo, VSCode-SCM style).
export type GitChange = z.infer<typeof GitChangeSchema>;
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
export type GitChangesResponse = z.infer<typeof GitChangesSchema>;
export type GitCommit = z.infer<typeof GitCommitSchema>;
export type GitLogResponse = z.infer<typeof GitLogSchema>;
export type GitCommitDiffResponse = z.infer<typeof GitCommitDiffSchema>;
export type GitReposResponse = z.infer<typeof GitReposSchema>;

// ---- platform-native (owned by the platform; NOT daemon wire shapes) ----

export const UserSchema = z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    image: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

// Avatars and sandbox logos are stored inline as small data URLs (client-side canvas downscale) — this caps
// what the API will persist (~110 kB decoded; a 128px webp/jpeg is ~5-10 kB) so no multi-megabyte string
// lands in a row. Enforced by sandbox.update's input and the auth user.update hook.
export const ImageDataUrlSchema = z.string().startsWith("data:image/").max(150_000);

// The platform's "pro" plan price, read live from Stripe (STRIPE_PRO_PRICE_ID) so the upgrade dialog never
// shows a figure that drifts from what's charged. `amount` is in the currency's minor unit (Stripe unit_amount,
// e.g. cents); `currency` is the lowercase ISO code (Stripe convention); `interval` is the billing period.
export const PricingSchema = z.object({
    amount: z.number(),
    currency: z.string(),
    interval: z.string(),
});
export type Pricing = z.infer<typeof PricingSchema>;

// The platform's billing tiers. The tier is resolved SERVER-side from the persisted Subscription rows the
// Better Auth Stripe plugin writes — never from client-listed subscriptions — because it gates API routes.
export const PlanSchema = z.enum(["free", "pro"]);
export type Plan = z.infer<typeof PlanSchema>;

// What the caller's plan entitles them to, resolved from the API's PLAN_ENTITLEMENTS config (the single source
// of truth for what's gated). `sandboxLimit` absent = unlimited. The web uses this only to render upsell states
// early — gated routes enforce regardless and throw PAYMENT_REQUIRED (402).
export const EntitlementsSchema = z.object({
    sandboxLimit: z.number().optional(),
    sandboxSharing: z.boolean(),
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;

export const PlanInfoSchema = z.object({ plan: PlanSchema, entitlements: EntitlementsSchema });
export type PlanInfo = z.infer<typeof PlanInfoSchema>;

// Remove-by-name input for the inventory routes (one sandbox per user, so the name identifies the entry).
export const RemoveInventoryInputSchema = z.object({
    name: z.string().min(1),
});
export type RemoveInventoryInput = z.infer<typeof RemoveInventoryInputSchema>;

// ---- live actual-state plan: an on-demand read of the realized infrastructure ----
//
// The platform streams the in-sandbox `intentic plan` (the engine's read+diff, no apply) over SSE, mapping each
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
// of asking for the user's Cloudflare token. sandbox.list returns owned ∪ shared.
export const SandboxSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    daemonUrl: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    token: z.string(),
    role: z.enum(["owner", "member"]),
    providedTunnel: z.boolean(),
});
export type SandboxSummary = z.infer<typeof SandboxSummarySchema>;

// ---- invites: sharing a sandbox with teammates by email ----

// A row in the owner's access roster: an email plus its derived state. `pending` = invited, link not yet
// accepted; `accepted` = an active member; `expired` = the invite link lapsed unaccepted (owner can resend).
// `expiresAt` is the link's expiry (ISO), absent once accepted or when there is none.
export const InviteStatusSchema = z.enum(["pending", "accepted", "expired"]);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;
export const InviteRecordSchema = z.object({
    email: z.string(),
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
    // From status.json (the last `intentic apply`); undefined before the first apply.
    converged: z.boolean().optional(),
    iterations: z.number().optional(),
    access: z.array(AccessEntrySchema).optional(),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

// ---- apps: the live Komodo deployments, contextualized by the desired-state graph ----
//
// Surfaced by the in-sandbox `intentic deployments` subcommand: it reads each `deployment` node's configured
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
