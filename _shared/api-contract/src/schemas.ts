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
    GitScopeSchema,
    GitTargetSchema,
    LandedMessageDraftSchema,
    LandedMessageSchema,
    LandedMessageStepSchema,
    OriginAgentSchema,
    RepoChangesSchema,
    RepoTargetSchema,
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
import { GrantedRoleSchema, MemberRoleSchema, PushNotificationSchema, WalletNetworkSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// Where the oRPC handler is mounted; the client link uses the same base so request URLs line up.
export const API_BASE_PATH = "/rpc";

// Daemon wire shapes: re-exported from @intentic/sandbox-contract, single source of truth.
// Some types keep the platform's historical names (e.g. WorkspaceTreeResponse = WorkspaceTree).
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
// One row of the runtime-install list; derived from the response so the row type can't drift from it.
export type EnvironmentRecurring = NonNullable<Environment["recurring"]>[number];
export type DefinitionExport = z.infer<typeof DefinitionExportSchema>;
export type DefinitionDiff = z.infer<typeof DefinitionDiffSchema>;
export type WorkspaceRemote = z.infer<typeof WorkspaceRemoteSchema>;
export type WorkspacePublishResult = z.infer<typeof WorkspacePublishResultSchema>;
// The arrival pipeline: one plan/apply/report shape shared by the four inbound sources.
export type ArrivalHost = z.infer<typeof ArrivalHostSchema>;
export type ArrivalItem = z.infer<typeof ArrivalItemSchema>;
export type ArrivalPlan = z.infer<typeof ArrivalPlanSchema>;
export type ArrivalSource = z.infer<typeof ArrivalSourceSchema>;
// The two kinds a connected computer can be scanned for; a bundle is a file, never a home-folder setup.
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

// Workspace tree/file/children types; the daemon's schemas stay re-exported above for runtime parsing.
// The daemon infers `children` loosely; this interface stays precisely recursive for the tree view.
// `to` is the link's own text; the entry's `type` beside it is what it points at (folder expands, file opens).
// `state` is absent when the link resolves inside the workspace; "broken" or "outside" otherwise.
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
    // Absent means listed but not descended into (client lazy-loads on expand); empty dir is `children: []`.
    readonly children?: readonly WorkspaceTreeEntry[];
}
export interface WorkspaceTreeResponse {
    readonly root: string;
    readonly tree: readonly WorkspaceTreeEntry[];
    // How many of the root's own entries the budget cut (0 = complete); per-dir cuts count on each entry.
    readonly hidden: number;
    // Folders holding only empty folders, root-relative; not derivable from `tree` (an undescended dir isn't empty).
    readonly barren: readonly string[];
}
// Children of one not-yet-descended dir, fetched lazily on expand (GET /workspace/children).
export interface WorkspaceChildrenResponse {
    readonly entries: readonly WorkspaceTreeEntry[];
    readonly hidden: number;
}
// One window of a file's text; `size` is the whole file, `offset`/`bytes` the byte range `content` decodes from.
// Byte counts, not `content.length`, since they differ on non-ASCII; the viewer gates on `size` here.
export interface WorkspaceFileWindow {
    readonly present: true;
    readonly path: string;
    readonly content: string;
    readonly size: number;
    readonly offset: number;
    readonly bytes: number;
    // Which tree answered: the shared /work tree, or the conversation's own checkout (`?agent=`).
    readonly shared: boolean;
}
// A read of a path with nothing at it is a successful answer, not a failure; a disallowed read still fails.
export type WorkspaceFileResponse = WorkspaceFileWindow | { readonly present: false; readonly path: string };
// What a named file reference resolves to: the workspace path it means, absent if nothing matches.
export interface WorkspaceResolveResponse {
    readonly path?: string;
}

// Workspace search results (the daemon's fused-search shape); `WorkspaceSearchMode` is the query's verb enum.
export type WorkspaceSearchTag = z.infer<typeof WorkspaceSearchTagSchema>;
export type WorkspaceSearchSpan = z.infer<typeof WorkspaceSearchSpanSchema>;
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHitSchema>;
export type WorkspaceSearchGroup = z.infer<typeof WorkspaceSearchGroupSchema>;
export type WorkspaceSearchFreshness = z.infer<typeof WorkspaceSearchFreshnessSchema>;
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;
export type WorkspaceSearchMode = z.infer<typeof WorkspaceSearchQuerySchema>["mode"];

// One repo's codebase health: churn x complexity per file, index totals, and the import graph's key modules.
export type WorkspaceHotspot = z.infer<typeof WorkspaceHotspotSchema>;
export type WorkspaceKeyModule = z.infer<typeof WorkspaceKeyModuleSchema>;
export type WorkspaceHealth = z.infer<typeof WorkspaceHealthSchema>;

// Workspace history (daemon snapshots); kept under the platform's historical *Response names as aliases.
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
// What a bulk git verb acts on: picked paths, or a scope the daemon resolves itself.
// Git can't span repos, so every batch verb groups into one RepoTarget per repo.
export type GitScope = z.infer<typeof GitScopeSchema>;
export type GitTarget = z.infer<typeof GitTargetSchema>;
export type RepoTarget = z.infer<typeof RepoTargetSchema>;
// Who an agent id in a repo's `origins` is; the roster can drop an archived agent while its lines remain.
export type OriginAgent = z.infer<typeof OriginAgentSchema>;
// The commit message drafted from a landing's diff, one shape for the board card and the review record.
export type LandedMessage = z.infer<typeof LandedMessageSchema>;
// Account of a message being drafted: models asked, how each went; live during the run, kept after.
export type LandedMessageDraft = z.infer<typeof LandedMessageDraftSchema>;
export type LandedMessageStep = z.infer<typeof LandedMessageStepSchema>;
export type GitChangesResponse = z.infer<typeof GitChangesSchema>;
// What a commit answers: whether it recorded anything, plus the repo's row after, absent if nothing's left.
export type CommitResult = z.infer<typeof CommitResultSchema>;
export type GitCommit = z.infer<typeof GitCommitSchema>;
export type GitLogResponse = z.infer<typeof GitLogSchema>;
export type GitCommitDiffResponse = z.infer<typeof GitCommitDiffSchema>;
export type GitReposResponse = z.infer<typeof GitReposSchema>;
export type GitActionResult = z.infer<typeof GitActionResultSchema>;
// Web push: the VAPID public key to subscribe with, plus whether this browser is already registered.
export type PushConfig = z.infer<typeof PushConfigSchema>;
// Remote sync + branch management (the Changes panel's sync bar and the graph's branch switcher).
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;
export type GitBranch = z.infer<typeof GitBranchSchema>;
export type GitBranchesResponse = z.infer<typeof GitBranchesSchema>;
// Per-agent worktree review: a flat change set per repo, not the working tree's staged/unstaged shape.
// A row flags whether the workspace holds that content; committed files drop out and count in `absorbed`.
export type AgentChange = z.infer<typeof AgentChangeSchema>;
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
export type AgentChangesResponse = z.infer<typeof AgentChangesSchema>;
// Where the absorbed half went: the user's own commits now carrying files the review can no longer list.
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

// The caller's hosted-plan billing state; `enabled: false` means the page doesn't exist at all.
// `cancelAtPeriodEnd` turns "renews" into "ends": a cancel leaves `status` active until the period runs out.
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
    // The free lane's ceiling in minutes; null when unmetered, so `usedMinutes` has nothing to compare against.
    allowanceMinutes: z.number().int().nonnegative().nullable(),
    // When the month rolls over (the first of next month, UTC).
    resetsAt: z.iso.datetime(),
});
export type HostedPlanUsage = z.infer<typeof HostedPlanUsageSchema>;

export const HostedPlanHostedSchema = z.object({
    // Hosted sandboxes this account may have: the plan's quantity when live, the free lane's otherwise.
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

// Most hosted sandboxes one plan sells; reachable by pressing a button, absorbable without review.
export const HOSTED_PLAN_MAX_SLOTS = 10;

// Avatars/logos as inline data URLs, client-downscaled; caps what the API persists in a row.
export const ImageDataUrlSchema = z.string().startsWith("data:image/").max(150_000);

// Remove-by-name input for inventory routes; one sandbox per user, so the name identifies the entry.
export const RemoveInventoryInputSchema = z.object({
    name: z.string().min(1),
});
export type RemoveInventoryInput = z.infer<typeof RemoveInventoryInputSchema>;

// Live infra read: streams `intentic deploy plan` (no apply) over SSE, distinct from the cached status.json.
// `action` is the reconcile verdict: noop, create, update (with a reason), delete/prune.
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

// One broken check from a setup run: its name, what it found, and the fix, rendered verbatim in the wizard.
// `remedy` may be empty when the failure message already carries its own fix.
export const SetupReportFailureSchema = z.object({
    check: z.string().max(120),
    problem: z.string().max(2000),
    remedy: z.string().max(2000),
});
// Machine-side setup progress, POSTed on every stage transition, authenticated by the live setup code.
// Stages are the connect flow's real phases; non-empty `failed` is a verdict, `at` stamped by the platform.
export const SetupReportSchema = z.object({
    stage: z.enum(["preflight", "pulling-image", "creating-tunnel", "starting-sandbox", "starting-connector", "waiting-health", "verifying", "done"]),
    failed: z.array(SetupReportFailureSchema).max(12),
    at: z.string(),
});
export type SetupReport = z.infer<typeof SetupReportSchema>;

// The daemon's boot account (POSTed to /sandbox/boot-report); an announce means the daemon started, not that it's
// reachable.
//   checking the probe has not concluded yet
//   reachable its own public address answered
//   unreachable it did not; `detail` says how
export const BootReportSchema = z.object({
    reach: z.enum(["checking", "reachable", "unreachable"]),
    // Why, for `unreachable`, already in the user's terms; rendered verbatim like a setup failure's problem.
    detail: z.string().max(2000).optional(),
    // Boot-chain progress; `ready` is the readiness gate, `step` names what's running, absent on an older daemon.
    boot: z
        .object({
            ready: z.boolean(),
            step: z.string().max(200).optional(),
            done: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
        })
        .optional(),
    // How much of the machine's time the host reclaimed, to tell a slow boot from the host's own quota.
    cpu: z.object({ throttledMs: z.number().nonnegative(), throttledPeriods: z.number().int().nonnegative() }).optional(),
    at: z.string(),
});
export type BootReport = z.infer<typeof BootReportSchema>;

// A check-in the platform turned away, kept so the refusal isn't silent to every screen.
// Carries both the announced and expected address, since the browser can't derive the expected one itself.
export const AnnounceRefusalSchema = z.object({ announced: z.string(), expected: z.string() });
export type AnnounceRefusal = z.infer<typeof AnnounceRefusalSchema>;

// The hosted machine's power state, asked of the provider; its own route so a list avoids one call per row.
// `unknown` means keep waiting; `gone` means stop, the machine or app no longer exists.
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

// A hosted sandbox's overlay build, since there's no host to run `ic sandbox rebuild` and watch.
// `hash` is the approved content's sha256; `log` is builder output, present above all for a failed RUN step.
export const HostedBuildStateSchema = z.object({
    state: z.enum(["building", "built", "failed"]),
    hash: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    error: z.string().optional(),
    log: z.string().optional(),
});
export type HostedBuildState = z.infer<typeof HostedBuildStateSchema>;

// Largest overlay the platform will build; far past any real recipe, short of an abusive one.
export const HOSTED_OVERLAY_MAX_BYTES = 256 * 1024;

// What the browser sends to build an overlay: content and hash, read off the daemon's /environment route.
// The platform re-hashes it, so only bytes matching what the owner reviewed get built.
export const HostedRebuildInputSchema = z.object({
    sandboxId: z.string(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    content: z.string().min(1).max(HOSTED_OVERLAY_MAX_BYTES),
});
export type HostedRebuildInput = z.infer<typeof HostedRebuildInputSchema>;

// The build in flight or last finished, null if never asked; `applied` is the hash last booted.
export const HostedBuildStatusSchema = z.object({
    build: HostedBuildStateSchema.nullable(),
    applied: z.string().nullable(),
});
export type HostedBuildStatus = z.infer<typeof HostedBuildStatusSchema>;

// The hosted machine as the browser sees it; its presence means "call wake", never "it's gone".
// No live machine state here: `wake` is idempotent, so the daemon's own answer is the only source of truth.
export const SandboxHostedSchema = z.object({
    region: z.string(),
    // Whether the machine came warm from the pool (seconds) or was built to order (a cold image pull, minutes).
    warm: z.boolean(),
});
export type SandboxHosted = z.infer<typeof SandboxHostedSchema>;

// The hosted lane's offer, read before creation; `remaining` is this caller's own allowance left.
// `hours` is the free lane's budget, absent for anyone it doesn't apply to (unmetered, a member, no ceiling).
export const HostedHoursSchema = z.object({
    // Monthly ceiling and what's left, in whole hours; `remaining` floors, so "1 hour left" isn't a few minutes.
    allowance: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
});
export type HostedHours = z.infer<typeof HostedHoursSchema>;

export const HostedOfferSchema = z.object({
    enabled: z.boolean(),
    remaining: z.number().int().nonnegative(),
    // The platform's fleet is full, no machine to give anyone; unrelated to this account's own `remaining`.
    full: z.boolean().optional(),
    hours: HostedHoursSchema.optional(),
    // True when the caller is on the hosted plan (or comped); the card reads "always on" instead of showing hours.
    plan: z.boolean().optional(),
});
export type HostedOffer = z.infer<typeof HostedOfferSchema>;

// Whether this platform can give a sandbox its own address, the tunnel fabric behind `setupCode`.
// A platform with none mints no codes; the wizard must say so before drawing the pasted-command lane.
export const AddressOfferSchema = z.object({ enabled: z.boolean() });

// A short-lived signed claim spent on a hosted daemon; the platform sign-in is the only one needed.
// Minted only for the owner on a platform-run machine; elsewhere it 404s and the browser falls back to Google.
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
    // The machine-side setup run's last word, null until a report lands, cleared on every mint.
    setupReport: SetupReportSchema.nullable(),
    // The daemon's own last word on its boot, null until it reports; every lane, not only hosted.
    bootReport: BootReportSchema.nullable(),
    // The last check-in refused, and why; null in the common case, cleared once an announce succeeds.
    announceRefusal: AnnounceRefusalSchema.nullable(),
    /* THE CONNECT TOKEN, on the OWNER's row only; null on a member's. The browser spends it on exactly one
     * daemon-side act, the first-bind that seeds ownership, which is the owner's act by definition: a member
     * reaches a daemon that is already bound, and the daemon never reads the header again. On the platform the
     * same secret is a credential in its own right (it spends the owner's trial allowance, asks the owner's
     * wallet for signatures, speaks as the sandbox to /sandbox/announce), so it is not something a `viewer`
     * invite may carry away. */
    token: z.string().nullable(),
    // The caller's trust tier on this sandbox: `owner` for their own, the invite's granted role for a shared
    // one. What the web gates its affordances on; the daemon independently enforces the same tier as route
    // floors, so this is a rendering fact, never the security boundary.
    role: MemberRoleSchema,
    providedAddress: z.boolean(),
    // Loopback listener's certified name, or null; server-computed, since it's a different zone from the sandbox.
    localHostname: z.string().nullable(),
    // The hosted lane's live machine record, null off-platform; unreachable with `state` != started means wake it.
    hosted: SandboxHostedSchema.nullable(),
});
export type SandboxSummary = z.infer<typeof SandboxSummarySchema>;

/* THE OWNER'S SPENDING CAPS on the platform's wallet signer (api wallet/), written over a SESSION and nowhere
 * else. The sandbox's wallet card carries the same two numbers for its own pre-check and its ledger's words, but
 * the container is not a trust boundary, so the copy the signer enforces is written only by the browser the
 * owner is signed into, over this shape: the editor sends it as the card is saved. USD decimal strings with up
 * to six places, USDC's own precision; money is never a float on either side. */
export const WalletPolicySchema = z.object({
    network: WalletNetworkSchema,
    perPaymentMaxUsd: z.string().regex(/^\d+(\.\d{1,6})?$/),
    dailyCapUsd: z.string().regex(/^\d+(\.\d{1,6})?$/),
});
export type WalletPolicy = z.infer<typeof WalletPolicySchema>;

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

// A row in the owner's access roster: an email plus its derived state.
//   pending invited, link not yet accepted
//   accepted an active member
//   expired the link lapsed unaccepted (owner can resend)
// `expiresAt` is absent once accepted, or when there is none.
export const InviteStatusSchema = z.enum(["pending", "accepted", "expired"]);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;
export const InviteRecordSchema = z.object({
    email: z.string(),
    // The trust tier granted (never owner); the daemon's list is the enforced copy, this is what re-grades from.
    role: GrantedRoleSchema,
    status: InviteStatusSchema,
    invitedAt: z.string(),
    expiresAt: z.string().optional(),
});
export type InviteRecord = z.infer<typeof InviteRecordSchema>;
export const InviteListSchema = z.object({ members: z.array(InviteRecordSchema) });

// How the invite link travelled; the grant is already made, so delivery never decides the mutation's verdict.
// The rest are this platform declining or failing to send, so `link` always comes back to hand over.
export const InviteDeliverySchema = z.enum(["sent", "unconfigured", "local-link", "refused"]);
export type InviteDelivery = z.infer<typeof InviteDeliverySchema>;
export const InviteSentSchema = z.object({
    members: z.array(InviteRecordSchema),
    // The accept link just minted, for the owner to hand over when mail didn't carry it.
    link: z.string(),
    delivery: InviteDeliverySchema,
    // What the mail provider said on refusal, verbatim-ish; `refused` only, fixable by whoever reads the card.
    reason: z.string().optional(),
});

// What the public accept page renders from a token, no session needed.
// `invalid` means no such token; name/email are included otherwise, so the page can prompt the right account.
export const InvitePreviewStatusSchema = z.enum(["pending", "accepted", "expired", "invalid"]);
export const InvitePreviewSchema = z.object({
    status: InvitePreviewStatusSchema,
    sandboxName: z.string().optional(),
    invitedEmail: z.string().optional(),
    // The tier the link carries, so the accept page can say what's being accepted; absent on an invalid token.
    role: GrantedRoleSchema.optional(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

// Zone discovery for the setup picker; a token can see multiple zones, so the user picks one first.
// Request-scoped: used for one Cloudflare listing call (the browser can't, no CORS) and then discarded.
export const CfTokenSchema = z.object({ token: z.string().min(1) });
export const CfZonesSchema = z.object({ zones: z.array(z.string()) });
export type CfZones = z.infer<typeof CfZonesSchema>;

// One short-lived value the install command carries, so no raw token lands in shell history.
// Redeemed at /setup/claim for a connect token and reachability grant; the address is derived, not chosen.
export const SetupCodeSchema = z.object({ code: z.string(), hostname: z.string(), expiresAt: z.string() });
export type SetupCode = z.infer<typeof SetupCodeSchema>;

// A "view" is a projection of the desired-state graph plus reconciliation drift.
// Read through the sandbox's own git routes (desired-state.json + status.json); it stays the source of truth.
// Only non-secret scalar inputs are surfaced; $secret/$ref values are dropped upstream.

// Coarse lenses the closed resource-type vocabulary buckets into, for grouping in the Overview.
export const ResourceGroupSchema = z.enum(["infra", "git", "deploy", "data", "notify", "other"]);
export type ResourceGroup = z.infer<typeof ResourceGroupSchema>;

// Maps each resource type to its group; a typed Record, so a new kind with no bucket is a compile error.
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
    // The per-resource reconcile action from status.json, or "unknown" before the first apply or if absent.
    status: z.string(),
    // The human-readable drift cause from status.json's step; present for "update" steps only.
    reason: z.string().optional(),
});
export type ResourceView = z.infer<typeof ResourceViewSchema>;

// Where the user logs into a provisioned service, from status.json's value-free access entries.
// A generated password's value is fetched via the owner-gated /secrets/reveal, keyed by `password.key`.
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

// Live Komodo deployments from `intentic deploy deployments`, confirmed live against the Komodo API.
// `env` carries only non-secret values; runtime detail lives in Komodo's own UI via `komodoDeploymentUrl`.
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

// APNs relay: Apple only accepts pushes from the app's own vendor, so a native install can't post directly.
// The daemon posts sessionless, proven by its per-device secret; each side holds only the half it needs.

// The one platform relayed to; Android's TWA app uses the daemon's own web-push instead.
export const PushPlatformSchema = z.enum(["ios"]);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

export const PushDeviceInputSchema = z.object({
    platform: PushPlatformSchema,
    // The APNs device token as the shell reports it (hex); opaque here, only the forwarder interprets it.
    token: z.string().min(1).max(400),
});

// What a registration answers: the relay channel the web app stores on the daemon.
// `secret` is returned once and persisted only as a hash; `url` is absolute, so grants always point home.
export const PushDeviceGrantSchema = z.object({
    deviceId: z.string(),
    secret: z.string(),
    url: z.url(),
});
export type PushDeviceGrant = z.infer<typeof PushDeviceGrantSchema>;

// A daemon's send; the notification is the daemon's own wire shape, forwarded unchanged.
export const PushSendSchema = z.object({
    deviceId: z.string().min(1),
    secret: z.string().min(1),
    notification: PushNotificationSchema,
});

// Whether APNs took the send; lets the settings page's test button prove the chain end-to-end.
export const PushSentSchema = z.object({ delivered: z.boolean() });

// Operator's read of the platform (ADMIN_EMAILS-gated); an aggregate or directory row, never a credential.
// Read-only: this surface proves the authorization rail, mutations arrive later behind the same guard.

// The platform at a glance.
// `activeDaemons` counts sandboxes announced within five minutes, the wizard's own "connected" reading.
export const AdminOverviewSchema = z.object({
    users: z.number(),
    sandboxes: z.number(),
    activeDaemons: z.number(),
    // Sandboxes announced within 24h/7d/30d; lastSeenAt is an announce, so a long-running box reads as active.
    activeSandboxes: z.object({ day: z.number(), week: z.number(), month: z.number() }),
    // Stripe's own words for the plan book; `mrrUsd` is active x the hosted price, display only, never accounting.
    plans: z.object({
        active: z.number(),
        trialing: z.number(),
        pastDue: z.number(),
        canceled30d: z.number(),
        mrrUsd: z.number(),
    }),
    hostedMachines: z.number(),
    // Which optional lanes this deployment runs, as a config sanity card; booleans only, never the secrets.
    lanes: z.object({
        trial: z.boolean(),
        hostedPlan: z.boolean(),
        hosted: z.boolean(),
        wallet: z.boolean(),
        push: z.boolean(),
    }),
    // Whether ADMIN_MUTATIONS is on, for rendering action buttons; the server re-checks it on every mutation.
    mutationsEnabled: z.boolean(),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

// The activation funnel: distinct accounts, each stage a superset of the next, so conversion is a subtraction.
//   accounts every user row
//   withSandbox created at least one sandbox
//   setupEngaged a setup started somewhere (code claimed, hosted machine, or a daemon announced)
//   connected a daemon has ever announced
//   activeLast7 announced within the last seven days
// `signupSeries` is per-UTC-day counts, oldest first, zero-filled.
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
    // Sign-up to first announce, over accounts that activated in the last 30 days; null if none did.
    activation: z.object({ medianHours: z.number(), count: z.number() }).nullable(),
});
export type AdminFunnel = z.infer<typeof AdminFunnelSchema>;

// One row of "this needs a human"; composed server-side so the vocabulary lives in one place.
// `kind` and the anchor ids are for grouping and drill-down, never for the UI to re-derive the words.
export const AdminAttentionItemSchema = z.object({
    kind: z.enum([`stuck-setup`, `announce-refusal`, `unreachable-sandbox`, `plan-past-due`, `pool-claim-lingering`, `pool-build-stale`]),
    severity: z.enum([`danger`, `warning`]),
    title: z.string(),
    detail: z.string().optional(),
    // The relevant moment (ISO): setup claimed, plan's last webhook, or the claim's last move.
    at: z.iso.datetime().optional(),
    // Drill-down anchors, present where they apply.
    email: z.email().optional(),
    sandboxId: z.string().optional(),
});
export type AdminAttentionItem = z.infer<typeof AdminAttentionItemSchema>;

// Ordered most-severe first, then newest; `truncated` means a category hit its cap, not a small problem.
export const AdminAttentionSchema = z.object({
    items: z.array(AdminAttentionItemSchema),
    truncated: z.boolean(),
});
export type AdminAttention = z.infer<typeof AdminAttentionSchema>;

// The bills before the invoice: the two places real money is spent on users' behalf.
// Config knobs ride along, so every figure renders against the promise it's spent under.
export const AdminCostsSchema = z.object({
    hosted: z.object({
        machines: z.number(),
        // Machines with an open wokeAt: awake now, or stopped with the stretch not yet counted.
        awakeOrUncounted: z.number(),
        idleWarned: z.number(),
        // Awake minutes billed this calendar month, and the per-owner free ceiling (0 = uncapped).
        monthMinutes: z.number(),
        monthlyHoursCap: z.number(),
        topOwners: z.array(z.object({ email: z.email(), minutes: z.number() })),
        pool: z.array(
            z.object({
                region: z.string(),
                building: z.number(),
                ready: z.number(),
                claimed: z.number(),
                // Machines pulled on an image no longer configured; a rising count means the reconcile isn't
                // rebuilding.
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
        // Which real model served each account's latest trial message over 7 days, stated as accounts, not messages.
        models: z.array(z.object({ model: z.string(), accounts: z.number() })),
    }),
});
export type AdminCosts = z.infer<typeof AdminCostsSchema>;

// The support page: one account, everything operational, so "it doesn't work" is answerable without psql.
// Operational rows and aggregates only, no credentials; sessions carry ip/userAgent for "is this sign-in you".
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

// One account in the operator's directory; counts ride along so the list renders without a per-row round trip.
export const AdminUserSchema = z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    image: z.string().nullable(),
    createdAt: z.iso.datetime(),
    sandboxCount: z.number(),
    // Stripe's word for plan state, absent when the account never completed a checkout.
    planStatus: z.string().optional(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

// Cursor-paged: `nextCursor` is the last row's id, absent on the final page; ordered newest first.
export const AdminUserListSchema = z.object({
    users: z.array(AdminUserSchema),
    total: z.number(),
    nextCursor: z.string().optional(),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;

// The daily rollup rows, oldest first, up to 90 days.
// Two kinds of column: window counts are exact for that day, snapshots are the platform as the rollup found it.
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
