import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
    AcpAgentConfig,
    AgentEvent,
    HostFacts,
    HostScopes,
    RunnerFacts,
    WebExtFacts,
    WebExtScopes,
    FileDiff,
    GitBranch,
    GitChange,
    GitCommit,
    GitPublishFileResult,
    GitRemoteBranch,
    GitRemoteState,
    IntenticLine,
    NativeProvider,
    TranscriptRow,
    StashEntry,
    WorkspaceChildren,
    WorkspaceTree,
} from "@intentic/sandbox-contract";
import { portSlotsFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import {
    type GitCloneOptions,
    type GitStatus,
    type GitSyncResult,
    defaultGit,
    gitCheckout,
    gitClone,
    gitCommitAll,
    gitFullHead,
    gitHead,
    gitInit,
    gitListFiles,
    gitStatus,
    gitSync,
    politeGit,
} from "@intentic/scaffold";
import type { ResidentEngine } from "@intentic/iq-engine";
import { createEngineClient } from "@intentic/iq-engine/host";
import { createInvariantRegistry, type InvariantRegistry } from "./invariants/invariants.js";
import { registerDaemonInvariants } from "./invariants/register.js";
import type { Logger } from "pino";
import { createAcpAgent } from "./runtimes/acp/acp-agent.js";
import { type AcpConnections, createAcpConnections } from "./runtimes/acp/acp-connection.js";
import { createPiAgent } from "./runtimes/pi/pi-agent.js";
import { piSpawner } from "./runtimes/pi/pi-rpc.js";
import { type ControlTokens, fileControlTokens } from "./auth/control-tokens.js";
import { type DoorTokens, fileDoorTokens } from "./auth/door-tokens.js";
import { createMediaTickets, type MediaTickets } from "./auth/media-tickets.js";
import { createWsTickets, type WsTickets } from "./auth/ws-tickets.js";
import { type ActivityStore, fileActivityStore } from "./activity/activity-store.js";
import { type AgentRequest, runAgent } from "./agent/run/agent.js";
import { cliProxyAuthDir, type CliProxyClient, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/providers/translator.js";
import { type HeldWakesStore, fileHeldWakesStore } from "./automations/held-wakes-store.js";
import { type AutomationsStore, fileAutomationsStore } from "./automations/automations-store.js";
import { fileLoopDesignsStore, fileLoopsStore, type LoopDesignsStore, type LoopsStore } from "./loops/loops-store.js";
import { fileWorkflowRunsStore, fileWorkflowsStore, type WorkflowRunsStore, type WorkflowsStore } from "./workflows/workflows-store.js";
import { type ChoresStore, fileChoresStore, LEDGER_FILE, PROBES_FILE } from "./chores/chores-store.js";
import { createProbeRunner, type ProbeRunner } from "./chores/probe-runner.js";
import { type CapabilitiesStore, fileCapabilitiesStore, vaultManifestSecrets, withSecretVault } from "./capabilities/capabilities-store.js";
import { contributionRegistry } from "./capabilities/contributions.js";
import { fileSecretVault, type SecretVault } from "./capabilities/secret-vault.js";
import { type NamedSecret, secretRegistryOf } from "./secrets/secret-registry.js";
import { fileSecretUses, type SecretUsesStore } from "./secrets/secret-uses.js";
import { type CredentialGatesStore, fileCredentialGates } from "./secrets/credential-gates.js";
import { type CredentialGrants, createCredentialGrants } from "./secrets/credential-grants.js";
import { type CredentialGate, createCredentialGate } from "./secrets/credential-gate.js";
import { fileWalletLedger, type WalletLedgerStore } from "./wallet/wallet-ledger.js";
import { createTrialService, type TrialService } from "./trial/trial.js";
import { withTrialEndpoint } from "./trial/trial-endpoint.js";
import { type DismissalsStore, fileDismissalsStore } from "./capabilities/dismissals-store.js";
import { filePersonasStore, type PersonasStore } from "./personas/personas-store.js";
import { fileHeavyCommandsStore, type HeavyCommandsStore } from "./platform/resources/heavy-commands.js";
import { type CiStore, fileCiStore } from "./ci/ci-store.js";
import { fileVerifyStore, type VerifyStore } from "./workspace/deps/verify-store.js";
import { type CiHookReconciler, createCiHookReconciler } from "./ci/hooks.js";
import { createRunsCache, type RunsCache } from "./ci/runs-cache.js";
import {
    type Caller,
    createAuthorizer,
    createGoogleVerifier,
    fileMembersStore,
    fileOwnerStore,
    type MembersStore,
    type VerifiedIdentity,
    ownerTicketVerifier,
} from "./auth/auth.js";
import { fileBrowserAccess } from "./auth/browser-access.js";
import { createAuthConnections, type AuthConnections } from "./auth/connections.js";
import { createSessions, type MintedSession } from "./auth/session.js";

import { type AccountUsageStore, fileAccountUsageStore } from "./usage/account-usage.js";
import { claudeHeadroomSource } from "./usage/claude-usage.js";
import { createHeadroomService, type HeadroomService } from "./usage/headroom.js";
import { fileModelRefusalStore, type ModelRefusalStore } from "./usage/model-refusals.js";
import { fileProviderRefusalStore, type ProviderRefusalStore } from "./usage/provider-refusals.js";
import { type ApprovalsStore, fileApprovalsStore } from "./approvals/approvals-store.js";
import { fileIssuesStore, type IssuesStore } from "./issues/issues-store.js";
import { fileInstallsStore, type InstallsStore } from "./store/installs.js";
import { HOST_PEER, type HostAnnounced, type HostClient, type HostHub, type HostStore } from "./hosts/host-peer.js";
import { WEBEXT_PEER, type WebExtAnnounced, type WebExtClient, type WebExtHub, type WebExtStore } from "./webext/webext-peer.js";
import { RUNNER_PEER, type RunnerAnnounced, type RunnerClient, type RunnerHub, type RunnerStore } from "./runners/runner-peer.js";
import type { ParentCredentials } from "./runners/runner-credentials.js";
import { createPeerHub } from "./peers/peer-hub.js";
import { filePeerStore } from "./peers/peer-store.js";
import { syncPairBurnPath, type SyncMode } from "./platform/sync.js";
import { pairings, type Pairings } from "./store/enrollment.js";
import { fileTurnJournal, type TurnJournal } from "./agent/run/turn/turn-journal.js";
import { fileWatchJournal, type WatchJournal } from "./agent/verification/watch-journal.js";
import { fileTurnAnchors, type TurnAnchors } from "./agent/anchors/turn-anchors.js";
import type { Config } from "./env.config.js";
import { createAgentsRegistry, type AgentsRegistry } from "./agents/registry/agents-registry.js";
import type { AgentArchiveDeps } from "./agents/registry/archive.js";
import { fileAgentsStore } from "./agents/registry/agents-store.js";
import { createTurnIsolation, type TurnIsolation } from "./agents/worktrees/isolation.js";
import { createAgentOrigins, type AgentOrigins } from "./agents/land/origins.js";
import { createExpiryTracker } from "./agents/registry/expiry.js";
import { createLandedPresences } from "./agents/land/landed-presence.js";
import { createLandStandings } from "./agents/land/standing.js";
import { createAgentWorktrees, type AgentWorktrees } from "./agents/worktrees/worktrees.js";
import { changedFiles } from "./git/changes/changes.js";
import {
    type ActionResult,
    checkoutRef,
    cherryPick,
    commitChanges,
    commitLog,
    createBranchAt,
    createTagAt,
    deleteTag,
    dropCommit,
    mergeCommit,
    pushTag,
    rebaseOnto,
    resetTo,
    revertCommit,
} from "./git/changes/changes-commits.js";
import { commitFileDiff, conflictedFileDiff, refFileDiff, stagedFileDiff, unstagedFileDiff, workingFileDiff } from "./git/changes/changes-diff.js";
import { commitIndex, discardPaths, stageAll, stagePaths, unstagePaths } from "./git/changes/changes-index.js";
import { collectRepoDiff, type CommitScope, type RepoDiff } from "./git/ops/commit-message.js";
import { createBranch, deleteBranch, listBranches, listRemoteBranches } from "./git/ops/branches.js";
import { abortOperation, type GitOperation, operationInProgress } from "./git/ops/operation.js";
import { type UndoableAction, undoableAction, undoLastAction } from "./git/ops/undo.js";
import { stashApply, stashChanges, stashDrop, stashList, stashPush } from "./git/ops/stash.js";
import { fetchRemote, pullRemote, remoteState } from "./git/remote/remote.js";
import { remoteProjectOf } from "./git/remote/remote-urls.js";
import { publishFile } from "./git/ops/publish-file.js";
import { type EndpointCatalog, createEndpointCatalog } from "./endpoints/endpoint-catalog.js";
import { createOpenCodeService, type OpenCodeService } from "./runtimes/grok/opencode.js";
import { type ClaudeSlice, createClaudeSlice } from "./runtimes/claude/claude-provider.js";
import { type CodexSlice, createCodexSlice } from "./runtimes/codex/codex-provider.js";
import { createCursorSlice, type CursorSlice } from "./runtimes/cursor/cursor-provider.js";
import { createGeminiSlice, type GeminiSlice } from "./runtimes/gemini/gemini-provider.js";
import { createGrokSlice, type GrokSlice } from "./runtimes/grok/grok-provider.js";
import { createMintedSlice, type MintedSlice } from "./runtimes/minted/minted-provider.js";
import { createKimiSlice, type KimiSlice } from "./runtimes/kimi/kimi-provider.js";
import { type ProviderCatalog, providerCatalogsOf } from "./agent/providers/provider-registry.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history/history.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { type ManagedProcesses, createManagedProcesses } from "./processes/managed-processes.js";
import { createServiceProcesses, type ServiceProcesses } from "./processes/service-processes.js";
import { createPanelUpstreamResolver, type PanelUpstreamResolver } from "./panels/panel-upstream.js";
import { discoverRepos } from "./workspace/layout/repo-discovery.js";
import { type PushStore, filePushStore } from "./push/push-store.js";
import { createPushSender, type PushSender } from "./push/push.js";
import { turnAwaiting } from "./push/notifications.js";
import { type PortForwards, createPortForwards } from "./ports/port-forwards.js";
import { type ListeningPort, scanListeningPorts, withOwningSessions } from "./ports/port-scan.js";
import {
    createRecentSessions,
    listWorkspaceSessions,
    readWorkspaceSession,
    readWorkspaceSessionTail,
    searchWorkspaceSessions,
    type SessionSummary,
    workspaceSessionExists,
} from "./sessions/sessions.js";
import { readSessionLines, spokenLinesOf, transcriptSearchMetrics } from "./sessions/transcript-search.js";
import { fileThreadSessionsStore, type ThreadSessionsStore } from "./sessions/thread-sessions.js";
import { openSearchIndex, type SearchIndex } from "./sessions/search-index.js";
import { backfillSearchIndex, type BackfillSource } from "./sessions/search-backfill.js";
import { agentTranscript, agentTranscriptPage, type AgentTranscriptDeps, spokenTranscript, type TranscriptAgent } from "./sessions/agent-transcript.js";
import { fileTranscriptRecord, type TranscriptPage, type TranscriptWindow } from "./sessions/transcript-record.js";
import { fileShareStore, type ShareStore } from "./share/share-store.js";
import { createSpeech, type Speech } from "./speech/transcribe.js";
import { purgeConversationState } from "./sessions/conversation-purge.js";
import { type SafetyLog, fileSafetyLog } from "./safety/safety-log.js";
import { type SafetyPolicyStore, fileSafetyPolicyStore } from "./safety/safety-policy-store.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { type RuleFiringsStore, fileRuleFiringsStore } from "./rules/rule-firings.js";
import { type DriftSweep, createDriftSweep } from "./environment/drift-sweep.js";
import { type RuntimeInstallsStore, fileRuntimeInstallsStore } from "./environment/runtime-installs.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { liveCardRun } from "./agent/run/offer-card.js";
import { onTurnSettled, turnRunOf } from "./agent/run/turn/turn-runs.js";
import { clearTurnTaint } from "./guard/turn-taint.js";
import { type Announcer, createAnnouncer } from "./platform/boot/announce.js";
import { type ReachReporter, createReachReporter } from "./platform/listeners/reach-report.js";
import { type BootTracker, createBootTracker } from "./platform/boot/boot.js";
import { DAEMON_OWNER } from "./platform/boot/leftovers.js";
import { type PlatformTunnel, startPlatformTunnel } from "./platform/listeners/local-tunnel.js";
import { createResourceReaper, type ResourceReaper } from "./platform/boot/reaper.js";
import { createClientLogger, createPerfLogger } from "./logger.js";
import { createPerfTracker, type PerfTracker } from "./platform/resources/perf.js";
import { createTerminalRunner, type TerminalRunner } from "./terminal/terminal-run.js";
import { panePids } from "./terminal/terminal-session.js";
import { version } from "./version.js";
import { type AgentTool, internalTools } from "./agent/tools/agent-tools.js";
import { type UsageStore, fileUsageStore } from "./usage/usage-store.js";
import { extensionIdOf } from "@intentic/extension-manifest";
import { createExtensionBackend, type ExtensionBackend } from "./extensions/backend/backend-supervisor.js";
import { type SecretKeyResolver, vaultExtensionSettingSecrets } from "./extensions/extension-settings.js";
import { installedExtensions } from "./extensions/installed-extensions.js";
import { workspaceArrivedEmpty } from "./scaffold/starter-site.js";
import { type WorkspacePaths, workspacePaths } from "./workspace/workspace.js";
import { writeWorkspaceFileStream } from "./workspace/files/workspace-files-upload.js";
import {
    copyWorkspacePath,
    makeWorkspaceDir,
    moveWorkspacePath,
    readWorkspaceFile,
    readWorkspaceFileBytes,
    readWorkspaceFileWindow,
    removeWorkspacePath,
    setWorkspaceMtime,
    statWorkspaceFileSize,
    type WorkspaceFileWindow,
    writeWorkspaceFile,
} from "./workspace/files/workspace-files.js";
import { listWorkspaceChildren, walkWorkspaceTree } from "./workspace/files/workspace-tree.js";
import type { WorkspaceScopeDeps } from "./workspace/layout/workspace-scope.js";
import { statePath } from "./workspace/layout/state-paths.js";
import { createDependencyCoordinator, type DependencyCoordinator } from "./workspace/deps/reconcile-deps.js";

// Wired once at boot for the route factories; a module should Pick only the seams it uses, not take Services whole,
// unless it orchestrates most of the daemon.
// One interface; each provider extends it with its own slice declared beside its code, so adding a provider needs only
// an extends clause and a spread.
export interface Services extends ClaudeSlice, CodexSlice, CursorSlice, GrokSlice, GeminiSlice, KimiSlice, MintedSlice {
    readonly config: Config;
    readonly logger: Logger;
    // Sink for the browser's own reports; undefined when there's nowhere to write, and the route says so.
    readonly clientLogger: Logger | undefined;
    // Every expensive path measures itself here, so a slow report names the op instead of an unattributed stall.
    readonly perf: PerfTracker;
    // Cardinalities behind heap growth in the resource series; stays allocation-light, called every minute.
    readonly resourceOwners: () => Readonly<Record<string, unknown>>;
    // Where the boot chain lives; app.ts gates every data route on `converged`, and /events streams its progress.
    readonly boot: BootTracker;
    // Promises the daemon makes to itself, checked while running, reported and never thrown; read by diagnostics.
    readonly invariants: InvariantRegistry;
    // Platform registration; main starts/stops it, /health reports its state, the one link the container can probe.
    readonly announcer: Announcer;
    // Whether this sandbox's public address answers; the announcer proves it started, this proves it's reachable.
    readonly reach: ReachReporter;
    readonly workspace: WorkspacePaths;
    // Was /work empty at daemon start; must be asked before any boot step writes into the workspace, not later.
    readonly workspaceArrivedEmpty: boolean;
    // Per-repo operator panels: the in-memory process manager the /panels routes and preview proxy drive.
    readonly processes: ManagedProcesses;
    // Extensions' declared background processes as the daemon's own children (respawn, one log file each).
    readonly serviceProcesses: ServiceProcesses;
    // Single owner of dependency status, durable setup requests, watcher reconciliation and installs.
    readonly dependencies: DependencyCoordinator;
    // Extension backend: one node process running every enabled extension's server, proxied under /x/<id>/.
    readonly extensionBackend: ExtensionBackend;
    // Forwarded-port slot table the /ports routes drive and the preview proxy resolves port-<slot> hosts against.
    readonly portForwards: PortForwards;
    // Discovers every listening TCP socket via procfs, traced back to the terminal it runs in.
    readonly scanPorts: () => Promise<ListeningPort[]>;
    // Runs user-triggered shell commands inside visible job-* tmux sessions, one window per command.
    readonly terminalRun: TerminalRunner;
    // Per-boot secret in every panel process so it can call the daemon without a browser token; container-only.
    readonly wsTickets: WsTickets;
    // Path-scoped tickets /workspace/media accepts, for a <video>/<audio> element that cannot header-authenticate.
    readonly mediaTickets: MediaTickets;
    readonly panelToken: string;
    // Per-boot secret the vpn/otp CLIs present; dials/drops tunnels, mints codes, never reads credentials.
    readonly agentToken: string;
    // Per-boot secret the agent's host tools carry to reach /mcp/hosts/:id; dies with the daemon, container-only.
    readonly hostBridgeToken: string;
    // The user's own computers as a peer door: durable enrollment plus who is holding a socket right now.
    readonly hosts: HostStore;
    readonly hostHub: HostHub;
    // Same pair for the user's own browsers; a separate bridge token so one leaking can't open the other's door.
    readonly webextBridgeToken: string;
    readonly webexts: WebExtStore;
    readonly webextHub: WebExtHub;
    // This sandbox's own runner containers on other machines: same enrollment and hub, no grant, no MCP bridge.
    readonly runners: RunnerStore;
    readonly runnerHub: RunnerHub;
    // Desktop sync's pairing; only the pairing lives here, its SSH-keyed enrollment half stays in platform/sync.ts.
    readonly syncPairings: Pairings<SyncMode>;
    // Set only when this daemon is a runner: the parent sandbox as a credential source, read off /history at boot.
    readonly runnerParent: { current?: ParentCredentials };
    // Owner-minted, hashed, revocable tokens for driving this sandbox outside the browser; each carries its scope.
    readonly controlTokens: ControlTokens;
    // This sandbox's identity for the Connections card; undefined means /info returns {} (loopback/test).
    readonly info:
        | {
              readonly name: string;
              readonly image: string;
              readonly version: string;
              // Release channel and rollback image, runner-set env; absent if predating channels or never swapped.
              readonly channel?: string;
              readonly previousImage?: string;
          }
        | undefined;
    // Intent-declared internal MCP tools, constant for the sandbox; merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest; reads carry the daemon's free-trial endpoint, never written to the file.
    readonly capabilities: CapabilitiesStore;
    // Moves any credential left in the readable manifest into the vault; the agent may edit the manifest anytime.
    readonly vaultManifestSecrets: () => Promise<readonly string[]>;
    // Same vault, one table over: extension settings declared secret:true; needs rehydrating at three call sites.
    readonly extensionSecretVault: SecretVault;
    // Settings twin of vaultManifestSecrets: the tracked settings file is agent-editable too.
    readonly vaultExtensionSettingSecrets: () => Promise<readonly string[]>;
    // Every credential under a stable name; read by the agent's masking and the exits resolving a reference back.
    readonly secretRegistry: () => Promise<readonly NamedSecret[]>;
    // Use ledger those exits feed, one row per resolved reference, joined onto the secrets inventory as last-used.
    readonly secretUses: SecretUsesStore;
    // Which credentials need a person's click: policy is owner-written, grants in-memory, gate the shared consult.
    readonly credentialGates: CredentialGatesStore;
    readonly credentialGrants: CredentialGrants;
    readonly credentialGate: CredentialGate;
    // Wallet's payment record, one row per attempt reaching policy, opened before and settled after the answer.
    readonly walletLedger: WalletLedgerStore;
    // Whether this sandbox can chat before an AI account connects, and today's allowance; unset with no platform.
    readonly trial: TrialService;
    // Loopback TLS terminator for a dev platform; awaited by the translator's render so the address isn't a race.
    readonly platformTunnel: PlatformTunnel;
    // Recommendations the owner declined, so a 'no' survives the reload that would otherwise re-derive it.
    readonly capabilityDismissals: DismissalsStore;
    // Named personas this sandbox shows outside; the turn path reads it to decide what a wake may act through.
    readonly personas: PersonasStore;
    // Which agent commands are heavy enough to queue; the Bash hook reads it per command, binding on the next one.
    readonly heavyCommands: HeavyCommandsStore;
    // Scheduled agent wake-ups; run history is a separate ledger joined on read, so callers see one store.
    readonly automations: AutomationsStore;
    // Ralph loops: the pump drives them, /loops starts/stops them; `running` at boot is what the daemon died under.
    readonly loops: LoopsStore;
    // Saved loops: the manifest half, a loop's machinery with its goal left out for the composer to supply.
    readonly loopDesigns: LoopDesignsStore;
    // Workflow designs, a manifest the user authors at human speed; /workflows edits it, nothing fires it alone.
    readonly workflows: WorkflowsStore;
    // Workflow runs, the ledger the scheduler writes per step; kept apart so a run outlives a deleted design.
    readonly workflowRuns: WorkflowRunsStore;
    // Maintenance evidence: the probe cache the background runner fills, and the ledger of what was done about it.
    readonly chores: ChoresStore;
    // Background sweep keeping the probe cache from expiring; skipped entirely while any turn is live.
    readonly probeRunner: ProbeRunner;
    // CI state: the webhook secret plus per repo+branch conclusion memory that reads a recovery as pipeline_fixed.
    readonly ciStore: CiStore;
    // Credentials behind the public doors (webhook, gate, intake tokens); attached to a listing for operators only.
    readonly doorTokens: DoorTokens;
    // Dependency verifier's memory: last verdict per project plus red streak, what makes deps.fixed an edge.
    readonly verifyStore: VerifyStore;
    // The Pipelines view's read model: webhook deliveries freshen it, /ci/runs backfills it when stale.
    readonly ciRuns: RunsCache;
    // Keeps every mapped repo's provider webhook pointing at this sandbox; its warnings ride /ci/runs.
    readonly ciHooks: CiHookReconciler;
    // Wakes from requireApproval automations, held for the owner; /automations pending routes approve or reject.
    readonly heldWakes: HeldWakesStore;
    // Which conversation each inbound thread owns; lets a message stream remember instead of starting fresh.
    readonly threadSessions: ThreadSessionsStore;
    // Things the agent prepared and may not do unasked; /approvals is the owner's approve/reject side.
    readonly approvals: ApprovalsStore;
    // Bug reports from /intake, triaged from /issues; one instance so per-fingerprint writes don't race.
    readonly issues: IssuesStore;
    // Which sites loaded the reporter's script and which were turned away; the install panel's landing check.
    readonly issueInstalls: InstallsStore;
    // What is in flight right now; cleared on settle, so what remains at boot is what the daemon died under.
    readonly turnJournal: TurnJournal;
    // Armed condition watches; a watch's life is between turns, so only a boot-time read survives a recreate.
    readonly watchJournal: WatchJournal;
    // What each message can be restored to: a workspace checkpoint, or an isolated turn's own per-repo commits.
    readonly turnAnchors: TurnAnchors;
    // Activity audit log, outside the agent's reach: inbound wakes, sniffed calls, voice sessions, failures.
    readonly activity: ActivityStore;
    // Durable spend ledger, outside the agent's reach, one row per attributed turn, never pruned unlike activity.
    readonly usage: UsageStore;
    // Per-sandbox agent settings; streamAgent reads it to gate per-turn behavior and the owner's rule table.
    readonly sandboxSettings: SandboxSettingsStore;
    // Safety policy the judge is handed, and what it decided; a policy is a document, the log changes mid-turn.
    readonly safetyPolicy: SafetyPolicyStore;
    readonly safetyLog: SafetyLog;
    // When each rule last fired; kept beside settings, not in them, so a firing isn't a config write.
    readonly ruleFirings: RuleFiringsStore;
    // Runtime-install ledger: tools sessions installed at runtime, read by the Environment card and drift sweep.
    readonly runtimeInstalls: RuntimeInstallsStore;
    // Environment drift sweep: probes what the container has beyond the image, drafts steps for recurring installs.
    readonly driftSweep: DriftSweep;
    // Push state: this sandbox's VAPID keypair plus one channel per device; outside agent reach, can forge a push.
    readonly push: PushStore;
    // Sends push notifications; notifyIfAway is suppressed while someone is actively watching, notify always fires.
    readonly pushSender: PushSender;
    // Latest plan-limit snapshot per account of any provider; every account surface merges it from one place.
    readonly accountUsage: AccountUsageStore;
    // Coalesced headroom reads across every provider behind one refresh, triggered by events, pushed on /events.
    readonly headroom: HeadroomService;
    // Last time each provider refused a turn outright; the observed counterpart to the polled headroom snapshot.
    readonly providerRefusals: ProviderRefusalStore;
    // Which models this sandbox was refused on, finer-grained than providerRefusals; the picker drops them.
    readonly modelRefusals: ModelRefusalStore;
    // Every native provider's live model catalog, assembled from provider modules for one lookup, not each its own.
    readonly providerCatalogs: Record<NativeProvider, ProviderCatalog>;
    // What each endpoint capability's server publishes, keyed by id; only the server says what it serves.
    readonly endpointModels: EndpointCatalog;
    // Bundled translator: connects/disconnects subscription OAuth; codex/kimi/gemini have no other credential.
    readonly cliProxy: CliProxyClient;
    // Shared OpenCode runtime backing Grok; OpenCode owns the xAI credential, so there is no separate GrokStore.
    readonly openCode: OpenCodeService;
    // AI-provider credential root (also OpenCode's XDG_DATA_HOME); CLIs and an absolute agent's opencode use it.
    readonly authRoot: string;
    // Daemon-owned workspace snapshots on /history, outside agent reach: captured per turn and on an interval.
    readonly history: WorkspaceHistory;
    // The Claude Code loop: serves native Claude, Kimi, every routed provider, every endpoint capability.
    readonly agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    // Generic ACP adapter for every agent-kind capability outside NATIVE_PROVIDERS; one warm subprocess per agent.
    readonly acpAgent: (id: string, config: AcpAgentConfig, request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly acpConnections: AcpConnections;
    // Pi adapter for the reserved pi agent-kind capability over Pi's RPC; one process per turn, sessions as files.
    readonly piAgent: (config: AcpAgentConfig, request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly intentic: (run: IntenticRun, signal?: AbortSignal) => AsyncGenerator<IntenticLine>;
    readonly git: {
        readonly init: (dir: string, separateGitDir?: string) => Promise<void>;
        readonly status: (dir: string) => Promise<GitStatus>;
        readonly listFiles: (dir: string) => Promise<string[]>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly clone: (parentDir: string, name: string, cloneUrl: string, options?: GitCloneOptions) => Promise<void>;
        readonly checkout: (dir: string, ref: string) => Promise<void>;
        readonly head: (dir: string) => Promise<string>;
        // Unabbreviated HEAD sha, the form a sha-pinned capability config stores.
        readonly fullHead: (dir: string) => Promise<string>;
        readonly sync: (dir: string) => Promise<GitSyncResult>;
        // Changes review verbs: status split into index/worktree, index moves, whole-repo commits, discard, diffs.
        readonly changedFiles: (dir: string) => Promise<{
            branch?: string;
            head?: string;
            conflicted: GitChange[];
            staged: GitChange[];
            unstaged: GitChange[];
            // Object names status already reported per path; free here, a spawn per file elsewhere.
            blobs: Map<string, { head?: string; index?: string }>;
        }>;
        readonly stagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
        // The whole repository in one spawn, nothing built or chunked; why staging everything has no size limit.
        readonly stageAll: (dir: string) => Promise<void>;
        readonly unstagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
        readonly commitIndex: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly discardPaths: (dir: string, paths?: readonly string[]) => Promise<void>;
        // Branches and the remote; remote verbs return an ActionResult since 'no remote' is an outcome, not an error.
        readonly listBranches: (dir: string) => Promise<GitBranch[]>;
        // Remote-tracking branches, so the switcher can pair main with origin/main instead of unrelated peers.
        readonly listRemoteBranches: (dir: string) => Promise<GitRemoteBranch[]>;
        readonly createBranch: (dir: string, name: string, start: string | undefined, checkout: boolean) => Promise<void>;
        readonly deleteBranch: (dir: string, name: string, force: boolean) => Promise<void>;
        // known.branch lets a caller that already holds the checked-out branch skip re-deriving it.
        readonly remoteState: (dir: string, known?: { readonly branch?: string | undefined }) => Promise<GitRemoteState>;
        readonly fetchRemote: (dir: string) => Promise<ActionResult>;
        readonly pullRemote: (dir: string) => Promise<ActionResult>;
        // Where the repo is online (host + owner/name), so it can be matched against a project id from elsewhere.
        readonly remoteProjectOf: (dir: string) => Promise<{ host: string; project: string } | undefined>;
        // One file onto the default branch and out to the remote in one step; write is passed in by the router.
        readonly publishFile: (
            dir: string,
            file: { path: string; content: string; message: string },
            write: (content: string) => Promise<void>,
        ) => Promise<GitPublishFileResult>;
        // The working tree's two diffs, one per Changes-panel side; fileDiff's ref is a conversation's base sha.
        readonly stagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly unstagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly conflictedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly fileDiff: (dir: string, path: string, ref: string) => Promise<FileDiff>;
        readonly refFileDiff: (dir: string, path: string, base: string, tip: string) => Promise<FileDiff>;
        // Git-history graph, read-only: one repo's commit log across all refs, lazy per-commit detail on request.
        readonly commitLog: (dir: string, limit: number, skip?: number) => Promise<{ branch?: string; commits: GitCommit[]; hasMore: boolean }>;
        // What one repo contributes to an AI commit message: recent subjects, file list, and the diff to be recorded.
        readonly collectRepoDiff: (repo: string, dir: string, scope: CommitScope) => Promise<RepoDiff>;
        readonly commitChanges: (dir: string, sha: string) => Promise<GitChange[]>;
        readonly commitFileDiff: (dir: string, sha: string, path: string) => Promise<FileDiff>;
        // The halted-operation pair, for what a terminal left (a rebase stopped on conflict), not this daemon's verbs.
        readonly operationInProgress: (dir: string) => Promise<GitOperation | undefined>;
        readonly abortOperation: (dir: string, operation: GitOperation) => Promise<void>;
        // The stash, read here because nothing else used to; an entry is a commit, which is why it reads like one.
        readonly stashList: (dir: string) => Promise<StashEntry[]>;
        readonly stashChanges: (dir: string, ref: string) => Promise<GitChange[]>;
        readonly stashPush: (
            dir: string,
            options: { message?: string; includeUntracked?: boolean },
        ) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashApply: (dir: string, ref: string, pop: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashDrop: (dir: string, ref: string) => Promise<void>;
        // Walks the current branch back off its own reflog, the ref-level complement to a checkpoint restore.
        readonly undoableAction: (dir: string) => Promise<UndoableAction | undefined>;
        readonly undoLastAction: (
            dir: string,
            expectedPreviousSha: string,
            discardChanges: boolean,
        ) => Promise<{ ok: true; action: UndoableAction } | { ok: false; reason: string }>;
        // Graph write actions: non-destructive refs return void and propagate errors, sequence ops return a value.
        readonly createBranchAt: (dir: string, name: string, sha: string) => Promise<void>;
        readonly createTagAt: (dir: string, name: string, sha: string) => Promise<void>;
        // The other two things one does with a tag, so a tag pill is not create-only.
        readonly deleteTag: (dir: string, name: string, remote: string | undefined) => Promise<void>;
        readonly pushTag: (dir: string, name: string, remote: string) => Promise<ActionResult>;
        readonly checkoutRef: (dir: string, ref: string) => Promise<void>;
        readonly resetTo: (dir: string, sha: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
        readonly revertCommit: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly cherryPick: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly mergeCommit: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly rebaseOnto: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
        readonly dropCommit: (dir: string, sha: string, author: { name: string; email: string }) => Promise<ActionResult>;
    };
    // Fleet registry, one entry per isolated conversation; streamAgent runs turns, /agents lists/lands/discards.
    readonly agents: AgentsRegistry;
    // Per-conversation worktree compositions on /history/worktrees: create/repair/remove/prune.
    readonly agentWorktrees: AgentWorktrees;
    // Everything a stopped conversation holds (processes, terminals, browsers, temp), reclaimed on its own clock.
    readonly reaper: ResourceReaper;
    // Which copy of the workspace a file read means: the shared tree or one conversation's checkout.
    readonly workspaceScope: WorkspaceScopeDeps;
    // Builds an isolated turn's mount namespace; probes capability once, then reports unavailable forever.
    readonly turnIsolation: TurnIsolation;
    // Which agent an uncommitted main-tree file came from, derived from the landed shas.
    readonly agentOrigins: AgentOrigins;
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        // One bounded window of a file's text, for the browser's own route; `read` stays for already-bounded readers.
        readonly readWindow: (absPath: string, offset?: number, limit?: number) => Promise<WorkspaceFileWindow | undefined>;
        readonly write: (absPath: string, content: string | Uint8Array) => Promise<void>;
        readonly writeStream: (absPath: string, body: ReadableStream<Uint8Array>, limit: number, offset?: number) => Promise<void>;
        readonly setMtime: (absPath: string, mtimeMs: number) => Promise<void>;
        readonly readBytes: (absPath: string) => Promise<Buffer | undefined>;
        readonly size: (absPath: string) => Promise<number | undefined>;
        readonly mkdir: (absPath: string) => Promise<void>;
        readonly remove: (absPath: string) => Promise<void>;
        readonly move: (fromAbs: string, toAbs: string) => Promise<void>;
        readonly copy: (fromAbs: string, toAbs: string) => Promise<void>;
    };
    readonly workspaceTree: (root: string) => Promise<WorkspaceTree>;
    readonly workspaceChildren: (root: string, relPath: string, options?: { depth?: number }) => Promise<WorkspaceChildren>;
    // Resident workspace search: one iq engine, its sweep cached in memory; indexing runs on its own thread.
    readonly iq: ResidentEngine;
    readonly sessions: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<TranscriptRow[]>;
        // The last turn of a session that never settled; what the boot pass writes in its place.
        readonly readTail: (dir: string, id: string) => Promise<TranscriptRow[]>;
        // No dir, unlike its neighbours: search reads the phrase index and the workspace listing, both built once.
        readonly search: (query: string, caseSensitive: boolean) => Promise<SessionSummary[]>;
        readonly exists: (dir: string, id: string) => Promise<boolean>;
    };
    // A conversation's transcript, keyed by conversationId, surviving an archive, a retired worktree, a swap.
    readonly transcripts: {
        // The whole record, for readers that cannot take a piece: a share, a runtime handoff, a subagent, self-recall.
        readonly read: (agent: TranscriptAgent) => Promise<TranscriptRow[]>;
        // One page, newest turns by default, window walking back; what a chat tab opening asks for.
        readonly page: (agent: TranscriptAgent, window?: TranscriptWindow) => Promise<TranscriptPage>;
        // Opens a branch's record as a copy of the source's first `keep` rows; a no-op once the record exists.
        readonly fork: (agent: TranscriptAgent, source: string, keep: number) => Promise<void>;
        readonly append: (agent: TranscriptAgent, messages: readonly TranscriptRow[]) => Promise<void>;
        // How many messages are stored, the position the next turn starts at and its checkpoint is filed under.
        readonly count: (agent: TranscriptAgent) => Promise<number>;
        // Drops everything after the message a rewind returned to; returns how many went.
        readonly truncate: (agent: TranscriptAgent, keep: number) => Promise<number>;
    };
    // What was said, indexed: what the fleet filter and chat-history search answer from, written as turns settle.
    readonly saidIndex: {
        // One query, one round trip; async here only so a test harness can substitute a fake without going synchronous.
        readonly search: (...args: Parameters<SearchIndex["search"]>) => Promise<ReturnType<SearchIndex["search"]>>;
        // Brings the index level with the stores; detached at boot and after a sweep, a no-op if nothing's behind.
        readonly backfill: (signal?: AbortSignal) => Promise<void>;
        // Whether a backfill is running, whether the answer can still grow; both search routes report it as partial.
        readonly indexing: () => boolean;
    };
    // Which conversations are published as shareable pages; the index only, pages live in the workspace outbox.
    readonly shares: ShareStore;
    // Composer's voice input: whisper.cpp over browser WAV, with a serialized queue and first-use model download.
    readonly speech: Speech;
    readonly purgeConversationState: NonNullable<AgentArchiveDeps["purgeConversationState"]>;
    // What a panel's preview hostname actually serves; the panels list only advertises a URL where it answers.
    readonly panelUpstreamOf: PanelUpstreamResolver;
    // Shared-access grants besides the owner; the daemon enforces these, the platform only mirrors them.
    readonly members: MembersStore;
    // Bound owner's email, read-only; undefined before the first trust-on-first-use sign-in; binding is elsewhere.
    readonly ownerEmail: () => Promise<string | undefined>;
    // When set, the daemon verifies the bearer on every route but /health and emits CORS; unset means loopback.
    readonly auth:
        | {
              readonly authorize: (bearer: string, firstBind: string | undefined) => Promise<Caller>;
              readonly authorizeOwner: (bearer: string) => Promise<void>;
              readonly authorizeRetirement: (bearer: string) => Promise<void>;
              readonly mintSession: (identity: VerifiedIdentity) => Promise<MintedSession>;
              // Re-keys the session signer, signing every browser out at once; backs 'sign out everywhere'.
              readonly rotateSessions: () => Promise<void>;
              readonly disableBrowserAccess: () => Promise<void>;
              readonly connections: AuthConnections;
          }
        | undefined;
}

// Builds production services from config; the agent/intentic/git/files/sessions/tree members default to real
// subprocess/fs functions.
export const createServices = (config: Config, logger: Logger): Services => {
    const workspace = workspacePaths(config.workspaceRoot);
    // AI-provider credential root; AGENT_AUTH_DIR shares it across dev sandboxes so subscription OAuth survives.
    const authRoot = config.agentAuthDir !== "" ? config.agentAuthDir : statePath(workspace.root, ".intentic/secrets/auth/");
    // Hoisted: the turn stream and the translator client both read and record into this same file.
    const accountUsage = fileAccountUsageStore(join(config.historyRoot, "account-usage.json"));
    const cliProxy = createCliProxyClient({
        managementUrl: cliProxyManagementUrl(config),
        token: config.translator.token,
        configPath: cliProxyConfigPath(config),
        // The credential store the proxy reads, so the connection list survives a proxy that isn't answering yet.
        authDir: cliProxyAuthDir(authRoot),
        usageStore: accountUsage,
    });
    // OpenCode and the Gemini slice reference each other; safe since the model read runs lazily, after returning.
    // oxlint-disable-next-line prefer-const -- openCode's config closure below reads `gemini` before this is assigned, which is what the definite-assignment `!` is for. There is no initialiser to merge into.
    let gemini!: GeminiSlice;
    const openCode = createOpenCodeService(authRoot, {
        // Where a non-isolated conversation runs, the one directory whose permission watcher is worth opening at boot.
        workspaceRoot: config.workspaceRoot,
        ...(config.translator.url === ""
            ? {}
            : {
                  gemini: {
                      baseUrl: config.translator.url,
                      token: config.translator.token,
                      models: async () =>
                          (await gemini.geminiModels.models()).models.map((model) => ({ id: model.id, inputModalities: model.inputModalities })),
                  },
              }),
    });
    gemini = createGeminiSlice({ config, authRoot, openCode });
    const info =
        config.sandbox.name !== "" && config.sandbox.image !== ""
            ? {
                  name: config.sandbox.name,
                  image: config.sandbox.image,
                  version,
                  // Empty means not set, never a value to publish; "" would be an unclickable rollback button.
                  ...(config.sandbox.channel !== "" ? { channel: config.sandbox.channel } : {}),
                  ...(config.sandbox.previousImage !== "" ? { previousImage: config.sandbox.previousImage } : {}),
              }
            : undefined;
    const members = fileMembersStore(statePath(workspace.root, ".intentic/identity/members.json"));
    // Bound owner, hoisted since the Access roster and gate routes both need to read, never write, the email.
    const ownerStore = fileOwnerStore(statePath(workspace.root, ".intentic/identity/owner.json"));
    // Session secret under historyRoot, daemon-private and persistent, so a restart doesn't sign every browser out.
    const sessions = createSessions(join(config.historyRoot, "session-secret"));
    const authConnections = createAuthConnections();
    const browserAccess = fileBrowserAccess(join(config.historyRoot, "browser-access-disabled"));
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
                  session: sessions.verify,
                  owner: ownerStore,
                  members,
                  browserAccess,
                  ...(config.connectToken !== "" ? { connectToken: config.connectToken } : {}),
                  ...(config.owner.email !== "" ? { expectedOwner: config.owner.email } : {}),
                  // Hosted machines only: the provisioner sets the platform's key, checked against this sandbox's id.
                  ...(config.platform.publicKey !== "" && config.connectToken !== ""
                      ? { ownerTicket: ownerTicketVerifier(config.platform.publicKey, sandboxIdFromToken(config.connectToken) ?? "") }
                      : {}),
              })
            : undefined;
    const auth = authorizer
        ? {
              authorize: authorizer.authorize,
              authorizeOwner: authorizer.authorizeOwner,
              authorizeRetirement: authorizer.authorizeRetirement,
              mintSession: sessions.mint,
              rotateSessions: sessions.rotate,
              disableBrowserAccess: browserAccess.disable,
              connections: authConnections,
          }
        : undefined;

    // Provider slices: each directory builds its own Services members; Gemini's slice is built beside OpenCode.
    const claude = createClaudeSlice({ config, logger, authRoot, workspaceRoot: workspace.root });
    // Both halves of 'what each account has left': Claude's own tokens, routed subscriptions via the translator.
    const headroom = createHeadroomService({
        store: accountUsage,
        sources: [claudeHeadroomSource(claude.claudeStore), cliProxy.headroom],
        logger,
    });
    const codex = createCodexSlice({ config, authRoot });
    const cursor = createCursorSlice({ authRoot, logger });
    const grok = createGrokSlice(openCode);
    const kimi = createKimiSlice(cliProxy);
    // One slice for every minted provider, built from a spec table so adding one is a contract row, not code here.
    const minted = createMintedSlice({ authRoot, logger });

    // Hoisted: worktree ops and the Changes scan must file into the same tracker the summary line reads.
    const perf = createPerfTracker(logger, createPerfLogger(config));

    // Hoisted: the invariant companions below observe these exact instances, not a second, disagreeing one.
    const turnJournal = fileTurnJournal(join(config.historyRoot, "turns"));
    const invariants = createInvariantRegistry(logger);

    // Hoisted: the ACP connection pool implements ACP terminal/* over the same runner, so both share one instance.
    const terminalRun = createTerminalRunner();
    const acpConnections = createAcpConnections(logger, terminalRun);
    const processes = createManagedProcesses();
    const serviceProcesses = createServiceProcesses(join(config.historyRoot, "logs", "services"), logger);
    const dependencies = createDependencyCoordinator({
        workspace,
        processes,
        logger,
        requestsPath: join(config.historyRoot, "dependency-requests.json"),
    });
    // Hoisted: the store and the sender reading it must be the same instance, or a subscription would go unseen.
    const pushStore = filePushStore(join(config.historyRoot, "push.json"));
    // Hoisted because the credential gate notifies through it when a release card goes up.
    const pushSender = createPushSender(pushStore, logger);
    // Shared by the turn path and worktree creation so both read one capability probe.
    const turnIsolation = createTurnIsolation({ root: workspace.root, historyRoot: config.historyRoot, logger });
    // Hoisted above the registry, which now derives a card's land standing through it rather than a stored verdict.
    const agentWorktrees = createAgentWorktrees(
        {
            workspace,
            worktreesRoot: join(config.historyRoot, "worktrees"),
            historyRoot: config.historyRoot,
            isolation: turnIsolation,
            logger,
            perf,
        },
        // Demoted: a worktree ensure is bulk agent-plane IO that must lose to the daemon's own loop under contention.
        politeGit,
    );
    // Hoisted: the Changes scan and the turns share one registry; one tracker serves both landing readers' query.
    const landingExpiry = createExpiryTracker();
    const landedPresences = createLandedPresences(agentWorktrees, logger, landingExpiry);
    const agents = createAgentsRegistry(
        fileAgentsStore(join(config.historyRoot, "agents.json")),
        createLandStandings(agentWorktrees),
        landedPresences,
    );
    // Reaper keys to the same three facts as everything else: whose work, whether it's live, whether it's ours.
    const reaper = createResourceReaper({
        ownerLive: (owner) => owner === DAEMON_OWNER || turnRunOf(owner)?.done === false,
        ownerKnown: (owner) => agents.entry(owner) !== undefined,
        liveSessionNames: () =>
            new Set(
                agents.liveSessionIds().flatMap((sessionId) => {
                    const session = agentSessionName(sessionId);
                    return session === undefined ? [] : [session];
                }),
            ),
        panePids,
        onOwnerStopped: onTurnSettled,
        logger,
    });
    // A settled turn's outside-content taint drops with the turn; the registry must be told when that moment is.
    onTurnSettled(clearTurnTaint);
    // Hoisted like the presences above: its attribution caches report into the resource series.
    const agentOrigins = createAgentOrigins({ agents, logger, expiry: landingExpiry });
    // Hoisted: the CI hook reconciler reads the same manifest the routes edit.
    // The free trial lays over the manifest, never into it; routing stays a config constant, not probe timing.
    const trial = createTrialService(config);
    // The bundled translator opens the trial's connection and verifies its cert; a self-signed platform fails this.
    const platformTunnel = startPlatformTunnel(config.platform.url, logger);
    const capabilityManifest = fileCapabilitiesStore(statePath(workspace.root, ".intentic/config/capabilities.json"), (id, reason) =>
        logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}), the rest of the manifest is unaffected`),
    );
    // Credential values, off /work, sited beside the AI-provider logins outside the file routes and search index.
    const secretVault = fileSecretVault(join(authRoot, "capability-secrets.json"));
    // Approval policy sits beside the vault it guards, off the tracked, agent-editable config directory.
    const credentialGates = fileCredentialGates(join(authRoot, "credential-gates.json"));
    const credentialGrants = createCredentialGrants();
    // Resolved against the raw manifest, not the vaulted store, since enumeration never reads a credential.
    const secretFieldConnectors = () =>
        contributionRegistry({
            workspace: { root: workspace.root },
            files: { read: readWorkspaceFile },
            capabilities: capabilityManifest,
            config: { extensionsDir: config.extensionsDir },
        });
    const onUnvaultable = (id: string, fields: readonly string[]): void =>
        logger.warn(
            `capabilities: "${id}" holds non-string credential field(s) ${fields.join(", ")}, left in the manifest, which the agent can read`,
        );
    // Extension-settings' own vault, keyed by publisher.name, not capability id, since the two ids can collide.
    const extensionSecretVault = fileSecretVault(join(authRoot, "extension-secrets.json"));
    const extensionHostAdapter = {
        workspace: { root: workspace.root },
        files: { read: readWorkspaceFile },
        capabilities: capabilityManifest,
        config: { extensionsDir: config.extensionsDir },
    };
    const settingSecretKeys = async (): Promise<SecretKeyResolver> => {
        const declared = new Map<string, ReadonlySet<string>>(
            (await installedExtensions(extensionHostAdapter)).map((extension) => [
                extensionIdOf(extension.manifest),
                new Set((extension.manifest.contributes?.settings ?? []).filter((setting) => setting.secret === true).map((setting) => setting.key)),
            ]),
        );
        return (extensionId) => declared.get(extensionId) ?? new Set<string>();
    };
    const onUnvaultableSetting = (id: string, keys: readonly string[]): void =>
        logger.warn(`extension settings: "${id}" declares ${keys.join(", ")} secret but stores a non-string, left in the tracked settings file`);
    const capabilities = withTrialEndpoint(
        withSecretVault(capabilityManifest, secretVault, secretFieldConnectors, onUnvaultable),
        config,
        trial,
        platformTunnel,
    );
    const personas = filePersonasStore(statePath(workspace.root, ".intentic/config/personas.json"), (id, reason) =>
        logger.warn(`personas: skipping unreadable card "${id}" (${reason}), the rest are unaffected`),
    );
    const heavyCommands = fileHeavyCommandsStore(statePath(workspace.root, ".intentic/config/heavy-commands.json"), (reason) =>
        logger.warn(`heavy-commands: ${reason}, falling back to the shipped rules`),
    );
    // Seeded on boot if absent so the rule list isn't invisible; not awaited, since nothing reads it before then.
    void heavyCommands.seed().catch((error: unknown) => logger.warn({ err: error }, "heavy-commands: could not write the default rules"));
    const ciStore = fileCiStore(statePath(workspace.root, ".intentic/secrets/ci.json"));
    const verifyStore = fileVerifyStore(statePath(workspace.root, ".intentic/records/verify.json"));
    // Hoisted: the drift sweep and the install-steering hook write the same ledger the /environment route reads.
    const runtimeInstalls = fileRuntimeInstallsStore(statePath(workspace.root, ".intentic/records/runtime-installs.json"));
    // Hoisted: the background probe runner writes the same cache the /chores route reads.
    const chores = fileChoresStore(join(workspace.root, PROBES_FILE), join(workspace.root, LEDGER_FILE));
    // Bound once against the same registry, whose sessionIdOf reads live turn state as well as the persisted entry.
    const turnAnchors = fileTurnAnchors(join(config.historyRoot, "turn-anchors.json"));
    const transcriptDeps: AgentTranscriptDeps = {
        record: fileTranscriptRecord(join(config.historyRoot, "transcripts")),
        turnAnchors,
    };
    // Phrase index on the history volume, daemon-private; a pure cache, deleted and rebuilt on a schema bump.
    const saidIndex = openSearchIndex(join(config.historyRoot, "said-index"));
    // One listing of the session window, shared by search and backfill, so a keystroke burst costs one stat pass.
    const recentSessions = createRecentSessions(workspace.root);
    // Version an indexed conversation is pinned to: its record's byte size; undefined (no record) is a version too.
    const recordVersion = async (id: string): Promise<string | undefined> => {
        const size = await transcriptDeps.record.size(id);
        return size === undefined ? undefined : String(size);
    };
    // Brings the index level with both stores in one pass: the roster's own list, and the session list's window.
    const runSaidBackfill = async (signal?: AbortSignal): Promise<void> => {
        const roster = [...agents.list(), ...agents.listArchived()].flatMap((summary) => {
            const entry = agents.entry(summary.id);
            return entry === undefined ? [] : [entry];
        });
        await backfillSearchIndex(
            saidIndex,
            {
                kind: "conversation",
                prune: false,
                sources: roster.map((entry): BackfillSource => ({
                    key: entry.id,
                    version: () => recordVersion(entry.id),
                    lines: () => spokenTranscript(transcriptDeps, entry),
                })),
            },
            logger,
            signal,
        );
        if (signal?.aborted === true) {
            return;
        }
        const listed = await recentSessions().catch(() => []);
        await backfillSearchIndex(
            saidIndex,
            {
                kind: "session",
                prune: true,
                sources: listed.map((session): BackfillSource => ({
                    key: session.id,
                    // The session file's own mtime, already read by the list; an append moves it, nothing else to open.
                    version: async () => String(session.updatedAt),
                    lines: () => readSessionLines(workspace.root, session.id),
                })),
            },
            logger,
            signal,
        );
    };
    // Reentrancy guard and the flag both search routes report; a search taken mid-backfill is legitimately partial.
    let backfillingSaid = false;
    const backfillSaidIndex = async (signal?: AbortSignal): Promise<void> => {
        if (backfillingSaid) {
            return;
        }
        backfillingSaid = true;
        try {
            await runSaidBackfill(signal);
        } finally {
            backfillingSaid = false;
        }
    };
    // A full embeddings rebuild is slow; logged at a human cadence so the load has a name while it runs.
    const BACKLOG_LOG_MS = 30_000;
    let backlogLoggedAt = 0;
    let backlogActive = false;
    // The engine runs in a child process, most of this daemon's RSS; a dead child only loses its own searches.
    const iq = createEngineClient({
        root: workspace.root,
        indexDir: statePath(workspace.root, ".intentic/local/cache/", "iq"),
        // An index pass failing after warm() has no caller to reject; without this it silently stops tracking disk.
        onIndexError: (error) => logger.warn({ err: error }, "iq index pass failed, search results may be stale"),
        onIndexProgress: (remaining) => {
            if (remaining === 0) {
                if (backlogActive) {
                    backlogActive = false;
                    logger.info("iq index embeddings complete: semantic search at full coverage");
                }
                return;
            }
            const now = Date.now();
            if (backlogActive && now - backlogLoggedAt < BACKLOG_LOG_MS) {
                return;
            }
            backlogActive = true;
            backlogLoggedAt = now;
            logger.info({ remaining }, "iq index building embeddings: semantic search fills in as it goes");
        },
        // The query worker owns the semantic scan and cross-encoder; losing it narrows a search to keyword matching.
        onQueryError: (error) => logger.warn({ err: error }, "iq query worker failed, search fell back to keyword matching"),
        ...(config.iqModelDir !== "" ? { modelDir: config.iqModelDir } : {}),
        ...(config.iqRgPath !== "" ? { rgPath: config.iqRgPath } : {}),
    });
    // Named once at boot: from outside the engine is one more node child, and this answers which holds the memory.
    logger.info({ enginePid: iq.pid() }, "iq search engine running in its own process");

    // The backend supervisor enumerates extensions through the finished services object, so it needs a thunk after.
    const servicesHolder: { current?: Services } = {};
    const services: Services = {
        config,
        logger,
        // The browser's own reports, in their own file.
        clientLogger: createClientLogger(config),
        perf,
        resourceOwners: () => {
            const operations = perf.ranked();
            return {
                transcriptSearch: transcriptSearchMetrics(),
                saidIndex: saidIndex.metrics(),
                agentOrigins: agentOrigins.metrics(),
                landedPresences: landedPresences.metrics(),
                landingExpiry: landingExpiry.metrics(),
                iq: iq.metrics(),
                perf: { operations: operations.length, spans: operations.reduce((total, operation) => total + operation.count, 0) },
            };
        },
        // Born converged: main() closes the gate, so a test or host-internal preview build has nothing to wait for.
        boot: createBootTracker(logger),
        announcer: createAnnouncer(config, logger),
        // Reads the tracker through the holder at call time, since this and boot are siblings in the same literal.
        reach: createReachReporter(config, logger, () => servicesHolder.current?.boot),
        workspace,
        // Read here, once, at composition: the last moment /work still looks the way the user handed it over.
        workspaceArrivedEmpty: workspaceArrivedEmpty(workspace.root),
        processes,
        serviceProcesses,
        dependencies,
        extensionBackend: createExtensionBackend(
            () => {
                if (servicesHolder.current === undefined) {
                    throw new Error("extension backend used before services finished composing");
                }
                return servicesHolder.current;
            },
            config.sandbox.port,
            logger,
        ),
        // Slot names are salted with the connect token so a port's hostname can't be guessed from the sandbox id.
        portForwards: createPortForwards(portSlotsFromToken(config.connectToken)),
        // Pane listing rides with the scan rather than behind it: both are cheap, and an unowned port is unactionable.
        scanPorts: async () => {
            const [listeners, panes] = await Promise.all([scanListeningPorts(), panePids()]);
            return withOwningSessions(listeners, panes);
        },
        terminalRun,
        wsTickets: createWsTickets(),
        mediaTickets: createMediaTickets(),
        panelToken: randomBytes(32).toString("hex"),
        agentToken: randomBytes(32).toString("hex"),
        hostBridgeToken: randomBytes(32).toString("hex"),
        hosts: filePeerStore(config.historyRoot, HOST_PEER.store),
        hostHub: createPeerHub<HostClient, HostAnnounced, HostFacts, HostScopes>(HOST_PEER.hub, logger),
        webextBridgeToken: randomBytes(32).toString("hex"),
        webexts: filePeerStore(config.historyRoot, WEBEXT_PEER.store),
        webextHub: createPeerHub<WebExtClient, WebExtAnnounced, WebExtFacts, WebExtScopes>(WEBEXT_PEER.hub, logger),
        runners: filePeerStore(config.historyRoot, RUNNER_PEER.store),
        runnerHub: createPeerHub<RunnerClient, RunnerAnnounced, RunnerFacts, never>(RUNNER_PEER.hub, logger),
        syncPairings: pairings<SyncMode>(syncPairBurnPath(config.historyRoot)),
        runnerParent: {},
        info,
        tools: internalTools(config.intenticAgentTools),
        capabilities,
        vaultManifestSecrets: () => vaultManifestSecrets(capabilityManifest, secretVault, secretFieldConnectors, onUnvaultable),
        extensionSecretVault,
        vaultExtensionSettingSecrets: async () =>
            vaultExtensionSettingSecrets(workspace.root, extensionSecretVault, await settingSecretKeys(), onUnvaultableSetting),
        secretRegistry: secretRegistryOf(secretVault, () => workspace.repos["desired-state"]),
        secretUses: fileSecretUses(statePath(workspace.root, ".intentic/records/secret-uses.json")),
        credentialGates,
        credentialGrants,
        // Grants must be one map: a release clicked at the shell exit must be the release the browser reads next turn.
        credentialGate: createCredentialGate({
            gates: credentialGates,
            grants: credentialGrants,
            liveRun: liveCardRun,
            observe: agents.observe,
            notify: (conversationId) => void pushSender.notifyIfAway(turnAwaiting(conversationId, "credential_offer")),
        }),
        walletLedger: fileWalletLedger(statePath(workspace.root, ".intentic/records/wallet-ledger.json")),
        trial,
        platformTunnel,
        capabilityDismissals: fileDismissalsStore(statePath(workspace.root, ".intentic/config/capability-dismissals.json")),
        personas,
        heavyCommands,
        ciStore,
        verifyStore,
        ciRuns: createRunsCache(),
        ciHooks: createCiHookReconciler({ workspace, capabilities, ciStore, config, logger }),
        controlTokens: fileControlTokens(statePath(workspace.root, ".intentic/identity/control-tokens.json")),
        doorTokens: fileDoorTokens(statePath(workspace.root, ".intentic/secrets/doors.json")),
        automations: fileAutomationsStore(
            statePath(workspace.root, ".intentic/config/automations.json"),
            statePath(workspace.root, ".intentic/records/automation-runs.json"),
        ),
        loops: fileLoopsStore(statePath(workspace.root, ".intentic/records/loops.json")),
        loopDesigns: fileLoopDesignsStore(statePath(workspace.root, ".intentic/config/loop-designs.json")),
        workflows: fileWorkflowsStore(statePath(workspace.root, ".intentic/config/workflows.json")),
        workflowRuns: fileWorkflowRunsStore(statePath(workspace.root, ".intentic/records/workflow-runs.json")),
        chores,
        probeRunner: createProbeRunner({ workspace, chores, agents, logger }),
        heldWakes: fileHeldWakesStore(statePath(workspace.root, ".intentic/records/approvals/")),
        threadSessions: fileThreadSessionsStore(statePath(workspace.root, ".intentic/records/thread-sessions.json")),
        approvals: fileApprovalsStore(statePath(workspace.root, ".intentic/config/approvals/")),
        issues: fileIssuesStore(statePath(workspace.root, ".intentic/records/issues/")),
        issueInstalls: fileInstallsStore(statePath(workspace.root, ".intentic/records/issue-installs.json")),
        turnJournal,
        // Beside the turn journal on the history volume, for the same reason: it must outlive a container recreate.
        watchJournal: fileWatchJournal(join(config.historyRoot, "watches")),
        invariants,
        // The same instance the transcript reader holds; a second would answer from a file the first already passed.
        turnAnchors,
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        usage: fileUsageStore(join(config.historyRoot, "usage.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(statePath(workspace.root, ".intentic/config/settings.json")),
        safetyPolicy: fileSafetyPolicyStore(statePath(workspace.root, ".intentic/config/safety.md")),
        safetyLog: fileSafetyLog(statePath(workspace.root, ".intentic/local/safety-log.json")),
        ruleFirings: fileRuleFiringsStore(statePath(workspace.root, ".intentic/local/rule-firings.json")),
        runtimeInstalls,
        driftSweep: createDriftSweep({ workspace, runtimeInstalls, agents, logger }),
        push: pushStore,
        pushSender,
        // Provider slices, spread whole; their members' docs live on the slice interfaces, beside the code.
        ...claude,
        ...codex,
        ...cursor,
        ...grok,
        ...gemini,
        ...kimi,
        ...minted,
        accountUsage,
        headroom,
        providerRefusals: fileProviderRefusalStore(join(config.historyRoot, "provider-refusals.json")),
        modelRefusals: fileModelRefusalStore(join(config.historyRoot, "model-refusals.json")),
        // Late-bound through the same holder the extension backend uses; the thunks only run per request.
        providerCatalogs: providerCatalogsOf(() => {
            if (servicesHolder.current === undefined) {
                throw new Error("provider catalog read before services finished composing");
            }
            return servicesHolder.current;
        }),
        endpointModels: createEndpointCatalog(join(authRoot, "endpoints")),
        cliProxy,
        openCode,
        authRoot,
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
        agent: runAgent,
        acpAgent: createAcpAgent(acpConnections),
        acpConnections,
        // Pi sessions sit beside other AI-provider state under authRoot, so a stable dir keeps them resumable.
        piAgent: createPiAgent(piSpawner(join(authRoot, "pi", "sessions"))),
        // Bound to the daemon logger so a CLI run's lifecycle is attributable from daemon.log.
        intentic: (run, signal) => runIntentic(run, signal, logger),
        git: {
            init: gitInit,
            status: gitStatus,
            listFiles: gitListFiles,
            commitAll: gitCommitAll,
            clone: gitClone,
            checkout: gitCheckout,
            head: gitHead,
            fullHead: gitFullHead,
            sync: gitSync,
            changedFiles,
            stagePaths,
            stageAll,
            unstagePaths,
            commitIndex,
            discardPaths,
            listBranches,
            listRemoteBranches,
            createBranch,
            deleteBranch,
            remoteState,
            fetchRemote,
            pullRemote,
            remoteProjectOf: (dir) => remoteProjectOf(dir, defaultGit),
            publishFile,
            stagedFileDiff,
            unstagedFileDiff,
            conflictedFileDiff,
            fileDiff: workingFileDiff,
            refFileDiff,
            commitLog,
            operationInProgress,
            abortOperation,
            undoableAction,
            undoLastAction,
            stashList,
            stashChanges,
            stashPush,
            stashApply,
            stashDrop,
            collectRepoDiff,
            commitChanges,
            commitFileDiff,
            createBranchAt,
            createTagAt,
            deleteTag,
            pushTag,
            checkoutRef,
            resetTo,
            revertCommit,
            cherryPick,
            mergeCommit,
            rebaseOnto,
            dropCommit,
        },
        agents,
        agentWorktrees,
        reaper,
        workspaceScope: {
            main: workspace.root,
            entry: (id) => agents.entry(id),
            worktreeDir: (id) => agentWorktrees.conversationDir(id),
        },
        turnIsolation,
        agentOrigins,
        files: {
            read: readWorkspaceFile,
            readWindow: readWorkspaceFileWindow,
            write: writeWorkspaceFile,
            writeStream: writeWorkspaceFileStream,
            setMtime: setWorkspaceMtime,
            readBytes: readWorkspaceFileBytes,
            size: statWorkspaceFileSize,
            mkdir: makeWorkspaceDir,
            remove: removeWorkspacePath,
            move: moveWorkspacePath,
            copy: copyWorkspacePath,
        },
        workspaceTree: walkWorkspaceTree,
        workspaceChildren: listWorkspaceChildren,
        iq,
        sessions: {
            list: listWorkspaceSessions,
            read: readWorkspaceSession,
            readTail: readWorkspaceSessionTail,
            // Bound to this daemon's one index, so the history box and the fleet board answer from the same rows.
            search: (query, caseSensitive) =>
                searchWorkspaceSessions(recentSessions, query, caseSensitive, async (...args) => saidIndex.search(...args)),
            exists: workspaceSessionExists,
        },
        transcripts: {
            read: (agent) => agentTranscript(transcriptDeps, agent),
            page: (agent, window) => agentTranscriptPage(transcriptDeps, agent, window),
            // A branch's opening history is the source conversation's record, copied once.
            fork: (agent, source, keep) => transcriptDeps.record.fork(agent.id, source, keep),
            // Written right after the record, best-effort: a failed index write is fixed by the next backfill.
            append: async (agent, messages) => {
                await transcriptDeps.record.append(agent.id, messages);
                try {
                    saidIndex.extend(agent.id, "conversation", (await recordVersion(agent.id)) ?? "none", spokenLinesOf(messages));
                } catch (error) {
                    logger.warn({ err: error, conversationId: agent.id }, "search index: turn not indexed");
                }
            },
            count: (agent) => transcriptDeps.record.count(agent.id),
            // A rewind shortens the record; the index is re-stated whole from it, never appended.
            truncate: async (agent, keep) => {
                const dropped = await transcriptDeps.record.truncate(agent.id, keep);
                try {
                    saidIndex.put(agent.id, "conversation", (await recordVersion(agent.id)) ?? "none", await spokenTranscript(transcriptDeps, agent));
                } catch (error) {
                    logger.warn({ err: error, conversationId: agent.id }, "search index: rewind not reindexed");
                }
                return dropped;
            },
        },
        saidIndex: {
            search: async (needle, kind, caseSensitive) => saidIndex.search(needle, kind, caseSensitive),
            backfill: backfillSaidIndex,
            indexing: () => backfillingSaid,
        },
        shares: fileShareStore(join(config.historyRoot, "shares.json")),
        speech: createSpeech({ workspaceRoot: workspace.root, log: (message) => logger.info(`speech: ${message}`) }),
        // The index goes with the state; a purged conversation's rows would otherwise still be findable by phrase.
        purgeConversationState: async (removed, retained) => {
            await purgeConversationState(workspace.root, config.historyRoot, removed, retained);
            for (const entry of removed) {
                saidIndex.forget(entry.id);
                // A gone conversation must not leave a live credential release behind it.
                credentialGrants.forget(entry.id);
            }
        },
        // Reads live sockets through the shared scan rather than the assigned port, since a monorepo can pin its own.
        panelUpstreamOf: createPanelUpstreamResolver({
            workspaceRoot: workspace.root,
            repos: () => discoverRepos(workspace.root),
            listeners: () => services.scanPorts(),
            // Panels answer from the panel manager; an extension preview answers from the supervisor that assigned it.
            portOf: (key) => processes.portOf(key) ?? serviceProcesses.portOf(key),
        }),
        members,
        ownerEmail: () => ownerStore.read(),
        auth,
    };
    servicesHolder.current = services;
    // Registration only; nothing runs until main.ts drives a moment, so a test build carries it unpaid for.
    registerDaemonInvariants(invariants, {
        turnJournal,
        agents,
        manifest: capabilityManifest,
        connectors: secretFieldConnectors,
        // The decorated store, since the exit checks read kind and a country code, never a credential.
        capabilities: services.capabilities,
        hosts: services.hosts,
        hostHub: services.hostHub,
        runners: services.runners,
        runnerHub: services.runnerHub,
        webexts: services.webexts,
        webextHub: services.webextHub,
        issues: services.issues,
        cursorHooks: services.cursorHooks,
    });
    return services;
};
