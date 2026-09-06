import type { ResourceType } from "@intentic/resources";
import type {
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
    CapabilityProbeSchema,
    CapabilityRecommendationSchema,
    CapabilityStateSchema,
    CapabilityStatusSchema,
    CapabilitySummarySchema,
    ApprovalSchema,
    ApprovalStatusSchema,
    ApprovalsListSchema,
    ApprovalSummarySchema,
    ArrivalHostSchema,
    ArrivalItemSchema,
    ArrivalPlanSchema,
    ArrivalReportSchema,
    ArrivalSourceSchema,
    DefinitionDiffSchema,
    DefinitionExportSchema,
    WorkspacePublishResultSchema,
    WorkspaceRemoteSchema,
    EngineRowSchema,
    EnginesViewSchema,
    EnvironmentContentsSchema,
    EnvironmentSchema,
    BundleExportSchema,
    InventoryEntrySchema,
    InventoryProviderSchema,
    LogFileEntrySchema,
    LogReadSchema,
    MarketplaceSchema,
    PanelLaunchSchema,
    PanelSummarySchema,
    PushConfigSchema,
    RepoAppSchema,
    RuleFiringsSchema,
    RuleMomentSchema,
    RuleSchema,
    SafetyLogEntrySchema,
    SafetyPolicySchema,
    SandboxSettingsSchema,
    ServiceKindSchema,
    AgentChangeSchema,
    AgentChangesSchema,
    AgentHistoryCommitSchema,
    AgentHistorySchema,
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
    LandedMessageDraftSchema,
    LandedMessageSchema,
    LandedMessageStepSchema,
    OriginAgentSchema,
    RepoChangesSchema,
    RepoPathsSchema,
    SnapshotChangeSchema,
    SnapshotDiffSchema,
    SnapshotSchema,
    SnapshotsListSchema,
    SkillBodySchema,
    SkillDraftSchema,
    SkillOriginSchema,
    SkillSummarySchema,
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
import { GrantedRoleSchema, MemberRoleSchema, PushNotificationSchema } from "@intentic/sandbox-contract";
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
    CapabilityProbeSchema,
    CapabilityRecommendationSchema,
    CapabilityStateSchema,
    CapabilityStatusSchema,
    CapabilitySummarySchema,
    ApprovalSchema,
    ApprovalStatusSchema,
    ApprovalsListSchema,
    ApprovalSummarySchema,
    NeedsActionSchema,
    ArrivalGroupSchema,
    ArrivalHostSchema,
    ArrivalHostsSchema,
    ArrivalItemSchema,
    ArrivalPlanSchema,
    ArrivalReportSchema,
    ArrivalSourceSchema,
    AssistantSourceSchema,
    DefinitionDiffSchema,
    DefinitionExportSchema,
    WorkspacePublishResultSchema,
    WorkspaceRemoteSchema,
    EngineRowSchema,
    EnginesViewSchema,
    EnvironmentContentsSchema,
    EnvironmentSchema,
    BundleExportSchema,
    BundleExportsSchema,
    InventoryEntrySchema,
    InventoryProviderSchema,
    InventoryValuesSchema,
    LogFileEntrySchema,
    LogReadSchema,
    LogsListSchema,
    MarketplaceSchema,
    PanelLaunchSchema,
    PanelsListSchema,
    PanelSummarySchema,
    PushConfigSchema,
    RepoAppSchema,
    RuleFiringsSchema,
    RuleMomentSchema,
    RuleSchema,
    SafetyLogEntrySchema,
    SafetyPolicySchema,
    SandboxSettingsSchema,
    ServiceEntrySchema,
    ServiceKindSchema,
    SkillBodySchema,
    SkillDraftSchema,
    SkillOriginSchema,
    SkillsListSchema,
    SkillSummarySchema,
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
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;
export type EngineRow = z.infer<typeof EngineRowSchema>;
export type EnginesView = z.infer<typeof EnginesViewSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type EnvironmentContents = z.infer<typeof EnvironmentContentsSchema>;
export type EnvironmentItem = EnvironmentContents["items"][number];
// One line of the runtime-install list, derived from the payload that carries it rather than imported
// separately, for the reason EnvironmentItem is: the row type cannot drift from the response it arrives in.
export type EnvironmentRecurring = NonNullable<Environment["recurring"]>[number];
export type DefinitionExport = z.infer<typeof DefinitionExportSchema>;
export type DefinitionDiff = z.infer<typeof DefinitionDiffSchema>;
export type WorkspaceRemote = z.infer<typeof WorkspaceRemoteSchema>;
export type WorkspacePublishResult = z.infer<typeof WorkspacePublishResultSchema>;
// The arrival pipeline: one plan/apply/report the four inbound sources share (sandbox-contract's arrival.ts).
export type ArrivalHost = z.infer<typeof ArrivalHostSchema>;
export type ArrivalItem = z.infer<typeof ArrivalItemSchema>;
export type ArrivalPlan = z.infer<typeof ArrivalPlanSchema>;
export type ArrivalSource = z.infer<typeof ArrivalSourceSchema>;
// The two a connected computer can be scanned for; a bundle is a file, never a setup sitting in a home folder.
export type AssistantSource = Extract<ArrivalSource, "hermes" | "openclaw">;
export type ArrivalReport = z.infer<typeof ArrivalReportSchema>;
export type BundleExport = z.infer<typeof BundleExportSchema>;
export type Marketplace = z.infer<typeof MarketplaceSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;
export type ApprovalsList = z.infer<typeof ApprovalsListSchema>;
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;
export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export type SkillBody = z.infer<typeof SkillBodySchema>;
export type SkillDraft = z.infer<typeof SkillDraftSchema>;
export type RuleMoment = z.infer<typeof RuleMomentSchema>;
export type RuleFirings = z.infer<typeof RuleFiringsSchema>;
export type SafetyPolicy = z.infer<typeof SafetyPolicySchema>;
export type SafetyLogEntry = z.infer<typeof SafetyLogEntrySchema>;
export type BuiltinPromptText = z.infer<typeof BuiltinPromptTextSchema>;
export type PanelSummary = z.infer<typeof PanelSummarySchema>;
export type PanelLaunch = z.infer<typeof PanelLaunchSchema>;
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export type TemplatesList = z.infer<typeof TemplatesListSchema>;
export type RepoApp = z.infer<typeof RepoAppSchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type ActivityConnection = z.infer<typeof ActivityConnectionSchema>;
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export type LogRead = z.infer<typeof LogReadSchema>;

// Workspace tree / file / children. The daemon's Zod schema infers `children` loosely (Record<string, unknown>[]
//, a z.lazy recursion limit), but the web renders a recursive tree, so the platform keeps the PRECISE recursive
// interface here. The daemon WorkspaceTree*Schema stay re-exported above for runtime parsing.
/* A symlink entry: `to` is the link's own text (what hover shows), and `type` on the entry beside it is the
 * type of what it POINTS AT, so a link to a folder expands and a link to a file opens. `state` is absent when
 * the link resolves inside the workspace; "broken" means nothing is at the other end, "outside" means it
 * leaves the workspace and the daemon refuses to follow it. */
export interface WorkspaceLink {
    readonly to: string;
    readonly state?: "broken" | "outside";
}
export interface WorkspaceTreeEntry {
    readonly name: string;
    // Root-relative path (forward slashes), fed straight back to the file route.
    readonly path: string;
    readonly type: "file" | "dir";
    readonly size?: number;
    // Ignored-by-tooling (node_modules, .git, .gitignore'd, browser profiles): the row is grayed.
    readonly ignored?: boolean;
    // Present when the entry is a symlink, `type` above is then its target's type.
    readonly link?: WorkspaceLink;
    // Absent on a DIR that was listed but not descended into (ignored, or below the walk's breadth-first
    // budget), the client lazy-loads it on expand. An empty dir has `children: []`, not `undefined`.
    readonly children?: readonly WorkspaceTreeEntry[];
}
export interface WorkspaceTreeResponse {
    readonly root: string;
    readonly tree: readonly WorkspaceTreeEntry[];
    // How many of the ROOT's own entries the budget cut (0 = complete); per-dir cuts are counted on each entry.
    readonly hidden: number;
    /* Every folder holding nothing but empty folders, root-relative, in tree order. Answered by a walk of its
     * own daemon-side and NOT derivable from `tree` above: a dir below the budget's cut arrives without
     * `children`, which means "not looked at" rather than "empty", so reading emptiness off the listing would
     * shrink it to whatever the budget reached. Complete however little of the tree was listed. */
    readonly barren: readonly string[];
}
// Children of one not-yet-descended dir, fetched lazily on expand (GET /workspace/children).
export interface WorkspaceChildrenResponse {
    readonly entries: readonly WorkspaceTreeEntry[];
    readonly hidden: number;
}
/* One WINDOW of a file's text. `size` is the whole file on disk, `offset`/`bytes` the byte range `content`
 * decodes from, so `offset > 0 || offset + bytes < size` means there is more, and `offset + bytes` is where
 * the next window starts. Byte counts, not `content.length`: they differ on non-ASCII, and the daemon reads
 * by byte. The viewer gates on `size` from here rather than on a tree entry's, which it may not have. */
export interface WorkspaceFileWindow {
    readonly present: true;
    readonly path: string;
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
    // Which tree answered, the shared /work one, or the conversation's own checkout the request named
    // (`?agent=`). True despite a scope when that checkout doesn't carry the path, which is legitimate: a
    // checkout is not a superset of /work. The one thing the reader must not have to guess.
    readonly shared: boolean;
}
/* A read of a path with nothing at it, a successful answer, not a failure. Most reads in the product are "read
 * it if it is there" (a bookkeeping file nobody has written yet, a directory with no UI document of its own, a
 * document set nobody has generated), so absence is an ordinary value and the daemon says so in the body rather
 * than in the status. A read the caller was not ALLOWED to make still fails. */
export type WorkspaceFileResponse = WorkspaceFileWindow | { readonly present: false; readonly path: string };
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
// import graph's key modules, the same resident engine that answers search, ranking instead of matching.
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;

// Workspace history (daemon-captured snapshots). Daemon names: Snapshot / SnapshotsList / SnapshotDiff,
// kept under the platform's historical *Response names as derived aliases.
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export type WorkspaceSnapshot = z.infer<typeof SnapshotSchema>;
export type SnapshotsResponse = z.infer<typeof SnapshotsListSchema>;
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export type SnapshotDiffResponse = z.infer<typeof SnapshotDiffSchema>;
// Shared by the snapshot file diff and the working-tree (Changes review) file diff.
export type FileDiffResponse = z.infer<typeof FileDiffSchema>;
// Which of the working tree's two diffs a Changes row opens, index-vs-HEAD or worktree-vs-index.
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;

// The Changes review (uncommitted work per repo, VSCode-SCM style).
export type GitChange = z.infer<typeof GitChangeSchema>;
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
// One repo's slice of an action that spans repos, the whole repo, or just the paths named. git can't span
// repos, so every batch verb in the Changes panel (stage, discard, commit, the AI draft) groups into these.
export type RepoPaths = z.infer<typeof RepoPathsSchema>;
// Who an agent id named in a repo's `origins` is, the review carries it, because the fleet roster drops an
// archived agent while its landed lines are still in the tree.
export type OriginAgent = z.infer<typeof OriginAgentSchema>;
// What a landing is called: the commit message drafted from its diff, carried by the agent's card while it is
// on the board and by the review's origin record after it leaves. One shape, so the panel reads one lookup.
export type LandedMessage = z.infer<typeof LandedMessageSchema>;
// The full account of that message being drafted, which models were asked, how each went, how it ended,
// live on the agent's card while it runs, kept after it ends until the next land replaces it.
export type LandedMessageDraft = z.infer<typeof LandedMessageDraftSchema>;
export type LandedMessageStep = z.infer<typeof LandedMessageStepSchema>;
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
// The per-agent worktree review, one flat change set per repo, NOT the working tree's staged/unstaged shape.
// A row is one file the agent wrote that still differs from main, flagged with whether the workspace already
// holds that content; files the user has committed are gone from the list and counted in `absorbed`.
export type AgentChange = z.infer<typeof AgentChangeSchema>;
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
export type AgentChangesResponse = z.infer<typeof AgentChangesSchema>;
// Where the absorbed half of that review went: the commits of the user's OWN history that carry the files the
// review can no longer list, because a file the user committed is not a difference against main any more.
export type AgentHistoryCommit = z.infer<typeof AgentHistoryCommitSchema>;
export type AgentHistoryResponse = z.infer<typeof AgentHistorySchema>;

// ---- platform-native (owned by the platform; NOT daemon wire shapes) ----

export const UserSchema = z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    image: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

/* THE CALLER'S HOSTED PLAN, as the Billing page renders it (docs/design/billing-view.md). `enabled: false` (a
 * platform with no plan configured) means the page does not exist; everything else describes the caller:
 * `onPlan` is the entitlement answer, `comped` says it came from the operator's comp list rather than a
 * subscription (nothing to manage, nothing to buy), `status` is Stripe's word for the state (past_due is worth
 * a sentence), `renewsAt` is display and `cancelAtPeriodEnd` turns "renews" into "ends": the portal's cancel
 * leaves the status active until the period runs out, and a page that could not see that told people who had
 * just cancelled that they would renew. The price rides along so the page can never disagree with the
 * platform about the number on the button, and it is for everyone: the person deciding whether to buy is
 * precisely the one who does not have it yet.
 *
 * `hosted` is the lane as it applies to THIS account, present for a signed-in caller on a platform that runs
 * machines at all: how many hosted sandboxes they may have (slots), the ones they have, this month's meter,
 * and what a slot is. One read for one page, and the same read the avatar row and the Overview card use. */
export const HostedPlanMachineSchema = z.object({
    sandboxId: z.string(),
    name: z.string(),
    region: z.string(),
    // Awake since (or stopped with its stretch not yet settled). Null when asleep and settled.
    wokeAt: z.iso.datetime().nullable(),
});
export type HostedPlanMachine = z.infer<typeof HostedPlanMachineSchema>;

export const HostedPlanUsageSchema = z.object({
    // The calendar month the meter is keyed by, `YYYY-MM` UTC.
    month: z.string(),
    // Awake minutes so far, live: a machine that is up right now counts the minutes since it woke.
    usedMinutes: z.number().int().nonnegative(),
    // The free lane's ceiling in minutes; null when this owner is unmetered (on the plan, or a platform with
    // no ceiling), in which case `usedMinutes` is information with nothing beside it.
    allowanceMinutes: z.number().int().nonnegative().nullable(),
    // When the month rolls over (the first of next month, UTC).
    resetsAt: z.iso.datetime(),
});
export type HostedPlanUsage = z.infer<typeof HostedPlanUsageSchema>;

export const HostedPlanHostedSchema = z.object({
    // Hosted sandboxes this account may have: the plan's quantity while it is live, the free lane's one otherwise.
    slots: z.number().int().nonnegative(),
    machines: z.array(HostedPlanMachineSchema),
    usage: HostedPlanUsageSchema,
    // The machine every slot is, the same on the free lane and the plan.
    shape: z.object({ cpus: z.number().int().positive(), memoryMb: z.number().int().positive(), volumeGb: z.number().int().positive() }),
});
export type HostedPlanHosted = z.infer<typeof HostedPlanHostedSchema>;

export const HostedPlanStateSchema = z.object({
    enabled: z.boolean(),
    onPlan: z.boolean(),
    comped: z.boolean().optional(),
    status: z.string().optional(),
    renewsAt: z.iso.datetime().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    priceUsd: z.number(),
    hosted: HostedPlanHostedSchema.optional(),
});
export type HostedPlanState = z.infer<typeof HostedPlanStateSchema>;

// The most hosted sandboxes one plan sells. A number a person can reach by pressing a button, and one the
// platform's own cost can absorb without anybody looking; more is a conversation.
export const HOSTED_PLAN_MAX_SLOTS = 10;

// Avatars and sandbox logos are stored inline as small data URLs (client-side canvas downscale), this caps
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
// live infra. `action` is the reconcile verdict, "noop" (in sync), "create" (absent / would create),
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
// `daemonUrl` + `lastSeenAt` (ISO) are reported by the daemon's announce, null until it first phones home.
// `role` is the caller's relationship to it (owner can manage access; member has access only). `providedAddress`
// is server-computed: the reported daemonUrl lives under intentic's own zone (an address the platform made
// reachable, by tunnel or by replay to a hosted machine), so the infra operator panel knows to mint host tunnels
// via the daemon's relay (POST /sandbox/host-tunnel) instead of asking for the user's Cloudflare token.
// `setupCodeClaimedAt` (ISO) is when a machine last redeemed the
// sandbox's CURRENT setup code, the setup wizard's only evidence that the pasted command actually ran, which
// is what lets it stop showing a spinner at someone who has not opened a terminal yet. sandbox.list returns
// owned ∪ shared.
// One broken check of a machine-side setup run, as the machine reported it: the check's name, what it
// found, and what to do about it, prose written for the person at the wizard and rendered verbatim.
// `remedy` may be empty: the flow's own failure messages carry their fix inline.
export const SetupReportFailureSchema = z.object({
    check: z.string().max(120),
    problem: z.string().max(2000),
    remedy: z.string().max(2000),
});
// Where the machine-side setup run stands, ic POSTs this to /setup/report on every stage transition and on
// any terminal failure, authenticated by possession of the live setup code (the claim's own trust). The
// stages are the connect flow's real phases, so the wizard can narrate honest progress during the minutes of
// invisible Docker work; a non-empty `failed` is a verdict, not progress. `at` (ISO) is stamped by the
// platform on receipt, the reporting machine's clock is never trusted.
export const SetupReportSchema = z.object({
    stage: z.enum(["preflight", "pulling-image", "creating-tunnel", "starting-sandbox", "starting-connector", "waiting-health", "verifying", "done"]),
    failed: z.array(SetupReportFailureSchema).max(12),
    at: z.string(),
});
export type SetupReport = z.infer<typeof SetupReportSchema>;

/* THE DAEMON'S OWN ACCOUNT OF ITS BOOT. SetupReportSchema's counterpart for the half of the chain no setup
 * code covers. The hosted lane has no `ic` run to narrate (the machine's first boot IS the sandbox), and the
 * one link nothing else can see is the one that broke during the tunnel migration: a daemon that is up,
 * announcing, and whose PUBLIC ADDRESS answers nobody. So the box checks that address from the inside and
 * POSTs the verdict to /sandbox/boot-report, authenticated by the connect token, the same outbound path the
 * announce uses, which is exactly why it still works when the tunnel is the broken thing.
 *
 * `reach` is that verdict and nothing else:
 *   • `checking`   , the daemon is up and the probe has not concluded yet
 *   • `reachable`  , its own public address answered it; the sandbox is genuinely usable from outside
 *   • `unreachable`, it did not, and `detail` says how (a status, a refusal, a timeout)
 *
 * The wizard holds the handover on this: an announce means "the daemon started", which is NOT the same claim
 * as "you can reach it", and treating the two as one is what dropped people into a workspace spinner. `at`
 * (ISO) is stamped by the platform on receipt, the reporting machine's clock is never trusted. */
export const BootReportSchema = z.object({
    reach: z.enum(["checking", "reachable", "unreachable"]),
    // Why, for `unreachable`, already in the user's terms, rendered verbatim like a setup failure's problem.
    detail: z.string().max(2000).optional(),
    /* Where the daemon's BOOT CHAIN stands (its main.ts steps, the same list the workspace's own warm-up gate
     * draws), so the setup wait can hold and narrate ONE wait instead of handing over to a second card. `ready`
     * is the readiness gate; `step` names the running step while there is one. Absent from a daemon older than
     * this, which the wait treats exactly as it did before. */
    boot: z
        .object({
            ready: z.boolean(),
            step: z.string().max(200).optional(),
            done: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
        })
        .optional(),
    /* How much of the machine's time the host took back so far (the daemon's platform/cpu-throttle.ts): the one
     * number that tells a slow first boot that was the daemon's work from one that was the host's quota. */
    cpu: z.object({ throttledMs: z.number().nonnegative(), throttledPeriods: z.number().int().nonnegative() }).optional(),
    at: z.string(),
});
export type BootReport = z.infer<typeof BootReportSchema>;

/* A CHECK-IN WE TURNED AWAY, kept because the refusal is otherwise a perfect silence: the box retries, we say
 * no, and every screen shows what it shows a machine that never booted. Both halves together or neither,
 * "it announced at X" is a fact nobody can act on without "and we expect it at Y", and the browser has no way
 * to derive the second (the zone is the platform's), so the record carries the comparison rather than an
 * operand of it. Neither is secret: X is what the sandbox itself just claimed, Y is its own public address. */
export const AnnounceRefusalSchema = z.object({ announced: z.string(), expected: z.string() });
export type AnnounceRefusal = z.infer<typeof AnnounceRefusalSchema>;

/* THE ONE FACT ABOUT A HOSTED MACHINE THAT COSTS A CALL, which is why it is a route of its own rather than a
 * field on the summary: the machine's power state has to be asked of the provider, and a list that carries it
 * would ask once per row on every poll. Everything else the wait needs (the boot report above, a refused
 * check-in) is already on the row and rides the summary.
 *
 * `unknown` covers both "this platform cannot ask" and "the provider answered a state we don't model", the
 * wait must degrade to today's honest spinner on an unrecognized state, never break on one. Otherwise this is
 * the only signal that exists BEFORE the daemon does, which makes it the only way to tell a machine that
 * never booted from one that booted and went quiet.
 *
 * `gone` is the state Fly reports by refusing to answer at all: the machine, or the whole app around it, does
 * not exist. It is deliberately NOT folded into `unknown`, because the two ask opposite things of the reader.
 * Unknown means keep waiting, we cannot see; gone means stop waiting, there is nothing there and only a new
 * machine will do. Flattening them is what left people watching a spinner for a box that had been destroyed. */
export const HostedStatusSchema = z.object({
    machine: z.enum([
        "unknown",
        "gone",
        "created",
        "starting",
        "started",
        "stopping",
        "stopped",
        "suspended",
        "replacing",
        "destroying",
        "destroyed",
        "failed",
    ]),
});
export type HostedStatus = z.infer<typeof HostedStatusSchema>;

/* A HOSTED SANDBOX'S OVERLAY BUILD, as the Environment card follows it. On a docker host the owner runs
 * `ic sandbox rebuild` themselves and watches its terminal; a hosted sandbox has no host, so the platform
 * builds the approved overlay on a machine of its own and this is the window onto that build. `hash` is the
 * approved content's sha256, the one the daemon will report as applied once the machine boots the result.
 * `log` is the builder's own output, present when there is something to read, which is above all a failed
 * `RUN`: the reason the recipe did not build is the one thing the owner needs from a failure. */
export const HostedBuildStateSchema = z.object({
    state: z.enum(["building", "built", "failed"]),
    hash: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    error: z.string().optional(),
    log: z.string().optional(),
});
export type HostedBuildState = z.infer<typeof HostedBuildStateSchema>;

/* The most overlay the platform will carry into a builder. A composed overlay is a few kilobytes of RUN lines;
 * a quarter megabyte is far past any recipe and well short of what an abusive request could make a build
 * machine chew on. */
export const HOSTED_OVERLAY_MAX_BYTES = 256 * 1024;

/* What the browser hands over to have an overlay built: the approved content AND its hash, both read off the
 * daemon's /environment route. The platform re-hashes the content, which is the same guarantee `ic sandbox
 * rebuild <hash>` gives on a docker host: only bytes that still hash to what the owner reviewed are built. */
export const HostedRebuildInputSchema = z.object({
    sandboxId: z.string(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    content: z.string().min(1).max(HOSTED_OVERLAY_MAX_BYTES),
});
export type HostedRebuildInput = z.infer<typeof HostedRebuildInputSchema>;

// The build in flight or the last one finished, or null when this sandbox never asked for one. `applied` is
// the overlay hash the platform last booted the machine with (null on the stock image), the platform's own
// record, which is there before the daemon is back to say the same.
export const HostedBuildStatusSchema = z.object({
    build: HostedBuildStateSchema.nullable(),
    applied: z.string().nullable(),
});
export type HostedBuildStatus = z.infer<typeof HostedBuildStatusSchema>;

/* The HOSTED lane's machine as the browser sees it: the platform created it on its OWN provider account and
 * keeps the way back in, so its presence is an affordance rather than residue: an unreachable hosted daemon
 * means "call sandbox.wake and keep probing", never "it's gone". Deliberately no live machine state, wake is
 * idempotent (waking a running machine is a no-op), so the browser needs no second source of truth beside the
 * daemon's own answer.
 *
 * There used to be a counterpart with the opposite stance, `SandboxCloudSchema`, for a lane that created ONE
 * VM in the user's own Hetzner, DigitalOcean or Oracle account off a pasted API token. It is gone, and so is
 * every trace of it: a sandbox now runs either on a machine the platform hosts or on a computer the reader
 * already owns, and onboarding picks between those two by which surface the reader arrived on rather than by
 * asking. A third answer whose first step was "create an API key in your provider's console" was the answer
 * nobody could take on the screen where it was offered. */
export const SandboxHostedSchema = z.object({
    region: z.string(),
    /* Whether this machine came WARM from the pool (image already on its host, boots in seconds) or was
     * built to order (first boot pulls the image, minutes). The setup wait reads it to make the right
     * promise: "under a minute" over a cold pull is the lie that made healthy first boots read as stuck.
     * A fact about the machine's origin, so it is stable across polls and reloads mid-wait. */
    warm: z.boolean(),
});
export type SandboxHosted = z.infer<typeof SandboxHostedSchema>;

/* The hosted lane's offer, read before anything is created: `enabled` mirrors platform config (a platform
 * with no provider token offers no hosted lane, routes 404, editor never mentions it), `remaining` is how
 * many more hosted sandboxes THIS caller may still create under the per-user allowance. What the editor's
 * zero-click first run and the wizard's lead card both gate on.
 *
 * `hours` is the free lane's awake-time budget for this caller, and is ABSENT for anyone unmetered, a
 * member, or a platform running with no ceiling. Absent means "do not mention hours at all", which is what
 * keeps a limit that does not apply to this person off their screen entirely rather than shown as a
 * generous-looking number they never asked about. */
export const HostedHoursSchema = z.object({
    // The monthly ceiling and what is left of it, in whole hours. Rounded for display only, the meter itself
    // counts minutes, and `remaining` floors, so "1 hour left" never means four minutes.
    allowance: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
});
export type HostedHours = z.infer<typeof HostedHoursSchema>;

export const HostedOfferSchema = z.object({
    enabled: z.boolean(),
    remaining: z.number().int().nonnegative(),
    hours: HostedHoursSchema.optional(),
    // True when the caller is on the hosted plan (or comped onto it): no hours, and the card says "always
    // on" rather than "free", which is the other reason `hours` can be absent (a platform with no ceiling).
    plan: z.boolean().optional(),
});
export type HostedOffer = z.infer<typeof HostedOfferSchema>;

/* Whether this platform can give a sandbox an address of its own, the tunnel fabric behind `setupCode`. A
 * platform that has not stood one up (the self-hoster's default) mints no codes at all, so the pasted-command
 * lane cannot finish on it, and the wizard must say so BEFORE it draws it. Asking the mint was the only way to
 * find out, which meant offering the lane first and retracting it a round-trip later. */
export const AddressOfferSchema = z.object({ enabled: z.boolean() });

/* THE PLATFORM'S WORD FOR WHO OWNS A HOSTED SANDBOX (sandbox-contract's owner-ticket.ts): a short-lived signed
 * claim the browser spends on that sandbox's daemon for a session, so signing in to the platform is the only
 * sign-in a hosted user makes. Minted only for the owner, only for a sandbox on a machine the platform runs,
 * and only where the platform can sign at all; everywhere else the route 404s and the browser asks Google. */
export const OwnerTicketSchema = z.object({
    ticket: z.string(),
    // ISO, the moment the ticket stops verifying; the browser spends it at once and never stores it.
    expiresAt: z.string(),
});
export type OwnerTicket = z.infer<typeof OwnerTicketSchema>;
export type AddressOffer = z.infer<typeof AddressOfferSchema>;

export const SandboxSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    daemonUrl: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    setupCodeClaimedAt: z.string().nullable(),
    // The machine-side setup run's last word (see SetupReportSchema), null until a report lands, cleared on
    // every mint like the claim stamp.
    setupReport: SetupReportSchema.nullable(),
    // The DAEMON's own last word about its boot (see BootReportSchema), null until the sandbox reports, which
    // is also what a sandbox running an image older than this feature looks like. Every lane's, not just the
    // hosted one: a tunnel that never came up strands a pasted run exactly as hard.
    bootReport: BootReportSchema.nullable(),
    // The last check-in we refused, and why (see AnnounceRefusalSchema). Null in the overwhelmingly common
    // case of never having refused one. Cleared by an announce that succeeds, so a value here always
    // describes a live disagreement rather than one somebody already fixed.
    announceRefusal: AnnounceRefusalSchema.nullable(),
    token: z.string(),
    // The caller's trust tier on this sandbox: `owner` for their own, the invite's granted role for a shared
    // one. What the web gates its affordances on; the daemon independently enforces the same tier as route
    // floors, so this is a rendering fact, never the security boundary.
    role: MemberRoleSchema,
    providedAddress: z.boolean(),
    /* THE NAME THIS SANDBOX'S LOOPBACK LISTENER IS CERTIFIED UNDER, or null where it cannot have one (no
     * connect token to derive an id from, or a platform with the loopback-certificate path switched off).
     *
     * Server-computed, and it has to be, because it is the one address in the product that lives in a
     * DIFFERENT zone from the sandbox itself. The browser used to derive it from `daemonUrl` — right only
     * while a sandbox's public zone and the platform's DNS zone were the same one, which stopped being true
     * the moment reachability moved to the platform's own edge: the sandbox answers under `sbx.<zone>` while the wildcard
     * and the ACME challenge are written under `<zone>`. The two names never met, so the browser probed an
     * address nothing was certified for, failed, and quietly settled for the plain-http loopback — HTTP/1.1,
     * six connections per origin, which is the transport the whole stream budget exists to survive.
     *
     * The platform owns the zone, so the platform says the name. One field ends the guessing on both sides
     * (the daemon asks for it too, over /sandbox/local-dns). */
    localHostname: z.string().nullable(),
    // The hosted lane's live machine record (sandbox.hostedCreate), null for a sandbox running on a computer
    // the reader owns. The delete dialog warns the MACHINE dies with the sandbox, and an unreachable daemon
    // with `state` ≠ started means "wake it", not "it's gone".
    hosted: SandboxHostedSchema.nullable(),
});
export type SandboxSummary = z.infer<typeof SandboxSummarySchema>;

// The sandbox's public base URL as the OWNER asserts it (sandbox.attach) instead of the daemon announcing it,
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
    // The trust tier this invite grants (viewer/collaborator/maintainer, never owner). The daemon's members
    // list is the enforced copy; this row is what the roster renders and re-grades from.
    role: GrantedRoleSchema,
    status: InviteStatusSchema,
    invitedAt: z.string(),
    expiresAt: z.string().optional(),
});
export type InviteRecord = z.infer<typeof InviteRecordSchema>;
export const InviteListSchema = z.object({ members: z.array(InviteRecordSchema) });

/* HOW THE LINK TRAVELLED, the answer to an invite/resend, beside the roster.
 *
 * The grant is done before the mail is attempted (the daemon holds it, the row is written), so delivery is a
 * separate fact and not the verdict on the mutation. `sent` is the ordinary path. `unconfigured` is a platform
 * with no mail credentials, `local-link` one whose own address only resolves on the machine running it, both
 * are this platform declining to send something nobody could act on. `refused` is the send that was made and
 * rejected. In every case but the first the owner is the courier, which is why `link` always comes back. */
export const InviteDeliverySchema = z.enum(["sent", "unconfigured", "local-link", "refused"]);
export type InviteDelivery = z.infer<typeof InviteDeliverySchema>;
export const InviteSentSchema = z.object({
    members: z.array(InviteRecordSchema),
    // The accept link just minted, for the owner to hand over when the mail didn't (or couldn't) carry it.
    link: z.string(),
    delivery: InviteDeliverySchema,
    /* What the mail provider said when it refused, verbatim-ish, for `refused` only. This is the owner's own
     * platform rejecting their own send, a quota, a key, an unverified domain, and every one of those is
     * fixed by the person reading the card. It used to be reachable only in the server's console, which is why
     * the same invite could fail all afternoon with nothing on screen but "internal server error". */
    reason: z.string().optional(),
});

// What the public accept page renders from an invite token (no session needed). `invalid` = no such token;
// otherwise the sandbox name + the invited address so the page can prompt sign-in as the right account. Name and
// email are omitted for an invalid token (nothing to show).
export const InvitePreviewStatusSchema = z.enum(["pending", "accepted", "expired", "invalid"]);
export const InvitePreviewSchema = z.object({
    status: InvitePreviewStatusSchema,
    sandboxName: z.string().optional(),
    invitedEmail: z.string().optional(),
    /* THE TIER THE LINK CARRIES, so the page that asks someone to accept can say what they are accepting.
     * Without it the invitation read "open and work in" to everybody, including a viewer, whose whole grant is
     * watching: they accepted a promise the sandbox then declined to keep, and every refusal afterwards looked
     * like a fault rather than the tier they were given. Absent on an invalid token, where nothing is exposed. */
    role: GrantedRoleSchema.optional(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

// Zone discovery for the setup screen's picker. The Cloudflare token can reach more than one zone (domain), and
// the sandbox refuses to guess which one to provision under, so the user must choose before the install command
// is revealed. The browser can't list zones itself (Cloudflare's API sends no CORS headers), so the token is
// posted here for a SINGLE request-scoped call to Cloudflare and then discarded: it is never persisted, logged,
// or stored. This is the one place the token transits the platform (the narrowed secret-free invariant).
// The pasted Cloudflare token + the zones it can see. NOT the sandbox tunnel's business any more (that fabric
// is self-hosted), this serves the in-app Cloudflare capability, where a user connects their OWN zone for the
// deploy engine to publish their apps under. Request-scoped: used for the one listing call, never stored.
export const CfTokenSchema = z.object({ token: z.string().min(1) });
export const CfZonesSchema = z.object({ zones: z.array(z.string()) });
export type CfZones = z.infer<typeof CfZonesSchema>;

/* The setup code: ONE short-lived value the copy-paste install command carries instead of raw tokens (nothing
 * secret lands in shell history or the process list). The connect script redeems it at POST /setup/claim (a
 * public non-oRPC route, the script has no session) for CONNECT_TOKEN plus the sandbox's reachability grant on
 * the platform's own edge: {SANDBOX_GRANT, INGRESS_URL, SANDBOX_HOSTNAME, OWNER_EMAIL}.
 *
 * There is no target to choose any more. Under the platform's own tunnel fabric every sandbox's address is
 * DERIVED from its connect token (`sandbox-<id>.<zone>`), the bring-your-own-Cloudflare lane it used to
 * select died with the Cloudflare tunnels, and "I have my own domain" is served by the attach lane, which
 * provisions nothing at all. */
export const SetupCodeSchema = z.object({ code: z.string(), hostname: z.string(), expiresAt: z.string() });
export type SetupCode = z.infer<typeof SetupCodeSchema>;

// ---- workspace state: the Overview / topology read-model ----
//
// A "view" is a projection of (desired-state graph ⊕ reconciliation drift). The platform reads the sandbox's
// resolved artifact (desired-state/desired-state.json, the compiled form of deploy.config.ts) and the last
// apply result (status.json) THROUGH the sandbox (its git file routes), and shapes this render-ready model
// server-side. The sandbox stays the source of truth (CLAUDE.md); only non-secret scalar inputs are surfaced,
// $secret/$ref values are dropped upstream.

// Coarse lenses the closed resource-type vocabulary buckets into, for grouping in the Overview.
export const ResourceGroupSchema = z.enum(["infra", "git", "deploy", "data", "notify", "other"]);
export type ResourceGroup = z.infer<typeof ResourceGroupSchema>;

// The coarse group each resolver resource-type buckets into, the single source the infra render models read
// (the web's local projection today; any server-side projection tomorrow) so a new kind can't silently land in
// the wrong bucket. Typed Record<ResourceType, …> via a type-only import (erased at runtime, no dep weight in
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
// detail (logs, container status) lives in Komodo's own UI, deep-linked via komodoDeploymentUrl (hybrid).
export const DeploymentSchema = z.object({
    // The graph node id (e.g. "app.production"), also the Komodo deployment name.
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

// ---- push relay: APNs on behalf of daemons that hold no vendor secret ----
//
// Apple only accepts pushes from the app's vendor, so a native install cannot be posted to directly the way a
// browser's web-push endpoint can. The relay is the platform's answer: the signed-in web app registers the
// shell's device token here, the grant it gets back is stored on the DAEMON as a relay channel
// (@intentic/sandbox-contract RelayChannelSchema), and from then on the daemon posts plain JSON to `url`,
// sessionless, proving itself with the per-device secret alone. The relay never learns which sandbox is
// calling, and the daemon never learns the device token; each side holds exactly the half it needs.

// The one platform the relay forwards to. Android deliberately absent: the Play-store app is a TWA, real
// Chrome, so its pushes ride the daemon's own web-push transport and never pass through here.
export const PushPlatformSchema = z.enum(["ios"]);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

export const PushDeviceInputSchema = z.object({
    platform: PushPlatformSchema,
    // The APNs device token as the shell reports it (hex). Opaque here; only the forwarder interprets it.
    token: z.string().min(1).max(400),
});

// What a registration answers, verbatim the relay channel the web app stores on the daemon. `secret` is
// returned exactly once and persisted only as a hash; `url` is absolute so the daemon needs no knowledge of
// any platform's layout, and a self-hosted platform's grants point home automatically.
export const PushDeviceGrantSchema = z.object({
    deviceId: z.string(),
    secret: z.string(),
    url: z.url(),
});
export type PushDeviceGrant = z.infer<typeof PushDeviceGrantSchema>;

// A daemon's send. The notification is the daemon's own wire shape, forwarded without reinterpretation.
export const PushSendSchema = z.object({
    deviceId: z.string().min(1),
    secret: z.string().min(1),
    notification: PushNotificationSchema,
});

// Whether APNs took the send. Parallel to the daemon's own delivery counting: a relay that swallowed a send
// silently would defeat the settings page's test button, whose whole job is proving the chain end-to-end.
export const PushSentSchema = z.object({ delivered: z.boolean() });

// ---- admin: the operator's read of the platform (ADMIN_EMAILS-gated; api guards.ts requireAdmin) ----
//
// Everything here is an AGGREGATE or an account's own directory row — no credentials, no tokens, no
// sandbox contents (the platform holds none). The surface is read-only on purpose: the v1 panel proves the
// authorization rail; mutations arrive later, each behind the same guard.

// The platform at a glance. `activeDaemons` counts sandboxes whose daemon announced within the last five
// minutes — the same "recent lastSeenAt" reading the setup wizard treats as connected.
export const AdminOverviewSchema = z.object({
    users: z.number(),
    sandboxes: z.number(),
    activeDaemons: z.number(),
    // Sandboxes whose daemon announced within the last 24h / 7d / 30d — the engagement proxies. Honest
    // caveat rendered in-UI: lastSeenAt is an announce, so a long-running box reads as active all along.
    activeSandboxes: z.object({ day: z.number(), week: z.number(), month: z.number() }),
    // The hosted plan's book, by Stripe's own words. past_due is churn about to happen; canceled30d is churn
    // that did. mrrUsd is the honest approximation active × HOSTED_PLAN_PRICE_USD — display, never accounting.
    plans: z.object({
        active: z.number(),
        trialing: z.number(),
        pastDue: z.number(),
        canceled30d: z.number(),
        mrrUsd: z.number(),
    }),
    hostedMachines: z.number(),
    /* Which optional lanes this deployment actually runs — "is prod configured the way I think" as a card
     * rather than an ssh session. Booleans only: the switches are secrets, their being set is not. */
    lanes: z.object({
        trial: z.boolean(),
        hostedPlan: z.boolean(),
        hosted: z.boolean(),
        wallet: z.boolean(),
        push: z.boolean(),
    }),
    // Whether ADMIN_MUTATIONS is on — what tells the panel to render action buttons at all. The server
    // re-checks on every mutation; this is display, never permission.
    mutationsEnabled: z.boolean(),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

/* THE ACTIVATION FUNNEL — the panel's most important read. Stages are DISTINCT ACCOUNTS, each a superset of
 * the next, so per-stage conversion is a subtraction the UI can render without re-deriving the rules:
 *   accounts        — every user row
 *   withSandbox     — created at least one sandbox (clicked past the landing)
 *   setupEngaged    — a setup actually started somewhere: a setup code was claimed by a machine, a hosted
 *                     machine exists, or a daemon has announced (the lanes differ in which stamp they leave,
 *                     so this is the union — anything narrower undercounts a whole lane)
 *   connected       — a daemon has EVER announced: the product moment
 *   activeLast7     — announced within the last seven days: still here
 * `signupSeries` is per-UTC-day counts, oldest first, exactly `days` entries with zeroes filled in. */
export const AdminFunnelSchema = z.object({
    signups: z.object({ today: z.number(), last7: z.number(), last30: z.number(), total: z.number() }),
    signupSeries: z.array(z.object({ day: z.string(), count: z.number() })),
    funnel: z.object({
        accounts: z.number(),
        withSandbox: z.number(),
        setupEngaged: z.number(),
        connected: z.number(),
        activeLast7: z.number(),
    }),
    /* Sign-up → first daemon announce, over the accounts whose FIRST activation (Sandbox.firstAnnouncedAt,
     * written once) landed in the last 30 days. Null when no account activated in the window — including
     * every deployment from before the column existed, which honestly has no answer. */
    activation: z.object({ medianHours: z.number(), count: z.number() }).nullable(),
});
export type AdminFunnel = z.infer<typeof AdminFunnelSchema>;

/* ONE ROW OF "THIS NEEDS A HUMAN" — the attention feed's unit. The sentence is composed SERVER-SIDE
 * (title/detail) so the vocabulary lives in one place and the panel stays a renderer; `kind` and the anchor
 * ids exist for grouping and drill-down, never for the UI to re-derive the words from. */
export const AdminAttentionItemSchema = z.object({
    kind: z.enum([`stuck-setup`, `announce-refusal`, `unreachable-sandbox`, `plan-past-due`, `pool-claim-lingering`, `pool-build-stale`]),
    severity: z.enum([`danger`, `warning`]),
    title: z.string(),
    detail: z.string().optional(),
    // The relevant moment (ISO): when the setup was claimed, the plan's last webhook, the claim's last move…
    at: z.iso.datetime().optional(),
    // Drill-down anchors, present where they apply.
    email: z.email().optional(),
    sandboxId: z.string().optional(),
});
export type AdminAttentionItem = z.infer<typeof AdminAttentionItemSchema>;

// Ordered most-severe first, then newest. `truncated` says a category hit its cap (each list is bounded
// server-side), so "the feed is short" is never read as "the problem is small".
export const AdminAttentionSchema = z.object({
    items: z.array(AdminAttentionItemSchema),
    truncated: z.boolean(),
});
export type AdminAttention = z.infer<typeof AdminAttentionSchema>;

/* THE BILLS, BEFORE THE INVOICE: the two places the platform spends real money on users' behalf. Config
 * knobs ride along (cap, image, pool size) so every figure is rendered AGAINST the promise it is spent
 * under, not as a bare number. */
export const AdminCostsSchema = z.object({
    hosted: z.object({
        machines: z.number(),
        // Machines with an open wokeAt — awake right now, or stopped with the stretch not yet counted;
        // either way the meter is running on them.
        awakeOrUncounted: z.number(),
        idleWarned: z.number(),
        // Awake minutes billed to owners this calendar month, and the per-owner free ceiling (0 = uncapped).
        monthMinutes: z.number(),
        monthlyHoursCap: z.number(),
        topOwners: z.array(z.object({ email: z.email(), minutes: z.number() })),
        pool: z.array(
            z.object({
                region: z.string(),
                building: z.number(),
                ready: z.number(),
                claimed: z.number(),
                // Machines pulled on an image that is no longer the configured one — the reconcile will
                // rebuild them; a count that stays up is the reconcile not doing so.
                staleImage: z.number(),
            }),
        ),
        poolSize: z.number(),
        image: z.string(),
    }),
    trial: z.object({
        enabled: z.boolean(),
        dailyMessages: z.number(),
        messagesToday: z.number(),
        usersToday: z.number(),
        messages7d: z.number(),
        users7d: z.number(),
        // Which real model served each account's most recent trial message, over the last 7 days — the only
        // model-mix signal the meter keeps (TrialUsage.lastModel), stated as accounts, not messages.
        models: z.array(z.object({ model: z.string(), accounts: z.number() })),
    }),
});
export type AdminCosts = z.infer<typeof AdminCostsSchema>;

/* THE SUPPORT PAGE — one account, everything operational the platform knows, so "it doesn't work" is
 * answerable without psql. Operational rows and aggregates only: no credentials, no tokens, no content
 * (the platform holds none). Sessions carry ip/userAgent because "is this sign-in you?" is a support
 * question; the GDPR export already shows the subject the same rows. */
export const AdminUserSandboxSchema = z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime().nullable(),
    daemonUrl: z.string().nullable(),
    setupClaimedAt: z.iso.datetime().nullable(),
    setupReport: SetupReportSchema.nullable(),
    bootReport: BootReportSchema.nullable(),
    announceRefusal: AnnounceRefusalSchema.nullable(),
    hosted: z
        .object({
            region: z.string(),
            appName: z.string(),
            wokeAt: z.iso.datetime().nullable(),
            idleWarnedAt: z.iso.datetime().nullable(),
        })
        .nullable(),
    members: z.array(z.object({ email: z.email(), role: z.string(), accepted: z.boolean() })),
});

export const AdminUserDetailSchema = z.object({
    user: z.object({
        id: z.string(),
        email: z.email(),
        name: z.string(),
        image: z.string().nullable(),
        createdAt: z.iso.datetime(),
        termsVersion: z.string().nullable(),
    }),
    sessions: z.array(
        z.object({
            createdAt: z.iso.datetime(),
            expiresAt: z.iso.datetime(),
            ipAddress: z.string().nullable(),
            userAgent: z.string().nullable(),
        }),
    ),
    // Auth providers on the account ("google", …).
    providers: z.array(z.string()),
    plan: z.object({ status: z.string(), currentPeriodEnd: z.iso.datetime() }).nullable(),
    trialDays: z.array(z.object({ day: z.string(), messages: z.number(), lastModel: z.string().nullable() })),
    hostedMonthMinutes: z.number(),
    wallets: z.array(
        z.object({
            network: z.string(),
            address: z.string(),
            perPaymentMaxUsd: z.string(),
            dailyCapUsd: z.string(),
            payments30d: z.number(),
        }),
    ),
    sandboxes: z.array(AdminUserSandboxSchema),
    // Sandboxes this account is a MEMBER of (owned ones are above).
    memberOf: z.array(z.object({ sandboxName: z.string(), ownerEmail: z.email(), role: z.string(), accepted: z.boolean() })),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

// One account in the operator's directory. Counts and status ride along so the list renders without a
// per-row round trip; nothing here is a secret (the GDPR export shows the subject strictly more).
export const AdminUserSchema = z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    image: z.string().nullable(),
    createdAt: z.iso.datetime(),
    sandboxCount: z.number(),
    // Stripe's word for the hosted plan's state ("active", "past_due", …), absent when the account never
    // completed a checkout.
    planStatus: z.string().optional(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

// Cursor-paged: `nextCursor` is the last row's id, absent on the final page. Ordered newest first.
export const AdminUserListSchema = z.object({
    users: z.array(AdminUserSchema),
    total: z.number(),
    nextCursor: z.string().optional(),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;

/* THE TREND LINES — the daily rollup rows (admin_daily_stat), oldest first, up to 90 days. Two kinds of
 * column, and the panel labels them: window counts are exact facts about that day, snapshot counts are the
 * platform as it stood when the rollup ran (the morning after). */
export const AdminTrendsSchema = z.object({
    days: z.array(
        z.object({
            day: z.string(),
            newUsers: z.number(),
            trialMessages: z.number(),
            totalUsers: z.number(),
            connectedUsers: z.number(),
            activeSandboxes24h: z.number(),
            plansActive: z.number(),
            hostedMachines: z.number(),
        }),
    ),
});
export type AdminTrends = z.infer<typeof AdminTrendsSchema>;

// What every admin mutation answers: what happened, in a sentence the panel can show verbatim.
export const AdminActionResultSchema = z.object({ ok: z.boolean(), message: z.string() });
export type AdminActionResult = z.infer<typeof AdminActionResultSchema>;
