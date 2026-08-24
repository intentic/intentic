import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
    AcpAgentConfig,
    AgentEvent,
    FileDiff,
    GitBranch,
    GitChange,
    GitCommit,
    GitPublishFileResult,
    GitRemoteBranch,
    GitRemoteState,
    IntenticLine,
    NativeProvider,
    RestoredMessage,
    StashEntry,
    WorkspaceChildren,
    WorkspaceTree,
} from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
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
import { createAcpAgent } from "./acp/acp-agent.js";
import { type AcpConnections, createAcpConnections } from "./acp/acp-connection.js";
import { createPiAgent } from "./pi/pi-agent.js";
import { piSpawner } from "./pi/pi-rpc.js";
import { type ControlTokens, fileControlTokens } from "./auth/control-tokens.js";
import { createMediaTickets, type MediaTickets } from "./auth/media-tickets.js";
import { createWsTickets, type WsTickets } from "./auth/ws-tickets.js";
import { type ActivityStore, fileActivityStore } from "./activity/activity-store.js";
import { type AgentRequest, runAgent } from "./agent/agent.js";
import { cliProxyAuthDir, type CliProxyClient, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/translator.js";
import { type ApprovalsStore, fileApprovalsStore } from "./automations/approvals-store.js";
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
import { fileWalletLedger, type WalletLedgerStore } from "./wallet/wallet-ledger.js";
import { createTrialService, type TrialService } from "./trial/trial.js";
import { withTrialEndpoint } from "./trial/trial-endpoint.js";
import { type DismissalsStore, fileDismissalsStore } from "./capabilities/dismissals-store.js";
import { filePersonasStore, type PersonasStore } from "./personas/personas-store.js";
import { type CiStore, fileCiStore } from "./ci/ci-store.js";
import { fileVerifyStore, type VerifyStore } from "./workspace/verify-store.js";
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
} from "./auth/auth.js";
import { fileBrowserAccess } from "./auth/browser-access.js";
import { createAuthConnections, type AuthConnections } from "./auth/connections.js";
import { createSessions, type MintedSession } from "./auth/session.js";

import { type AccountUsageStore, fileAccountUsageStore } from "./usage/account-usage.js";
import { fileProviderRefusalStore, type ProviderRefusalStore } from "./usage/provider-refusals.js";
import { type DraftsStore, fileDraftsStore } from "./drafts/drafts-store.js";
import { createHostHub, type HostHub } from "./hosts/host-hub.js";
import { fileHostsStore, type HostsStore } from "./hosts/hosts-store.js";
import { fileTurnJournal, type TurnJournal } from "./agent/turn-journal.js";
import { fileTurnAnchors, type TurnAnchors } from "./agent/turn-anchors.js";
import type { Config } from "./env.config.js";
import { createAgentsRegistry, type AgentsRegistry } from "./agents/agents-registry.js";
import type { AgentArchiveDeps } from "./agents/archive.js";
import { fileAgentsStore } from "./agents/agents-store.js";
import { createTurnIsolation, type TurnIsolation } from "./agents/isolation.js";
import { createAgentOrigins, type AgentOrigins } from "./agents/origins.js";
import { createExpiryTracker } from "./agents/expiry.js";
import { createLandedPresences } from "./agents/landed-presence.js";
import { createLandStandings } from "./agents/standing.js";
import { createAgentWorktrees, type AgentWorktrees } from "./agents/worktrees.js";
import {
    type ActionResult,
    changedFiles,
    checkoutRef,
    cherryPick,
    commitChanges,
    commitFileDiff,
    commitIndex,
    commitLog,
    createBranchAt,
    createTagAt,
    deleteTag,
    discardPaths,
    dropCommit,
    mergeCommit,
    pushTag,
    rebaseOnto,
    resetTo,
    revertCommit,
    conflictedFileDiff,
    refFileDiff,
    stagePaths,
    stagedFileDiff,
    unstagePaths,
    unstagedFileDiff,
    workingFileDiff,
} from "./git/changes.js";
import { collectRepoDiff, type CommitScope, type RepoDiff } from "./git/commit-message.js";
import { createBranch, deleteBranch, listBranches, listRemoteBranches } from "./git/branches.js";
import { abortOperation, type GitOperation, operationInProgress } from "./git/operation.js";
import { type UndoableAction, undoableAction, undoLastAction } from "./git/undo.js";
import { stashApply, stashChanges, stashDrop, stashList, stashPush } from "./git/stash.js";
import { fetchRemote, pullRemote, pushBranch, remoteState } from "./git/remote.js";
import { remoteProjectOf } from "./git/remote-urls.js";
import { publishFile } from "./git/publish-file.js";
import { type EndpointCatalog, createEndpointCatalog } from "./endpoints/endpoint-catalog.js";
import { createOpenCodeService, type OpenCodeService } from "./grok/opencode.js";
import { type ClaudeSlice, createClaudeSlice } from "./claude/claude-provider.js";
import { type CodexSlice, createCodexSlice } from "./codex/codex-provider.js";
import { createCursorSlice, type CursorSlice } from "./cursor/cursor-provider.js";
import { createGeminiSlice, type GeminiSlice } from "./gemini/gemini-provider.js";
import { createGrokSlice, type GrokSlice } from "./grok/grok-provider.js";
import { createKimiSlice, type KimiSlice } from "./kimi/kimi-provider.js";
import { type ProviderCatalog, providerCatalogsOf } from "./agent/provider-registry.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history/history.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { type ManagedProcesses, createManagedProcesses } from "./processes/managed-processes.js";
import { createPreviewRouteEnsurer } from "./panels/preview-route.js";
import { type PushStore, filePushStore } from "./push/push-store.js";
import { createPushSender, type PushSender } from "./push/push.js";
import { type PortForwards, createPortForwards } from "./ports/port-forwards.js";
import { type ListeningPort, scanListeningPorts, withOwningSessions } from "./ports/port-scan.js";
import {
    createRecentSessions,
    listWorkspaceSessions,
    readWorkspaceSession,
    searchWorkspaceSessions,
    type SessionSummary,
    workspaceSessionExists,
} from "./sessions/sessions.js";
import { readSessionLines, spokenLinesOf, transcriptSearchMetrics } from "./sessions/transcript-search.js";
import { fileThreadSessionsStore, type ThreadSessionsStore } from "./sessions/thread-sessions.js";
import { openSearchIndex, type SearchIndex } from "./sessions/search-index.js";
import { backfillSearchIndex, type BackfillSource } from "./sessions/search-backfill.js";
import { agentTranscript, type AgentTranscriptDeps, spokenTranscript, storedTranscript, type TranscriptAgent } from "./sessions/agent-transcript.js";
import { fileTranscriptRecord } from "./sessions/transcript-record.js";
import { fileShareStore, type ShareStore } from "./share/share-store.js";
import { createSpeech, type Speech } from "./speech/transcribe.js";
import { purgeConversationState } from "./sessions/conversation-purge.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { type RuleFiringsStore, fileRuleFiringsStore } from "./rules/rule-firings.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { onTurnSettled, turnRunOf } from "./agent/turn-runs.js";
import { clearTurnTaint } from "./guard/turn-taint.js";
import { type Announcer, createAnnouncer } from "./platform/announce.js";
import { type ReachReporter, createReachReporter } from "./platform/reach-report.js";
import { type BootTracker, createBootTracker } from "./platform/boot.js";
import { DAEMON_OWNER } from "./platform/leftovers.js";
import { type PlatformTunnel, startPlatformTunnel } from "./platform/local-tunnel.js";
import { createResourceReaper, type ResourceReaper } from "./platform/reaper.js";
import { createClientLogger, createPerfLogger } from "./logger.js";
import { createPerfTracker, type PerfTracker } from "./platform/perf.js";
import { createTerminalRunner, type TerminalRunner } from "./terminal/terminal-run.js";
import { panePids } from "./terminal/terminal-session.js";
import { version } from "./version.js";
import { type AgentTool, internalTools } from "./agent/agent-tools.js";
import { type UsageStore, fileUsageStore } from "./usage/usage-store.js";
import { extensionIdOf } from "@intentic/extension-manifest";
import { createExtensionBackend, type ExtensionBackend } from "./extensions/backend/backend-supervisor.js";
import { type SecretKeyResolver, vaultExtensionSettingSecrets } from "./extensions/extension-settings.js";
import { installedExtensions } from "./extensions/installed-extensions.js";
import { type WorkspacePaths, workspacePaths } from "./workspace/workspace.js";
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
    writeWorkspaceFileStream,
} from "./workspace/workspace-files.js";
import { listWorkspaceChildren, walkWorkspaceTree } from "./workspace/workspace-tree.js";
import type { WorkspaceScopeDeps } from "./workspace/workspace-scope.js";
import { statePath } from "./workspace/state-paths.js";
import { createDependencyCoordinator, type DependencyCoordinator } from "./workspace/reconcile-deps.js";

/* The daemon's collaborators, wired once at boot and handed to the route factories, the injection seam the
 * route tests build fakes against (the equivalent of the old createDaemon `deps` object). Stateful members
 * (appProcesses, the agent/intentic process runners, the credential/tool stores) live here; the in-memory
 * plan/question bridge stays a module singleton in agent-requests.ts (the agent routes call it directly).
 *
 * WHAT A MODULE SHOULD TAKE OF IT. This type is the composition root's, not every consumer's. A module that
 * reads a few seams declares those and nothing else, `export type PortsRoutesDeps = Pick<Services, "config" |
 * "portForwards" | ...>`, because the surface a module depends on is the surface a test has to stand up, and
 * the surface a change somewhere else can reach it through. Twenty-two of the daemon's route modules and their
 * leaf stores are written that way, and their tests build three or four seams instead of a hundred and thirty.
 *
 * The exception is real and is the reason the rest still take `Services` whole: a module that ORCHESTRATES the
 * daemon, the agent turn, the land pass, the capability handlers, the workspace routes, hands `services`
 * onward to machinery that legitimately reaches most of it. A `Pick` of forty members there would be a
 * transcription of `Services` that goes stale, which is the exact failure this file's fakes used to have. Take
 * the whole thing where you pass the whole thing on; name what you use where you use a few. */
/* The daemon's whole wiring, one interface. The per-provider members arrive by EXTENSION: each provider
 * directory declares the slice of Services it contributes (its stores, catalogs, gates and runtime entry
 * point) beside the code that implements them, and composition merely spreads the slices in. Adding a
 * provider therefore adds an `extends` clause and a spread here, never a block of members whose docs live a
 * package away from their owners (agent/provider-module.ts is the seam). */
export interface Services extends ClaudeSlice, CodexSlice, CursorSlice, GrokSlice, GeminiSlice, KimiSlice {
    readonly config: Config;
    readonly logger: Logger;
    /* The sink for what the BROWSER reports about itself (logs/client.jsonl), separate from `logger` above
     * because that file's value is that only the daemon writes it. Undefined when there is nowhere to write, and
     * the route then records nothing and says so rather than pretending, see logs/logs.routes.ts `report`. */
    readonly clientLogger: Logger | undefined;
    // Where the daemon's time goes. Every expensive path (git subprocesses, the Changes scan, repo-lock waits,
    // HTTP requests, event fan-out) measures itself through this, so a "the panel felt slow" report has a log
    // line naming the op instead of a stall with no attribution, see platform/perf.ts.
    readonly perf: PerfTracker;
    // Cardinalities of the resident structures whose growth should explain heap growth in the durable resource
    // series. Reading this must stay allocation-light: the sampler calls it every minute on the daemon loop.
    readonly resourceOwners: () => Readonly<Record<string, unknown>>;
    // Where the boot chain is. main.ts declares its steps and drives it; app.ts gates every data route on its
    // `converged` promise, and /events streams its progress so the browser can WAIT VISIBLY instead of firing
    // a workspace's worth of reads at a daemon that will only park them (see platform/boot.ts).
    readonly boot: BootTracker;
    // The promises this daemon makes to itself, checked while it runs, one companion per subsystem, reported
    // and never thrown (see invariants/invariants.ts). main.ts drives the moments; nothing else reads it except
    // the diagnostics surface and the tests.
    readonly invariants: InvariantRegistry;
    // The platform registration, same split as `boot`: main starts/stops it, /health reports its state, the
    // one setup link nothing outside the container can probe (see platform/announce.ts).
    readonly announcer: Announcer;
    // Whether this sandbox's PUBLIC address actually answers, established by the box probing itself and
    // reported to the platform (see platform/reach-report.ts). The announce's missing other half: registering
    // proves the daemon started, this proves somebody can reach it.
    readonly reach: ReachReporter;
    readonly workspace: WorkspacePaths;
    // Per-repository operator panels: the in-memory process manager the /panels routes and the preview proxy
    // drive (discovery of which repo has a panel is convention-only, see panels/panels.ts).
    readonly processes: ManagedProcesses;
    // The single owner of dependency status, durable setup requests, watcher reconciliation and installs.
    readonly dependencies: DependencyCoordinator;
    // The extension backend host's supervisor: one separate node process running every enabled extension's
    // `server` bundle, proxied under /x/<id>/ and restarted on any change to the enabled set or a workspace
    // extension's files (see extensions/backend/backend-supervisor.ts).
    readonly extensionBackend: ExtensionBackend;
    // The forwarded-port slot table the /ports routes drive and the preview proxy resolves port-<slot> hosts
    // against (see ports/port-forwards.ts).
    readonly portForwards: PortForwards;
    // Discovers every listening TCP socket via procfs, each traced back to the terminal it runs in, the
    // discovery seam behind both the Ports view and a repo's answering dev servers.
    readonly scanPorts: () => Promise<ListeningPort[]>;
    // Runs user-triggered shell commands inside visible job-* tmux sessions (window per command), the
    // surfacing substrate for capability adds and the infra check (see terminal-run.ts for the principle).
    readonly terminalRun: TerminalRunner;
    // A per-boot secret injected into every panel process (INTENTIC_PANEL_TOKEN) so a panel's own backend can
    // call the daemon from inside the sandbox without the browser's Google token. Never leaves the container.
    // One-shot tickets the WebSocket upgrades redeem, so a bearer never rides a query string (auth/ws-tickets.ts).
    readonly wsTickets: WsTickets;
    // Path-scoped tickets /workspace/media accepts, for the one route the browser cannot header-authenticate:
    // a <video>/<audio> element fetching its own byte ranges (auth/media-tickets.ts).
    readonly mediaTickets: MediaTickets;
    readonly panelToken: string;
    // A per-boot secret the in-container `vpn` and `otp` CLIs present (x-intentic-agent), written to a 0600
    // file at AGENT_TOKEN_PATH so the agent's shell and the owner's terminals can both read it. UNLIKE
    // panelToken it is scoped hard (agentReach in auth/grants.ts): the agent may dial and drop the owner's
    // tunnels and mint expiring one-time codes, never read the credentials behind them. Never leaves the container.
    readonly agentToken: string;
    // A per-boot secret the AGENT's host tools carry (as their MCP bearer) to reach /mcp/hosts/:id, the door
    // onto a connected computer of the user's. Deliberately NOT the machine's own enrollment token: that one
    // lives on /history where the agent cannot read it, and this one dies with the daemon and works only from
    // inside the container. What it opens is still bounded by the scopes that machine enforces (hosts/).
    readonly hostBridgeToken: string;
    // The user's own computers: enrollment (a durable per-machine token, digests on /history) …
    readonly hosts: HostsStore;
    // … and who is actually holding a socket right now, with the JSON-RPC correlation over it.
    readonly hostHub: HostHub;
    // Owner-minted, hashed, revocable tokens for anything driving this sandbox from outside the browser, the
    // ACP editor bridge today (x-intentic-control header). Each carries the scope it was minted with; what a
    // scope reaches is auth/control-tokens.ts. Persisted in /work/.intentic like owner/members.
    readonly controlTokens: ControlTokens;
    // This sandbox's identity for the platform's Connections card; undefined ⇒ /info returns {} (loopback/test).
    readonly info:
        | {
              readonly name: string;
              readonly image: string;
              readonly version: string;
              // The release channel this sandbox follows and the image it would roll back to, both runner-set
              // container env (see env.config.ts). Absent when this sandbox predates channels, or has never
              // been swapped, in which case the Update card offers no rollback.
              readonly channel?: string;
              readonly previousImage?: string;
          }
        | undefined;
    // Intent-declared internal MCP tools (constant for the sandbox), merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest (.intentic/config/capabilities.json). DevOps/mcp/service/integration. Reads also
    // carry the daemon-provisioned free-trial endpoint when the platform serves one (trial/trial-endpoint.ts);
    // it is never written to the file.
    readonly capabilities: CapabilitiesStore;
    // Moves any credential still sitting in the READABLE manifest into the vault, answering the ids it moved.
    // A boot step (main.ts), and an invariant rather than a one-time conversion, the manifest is a file the
    // agent may edit, so a real value can arrive in it at any time (capabilities/capabilities-store.ts).
    readonly vaultManifestSecrets: () => Promise<readonly string[]>;
    /* The same vault, for the same reason, one table over: values of `contributes.settings` entries an extension
     * declared `secret: true`. Held as the store rather than behind a function because three call sites read
     * settings and each needs rehydration (extension-settings.ts owns what that means). */
    readonly extensionSecretVault: SecretVault;
    // The settings twin of vaultManifestSecrets, a boot step, and an invariant for the same reason: the tracked
    // settings file is one the agent may edit, so a real token can arrive in it at any time.
    readonly vaultExtensionSettingSecrets: () => Promise<readonly string[]>;
    // Every credential this sandbox stores under its stable name, the capability vault, the DevOps .env and
    // the deploy engine's generated values, read by the agent's masking (values → `{{secret:name}}`) and by
    // the two exits that resolve the same reference back (secrets/secret-registry.ts).
    readonly secretRegistry: () => Promise<readonly NamedSecret[]>;
    // The use ledger those exits feed, one row per resolved reference or typed field, joined onto the
    // secrets inventory as each entry's "last used" (secrets/secret-uses.ts).
    readonly secretUses: SecretUsesStore;
    // The wallet's payment record, one row per attempt that reached policy, opened before any signature is
    // asked for and settled after the endpoint answers; the daily-cap arithmetic reads it (wallet/wallet-ledger.ts).
    readonly walletLedger: WalletLedgerStore;
    // Whether this sandbox can chat before any AI account is connected, and how much of today's allowance is
    // left. Answered by the platform, so a sandbox with no platform never has one.
    readonly trial: TrialService;
    // The loopback TLS terminator for a dev platform (platform/local-tunnel.ts). Read wherever the trial's
    // platform address is written down: the trial capability and the translator's static routing entry, and
    // awaited (`ready`) by the translator's config render so the baked address is deterministic, not a race
    // against the loopback bind.
    readonly platformTunnel: PlatformTunnel;
    // Recommendations the owner has declined (.intentic/config/capability-dismissals.json), so a "no" survives the
    // page load that would otherwise re-derive the same suggestion straight back onto the catalog.
    readonly capabilityDismissals: DismissalsStore;
    // The named personas this sandbox shows the outside world (.intentic/config/personas.json), which connected
    // accounts each speaks for. The turn path reads it to decide what a wake may act through.
    readonly personas: PersonasStore;
    // Scheduled agent wake-ups (.intentic/config/automations.json), the scheduler polls it; /automations edits it.
    // Their run history is the untracked ledger beside it (.intentic/records/automation-runs.json), joined on read so
    // that nothing above this store knows the two are separate files.
    readonly automations: AutomationsStore;
    // Ralph loops (.intentic/records/loops.json): the pump drives them, /loops starts and stops them, and the record is
    // its own restart journal, a loop still marked `running` at boot is one the daemon died under.
    readonly loops: LoopsStore;
    // Saved loops (.intentic/config/loop-designs.json): the manifest half of the same feature, a loop's machinery with
    // its goal left out, so the composer can arm one and the message supplies the job.
    readonly loopDesigns: LoopDesignsStore;
    // Workflow designs (.intentic/config/workflows.json): a manifest the user authors and edits, changing at human
    // speed. /workflows edits it; nothing fires it on its own.
    readonly workflows: WorkflowsStore;
    // Workflow runs (.intentic/records/workflow-runs.json): the ledger the scheduler writes several times per step.
    // Kept out of the manifest so a run's writes cannot rewrite the user's designs, and so a run of a deleted
    // workflow stays readable, it snapshotted its definition. Its own restart journal, like the loops one.
    readonly workflowRuns: WorkflowRunsStore;
    // Maintenance evidence (.intentic/records/chores/): the probe cache the background runner fills, and the ledger of
    // what has been done about it. /chores reads both; @intentic/sandbox-contract/chores turns them into verdicts, in the
    // browser, where the panel and the rail badge share one computation.
    readonly chores: ChoresStore;
    // The background sweep that keeps the probe cache from expiring. Serialized across the whole sandbox and
    // skipped entirely while any turn is live, maintenance is the least urgent thing this daemon does.
    readonly probeRunner: ProbeRunner;
    // CI state (.intentic/secrets/ci.json): the webhook secret + the per repo+branch conclusion memory that makes a
    // success after a failure read as `pipeline_fixed`.
    readonly ciStore: CiStore;
    // The dependency verifier's memory (.intentic/records/verify.json): last check verdict per project + consecutive
    // red count, what makes `deps.fixed` an edge and lets a fix chore's guard cap its own retries.
    readonly verifyStore: VerifyStore;
    // The Pipelines view's read model: webhook deliveries freshen it, /ci/runs backfills it when stale.
    readonly ciRuns: RunsCache;
    // Keeps every mapped repo's provider webhook pointing at this sandbox; its warnings ride /ci/runs.
    readonly ciHooks: CiHookReconciler;
    // Wakes from `requireApproval` automations, held for the owner (.intentic/records/approvals/, one file per wake),
    // the /automations pending routes approve (run the held wake) or reject them.
    readonly approvals: ApprovalsStore;
    // Which sandbox conversation each inbound THREAD owns (.intentic/records/thread-sessions.json), a Front Desk
    // visitor's chat, a Discord or Slack channel. What makes a stream of messages one agent that remembers
    // instead of one fresh worktree per message; a thread past its TTL starts over.
    readonly threadSessions: ThreadSessionsStore;
    // Agent-proposed post drafts (.intentic/config/drafts/, one file per draft), the agent writes them; /drafts is
    // the owner's approve/edit/reject side.
    readonly drafts: DraftsStore;
    // What is in flight right now (historyRoot/turns/, one file per in-flight turn or automation fire). Written
    // at the turn's start, cleared when it settles, so whatever is still there at boot is exactly what the
    // daemon died under, which is what turn-resume re-runs. On the HISTORY volume: it holds full prompts, and
    // it must outlive the container recreates (rebuild, update, dev-sandbox.sh swap) that cause the deaths.
    readonly turnJournal: TurnJournal;
    // What each conversation message can be put back to (historyRoot/turn-anchors.json), a workspace
    // checkpoint for a main-tree turn, that conversation's own per-repo commits for an isolated one. Written at
    // every turn's start, read by the rewind route, by a fork asking for the files as they were, and by a
    // transcript being read back, see agent/turn-anchors.ts for why this is a map and not the commit.
    readonly turnAnchors: TurnAnchors;
    // The activity audit log (historyRoot/activity.jsonl, outside the agent's reach): inbound wakes,
    // sniffed outbound provider calls, voice sessions, failures. /activity reads it; only the daemon appends.
    readonly activity: ActivityStore;
    // The durable spend ledger (historyRoot/usage.jsonl, outside the agent's reach): one row per attributed
    // turn, NEVER pruned, unlike the activity log, whose rolling window makes spend totals shrink over time.
    // streamAgent appends at turn end; /usage/rollup and /system/usage project it.
    readonly usage: UsageStore;
    // Per-sandbox agent settings (.intentic/config/settings.json): /settings edits it; streamAgent reads it to gate
    // per-turn agent behavior (iq plugin, hashline tools, output cleaning, prompt stability) and it carries the
    // owner's rule table (rules/rules.ts).
    readonly sandboxSettings: SandboxSettingsStore;
    // When each rule last did something (.intentic/local/rule-firings.json). Beside the settings rather than in them:
    // a firing is not an edit, so it must not make every push a write of the owner's configuration.
    readonly ruleFirings: RuleFiringsStore;
    // Push state: this sandbox's VAPID keypair + one channel per registered device (browsers over web push,
    // native installs through the platform relay). On the HISTORY volume, outside the agent's reach, because
    // the private key and the relay secrets can forge notifications to the owner's devices.
    readonly push: PushStore;
    // Sends those notifications. `notifyIfAway` (the turn/approval triggers) is suppressed while anyone is
    // actively watching; `notify` (the settings test button) always fires.
    readonly pushSender: PushSender;
    // The latest plan-limit snapshot per account of ANY provider (historyRoot/account-usage.json). streamAgent
    // records what a Claude turn's stream reports and the translator client records what it pulls for the
    // routed subscriptions; /claude/accounts and /translator/accounts each merge it into their own rows, so
    // every account the user can see reports its headroom from one place.
    readonly accountUsage: AccountUsageStore;
    // The last time each PROVIDER refused a turn outright (historyRoot/provider-refusals.json), a spent plan or
    // a credential the API would not take. The observed counterpart to the polled snapshot above: streamAgent
    // records it from the turn that was refused, and /agent/refusals serves it to the account surfaces, which
    // read the two together (a healthy meter beside a fresh refusal means the meter is stale).
    readonly providerRefusals: ProviderRefusalStore;
    // Every native provider's live model catalog, keyed by provider, what /providers/{provider}/models serves
    // the picker, what the quick model compares over, and what a routed turn validates its pick against.
    // ASSEMBLED from the provider modules (agent/provider-registry.ts), so those readers do a lookup instead
    // of each keeping its own enumeration of the providers.
    readonly providerCatalogs: Record<NativeProvider, ProviderCatalog>;
    // What each `endpoint` capability's own server publishes, the user's model APIs, wherever they run. Keyed by
    // capability id because these are user-created and unbounded, unlike the fixed native catalogs above, and
    // there is no seed floor: only the server can say what it serves. Read by the picker route, by the capability
    // card, and by the translator reconciler that turns each one into a routable provider.
    readonly endpointModels: EndpointCatalog;
    // The bundled translator (CLIProxyAPI): connects/lists/disconnects the routed providers' SUBSCRIPTION OAuth
    // (codex → ChatGPT, grok → SuperGrok, kimi → Kimi Code, gemini → Google). Codex, Kimi and Gemini have no
    // other credential. /translator drives the connect; streamAgent reads `accounts` to gate a routed turn.
    readonly cliProxy: CliProxyClient;
    // The shared OpenCode runtime backing the Grok provider: the warm server/client plus xAI OAuth
    // connect/disconnect. OpenCode owns the xAI credential, so there's no GrokStore twin.
    readonly openCode: OpenCodeService;
    // The AI-provider credential root (also OpenCode's XDG_DATA_HOME), the delegation note points the
    // agent's `opencode run` commands at it.
    readonly authRoot: string;
    // Daemon-owned workspace snapshots on /history (outside the agent's reach): auto-captured per turn + on an
    // interval, diffed and restored through the /history routes.
    readonly history: WorkspaceHistory;
    /* The Claude Code loop, the one adapter that is NOT a provider slice's: it serves native Claude turns,
     * Kimi (which has no runtime of its own), every routed provider under the claude-code harness, and every
     * endpoint capability, so no single provider may own it. The other native runtimes' entry points arrive
     * through the slices this interface extends (see the provider modules). */
    readonly agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    // The generic ACP adapter serving every `agent`-kind capability (any provider id outside NATIVE_PROVIDERS);
    // streamAgent resolves the capability and passes it in. The pool keeps one warm subprocess per agent.
    readonly acpAgent: (id: string, config: AcpAgentConfig, request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly acpConnections: AcpConnections;
    // The Pi adapter serving the reserved `pi` agent-kind capability over Pi's RPC protocol, one process per
    // turn, sessions persisted as files under `<authRoot>/pi/sessions` (see pi/pi-agent.ts).
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
        // The unabbreviated HEAD sha, the form a sha-pinned capability config stores (extension revert).
        readonly fullHead: (dir: string) => Promise<string>;
        readonly sync: (dir: string) => Promise<GitSyncResult>;
        // The Changes review verbs (git/changes.ts): working-tree status split into the index and worktree sides,
        // the index moves, the two whole-repo commit shapes, per-path discard, and the per-side file diffs.
        // `head` rides along because the status read already carries it: the scan's other readers (attribution)
        // take it as an argument rather than spawning `rev-parse HEAD` for the answer it just had.
        readonly changedFiles: (
            dir: string,
        ) => Promise<{ branch?: string; head?: string; conflicted: GitChange[]; staged: GitChange[]; unstaged: GitChange[] }>;
        readonly stagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
        readonly unstagePaths: (dir: string, paths: readonly string[]) => Promise<void>;
        readonly commitIndex: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly discardPaths: (dir: string, paths?: readonly string[]) => Promise<void>;
        // Branches (git/branches.ts) and the remote (git/remote.ts). The remote verbs return an ActionResult
        // because "no remote"/"no upstream"/"won't fast-forward" are ordinary outcomes, not exceptions.
        readonly listBranches: (dir: string) => Promise<GitBranch[]>;
        // Remote-tracking branches, so the switcher can pair `main` with `origin/main` instead of listing them
        // as unrelated peers.
        readonly listRemoteBranches: (dir: string) => Promise<GitRemoteBranch[]>;
        readonly createBranch: (dir: string, name: string, start: string | undefined, checkout: boolean) => Promise<void>;
        readonly deleteBranch: (dir: string, name: string, force: boolean) => Promise<void>;
        // `known.branch` lets a caller that already holds the checked-out branch (the Changes scan reads it
        // off the same status pass that produced the rows) spare the spawn that would re-derive it.
        readonly remoteState: (dir: string, known?: { readonly branch?: string | undefined }) => Promise<GitRemoteState>;
        readonly fetchRemote: (dir: string) => Promise<ActionResult>;
        readonly pullRemote: (dir: string) => Promise<ActionResult>;
        readonly pushBranch: (dir: string, options: { branch?: string }) => Promise<ActionResult>;
        // Where the repo is online (host + `owner/name`), so a workspace repo can be recognised in a list of
        // project ids that came from somewhere else, the publisher claim matches the registry's list this way.
        readonly remoteProjectOf: (dir: string) => Promise<{ host: string; project: string } | undefined>;
        /* One file onto the default branch and out to the remote, in a single step whose answer says how far it
         * got. `write` is passed in by the router, which owns path resolution; everything else, the mid-sequence
         * and wrong-branch refusals, committing that path ALONE so a staged index survives, is in publish-file.ts. */
        readonly publishFile: (
            dir: string,
            file: { path: string; content: string; message: string },
            write: (content: string) => Promise<void>,
        ) => Promise<GitPublishFileResult>;
        // The working tree's two diffs, one per side the Changes panel lists, a partially staged file has two
        // of them, and HEAD↔worktree is neither. `fileDiff`'s `ref` is the before side for the AGENTS review,
        // whose worktree has no index to split (a conversation's recorded base sha); `refFileDiff` is that same
        // row for an ARCHIVED agent, whose retired checkout leaves both sides as refs in the main repo.
        readonly stagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly unstagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly conflictedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly fileDiff: (dir: string, path: string, ref: string) => Promise<FileDiff>;
        readonly refFileDiff: (dir: string, path: string, base: string, tip: string) => Promise<FileDiff>;
        // The git-history graph (read-only): one repo's commit log across all refs, and lazy per-commit detail
        // (changed files, then a file's before/after AT the commit).
        readonly commitLog: (dir: string, limit: number, skip?: number) => Promise<{ branch?: string; commits: GitCommit[]; hasMore: boolean }>;
        // What one repo contributes to an AI-drafted commit message: its recent subjects (the house style), the
        // file list, and the diff of whichever side the commit will record, a commit that stages first reads
        // the worktree (`all`, or just the `paths` it will stage), a bare one reads the index.
        readonly collectRepoDiff: (repo: string, dir: string, scope: CommitScope) => Promise<RepoDiff>;
        readonly commitChanges: (dir: string, sha: string) => Promise<GitChange[]>;
        readonly commitFileDiff: (dir: string, sha: string, path: string) => Promise<FileDiff>;
        // The halted-operation pair. Never something this daemon's own verbs leave behind (they abort
        // themselves), this is for what a terminal left: an agent's `git rebase` that stopped on a conflict.
        readonly operationInProgress: (dir: string) => Promise<GitOperation | undefined>;
        readonly abortOperation: (dir: string, operation: GitOperation) => Promise<void>;
        /* The stash, the one part of a repository's real state nothing here used to read, so a `git stash` in a
         * terminal made the work invisible. An entry is a commit, which is why it reads like one. */
        readonly stashList: (dir: string) => Promise<StashEntry[]>;
        readonly stashChanges: (dir: string, ref: string) => Promise<GitChange[]>;
        readonly stashPush: (
            dir: string,
            options: { message?: string; includeUntracked?: boolean },
        ) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashApply: (dir: string, ref: string, pop: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashDrop: (dir: string, ref: string) => Promise<void>;
        // Walking the current branch back off its own reflog, the ref-level complement to a checkpoint restore.
        readonly undoableAction: (dir: string) => Promise<UndoableAction | undefined>;
        readonly undoLastAction: (
            dir: string,
            expectedPreviousSha: string,
            discardChanges: boolean,
        ) => Promise<{ ok: true; action: UndoableAction } | { ok: false; reason: string }>;
        // Graph write actions (VSCode "Git Graph" parity). Non-destructive refs (branch/tag) and the
        // HEAD-movers (checkout/reset) return void + propagate git errors; the sequence ops return an
        // ActionResult so a conflict is a value. The route auto-checkpoints every destructive one.
        readonly createBranchAt: (dir: string, name: string, sha: string) => Promise<void>;
        readonly createTagAt: (dir: string, name: string, sha: string) => Promise<void>;
        // The other two things one does with a tag, so a tag pill is not a create-only affordance.
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
    // The fleet registry (persisted at historyRoot/agents.json + runtime turn state), one entry per isolated
    // conversation. streamAgent begins/observes/finishes turns; /agents lists, lands, and discards.
    readonly agents: AgentsRegistry;
    // The per-conversation worktree compositions on /history/worktrees (create/repair/remove/prune).
    readonly agentWorktrees: AgentWorktrees;
    // Everything a stopped conversation still holds, its processes, terminals, browsers, temp state, reclaimed
    // on the conversation's own stop clock. main starts it (container role only); archive/discard call its hard
    // stop (see platform/reaper.ts for the whole policy).
    readonly reaper: ResourceReaper;
    // Which copy of the workspace a file read means, the shared tree, or one conversation's checkout (see
    // workspace/workspace-scope.ts). Composed once here because the two surfaces that serve files ask the same
    // question: the oRPC workspace routes, and the raw/media byte routes in app.ts.
    readonly workspaceScope: WorkspaceScopeDeps;
    // Builds an isolated turn's mount namespace, where the conversation's worktree stands in for the
    // workspace root. Probes the container's capability once and reports "unavailable" forever after when it
    // has none, so a sandbox launched without CAP_SYS_ADMIN keeps running turns the old way.
    readonly turnIsolation: TurnIsolation;
    // Which agent an uncommitted main-tree file came from, derived from the landed shas (agents/origins.ts).
    readonly agentOrigins: AgentOrigins;
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        // One bounded window of a file's text, for the route the browser reads through, see
        // readWorkspaceFileWindow. `read` above stays for the daemon's own already-bounded readers.
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
    readonly workspaceChildren: (root: string, relPath: string) => Promise<WorkspaceChildren>;
    // Resident workspace search: one iq engine instance holding the index DB open with its sweep cached in
    // memory: /workspace/search runs in-process (no per-query CLI spawn), revalidation rides the workspace
    // watcher (main.ts) instead of the query path. The agent's Bash `iq` calls share the same on-disk index.
    // Indexing itself runs on the engine's own worker thread; only queries touch this one.
    readonly iq: ResidentEngine;
    readonly sessions: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<RestoredMessage[]>;
        // No `dir`, unlike its neighbours: a search reads the phrase index and a listing bound to this
        // workspace's root, both of which the daemon built once. A parameter the implementation is free to
        // ignore is a trap for the next caller who passes something else and is quietly obeyed.
        readonly search: (query: string, caseSensitive: boolean) => Promise<SessionSummary[]>;
        readonly exists: (dir: string, id: string) => Promise<boolean>;
    };
    /* A CONVERSATION's transcript, as opposed to a SESSION's, keyed by conversationId, which is the identity
     * that survives everything a session id does not (an archive, a worktree retired, a runtime swapped, a
     * provider with no session store at all). Written by every settled turn, read by /agents/:id/transcript.
     * See sessions/transcript-record.ts for why this stopped being the provider's job. */
    readonly transcripts: {
        readonly read: (agent: TranscriptAgent) => Promise<RestoredMessage[]>;
        // Opens/adopts the durable record before the provider starts the next turn. Settlement must never be
        // the first time a provider store is read (see transcript-record.ts).
        readonly open: (agent: TranscriptAgent) => Promise<void>;
        // Opens a BRANCH's record instead, as a copy of the first `keep` rows of the conversation it was cut
        // from. Same no-op-if-already-opened rule as `open`.
        readonly fork: (agent: TranscriptAgent, source: string, keep: number) => Promise<void>;
        readonly append: (agent: TranscriptAgent, messages: readonly RestoredMessage[]) => Promise<void>;
        // How many messages are stored, the position the next turn starts at, which its checkpoint is filed
        // under so a rewind can address it (see transcript-record.ts).
        readonly count: (agent: TranscriptAgent) => Promise<number>;
        // Drop everything after the message a rewind went back to; returns how many went.
        readonly truncate: (agent: TranscriptAgent, keep: number) => Promise<number>;
    };
    /* WHAT WAS SAID, INDEXED, the substrate both phrase searches answer from: the fleet filter over the board
     * and the archive (/agents/search) and the chat-history box (/sessions?query=). On disk, written forward as
     * turns settle, so a query reads an index and never a transcript. See sessions/search-index.ts for the
     * numbers that made this durable rather than a heap cache built on the query path. */
    readonly saidIndex: {
        /* One query, one round trip: which sources said this and the line that proves it.
         *
         * Async at this seam though the index itself answers synchronously (it is one SQL statement). The seam
         * is what a test harness substitutes, and a harness has to read the fake transcripts it was given
         * before it can answer; forcing that to be synchronous is how a double ends up diverging from the
         * thing it stands for. One microtask on a path that used to take seconds. */
        readonly search: (...args: Parameters<SearchIndex["search"]>) => Promise<ReturnType<SearchIndex["search"]>>;
        // Bring the index level with the stores. Detached at boot and after an archive sweep; a no-op once
        // there is nothing behind.
        readonly backfill: (signal?: AbortSignal) => Promise<void>;
        /* Whether a backfill is running right now, which is the same question as "can this answer still grow".
         * Both search routes report it, so a screen showing a partial list can say that it is partial instead
         * of implying it is everything. */
        readonly indexing: () => boolean;
    };
    /* Which conversations have been published as pages anyone with the link can read (historyRoot/shares.json).
     * The index only, the pages themselves live in the workspace's outbox. See share/share-store.ts. */
    readonly shares: ShareStore;
    // The composer's voice input: whisper.cpp over browser-recorded WAV utterances, with the serialized run
    // queue and the first-use model download that make it stateful (see speech/transcribe.ts).
    readonly speech: Speech;
    readonly purgeConversationState: NonNullable<AgentArchiveDeps["purgeConversationState"]>;
    // Attaches a batch of share names (`preview-<panel>` / `port-<slot>` labels) to this box's own account on
    // the tunnel fabric before the hostnames reach a browser; never rejects (see panels/preview-route.ts).
    readonly ensurePreviewRoutes: (labels: readonly string[]) => Promise<void>;
    // Shared-access grants, the emails authorized besides the owner. Always present; the /members routes read
    // and write it, and the authorizer consults it. The daemon is the enforcer; the platform only mirrors these.
    readonly members: MembersStore;
    // When set, the daemon is exposed directly and verifies the caller's bearer (a daemon-minted session, or a
    // Google ID token) on every route but /health; CORS is emitted for `allowOrigins`. Undefined ⇒ loopback mode
    // (tests / host-internal preview). authorizeOwner gates the owner-only member-management routes; mintSession
    // backs system.session, the Google-verified exchange that makes sessions the steady-state credential.
    readonly auth:
        | {
              readonly authorize: (bearer: string, firstBind: string | undefined) => Promise<Caller>;
              readonly authorizeOwner: (bearer: string) => Promise<void>;
              readonly authorizeRetirement: (bearer: string) => Promise<void>;
              readonly mintSession: (identity: VerifiedIdentity) => Promise<MintedSession>;
              // Re-key the session signer: every browser holding a session for this sandbox is signed out at
              // once (auth/session.ts rotate). Backs the owner-only "sign out everywhere" route.
              readonly rotateSessions: () => Promise<void>;
              readonly disableBrowserAccess: () => Promise<void>;
              readonly connections: AuthConnections;
          }
        | undefined;
}

// Build the production services from config (env). The agent/intentic/git/files/sessions/tree members are the
// real module functions referenced directly (their injectable last arg defaults to the real subprocess/fs).
export const createServices = (config: Config, logger: Logger): Services => {
    const workspace = workspacePaths(config.workspaceRoot);
    // The AI-provider credential root. AGENT_AUTH_DIR points it at a stable dir shared across dev sandboxes so
    // subscription OAuth survives resets; everything else under .intentic (owner/members/capabilities/sessions/…)
    // stays per-workspace. ponytail: sharing OpenCode's XDG dir also shares its session/snapshot storage, and
    // concurrent sandboxes can race a token refresh (recoverable: reconnect once), split auth.json out /
    // per-provider locks if either bites.
    const authRoot = config.agentAuthDir !== "" ? config.agentAuthDir : statePath(workspace.root, ".intentic/secrets/auth/");
    // Hoisted because two services share it: the turn stream records Claude's readings into it, and the
    // translator client both reads and records the routed subscriptions' through the same file.
    const accountUsage = fileAccountUsageStore(join(config.historyRoot, "account-usage.json"));
    const cliProxy = createCliProxyClient({
        managementUrl: cliProxyManagementUrl(config),
        token: config.translator.token,
        configPath: cliProxyConfigPath(config),
        // The credential store the proxy reads, so the connection list survives a proxy that isn't answering,
        // its 15s boot warm-up and every rung of its restart ladder (see listFiles).
        authDir: cliProxyAuthDir(authRoot),
        usageStore: accountUsage,
    });
    /* The OpenCode server and the Gemini slice hold references to EACH OTHER, and the knot is real rather
     * than an ordering accident: OpenCode's spawn config re-serves Gemini's model ids as an OpenAI-compatible
     * backend, and Gemini's runtime is the OpenCode loop. The model read below is lazy (it runs when the
     * server boots, in main's provider boot pass, long after this function returned), so the forward
     * reference is safe — the extensionBackend holder two pages down is the same pattern for the same reason.
     *
     * OpenCode itself stays CORE rather than becoming Grok's: one warm server serves Grok's turns, Gemini's
     * native runtime and the delegation watchers, so no single provider may own it. Its data dir (OpenCode's
     * XDG_DATA_HOME) is the credential root so xAI OAuth tokens persist across restarts. Gemini brings no
     * credential of its own here — the translator holds Google's, exactly as for a routed turn; an unbaked
     * translator (the dev profile) leaves the config absent and the loop serves Grok alone. */
    let gemini!: GeminiSlice;
    const openCode = createOpenCodeService(authRoot, {
        // Where a non-isolated conversation delegates from, and so the one directory whose delegation watcher is
        // worth opening at boot, event streams are per-directory, and a turn registers its own worktree itself.
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
                  // Empty is "not set", never a value to publish: `channel: ""` on the wire reads as a channel
                  // literally named nothing, and a rollback offer pointing at "" is a button that cannot work.
                  ...(config.sandbox.channel !== "" ? { channel: config.sandbox.channel } : {}),
                  ...(config.sandbox.previousImage !== "" ? { previousImage: config.sandbox.previousImage } : {}),
              }
            : undefined;
    const members = fileMembersStore(statePath(workspace.root, ".intentic/identity/members.json"));
    // The session secret lives under historyRoot (like the activity/usage ledgers), daemon-private, outside
    // the workspace, and persistent, so a daemon restart doesn't sign every browser out.
    const sessions = createSessions(join(config.historyRoot, "session-secret"));
    const authConnections = createAuthConnections();
    const browserAccess = fileBrowserAccess(join(config.historyRoot, "browser-access-disabled"));
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
                  session: sessions.verify,
                  owner: fileOwnerStore(statePath(workspace.root, ".intentic/identity/owner.json")),
                  members,
                  browserAccess,
                  ...(config.connectToken !== "" ? { connectToken: config.connectToken } : {}),
                  ...(config.owner.email !== "" ? { expectedOwner: config.owner.email } : {}),
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

    /* The provider slices: each provider directory builds its own Services members (agent/provider-module.ts
     * is the seam), and this function's whole part in it is these calls and the spreads in the literal below.
     * The Gemini slice is built beside OpenCode above, whose knot it is part of. */
    const claude = createClaudeSlice({ config, logger, authRoot, workspaceRoot: workspace.root, accountUsage });
    const codex = createCodexSlice({ config, authRoot });
    const cursor = createCursorSlice({ authRoot, logger });
    const grok = createGrokSlice(openCode);
    const kimi = createKimiSlice(cliProxy);

    // Hoisted: the members below that measure themselves (the worktree op chains, the git routes' Changes scan)
    // must file into the SAME tracker the summary line reads, or each would rank its own slice in isolation.
    // Its per-span slow lines go to logs/perf.jsonl rather than daemon.log (createPerfLogger says why); the
    // ranked summary stays on the main logger, where an incident reader will meet it.
    const perf = createPerfTracker(logger, createPerfLogger(config));

    /* Hoisted for the same reason the perf tracker is: the invariant companions registered at the end of this
     * function observe the very instances built here, and a second journal would let a check read a directory
     * the turn path never writes to, a diagnostic that agrees with itself and with nothing else. */
    const turnJournal = fileTurnJournal(join(config.historyRoot, "turns"));
    const invariants = createInvariantRegistry(logger);

    // Hoisted (not inline in the literal below): the ACP connection pool implements ACP terminal/* over the
    // same runner, so both must share one instance (and its `visible` gate).
    const terminalRun = createTerminalRunner();
    const acpConnections = createAcpConnections(logger, terminalRun);
    const processes = createManagedProcesses();
    const dependencies = createDependencyCoordinator({
        workspace,
        processes,
        logger,
        requestsPath: join(config.historyRoot, "dependency-requests.json"),
    });
    // Hoisted: the store and the sender that reads it must be the same instance, or a subscription added
    // through the routes would be invisible to the next send.
    const pushStore = filePushStore(join(config.historyRoot, "push.json"));
    // Shared by the turn path (which builds a namespace per isolated turn) and worktree creation (which plants
    // mount points rather than symlinks when it knows the namespace is coming), so both read ONE probe.
    const turnIsolation = createTurnIsolation({ root: workspace.root, historyRoot: config.historyRoot, logger });
    // Hoisted ABOVE the registry, which now derives each card's land standing through it (standing.ts) rather
    // than reading a verdict off the entry.
    const agentWorktrees = createAgentWorktrees(
        {
            workspace,
            worktreesRoot: join(config.historyRoot, "worktrees"),
            historyRoot: config.historyRoot,
            isolation: turnIsolation,
            logger,
            perf,
        },
        // Demoted git: a worktree ensure is a whole-monorepo checkout (and several conversations start
        // together), bulk agent-plane IO that must lose to the daemon's own loop under contention.
        politeGit,
    );
    // Hoisted: the Changes scan's per-file attribution reads the SAME registry the turns write to, a
    // second instance would answer from a stale agents.json.
    // The presences are held by name too, because their caches report into the resource series below.
    // ONE expiry tracker for both landing readers (agents/expiry.ts): they ask the identical
    // "what has history touched since this landing" question, so sharing the tracker halves both the
    // per-head-move diff and the memory the answers sit in.
    const landingExpiry = createExpiryTracker();
    const landedPresences = createLandedPresences(agentWorktrees, logger, landingExpiry);
    const agents = createAgentsRegistry(
        fileAgentsStore(join(config.historyRoot, "agents.json")),
        createLandStandings(agentWorktrees),
        landedPresences,
    );
    /* The reaper, keyed to the same three facts everything else keys to: whose work (the workload stamp),
     * whether it is live (the turn registry), and whether it is OURS (this registry knows the conversation).
     * The reserved owners answer for themselves, what the daemon keeps warm on purpose (the ACP/Pi pools, the
     * translator) is live for as long as this daemon is, and a helper one-shot never is. */
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
    /* A settled turn's outside-content bit is dropped with the turn (guard/turn-taint.ts). The bit's LIFETIME
     * is the turn, a page read three tool calls ago still counts, the next turn starts clean, and the
     * registry that publishes it to the daemon's own consult sites has to be told when that moment is. */
    onTurnSettled(clearTurnTaint);
    // Hoisted like the presences above, and for the same reason: the attribution caches report into the
    // resource series, they are the structures whose silent growth was once the daemon's memory leak.
    const agentOrigins = createAgentOrigins({ agents, logger, expiry: landingExpiry });
    // Hoisted: the CI hook reconciler reads the same manifest the routes edit.
    /* The free trial is laid OVER the manifest, never into it (trial/trial-endpoint.ts): the OFFER surfaces:
     * the endpoint catalog, the picker's provider list, the capability card: see the trial as an ordinary
     * endpoint exactly while the platform says one exists, and the file on disk stays what the user put there.
     * The one consumer deliberately NOT fed from this layer is the translator's routing table, which carries
     * the trial's static entry whenever a platform is configured at all (trialCompatEntry): routing must be a
     * constant of configuration, not a function of the probe's timing. Availability is probed on boot below. */
    const trial = createTrialService(config);
    /* And the one thing between the trial and a platform running on the developer's own machine: the bundled
     * translator opens the trial's connection itself and verifies the certificate, which a self-signed dev
     * platform cannot satisfy. Opens nothing at all against a deployed platform (platform/local-tunnel.ts). */
    const platformTunnel = startPlatformTunnel(config.platform.url, logger);
    const capabilityManifest = fileCapabilitiesStore(statePath(workspace.root, ".intentic/config/capabilities.json"), (id, reason) =>
        logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}), the rest of the manifest is unaffected`),
    );
    /* The credential values, off /work (secret-vault.ts). Sited beside the AI-provider logins under
     * AGENT_AUTH_DIR, which is already outside the file routes, the tree walk and the search index. */
    const secretVault = fileSecretVault(join(authRoot, "capability-secrets.json"));
    /* The connector registry this needs to know which of an entry's fields are credentials, resolved against the
     * RAW manifest rather than the vaulted store, enumerating extensions reads capability entries, so pointing
     * it at the decorator would have the decorator call itself. Enumeration only ever looks at an entry's
     * kind/id/path, never at a credential, so the un-rehydrated view is the whole truth it needs. */
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
    /* THE EXTENSION-SETTINGS HALF OF THE SAME SPLIT (extensions/extension-settings.ts). A second vault file
     * rather than rows in the capability one: the two are keyed differently, a capability entry id there, a
     * manifest identity (publisher.name) here, and one namespace holding both would collide the day an
     * extension capability and its own manifest identity share a name, which is the common case.
     *
     * The resolver reads the manifests through the same minimal adapter `secretFieldConnectors` builds, and over
     * `installedExtensions` rather than the enabled ones: a switched-off extension's stored token is exactly as
     * readable as a running one's, so the sweep must reach it. */
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
    const ciStore = fileCiStore(statePath(workspace.root, ".intentic/secrets/ci.json"));
    const verifyStore = fileVerifyStore(statePath(workspace.root, ".intentic/records/verify.json"));
    // Hoisted: the background probe runner writes the same cache the /chores route reads, and a second store
    // instance would answer a poll from a file the runner had already moved past.
    const chores = fileChoresStore(join(workspace.root, PROBES_FILE), join(workspace.root, LEDGER_FILE));
    // Bound once, and against the SAME registry instance above, `sessionIdOf` answers from live turn state as
    // well as the persisted entry, so a second registry would report no session for a first turn still running.
    const turnAnchors = fileTurnAnchors(join(config.historyRoot, "turn-anchors.json"));
    const transcriptDeps: AgentTranscriptDeps = {
        record: fileTranscriptRecord(join(config.historyRoot, "transcripts")),
        turnAnchors,
        root: workspace.root,
        codexHome: codex.codexHome,
        sessionIdOf: agents.sessionIdOf,
        readClaudeSession: readWorkspaceSession,
    };
    /* THE PHRASE INDEX, on the history volume beside the records it is derived from, daemon-private and outside
     * the agent's reach like the journal and the activity ledger. A pure cache: it is deleted and rebuilt on a
     * schema bump, and every line in it can be re-extracted from a record. */
    const saidIndex = openSearchIndex(join(config.historyRoot, "said-index"));
    // One listing of the history menu's window, shared by the search that filters it and the backfill that
    // indexes it, so a keystroke burst costs one stat pass over the session store rather than one per query.
    const recentSessions = createRecentSessions(workspace.root);
    /* The version an indexed conversation is pinned to: its record's byte size, one stat. Append-only plus
     * rewind's truncate, so any change to what the conversation said moves this. `undefined` (no record at all)
     * is a version too, so a conversation that has genuinely said nothing is not re-read on every pass. */
    const recordVersion = async (id: string): Promise<string | undefined> => {
        const size = await transcriptDeps.record.size(id);
        return size === undefined ? undefined : String(size);
    };
    /* Bring the index level with both stores, ONE PASS. The conversation half is the ROSTER's own list, live and
     * archived together, which is exactly the set /agents/search answers over. The session half is the history
     * list's window, which is what /sessions can return, and it prunes: a session that has fallen out of that
     * window can never be answered with, so its rows are dead weight. */
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
                    // The session file's own mtime, which the list already read: a session the SDK appended
                    // to moves it, and nothing else has to be opened to find out.
                    version: async () => String(session.updatedAt),
                    lines: () => readSessionLines(workspace.root, session.id),
                })),
            },
            logger,
            signal,
        );
    };
    /* Reentrancy guard AND the flag both search routes report. Two passes over the same sources at once would
     * race for no gain, and a search taken during either is legitimately partial, which is the thing the board
     * needs told rather than hidden. */
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
    /* A COLD INDEX REBUILD USED TO ANNOUNCE ITSELF NOWHERE, and that silence was the whole bug report.
     *
     * Rebuilding every vector in the workspace is ~30 minutes at four cores. Nothing said so: the machine simply
     * went busy, the index reported a sweep that never completed and a change queue that only grew, and no line
     * in this log connected the three. It reads exactly like a wedged worker, and it cost a full investigation
     * to find out it was working correctly the whole time.
     *
     * Logged at a human cadence, the first slice, every 30s after, and the finish, so the load has a name
     * while it is happening. `backlogActive` is what makes the closing line fire only for a backlog that was
     * actually announced: with no model configured the worker reports 0 forever, and a "complete" for work that
     * never started is noise. */
    const BACKLOG_LOG_MS = 30_000;
    let backlogLoggedAt = 0;
    let backlogActive = false;
    /* The engine runs in a CHILD PROCESS (iq-engine/host), not on this one. Its two worker threads and their
     * ML models were the bulk of this daemon's ~2 GB RSS against ~360 MB of heap, and on a memory-pressured
     * host that put most of a gigabyte of the CONTROL PLANE into swap, the floor under every slow request
     * here, search or not. The interface is unchanged (a ResidentEngine either way), and a child that dies
     * takes only the searches it was holding: the next one brings up a fresh engine. */
    const iq = createEngineClient({
        root: workspace.root,
        indexDir: statePath(workspace.root, ".intentic/local/cache/", "iq"),
        // An index pass that fails once warm() has settled has no caller to reject, without this the index
        // would stop tracking disk and search would just quietly get older.
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
        // The query worker owns the semantic scan and the cross-encoder. Losing it does not fail a search,
        // it silently narrows one to keyword matching, so it has to be visible here.
        onQueryError: (error) => logger.warn({ err: error }, "iq query worker failed, search fell back to keyword matching"),
        ...(config.iqModelDir !== "" ? { modelDir: config.iqModelDir } : {}),
        ...(config.iqRgPath !== "" ? { rgPath: config.iqRgPath } : {}),
    });
    // Named once at boot, because from outside this box the engine is now just one more node child among
    // several, and "which process is holding the gigabyte" is the first question anyone asks of a memory
    // report. Without this line the answer needs `ps` plus a guess.
    // `enginePid`, not `pid`: pino stamps every line with the DAEMON's pid under that name, and a second one
    // made the boot line a JSON object with two `pid` keys, where the last wins, so a log reader was told the
    // daemon lived at the engine's pid.
    logger.info({ enginePid: iq.pid() }, "iq search engine running in its own process");

    /* The backend supervisor enumerates extensions through the finished services object (the same
     * ExtensionHost seam every other consumer uses), which does not exist until the literal below is built,
     * so it takes a thunk bound afterwards. Nothing calls it before main() starts the boot chain. */
    const servicesHolder: { current?: Services } = {};
    const services: Services = {
        config,
        logger,
        // The browser's own reports, in their own file (createClientLogger says why it is not `logger`).
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
        // Born converged, main() declares the chain and closes the gate behind it, so a services object built
        // for a test or the host-internal preview has nothing to wait for.
        boot: createBootTracker(logger),
        announcer: createAnnouncer(config, logger),
        reach: createReachReporter(config, logger),
        workspace,
        processes,
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
        // Slot names are salted with the connect token, so a forwarded port's public hostname can't be guessed
        // from the sandbox id alone (tunnel-ids.ts). The daemon and the platform derive the same eight.
        portForwards: createPortForwards(portSlotsFromToken(config.connectToken)),
        // The pane listing rides along with the scan rather than behind it: both are cheap reads of live state,
        // and a port whose terminal is unknown is a port nobody can do anything about.
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
        hosts: fileHostsStore(config.historyRoot),
        hostHub: createHostHub(logger),
        info,
        tools: internalTools(config.intenticAgentTools),
        capabilities,
        vaultManifestSecrets: () => vaultManifestSecrets(capabilityManifest, secretVault, secretFieldConnectors, onUnvaultable),
        extensionSecretVault,
        vaultExtensionSettingSecrets: async () =>
            vaultExtensionSettingSecrets(workspace.root, extensionSecretVault, await settingSecretKeys(), onUnvaultableSetting),
        secretRegistry: secretRegistryOf(secretVault, () => workspace.repos["desired-state"]),
        secretUses: fileSecretUses(statePath(workspace.root, ".intentic/records/secret-uses.json")),
        walletLedger: fileWalletLedger(statePath(workspace.root, ".intentic/records/wallet-ledger.json")),
        trial,
        platformTunnel,
        capabilityDismissals: fileDismissalsStore(statePath(workspace.root, ".intentic/config/capability-dismissals.json")),
        personas,
        ciStore,
        verifyStore,
        ciRuns: createRunsCache(),
        ciHooks: createCiHookReconciler({ workspace, capabilities, ciStore, config, logger }),
        controlTokens: fileControlTokens(statePath(workspace.root, ".intentic/identity/control-tokens.json")),
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
        approvals: fileApprovalsStore(statePath(workspace.root, ".intentic/records/approvals/")),
        threadSessions: fileThreadSessionsStore(statePath(workspace.root, ".intentic/records/thread-sessions.json")),
        drafts: fileDraftsStore(statePath(workspace.root, ".intentic/config/drafts/")),
        turnJournal,
        invariants,
        // The same instance the transcript reader holds, two would answer a read from a file the other had
        // already moved past, exactly the argument the chores store above makes.
        turnAnchors,
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        usage: fileUsageStore(join(config.historyRoot, "usage.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(statePath(workspace.root, ".intentic/config/settings.json")),
        ruleFirings: fileRuleFiringsStore(statePath(workspace.root, ".intentic/local/rule-firings.json")),
        push: pushStore,
        pushSender: createPushSender(pushStore, logger),
        // The provider slices, whole: their members' docs live on the slice interfaces, beside the code.
        ...claude,
        ...codex,
        ...cursor,
        ...grok,
        ...gemini,
        ...kimi,
        accountUsage,
        providerRefusals: fileProviderRefusalStore(join(config.historyRoot, "provider-refusals.json")),
        // Assembled from the provider modules, LATE-BOUND through the same holder the extension backend uses:
        // the record is a member of the object its thunks read from, and the thunks only run per request.
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
        // Pi sessions sit beside the other AI-provider state under authRoot, so a dev sandbox pointing
        // AGENT_AUTH_DIR at a stable dir keeps its Pi conversations resumable across resets too.
        piAgent: createPiAgent(piSpawner(join(authRoot, "pi", "sessions"))),
        // Bound to the daemon logger so every CLI run's lifecycle (spawn/kill/exit) is attributable from
        // daemon.log, the runs themselves are transient subprocesses whose absence proves nothing.
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
            pushBranch,
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
            // Bound to this daemon's one index: the history box and the fleet board answer from the same rows.
            search: (query, caseSensitive) =>
                searchWorkspaceSessions(recentSessions, query, caseSensitive, async (...args) => saidIndex.search(...args)),
            exists: workspaceSessionExists,
        },
        transcripts: {
            read: (agent) => agentTranscript(transcriptDeps, agent),
            // storedTranscript, not agentTranscript, as the opening adoption: the record is empty by definition
            // at the moment it opens, and what a conversation had before it is exactly what the provider store
            // holds. This runs before the new turn, so that turn cannot be adopted and appended twice.
            open: (agent) => transcriptDeps.record.open(agent.id, () => storedTranscript(transcriptDeps, agent)),
            // No provider-store fallback here, unlike `open`: a branch's opening history is by definition the
            // source conversation's record, and no provider knows this conversation exists yet.
            fork: (agent, source, keep) => transcriptDeps.record.fork(agent.id, source, keep),
            /* THE INDEX IS WRITTEN HERE, on the same call that records the turn, because this is the moment the
             * conversation's words become durable and every road a turn can be started down ends at it (see
             * turn-transcript's recordTurnTranscript). Appending the turn's own lines rather than re-extracting
             * the conversation is what keeps this at ~1.4 ms on the settle path.
             *
             * The index write is best-effort and deliberately AFTER the record's: the record is the truth and
             * must not be held hostage to a cache. An index write that fails leaves the conversation's last turn
             * unsearchable until the next boot's backfill notices the version moved and re-reads it. */
            append: async (agent, messages) => {
                await transcriptDeps.record.append(agent.id, messages);
                try {
                    saidIndex.extend(agent.id, "conversation", (await recordVersion(agent.id)) ?? "none", spokenLinesOf(messages));
                } catch (error) {
                    logger.warn({ err: error, conversationId: agent.id }, "search index: turn not indexed");
                }
            },
            count: (agent) => transcriptDeps.record.count(agent.id),
            /* A rewind is the one thing that SHORTENS a record, so the index cannot be appended to here: it is
             * re-stated whole from what the record now holds. Rare enough (a person clicking back to a turn)
             * that reading one conversation is the right trade against tracking positions in the index. */
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
        // The index goes with the state: a purged conversation's rows would otherwise keep it findable by
        // phrase after everything it said was deleted.
        purgeConversationState: async (removed, retained) => {
            await purgeConversationState(workspace.root, config.historyRoot, removed, retained);
            for (const entry of removed) {
                saidIndex.forget(entry.id);
            }
        },
        ensurePreviewRoutes: createPreviewRouteEnsurer(config, logger),
        members,
        auth,
    };
    servicesHolder.current = services;
    /* Arm the checks over the instances built above. Registration only, nothing runs until main.ts drives a
     * moment, so a composition used by a test or the host-internal preview carries the companions without ever
     * paying for them. The container-claim companion is not here: its subject is the role main.ts learns after
     * this returns (invariants/register.ts). */
    registerDaemonInvariants(invariants, {
        turnJournal,
        agents,
        manifest: capabilityManifest,
        connectors: secretFieldConnectors,
        // The DECORATED store for the exit checks: they read `kind` and a country code, never a credential, so
        // the rehydrating read is the right one and the raw store would only hide vault markers from them.
        capabilities: services.capabilities,
    });
    return services;
};
