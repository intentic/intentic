import { randomBytes } from "node:crypto";
import { queuePrefixFor, queueWhole } from "./agent/tools/agent-terminals.js";
import { join, resolve } from "node:path";
import type { DeviceFacts, DeviceScopes, RunnerFacts, WebExtFacts, WebExtScopes, IntenticLine } from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import {
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
import { capabilityCtx } from "./capabilities/capability.js";
import { openBrowserAccount } from "./capabilities/open-account.js";
import { composeEnvironment } from "./environment/environment.js";
import { judgeCommand } from "./agent/tools/command-judge.js";
import { wakeLocalModel as wakeLocalModelServer } from "./capabilities/handlers/localmodel.handler.js";
import { LOCAL_MODEL_WAKE_MS } from "./endpoints/local-model-idle.js";
import { createInvariantRegistry, type InvariantRegistry } from "./invariants/invariants.js";
import { registerDaemonInvariants } from "./invariants/register.js";
import type { Logger } from "pino";
import { createAcpAgent } from "./runtimes/acp/acp-agent.js";
import { createAcpConnections } from "./runtimes/acp/acp-connection.js";
import { createPiAgent } from "./runtimes/pi/pi-agent.js";
import { piSpawner } from "./runtimes/pi/pi-rpc.js";
import { type ActivityStore, fileActivityStore } from "./activity/activity-store.js";
import { runAgent } from "./agent/run/agent.js";
import { cliProxyAuthDir, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/providers/translator.js";
import { fileHeldWakesStore } from "./automations/held-wakes-store.js";
import { fileSendersStore } from "./automations/senders-store.js";
import { fileAutomationsStore } from "./automations/automations-store.js";
import { fileLoopDesignsStore, fileLoopsStore } from "./loops/loops-store.js";
import { fileWorkflowRunsStore, fileWorkflowsStore } from "./workflows/workflows-store.js";
import { type ChoresStore, fileChoresStore, LEDGER_FILE, PROBES_FILE } from "./chores/chores-store.js";
import { createProbeRunner, type ProbeRunner } from "./chores/probe-runner.js";
import { fileCapabilitiesStore, vaultManifestSecrets, withSecretVault } from "./capabilities/capabilities-store.js";
import { contributionRegistry, invalidatingContributions } from "./capabilities/contributions.js";
import { fileSecretVault } from "./capabilities/credentials/secret-vault.js";
import { secretRegistryOf } from "./secrets/secret-registry.js";
import { fileSecretUses } from "./secrets/secret-uses.js";
import { fileCredentialGates } from "./secrets/credential-gates.js";
import { createCredentialGrants } from "./secrets/credential-grants.js";
import { createCredentialGate } from "./secrets/credential-gate.js";
import { fileWalletLedger, type WalletLedgerStore } from "./wallet/wallet-ledger.js";
import { createTrialService, type TrialService } from "./trial/trial.js";
import { withTrialEndpoint } from "./trial/trial-endpoint.js";
import { fileDismissalsStore } from "./capabilities/offers/dismissals-store.js";
import { filePersonasStore, type PersonasStore } from "./personas/personas-store.js";
import { fileAreasStore, type AreasStore } from "./areas/areas-store.js";
import { fileHeavyCommandsStore } from "./system/resources/heavy-commands.js";
import { createResourceBudget } from "./workload/resource-budget.js";
import { deriveBytes } from "./derived/derived-blob.js";
import { deriveText, readDerivedText } from "./derived/derived-text.js";
import { sidecarStatus } from "./derived/sidecar-service.js";
import { fileCiStore } from "./ci/ci-store.js";
import { fileVerifyStore } from "./workspace/deps/verify-store.js";
import { landCheckOf } from "./conversations/land/verify-landed.js";
import { filePushChecksStore } from "./workspace/deps/push-checks-store.js";
import { createPushChecks } from "./workspace/deps/push-checks.js";
import { createCiHookReconciler } from "./ci/hooks.js";
import { createRunsCache } from "./ci/runs-cache.js";
import { createBrowserRouters } from "./browser/tools/browser-prepare.js";
import type { BrowserRouterFactory } from "./browser/tools/browser-router.js";

import { fileAccountUsageStore } from "./usage/account-usage.js";
import { claudeHeadroomSource } from "./usage/claude-usage.js";
import { createHeadroomService } from "./usage/headroom.js";
import { fileUsageParkStore } from "./usage/usage-parks.js";
import { fileModelCooldownStore } from "./usage/model-cooldowns.js";
import { fileModelRefusalStore } from "./usage/model-refusals.js";
import { fileObservedLimitStore } from "./usage/observed-limits.js";
import { fileProviderRefusalStore } from "./usage/provider-refusals.js";
import { cursorHeadroomSource } from "./runtimes/cursor/cursor-usage.js";
import { type ApprovalsStore, fileApprovalsStore } from "./approvals/approvals-store.js";
import { fileIssuesStore } from "./issues/issues-store.js";
import { fileInstallsStore } from "./store/installs.js";
import { HOST_PEER, type HostAnnounced, type HostClient } from "./hosts/host-peer.js";
import { hostDeviceReach } from "./hosts/self-host.js";
import { ownBrowserReach, WEBEXT_PEER, type WebExtAnnounced, type WebExtClient } from "./webext/webext-peer.js";
import { RUNNER_PEER, type RunnerAnnounced, type RunnerClient } from "./runners/runner-peer.js";
import { createPeerHub } from "./peers/peer-hub.js";
import { filePeerStore } from "./peers/peer-store.js";
import { filePeerTools } from "./peers/peer-tool-memory.js";
import { fetchPresentation, type SandboxPresentation } from "./system/platform-client.js";
import { enrolledFleet, syncPairBurnPath, type SyncMode } from "./hosts/desktop-sync.js";
import { pairings } from "./peers/enrollment.js";
import { sqliteTurnJournal, turnJournalRows } from "./agent/run/turn/turn-journal.js";
import { sqliteWatchJournal } from "./agent/verification/watch-journal.js";
import { sqliteTurnCheckpoints } from "./agent/checkpoints/turn-checkpoints.js";
import { filePromptRecord } from "./agent/prompt/prompt-record.js";
import type { Config } from "./env.config.js";
import { createFleet } from "./conversations/registry/agents-registry.js";
import { sqliteAgentsStore } from "./conversations/registry/agents-store.js";
import { conversationsDbPath, openConversationsDb } from "./store/conversations-db.js";
import { conversationUnits } from "./store/conversation-units.js";
import { createTurnIsolation } from "./conversations/worktrees/isolation.js";
import { createAgentOrigins } from "./conversations/land/origins.js";
import { createExpiryTracker } from "./conversations/registry/expiry.js";
import { createLandedPresences } from "./conversations/land/landed-presence.js";
import { createLandStandings } from "./conversations/land/standing.js";
import { createAgentWorktrees } from "./conversations/worktrees/worktrees.js";
import { changedFiles } from "./git/changes/changes.js";
import {
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
import { keepCodeCounts } from "./git/changes/code-counts.js";
import { scratchOf } from "./git/changes/scratch.js";
import { collectRepoDiff } from "./git/ops/commit-message.js";
import { createBranch, deleteBranch, listBranches, listRemoteBranches } from "./git/ops/branches.js";
import { abortOperation, operationInProgress } from "./git/ops/operation.js";
import { undoableAction, undoLastAction } from "./git/ops/undo.js";
import { stashApply, stashChanges, stashDrop, stashList, stashPush } from "./git/ops/stash.js";
import { fetchRemote, pullRemote, remoteState } from "./git/remote/remote.js";
import { remoteProjectOf } from "./git/remote/remote-urls.js";
import { publishFile } from "./git/ops/publish-file.js";
import { createEndpointCatalog } from "./endpoints/endpoint-catalog.js";
import { createOpenCodeService } from "./runtimes/opencode/opencode.js";
import { createOpenCodeAgent, createOpenCodeRunner } from "./runtimes/opencode/opencode-agent.js";
import { type ClaudeSlice, createClaudeSlice } from "./runtimes/claude/claude-provider.js";
import { type CodexSlice, createCodexSlice } from "./runtimes/codex/codex-provider.js";
import { createCursorSlice, type CursorSlice } from "./runtimes/cursor/cursor-provider.js";
import { OPENCODE_GEMINI_PROVIDER } from "./runtimes/gemini/gemini-models.js";
import { createGeminiSlice, type GeminiSlice } from "./runtimes/gemini/gemini-provider.js";
import type { GrokSlice } from "./runtimes/grok/grok-provider.js";
import { createMintedSlice, type MintedSlice } from "./runtimes/minted/minted-provider.js";
import { createKimiSlice, type KimiSlice } from "./runtimes/kimi/kimi-provider.js";
import { providerCatalogsOf, providerReadiness } from "./agent/providers/provider-registry.js";
import { PROVIDER_MODULES, RUNTIME_ADAPTERS } from "./runtimes/runtime-table.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history/history.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { createManagedProcesses } from "./processes/managed-processes.js";
import { createServiceProcesses } from "./processes/service-processes.js";
import { createPanelUpstreamResolver, type PanelUpstreamResolver } from "./panels/panel-upstream.js";
import { discoverRepos } from "./workspace/layout/repo-discovery.js";
import { type PushStore, filePushStore } from "./push/push-store.js";
import { createPushSender, type PushSender } from "./push/push.js";
import { createPortForwards } from "./ports/port-forwards.js";
import { scanListeningPorts, withOwningSessions } from "./ports/port-scan.js";
import { transcriptSearchMetrics } from "./sessions/transcript-search.js";
import { fileThreadSessionsStore } from "./sessions/thread-sessions.js";
import { fileWebchatOutbox, outboxStreamFor } from "./webchat/webchat-outbox.js";
import { fileShareStore, type ShareStore } from "./share/share-store.js";
import { createSpeech, type Speech } from "./speech/transcribe.js";
import { type SafetyLog, fileSafetyLog } from "./safety/safety-log.js";
import { type SafetyPolicyStore, fileSafetyPolicyStore } from "./safety/safety-policy-store.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { type RuleFiringsStore, fileRuleFiringsStore } from "./rules/rule-firings.js";
import { type DriftSweep, createDriftSweep } from "./environment/drift-sweep.js";
import { type RuntimeInstallsStore, fileRuntimeInstallsStore } from "./environment/runtime-installs.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { cardDeps } from "./conversations/actor/card-offers.js";
import { turnDoors } from "./agent/run/turn/turn-doors.js";
import { streamAgent } from "./agent/run/stream-agent.js";
import { dispatchWorkspaceEvent } from "./automations/workspace-events.js";
import { clearTurnTaint } from "./guard/turn-taint.js";
import { turnAwaiting, turnFinished } from "./push/notifications.js";
import { createDomainEvents, type DomainEvents } from "./seams/domain-events.js";
import { type Announcer, createAnnouncer } from "./system/boot/announce.js";
import { type ReachReporter, createReachReporter } from "./system/listeners/reach-report.js";
import { type BootTracker, createBootTracker } from "./system/boot/boot.js";
import { DAEMON_OWNER } from "./seams/workload-stamp.js";
import { type PlatformTunnel, startPlatformTunnel } from "./system/listeners/local-tunnel.js";
import { createResourceReaper, type ResourceReaper } from "./system/boot/reaper.js";
import { createClientLogger, createPerfLogger, inLogContext } from "./logger.js";
import { createPerfTracker } from "./system/resources/perf.js";
import { createLiveMetrics } from "./system/resources/live-metrics.js";
import { createTerminalRunner } from "./terminal/terminal-run.js";
import { panePids } from "./terminal/terminal-session.js";
import { version } from "./version.js";
import { internalTools } from "./agent/tools/agent-tools.js";
import { backgroundJobSessions } from "./agent/tools/jobs/background-jobs.js";
import { conversationBusy } from "./agent/run/turn/turn-liveness.js";
import { fileUsageStore } from "./usage/usage-store.js";
import { extensionIdOf } from "@intentic/extension-manifest";
import { createExtensionBackend } from "./extensions/backend/backend-supervisor.js";
import { createTurnMounts, TURN_MOUNT_BASE, type TurnMounts } from "./agent/tools/turn-mounts.js";
import { type SecretKeyResolver, vaultExtensionSettingSecrets } from "./extensions/extension-settings.js";
import { enabledExtensions, installedExtensions } from "./extensions/installed-extensions.js";
import { workspaceArrivedEmpty } from "./scaffold/starter-site.js";
import { workspacePaths } from "./workspace/workspace.js";
import { writeWorkspaceFileStream } from "./workspace/files/workspace-files-upload.js";
import { extractArchive } from "./workspace/files/workspace-extract.js";
import { createWorkspaceTrash } from "./workspace/files/trash/workspace-trash.js";
import {
    copyWorkspacePath,
    makeWorkspaceDir,
    moveWorkspacePath,
    readWorkspaceFile,
    openWorkspaceFile,
    readWorkspaceFileWindow,
    removeWorkspacePath,
    setWorkspaceMtime,
    statWorkspaceFileSize,
    writeWorkspaceFile,
} from "./workspace/files/workspace-files.js";
import { coalescingWorkspaceTree } from "./workspace/files/workspace-tree-coalesce.js";
import { residentWorkspaceTree } from "./workspace/watch/workspace-watch.js";
import { listWorkspaceChildren, walkWorkspaceTree } from "./workspace/files/workspace-tree.js";
import { heldDirReads } from "./workspace/files/dir-reads.js";

import { statePath } from "./state-paths.js";
import { createDependencyCoordinator } from "./workspace/deps/reconcile-deps.js";
import { parkedCards } from "./conversations/actor/parked-cards.js";
import { createAuthSlice, type AuthSlice } from "./auth/auth-slice.js";
import type { HostsSlice } from "./hosts/hosts-slice.js";
import type { WebextSlice } from "./webext/webext-slice.js";
import type { RunnersSlice } from "./runners/runners-slice.js";
import type { CapabilitiesSlice } from "./capabilities/capabilities-slice.js";
import type { SecretsSlice } from "./secrets/secrets-slice.js";
import type { ExtensionsSlice } from "./extensions/extensions-slice.js";
import type { AutomationsSlice } from "./automations/automations-slice.js";
import type { LoopsSlice } from "./loops/loops-slice.js";
import type { CiSlice } from "./ci/ci-slice.js";
import type { MainlineSlice } from "./workspace/deps/mainline-slice.js";
import type { ResourcesSlice } from "./system/resources/resources-slice.js";
import type { ProvidersSlice } from "./agent/providers/providers-slice.js";
import type { ConversationsSlice } from "./conversations/conversations-slice.js";
import type { WorkspaceSlice } from "./workspace/workspace-slice.js";
import { createSessionsSlice, type SessionsSlice } from "./sessions/sessions-slice.js";
import type { ProcessesSlice } from "./processes/processes-slice.js";
import type { GitSlice } from "./git/git-slice.js";
import { createCodeSearchEngine } from "./workspace/code-search.js";

// Wired once at boot for the route factories; a module should Pick only the seams it uses, not take Services whole,
// unless it orchestrates most of the daemon.
// One interface; each provider extends it with its own area declared beside its code, so adding a provider needs only
// an extends clause and a spread.
export interface Services
    extends ClaudeSlice,
        CodexSlice,
        CursorSlice,
        GrokSlice,
        GeminiSlice,
        KimiSlice,
        MintedSlice,
        AuthSlice,
        HostsSlice,
        WebextSlice,
        RunnersSlice,
        CapabilitiesSlice,
        SecretsSlice,
        ExtensionsSlice,
        AutomationsSlice,
        LoopsSlice,
        CiSlice,
        MainlineSlice,
        ResourcesSlice,
        ProvidersSlice,
        ConversationsSlice,
        WorkspaceSlice,
        SessionsSlice,
        ProcessesSlice,
        GitSlice {
    readonly config: Config;
    readonly logger: Logger;
    // Sink for the browser's own reports; undefined when there's nowhere to write, and the route says so.
    readonly clientLogger: Logger | undefined;
    // Where the boot chain lives; app.ts gates every data route on `converged`, and /events streams its progress.
    readonly boot: BootTracker;
    // Promises the daemon makes to itself, checked while running, reported and never thrown; read by diagnostics.
    readonly invariants: InvariantRegistry;
    // Platform registration; main starts/stops it, /health reports its state, the one link the container can probe.
    readonly announcer: Announcer;
    // Whether this sandbox's public address answers; the announcer proves it started, this proves it's reachable.
    readonly reach: ReachReporter;
    // Makes a turn's browser router, which the turn then mounts.
    readonly browserRouters: BrowserRouterFactory;
    // Every live turn's MCP mounts (its browser routers, peers and extension cards), reached at /mcp/<name> with its
    // conversation's bearer, which opens only what the running turn mounted.
    readonly turnMounts: TurnMounts;
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
    // How the platform says this sandbox presents itself: the owner's name for it and its switcher logo. Neither is
    // workspace state, so an export has to ask; injected rather than imported so the bundler stays testable and a
    // headless daemon can simply not have one. Resolves undefined whenever the platform can't answer — an export
    // must never fail over presentation.
    readonly presentation: () => Promise<SandboxPresentation | undefined>;
    // Wallet's payment record, one row per attempt reaching policy, opened before and settled after the answer.
    readonly walletLedger: WalletLedgerStore;
    // Whether this sandbox can chat before an AI account connects, and today's allowance; unset with no platform.
    readonly trial: TrialService;
    // Loopback TLS terminator for a dev platform; awaited by the translator's render so the address isn't a race.
    readonly platformTunnel: PlatformTunnel;
    // Named personas this sandbox shows outside; the turn path reads it to decide what a wake may act through.
    readonly personas: PersonasStore;
    // Named parts of the workspace; every path fence resolves through it, for people and for the turns they start.
    readonly areas: AreasStore;
    // Maintenance evidence: the probe cache the background runner fills, and the ledger of what was done about it.
    readonly chores: ChoresStore;
    // Background sweep keeping the probe cache from expiring; skipped entirely while any turn is live.
    readonly probeRunner: ProbeRunner;
    // Things the agent prepared and may not do unasked; /approvals is the owner's approve/reject side.
    readonly approvals: ApprovalsStore;
    // Activity audit log, outside the agent's reach: inbound wakes, sniffed calls, voice sessions, failures.
    readonly activity: ActivityStore;
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
    // Daemon-owned workspace snapshots on /history, outside agent reach: captured per turn and on an interval.
    readonly history: WorkspaceHistory;
    readonly intentic: (run: IntenticRun, signal?: AbortSignal) => AsyncGenerator<IntenticLine>;
    // What turns and the fleet announce; `wireReactions` below subscribes what reacts to it.
    readonly events: DomainEvents;
    // Everything a stopped conversation holds (processes, terminals, browsers, temp), reclaimed on its own clock.
    readonly reaper: ResourceReaper;
    // Which conversations are published as shareable pages; the index only, pages live in the workspace outbox.
    readonly shares: ShareStore;
    // Composer's voice input: whisper.cpp over browser WAV, with a serialized queue and first-use model download.
    readonly speech: Speech;
    // What a panel's preview hostname actually serves; the panels list only advertises a URL where it answers.
    readonly panelUpstreamOf: PanelUpstreamResolver;
}

// Builds production services from config; the agent/intentic/git/files/sessions/tree members default to real
// subprocess/fs functions.
export const createServices = (config: Config, logger: Logger): Services => {
    const workspace = workspacePaths(config.workspaceRoot);
    const treeReads = heldDirReads(workspace.root);
    // Shared by every caller that walks at once; one walk per checkout serves them all.
    const walkedWorkspaceTree = coalescingWorkspaceTree((root: string) =>
        walkWorkspaceTree(root, resolve(root) === resolve(workspace.root) ? { reads: treeReads } : {}),
    );
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
    // OpenCode and the Gemini area reference each other; safe since the model read runs lazily, after returning.
    // oxlint-disable-next-line prefer-const -- The config closure reads this binding before assignment.
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
    gemini = createGeminiSlice({ config, authRoot, geminiAgent: createOpenCodeAgent(createOpenCodeRunner(openCode), OPENCODE_GEMINI_PROVIDER) });
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
    // Who may call this daemon, and how: the roster, passkeys, sessions and every per-boot and per-extension token.
    const authSlice = createAuthSlice(config, workspace.root);

    // Provider areas: each directory builds its own Services members; Gemini's area is built beside OpenCode.
    const claude = createClaudeSlice({ config, logger, authRoot, workspaceRoot: workspace.root });
    const codex = createCodexSlice({ config, authRoot });
    const cursor = createCursorSlice({ authRoot, logger });
    // What this sandbox has been refused, for the plans that publish no allowance to read; Cursor's only reading.
    const observedLimits = fileObservedLimitStore(join(config.historyRoot, "observed-limits.json"));
    // Every way 'what each account has left' can be learned: Claude's own tokens, routed subscriptions via the
    // translator, and — where nothing is published — the refusals this sandbox has collected itself.
    const headroom = createHeadroomService({
        store: accountUsage,
        parks: fileUsageParkStore(join(config.historyRoot, "usage-parks.json")),
        sources: [
            claudeHeadroomSource(claude.claudeStore),
            cliProxy.headroom,
            cursorHeadroomSource({ cursorStore: cursor.cursorStore, cursorModels: cursor.cursorModels, observedLimits }),
        ],
        logger,
    });
    const grok: GrokSlice = { grokAgent: createOpenCodeAgent(createOpenCodeRunner(openCode)) };
    const kimi = createKimiSlice(cliProxy);
    // One area for every minted provider, built from a spec table so adding one is a contract row, not code here.
    const minted = createMintedSlice({ authRoot, logger });

    // Hoisted: worktree ops and the Changes scan must file into the same tracker the summary line reads.
    const perf = createPerfTracker(logger, createPerfLogger(config));

    // One database for the registry and everything keyed by a conversation, so a fact spanning its tables is one write.
    const conversationsDb = openConversationsDb(conversationsDbPath(config.historyRoot));
    const agentsStore = sqliteAgentsStore(conversationsDb);
    const units = conversationUnits(config.historyRoot, agentsStore.has);
    // Hoisted: the invariant companions below observe these exact instances, not a second, disagreeing one.
    const turnJournal = sqliteTurnJournal(conversationsDb);
    const invariants = createInvariantRegistry(logger);

    // Hoisted: the ACP connection pool implements ACP terminal/* over the same runner, so both share one instance.
    const terminalRun = createTerminalRunner();
    const acpConnections = createAcpConnections(logger, terminalRun);
    const processes = createManagedProcesses(undefined, { logger });
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
    const { agents, conversations } = createFleet(
        { agents: agentsStore, journal: turnJournalRows(conversationsDb), transaction: conversationsDb.transaction, units },
        createLandStandings(agentWorktrees),
        landedPresences,
    );
    const cards = parkedCards(conversations);
    // A reaction's failure is its own; the announcement it answered has already been made.
    const events = createDomainEvents((name, error) => logger.warn({ err: error, event: name }, "domain event: a reaction failed"));
    // Reaper keys to the same three facts as everything else: whose work, whether it's live, whether it's ours.
    const reaper = createResourceReaper({
        ownerLive: (owner) => owner === DAEMON_OWNER || conversationBusy(conversations, owner),
        ownerKnown: (owner) => agents.entry(owner) !== undefined,
        liveSessionNames: () =>
            new Set([
                ...conversations.liveSessionIds().flatMap((sessionId) => {
                    const session = agentSessionName(sessionId);
                    return session === undefined ? [] : [session];
                }),
                // A session still holding a background job, whose whole point is to outlive the turn that started it:
                // without this the terminal sweep would kill the pane ten minutes after the conversation stopped, and
                // the wake armed on the job would time out instead of firing (agent/tools/jobs/background-jobs.ts).
                ...backgroundJobSessions(conversations),
            ]),
        panePids,
        onOwnerStopped: (listener) => events.subscribe("run.settled", (settled) => listener(settled.conversationId)),
        logger,
    });
    // A settled turn's outside-content taint drops with the turn; the registry must be told when that moment is.
    events.subscribe("run.settled", (settled) => clearTurnTaint(settled.conversationId));
    // Hoisted like the presences above: its attribution caches report into the resource series.
    const agentOrigins = createAgentOrigins({ agents, logger, expiry: landingExpiry });
    // Hoisted: the CI hook reconciler reads the same manifest the routes edit.
    // The free trial lays over the manifest, never into it; routing stays a config constant, not probe timing.
    const trial = createTrialService(config);
    // The bundled translator opens the trial's connection and verifies its cert; a self-signed platform fails this.
    const platformTunnel = startPlatformTunnel(config.platform.url, logger);
    // Every write moves the contribution inventory (contributions.ts), which enumerates installed extensions from here;
    // the file watcher would too, but only after a turn planned in between had read the old one.
    const capabilityManifest = invalidatingContributions(
        fileCapabilitiesStore(statePath(workspace.root, ".intentic/config/capabilities.json"), (id, reason) =>
            logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}), the rest of the manifest is unaffected`),
        ),
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
            config: { extensionsDir: config.extensionsDir, historyRoot: config.historyRoot },
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
        config: { extensionsDir: config.extensionsDir, historyRoot: config.historyRoot },
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
    const areas = fileAreasStore(statePath(workspace.root, ".intentic/config/areas.json"), (id, reason) =>
        logger.warn(`areas: skipping unreadable area "${id}" (${reason}); anyone fenced to it reaches nothing until it parses`),
    );
    const heavyCommands = fileHeavyCommandsStore(statePath(workspace.root, ".intentic/config/heavy-commands.json"), (reason) =>
        logger.warn(`heavy-commands: ${reason}, falling back to the shipped rules`),
    );
    const ciStore = fileCiStore(statePath(workspace.root, ".intentic/secrets/ci.json"));
    // Samples on a timer of its own, so a death certificate can look back at what the sandbox had.
    const resources = createResourceBudget();
    const verifyStore = fileVerifyStore(statePath(workspace.root, ".intentic/records/verify.json"));
    // Hoisted: the drift sweep and the install-steering hook write the same ledger the /environment route reads.
    const runtimeInstalls = fileRuntimeInstallsStore(statePath(workspace.root, ".intentic/records/runtime-installs.json"));
    // Hoisted: the background probe runner writes the same cache the /chores route reads.
    const chores = fileChoresStore(join(workspace.root, PROBES_FILE), join(workspace.root, LEDGER_FILE));
    // Bound once against the same registry, whose sessionIdOf reads live turn state as well as the persisted entry.
    const turnCheckpoints = sqliteTurnCheckpoints(conversationsDb);
    // Transcripts, session files and phrase search, and what a conversation's purge takes with it.
    const sessionsSlice = createSessionsSlice({
        historyRoot: config.historyRoot,
        workspaceRoot: workspace.root,
        logger,
        turnCheckpoints,
        roster: () =>
            [...agents.list(), ...agents.listArchived()].flatMap((summary) => {
                const entry = agents.entry(summary.id);
                return entry === undefined ? [] : [entry];
            }),
        forget: (conversationId) => credentialGrants.forget(conversationId),
    });
    // A review's code-only counts outlive the process: a restart reopening every review tab reads them back.
    keepCodeCounts(statePath(workspace.root, ".intentic/local/cache/", "code-counts.db"));
    const iq = createCodeSearchEngine(config, workspace.root, logger);

    // One tool table per connected peer, shared by every door: what a turn lists for a machine or a browser that is
    // asleep right now, and the reason a restart doesn't make one vanish from the next turn's tools.
    const peerTools = filePeerTools(config.historyRoot, logger);

    // The backend supervisor enumerates extensions through the finished services object, so it needs a thunk after.
    const servicesHolder: { current?: Services } = {};
    const services: Services = {
        ...authSlice,
        ...sessionsSlice.slice,
        config,
        logger,
        // The browser's own reports, in their own file.
        clientLogger: createClientLogger(config),
        perf,
        resourceOwners: () => {
            const operations = perf.ranked();
            return {
                transcriptSearch: transcriptSearchMetrics(),
                saidIndex: sessionsSlice.saidIndexMetrics(),
                agentOrigins: agentOrigins.metrics(),
                landedPresences: landedPresences.metrics(),
                landingExpiry: landingExpiry.metrics(),
                iq: iq.metrics(),
                perf: { operations: operations.length, spans: operations.reduce((total, operation) => total + operation.count, 0) },
            };
        },
        liveMetrics: createLiveMetrics({ workspaceRoot: workspace.root, budget: resources }),
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
            const [listeners, panes] = await Promise.all([
                scanListeningPorts(),
                // The ports list never fails for want of owners: unknown panes leave each port unowned, said in the log.
                panePids().catch((error: unknown) => {
                    logger.warn({ err: error }, "ports: terminal panes could not be listed, ports show no owning session");
                    return new Map<number, string>();
                }),
            ]);
            return withOwningSessions(listeners, panes);
        },
        terminalRun,
        hosts: filePeerStore(config.historyRoot, HOST_PEER.store),
        // Reads only readings already held (hosts/self-host.ts), so composing a turn never waits on a laptop.
        hostReach: (granted) => hostDeviceReach(services, granted),
        syncFleet: () => enrolledFleet(config.historyRoot),
        hostHub: createPeerHub<HostClient, HostAnnounced, DeviceFacts, DeviceScopes>(HOST_PEER.hub, logger, peerTools),
        browserRouters: createBrowserRouters(() => services),
        turnMounts: createTurnMounts({ baseUrl: () => `http://127.0.0.1:${config.sandbox.port}${TURN_MOUNT_BASE}` }),
        webexts: filePeerStore(config.historyRoot, WEBEXT_PEER.store),
        webextHub: createPeerHub<WebExtClient, WebExtAnnounced, WebExtFacts, WebExtScopes>(WEBEXT_PEER.hub, logger, peerTools),
        // Held readings only (webext/webext-peer.ts), like hostReach: a browser that is closed costs the turn nothing.
        webextReach: (granted) => ownBrowserReach(services, granted),
        runners: filePeerStore(config.historyRoot, RUNNER_PEER.store),
        runnerHub: createPeerHub<RunnerClient, RunnerAnnounced, RunnerFacts, never>(RUNNER_PEER.hub, logger, peerTools),
        syncPairings: pairings<SyncMode>(syncPairBurnPath(config.historyRoot)),
        runnerParent: {},
        info,
        tools: internalTools(config.intenticAgentTools),
        capabilities,
        vaultManifestSecrets: () => vaultManifestSecrets(capabilityManifest, secretVault, secretFieldConnectors, onUnvaultable),
        presentation: () => fetchPresentation(config),
        extensionSecretVault,
        vaultExtensionSettingSecrets: async () =>
            vaultExtensionSettingSecrets(workspace.root, extensionSecretVault, await settingSecretKeys(), onUnvaultableSetting),
        secretRegistry: secretRegistryOf(secretVault, () => workspace.repos["desired-state"]),
        secretUses: fileSecretUses(statePath(workspace.root, ".intentic/records/secret-uses.json")),
        credentialGates,
        credentialGrants,
        // Grants must be one map: a release clicked at the shell exit must be the release the browser reads next turn.
        credentialGate: createCredentialGate({ gates: credentialGates, grants: credentialGrants, ...cardDeps({ conversations, cards, events }) }),
        walletLedger: fileWalletLedger(statePath(workspace.root, ".intentic/records/wallet-ledger.json")),
        trial,
        platformTunnel,
        capabilityDismissals: fileDismissalsStore(statePath(workspace.root, ".intentic/config/capability-dismissals.json")),
        personas,
        areas,
        heavyCommands,
        queueHeavy: queueWhole(heavyCommands.read),
        heavyPrefix: queuePrefixFor(heavyCommands.read),
        resources,
        ciStore,
        verifyStore,
        landCheck: landCheckOf(() => services),
        pushChecks: createPushChecks({
            root: workspace.root,
            store: filePushChecksStore(statePath(workspace.root, ".intentic/records/push-checks.json")),
            logger,
        }),
        ciRuns: createRunsCache(),
        ciHooks: createCiHookReconciler({ workspace, capabilities, ciStore, config, logger }),
        automations: fileAutomationsStore(
            statePath(workspace.root, ".intentic/config/automations.json"),
            statePath(workspace.root, ".intentic/records/automation-runs.json"),
        ),
        loops: fileLoopsStore(statePath(workspace.root, ".intentic/records/loops.json")),
        loopDesigns: fileLoopDesignsStore(statePath(workspace.root, ".intentic/config/loop-designs.json")),
        workflows: fileWorkflowsStore(statePath(workspace.root, ".intentic/config/workflows.json")),
        workflowRuns: fileWorkflowRunsStore(statePath(workspace.root, ".intentic/records/workflow-runs.json")),
        chores,
        probeRunner: createProbeRunner({
            workspace,
            chores,
            conversations,
            wanted: async () => (await enabledExtensions(extensionHostAdapter)).some((extension) => extension.id === "intentic.maintenance"),
            logger,
        }),
        heldWakes: fileHeldWakesStore(statePath(workspace.root, ".intentic/records/approvals/")),
        threadSessions: fileThreadSessionsStore(
            statePath(workspace.root, ".intentic/records/thread-sessions.json"),
            (conversationId) => agents.entry(conversationId)?.archivedAt !== undefined,
        ),
        senders: fileSendersStore(statePath(workspace.root, ".intentic/records/senders.json")),
        webchatOutbox: fileWebchatOutbox(statePath(workspace.root, ".intentic/records/webchat-outbox.json")),
        outboxStreamFor: (origin) => outboxStreamFor(services, origin),
        approvals: fileApprovalsStore(statePath(workspace.root, ".intentic/config/approvals/")),
        issues: fileIssuesStore(statePath(workspace.root, ".intentic/records/issues/")),
        issueInstalls: fileInstallsStore(statePath(workspace.root, ".intentic/records/issue-installs.json")),
        turnJournal,
        // Beside the turn journal, for the same reason: it must outlive a container recreate.
        watchJournal: sqliteWatchJournal(conversationsDb),
        invariants,
        // The same instance the transcript reader holds; a second would answer from a file the first already passed.
        turnCheckpoints,
        // Beside the transcript in the conversation's unit: what a conversation is told outlives a container recreate the
        // same way what it said does.
        promptRecord: filePromptRecord(config.historyRoot),
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        usage: fileUsageStore(join(config.historyRoot, "usage.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(statePath(workspace.root, ".intentic/config/settings.json")),
        safetyPolicy: fileSafetyPolicyStore(statePath(workspace.root, ".intentic/config/safety.md")),
        safetyLog: fileSafetyLog(statePath(workspace.root, ".intentic/local/safety-log.json")),
        ruleFirings: fileRuleFiringsStore(statePath(workspace.root, ".intentic/local/rule-firings.json")),
        runtimeInstalls,
        driftSweep: createDriftSweep({ workspace, runtimeInstalls, conversations, logger }),
        push: pushStore,
        pushSender,
        // Provider areas, spread whole; their members' docs live on the area interfaces, beside the code.
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
        modelCooldowns: fileModelCooldownStore(join(config.historyRoot, "model-cooldowns.json")),
        observedLimits,
        // Late-bound through the same holder the extension backend uses; the thunks only run per request.
        providerCatalogs: providerCatalogsOf(PROVIDER_MODULES, () => {
            if (servicesHolder.current === undefined) {
                throw new Error("provider catalog read before services finished composing");
            }
            return servicesHolder.current;
        }),
        providerReadiness: () => {
            if (servicesHolder.current === undefined) {
                throw new Error("provider readiness read before services finished composing");
            }
            return providerReadiness(servicesHolder.current);
        },
        providerModules: PROVIDER_MODULES,
        adapters: RUNTIME_ADAPTERS,
        judgeCommand: (input, signal) => judgeCommand(services, input, signal),
        openBrowserAccount: (input) => openBrowserAccount(services, input),
        composeEnvironment: () => composeEnvironment(services),
        endpointModels: createEndpointCatalog(join(authRoot, "endpoints")),
        // Same late binding as the thunks above: a wake needs the finished Services to build a capability context,
        // and the only caller is a turn, long after composing.
        wakeLocalModel: async (id: string) => {
            const current = servicesHolder.current;
            return current === undefined ? false : wakeLocalModelServer(capabilityCtx(current), id, LOCAL_MODEL_WAKE_MS);
        },
        cliProxy,
        openCode,
        authRoot,
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
        // The Claude Code loop over these actors, which hold the children and background commands a turn starts.
        agent: (request) => runAgent(conversations, request),
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
            scratchOf,
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
        conversationUnits: units,
        conversationsDb,
        conversations,
        cards,
        // Bound to streamAgent here, the one module that may name the turn body.
        turns: turnDoors(
            () => services,
            (input, signal) =>
                input.conversationId === undefined
                    ? streamAgent(services, input, signal)
                    : inLogContext({ conversationId: input.conversationId }, streamAgent(services, input, signal)),
        ),
        events,
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
            open: openWorkspaceFile,
            size: statWorkspaceFileSize,
            mkdir: makeWorkspaceDir,
            remove: removeWorkspacePath,
            trash: createWorkspaceTrash(statePath(workspace.root, ".intentic/local/trash/")),
            move: moveWorkspacePath,
            copy: copyWorkspacePath,
            extract: extractArchive,
        },
        derived: {
            read: readDerivedText,
            derive: deriveText,
            deriveBytes,
            status: sidecarStatus,
        },
        // The watched workspace answers from the tree its watcher holds; the walk behind it reads the workspace through
        // what that watcher keeps current, and a conversation's own checkout straight from disk.
        workspaceTree: (root: string) => residentWorkspaceTree(root) ?? walkedWorkspaceTree(root),
        workspaceTreeChanged: treeReads.changed,
        workspaceChildren: listWorkspaceChildren,
        iq,
        shares: fileShareStore(join(config.historyRoot, "shares.json")),
        speech: createSpeech({ workspaceRoot: workspace.root, log: (message) => logger.info(`speech: ${message}`) }),
        // Reads live sockets through the shared scan rather than the assigned port, since a monorepo can pin its own.
        panelUpstreamOf: createPanelUpstreamResolver({
            workspaceRoot: workspace.root,
            repos: () => discoverRepos(workspace.root),
            listeners: () => services.scanPorts(),
            // Panels answer from the panel manager; an extension preview answers from the supervisor that assigned it.
            portOf: (key) => processes.portOf(key) ?? serviceProcesses.portOf(key),
        }),
    };
    servicesHolder.current = services;
    wireReactions(services);
    // Registration only; nothing runs until a boot phase drives a moment, so a test build carries it unpaid for.
    registerDaemonInvariants(invariants, {
        turnJournal,
        agents,
        conversations,
        agentWorktrees,
        areas,
        members: authSlice.members,
        personas,
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

// What reacts to the turns' and the fleet's announcements, subscribed in this order: chores to workspace events, the
// owner's devices to a turn that parks or ends, history to a main tree a turn changed. Shared with the route harness,
// so a suite's turn reaches the same reactions.
export const wireReactions = (services: Services): void => {
    services.events.subscribe("workspace", (event) =>
        dispatchWorkspaceEvent(services, event).catch((error: unknown) =>
            services.logger.warn({ err: error, event: event.event }, "workspace event dispatch failed"),
        ),
    );
    services.events.subscribe("turn.awaiting", ({ conversationId, awaiting }) =>
        services.pushSender.notifyIfAway(turnAwaiting(conversationId, awaiting)),
    );
    services.events.subscribe("turn.finished", ({ conversationId, prompt, outcome }) =>
        services.pushSender.notifyIfAway(turnFinished(conversationId, prompt, outcome)),
    );
    services.events.subscribe("tree.changed", ({ label }) =>
        services.history.snapshot("turn", label).catch((error: unknown) => services.logger.warn({ err: error }, "history: turn snapshot failed")),
    );
    // A turn ending is when what waited behind it goes, whoever queued it (turn-admission.ts).
    services.events.subscribe("run.settled", ({ conversationId }) => void services.turns.drain(conversationId));
};
