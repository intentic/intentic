import { queuePrefixFor, queueWhole } from "./agent/tools/agent-terminals.js";
import { join } from "node:path";
import type { DeviceFacts, DeviceScopes, IntenticLine } from "@intentic/sandbox-contract";
import { portSlotsFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { capabilityCtx } from "./capabilities/capability.js";
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
import { cliProxyAuthDir, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/providers/translator.js";
import { fileWorkflowRunsStore, fileWorkflowsStore, workflowRunsDocument, workflowsDocument } from "./workflows/workflows-store.js";
import { type ChoresStore, fileChoresStore, LEDGER_FILE, PROBES_FILE } from "./chores/chores-store.js";
import { createProbeRunner, type ProbeRunner } from "./chores/probe-runner.js";
import { fileWalletLedger, walletLedgerDocument, type WalletLedgerStore } from "./wallet/wallet-ledger.js";
import { createTrialService, type TrialService } from "./trial/trial.js";
import { withTrialEndpoint } from "./trial/trial-endpoint.js";
import { filePersonasStore, personasDocument, type PersonasStore } from "./personas/personas-store.js";
import { areasDocument, type AreasStore, fileAreasStore } from "./areas/areas-store.js";
import { deriveBytes } from "./derived/derived-blob.js";
import { deriveText, readDerivedText } from "./derived/derived-text.js";
import { sidecarStatus } from "./derived/sidecar-service.js";
import { landCheckOf, type LandCheckWiring } from "./conversations/land/verify-landed.js";
import { createBrowserRouters } from "./browser/tools/browser-prepare.js";
import type { BrowserRouterFactory } from "./browser/tools/browser-router.js";

import { accountUsageDocument, fileAccountUsageStore } from "./usage/account-usage.js";
import { claudeHeadroomSource } from "./usage/claude-usage.js";
import { createHeadroomService } from "./usage/headroom.js";
import { fileUsageParkStore, usageParksDocument } from "./usage/usage-parks.js";
import { fileObservedLimitStore, observedLimitsDocument } from "./usage/observed-limits.js";
import { cursorHeadroomSource } from "./runtimes/cursor/cursor-usage.js";
import { approvalsDocument, type ApprovalsStore, fileApprovalsStore } from "./approvals/approvals-store.js";
import { fileIssuesStore, issuesDocument } from "./issues/issues-store.js";
import { fileInstallsStore, issueInstallsDocument } from "./store/installs.js";
import { HOST_PEER, type HostAnnounced, type HostClient } from "./hosts/host-peer.js";
import { hostDeviceReach } from "./hosts/self-host.js";
import { createPeerHub, type PeerDoorDeps } from "./peers/peer-hub.js";
import { filePeerStore } from "./peers/peer-store.js";
import { filePeerTools } from "./peers/peer-tool-memory.js";
import { fetchPresentation, type SandboxPresentation } from "./system/platform-client.js";
import { enrolledFleet, syncPairBurns, type SyncMode } from "./hosts/desktop-sync.js";
import { pairings } from "./peers/enrollment.js";
import type { Config } from "./env.config.js";
import { keepCodeCounts } from "./git/changes/code-counts.js";
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
import { createWorkspaceHistory, type WorkspaceHistory } from "./history/history.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { createPanelUpstreamResolver, type PanelUpstreamResolver } from "./panels/panel-upstream.js";
import { discoverRepos } from "./workspace/layout/repo-discovery.js";
import { filePushStore, pushDocument, type PushStore } from "./push/push-store.js";
import { createPushSender, type PushSender } from "./push/push.js";
import { createPortForwards } from "./ports/port-forwards.js";
import { type ListeningPort, scanListeningPorts, withOwningSessions } from "./ports/port-scan.js";
import { transcriptSearchMetrics } from "./sessions/transcript-search.js";
import { fileWebchatOutbox, outboxStreamFor, webchatOutboxDocument } from "./webchat/webchat-outbox.js";
import { fileShareStore, sharesDocument, type ShareStore } from "./share/share-store.js";
import { createSpeech, type Speech } from "./speech/transcribe.js";
import { fileSafetyLog, type SafetyLog, safetyLogDocument } from "./safety/safety-log.js";
import { type SafetyPolicyStore, fileSafetyPolicyStore } from "./safety/safety-policy-store.js";
import { fileSandboxSettingsStore, type SandboxSettingsStore, settingsDocument } from "./settings/settings-store.js";
import { fileRuleFiringsStore, ruleFiringsDocument, type RuleFiringsStore } from "./rules/rule-firings.js";
import { type DriftSweep, createDriftSweep } from "./environment/drift-sweep.js";
import { fileRuntimeInstallsStore, runtimeInstallsDocument, type RuntimeInstallsStore } from "./environment/runtime-installs.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { cardDeps } from "./conversations/actor/card-offers.js";
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
import { createClientLogger, createPerfLogger } from "./logger.js";
import { createPerfTracker } from "./system/resources/perf.js";
import { panePids } from "./terminal/terminal-session.js";
import { version } from "./version.js";
import { internalTools } from "./agent/tools/agent-tools.js";
import { backgroundJobSessions } from "./agent/tools/jobs/background-jobs.js";
import { conversationBusy } from "./agent/run/turn/turn-liveness.js";
import { createTurnMounts, TURN_MOUNT_BASE, type TurnMounts } from "./agent/tools/turn-mounts.js";
import { enabledExtensions, type ExtensionHost } from "./extensions/installed-extensions.js";
import { workspaceArrivedEmpty } from "./scaffold/starter-site.js";

import { statePath } from "./state-paths.js";
import { createAuthSlice, type AuthSlice } from "./auth/auth-slice.js";
import type { HostsSlice } from "./hosts/hosts-slice.js";
import { createWebextSlice, type WebextSlice } from "./webext/webext-slice.js";
import { createRunnersSlice, type RunnersSlice } from "./runners/runners-slice.js";
import { type AgentToolsMember, createCapabilitiesSlice, type CapabilitiesSlice } from "./capabilities/capabilities-slice.js";
import { createSecretsSlice, type SecretsSlice } from "./secrets/secrets-slice.js";
import { createExtensionsSlice, type ExtensionsSlice } from "./extensions/extensions-slice.js";
import { type AutomationsSlice, createAutomationsSlice, type IntakeMembers } from "./automations/automations-slice.js";
import { createLoopsSlice, type LoopsSlice, type WorkflowsMembers } from "./loops/loops-slice.js";
import { type CiSlice, createCiSlice } from "./ci/ci-slice.js";
import { createMainlineSlice, type LandMembers, type MainlineSlice } from "./workspace/deps/mainline-slice.js";
import { createResourcesSlice, type ResourcesSlice } from "./system/resources/resources-slice.js";
import { createProvidersSlice, type ProvidersSlice } from "./agent/providers/providers-slice.js";
import { createConversationsSlice, type ConversationsSlice } from "./conversations/conversations-slice.js";
import { createWorkspaceSlice, type DerivedMembers, type WorkspaceSlice } from "./workspace/workspace-slice.js";
import { createSessionsSlice, type SessionsSlice } from "./sessions/sessions-slice.js";
import { createProcessesSlice, type PortsMembers, type ProcessesSlice } from "./processes/processes-slice.js";
import { createGitSlice, type GitSlice } from "./git/git-slice.js";

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
    // Every live turn's MCP mounts (its browser routers, peers and extension cards), reached at /mcp/<name> with the
    // turn's own bearer, which opens only what that turn mounted.
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

// This sandbox's identity for the Connections card, or undefined outside a named, imaged sandbox.
const infoOf = (config: Config): Services["info"] =>
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

// The provider areas, each built by its own directory, and what they share: the translator, OpenCode, and the headroom
// every account's allowance is read through.
const createProviderAreas = (config: Config, logger: Logger, authRoot: string, whole: () => Services) => {
    // Hoisted: the turn stream and the translator client both read and record into this same file.
    const accountUsage = fileAccountUsageStore(join(config.historyRoot, accountUsageDocument.path));
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
    const claude = createClaudeSlice({ config, logger, authRoot, workspaceRoot: config.workspaceRoot, providerRefusals: () => whole().providerRefusals });
    const cursor = createCursorSlice({ authRoot, logger });
    // What this sandbox has been refused, for the plans that publish no allowance to read; Cursor's only reading.
    const observedLimits = fileObservedLimitStore(join(config.historyRoot, observedLimitsDocument.path));
    // Every way 'what each account has left' can be learned: Claude's own tokens, routed subscriptions via the
    // translator, and — where nothing is published — the refusals this sandbox has collected itself.
    const headroom = createHeadroomService({
        store: accountUsage,
        parks: fileUsageParkStore(join(config.historyRoot, usageParksDocument.path)),
        sources: [
            claudeHeadroomSource(claude.claudeStore),
            cliProxy.headroom,
            cursorHeadroomSource({ cursorStore: cursor.cursorStore, cursorModels: cursor.cursorModels, observedLimits }),
        ],
        logger,
    });
    const grok: GrokSlice = { grokAgent: createOpenCodeAgent(createOpenCodeRunner(openCode)) };
    return {
        shared: { accountUsage, cliProxy, openCode, authRoot, observedLimits, headroom },
        // Spread whole into Services; their members' docs live on the area interfaces, beside the code.
        areas: {
            ...claude,
            ...createCodexSlice({ config, authRoot }),
            ...cursor,
            ...grok,
            ...gemini,
            ...createKimiSlice(cliProxy),
            // One area for every minted provider, built from a spec table so adding one is a contract row, not code here.
            ...createMintedSlice({ authRoot, logger }),
        },
    };
};

// Reaper keys to the same three facts as everything else: whose work, whether it's live, whether it's ours.
const createReaper = ({ conversations, agents, events, logger }: Pick<Services, "conversations" | "agents" | "events" | "logger">): ResourceReaper =>
    createResourceReaper({
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

// The hosts slice, built here rather than beside its interface while the devices work reshapes hosts/.
const createHostsSlice = ({ historyRoot, logger, peerTools, whole }: PeerDoorDeps & { readonly whole: () => Services }): HostsSlice => ({
    hosts: filePeerStore(historyRoot, HOST_PEER.store),
    // Reads only readings already held (hosts/self-host.ts), so composing a turn never waits on a laptop.
    hostReach: (granted) => hostDeviceReach(whole(), granted),
    syncFleet: () => enrolledFleet(historyRoot),
    hostHub: createPeerHub<HostClient, HostAnnounced, DeviceFacts, DeviceScopes>(HOST_PEER.hub, logger, peerTools),
    syncPairings: pairings<SyncMode>(syncPairBurns(historyRoot)),
});

// Pane listing rides with the scan rather than behind it: both are cheap, and an unowned port is unactionable.
const scanPortsWith =
    (logger: Logger) =>
    async (): Promise<ListeningPort[]> => {
        const [listeners, panes] = await Promise.all([
            scanListeningPorts(),
            // The ports list never fails for want of owners: unknown panes leave each port unowned, said in the log.
            panePids().catch((error: unknown) => {
                logger.warn({ err: error }, "ports: terminal panes could not be listed, ports show no owning session");
                return new Map<number, string>();
            }),
        ]);
        return withOwningSessions(listeners, panes);
    };

// Slice members a slice builder leaves out, each because the builder importing it would close a cycle between
// subsystems (daemon-boundaries): the builder's Omit<…> type names them, and this Pick of the same names is checked
// against it, so leaving one out fails to compile.
type BridgedMembers = DerivedMembers | PortsMembers | LandMembers | IntakeMembers | WorkflowsMembers | AgentToolsMember;
const createBridgedMembers = (
    deps: Pick<Services, "config" | "logger" | "workspace" | "heavyCommands"> & { readonly landCheck: LandCheckWiring },
): Pick<Services, BridgedMembers> => {
    const { config, logger, workspace } = deps;
    const webchatOutbox = fileWebchatOutbox(join(workspace.root, webchatOutboxDocument.path));
    return {
        // WorkspaceSlice: derived/ and scaffold/ import workspace/ back. Read here, once, at composition: the last moment
        // /work still looks the way the user handed it over.
        workspaceArrivedEmpty: workspaceArrivedEmpty(workspace.root),
        derived: { read: readDerivedText, derive: deriveText, deriveBytes, status: sidecarStatus },
        // ProcessesSlice: ports/ reaches processes/ back through system/. Slot names are salted with the connect token so
        // a port's hostname can't be guessed from the sandbox id.
        portForwards: createPortForwards(portSlotsFromToken(config.connectToken)),
        scanPorts: scanPortsWith(logger),
        // MainlineSlice: the land check routes a red run into conversations/, the heavy queue is agent/'s terminal lane.
        landCheck: landCheckOf(deps.landCheck),
        queueHeavy: queueWhole(deps.heavyCommands.read),
        heavyPrefix: queuePrefixFor(deps.heavyCommands.read),
        // AutomationsSlice: issues/ and webchat/ import automations/ back.
        webchatOutbox,
        outboxStreamFor: (origin) => outboxStreamFor({ webchatOutbox, logger }, origin),
        issues: fileIssuesStore(join(workspace.root, issuesDocument.path)),
        issueInstalls: fileInstallsStore(issueInstallsDocument, join(workspace.root, issueInstallsDocument.path)),
        // LoopsSlice: workflows/ imports loops/ back.
        workflows: fileWorkflowsStore(join(workspace.root, workflowsDocument.path)),
        workflowRuns: fileWorkflowRunsStore(join(workspace.root, workflowRunsDocument.path)),
        // CapabilitiesSlice: agent/ imports capabilities/ back.
        tools: internalTools(config.intenticAgentTools),
    };
};

// The members Services declares itself, which no slice owns: what the daemon is, and the stores and services beside
// the slices.
const createDaemonMembers = (
    deps: Pick<
        Services,
        "config" | "logger" | "workspace" | "capabilities" | "conversations" | "chores" | "runtimeInstalls" | "processes" | "serviceProcesses" | "scanPorts"
    > & { readonly manifestHost: ExtensionHost },
) => {
    const { config, logger, workspace, capabilities, conversations, chores, runtimeInstalls, processes, serviceProcesses } = deps;
    // Born converged: main() closes the gate, so a test or host-internal preview build has nothing to wait for.
    const boot = createBootTracker(logger);
    return {
        config,
        logger,
        // The browser's own reports, in their own file.
        clientLogger: createClientLogger(config),
        boot,
        announcer: createAnnouncer(config, logger),
        reach: createReachReporter(config, logger, () => boot),
        browserRouters: createBrowserRouters(() => ({ capabilities, workspace })),
        turnMounts: createTurnMounts({ baseUrl: () => `http://127.0.0.1:${config.sandbox.port}${TURN_MOUNT_BASE}` }),
        info: infoOf(config),
        presentation: () => fetchPresentation(config),
        walletLedger: fileWalletLedger(join(workspace.root, walletLedgerDocument.path)),
        probeRunner: createProbeRunner({
            workspace,
            chores,
            conversations,
            wanted: async () => (await enabledExtensions(deps.manifestHost)).some((extension) => extension.id === "intentic.maintenance"),
            logger,
        }),
        approvals: fileApprovalsStore(join(workspace.root, approvalsDocument.path)),
        safetyPolicy: fileSafetyPolicyStore(statePath(workspace.root, ".intentic/config/safety.md")),
        safetyLog: fileSafetyLog(join(workspace.root, safetyLogDocument.path)),
        ruleFirings: fileRuleFiringsStore(join(workspace.root, ruleFiringsDocument.path)),
        driftSweep: createDriftSweep({ workspace, runtimeInstalls, conversations, logger }),
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
        // Bound to the daemon logger so a CLI run's lifecycle is attributable from daemon.log.
        intentic: (run: IntenticRun, signal?: AbortSignal) => runIntentic(run, signal, logger),
        shares: fileShareStore(join(config.historyRoot, sharesDocument.path)),
        speech: createSpeech({ workspaceRoot: workspace.root, log: (message) => logger.info(`speech: ${message}`) }),
        // Reads live sockets through the shared scan rather than the assigned port, since a monorepo can pin its own.
        panelUpstreamOf: createPanelUpstreamResolver({
            workspaceRoot: workspace.root,
            repos: () => discoverRepos(workspace.root),
            listeners: deps.scanPorts,
            // Panels answer from the panel manager; an extension preview answers from the supervisor that assigned it.
            portOf: (key) => processes.portOf(key) ?? serviceProcesses.portOf(key),
        }),
    };
};

// Builds production services from config, one slice builder at a time in the order their dependencies ask for: each
// takes what it reads as a typed argument, so a dependency missing here is a compile error, not a first-request crash.
export const createServices = (config: Config, logger: Logger): Services => {
    // The one late binding left. A few services do work that reaches back into most of the daemon (a turn, a land's
    // breakage route, the provider catalogs, the safety judge, filing a browser account, a host's reach); they read the
    // finished services through this per call, and none is called before composing returns.
    const whole = (): Services => services;

    const workspaceSlice = createWorkspaceSlice({ config, logger });
    const { workspace } = workspaceSlice;
    // AI-provider credential root; AGENT_AUTH_DIR shares it across dev sandboxes so subscription OAuth survives.
    const authRoot = config.agentAuthDir !== "" ? config.agentAuthDir : statePath(workspace.root, ".intentic/secrets/auth/");
    const providers = createProviderAreas(config, logger, authRoot, whole);
    // Who may call this daemon, and how: the roster, passkeys, sessions and every per-boot and per-extension token.
    const authSlice = createAuthSlice(config, workspace.root);
    // Hoisted: worktree ops and the Changes scan must file into the same tracker the summary line reads.
    const perf = createPerfTracker(logger, createPerfLogger(config));
    const conversationsParts = createConversationsSlice({ historyRoot: config.historyRoot, workspace, logger, perf, whole });
    const { agents, conversations, cards } = conversationsParts.slice;
    const invariants = createInvariantRegistry(logger);
    const processesSlice = createProcessesSlice({ config, logger });
    // The ACP connection pool implements ACP terminal/* over the processes' terminal runner, so both share one instance.
    const acpConnections = createAcpConnections(logger, processesSlice.terminalRun);
    const mainlineSlice = createMainlineSlice({ workspace, historyRoot: config.historyRoot, processes: processesSlice.processes, logger });
    // Hoisted: the store and the sender reading it must be the same instance, or a subscription would go unseen.
    const push = filePushStore(join(config.historyRoot, pushDocument.path));
    // A reaction's failure is its own; the announcement it answered has already been made.
    const events = createDomainEvents((name, error) => logger.warn({ err: error, event: name }, "domain event: a reaction failed"));
    const reaper = createReaper({ conversations, agents, events, logger });
    // A settled turn's outside-content taint drops with the turn; the registry must be told when that moment is.
    events.subscribe("run.settled", (settled) => clearTurnTaint(settled.conversationId));
    // The free trial lays over the manifest, never into it; routing stays a config constant, not probe timing.
    const trial = createTrialService(config);
    // The bundled translator opens the trial's connection and verifies its cert; a self-signed platform fails this.
    const platformTunnel = startPlatformTunnel(config.platform.url, logger);
    const capabilitiesParts = createCapabilitiesSlice({
        config,
        logger,
        workspaceRoot: workspace.root,
        authRoot,
        overlay: (store) => withTrialEndpoint(store, config, trial, platformTunnel),
        whole,
    });
    const { capabilities } = capabilitiesParts.slice;
    const secretsSlice = createSecretsSlice({ workspace, authRoot, secretVault: capabilitiesParts.secretVault, cards: cardDeps({ conversations, cards, events }) });
    const extensionsSlice = createExtensionsSlice({
        config,
        logger,
        workspaceRoot: workspace.root,
        authRoot,
        served: { workspace, files: workspaceSlice.files, capabilities, config },
        declared: capabilitiesParts.manifestHost,
    });
    const personas = filePersonasStore(join(workspace.root, personasDocument.path), (id, reason) =>
        logger.warn(`personas: skipping unreadable card "${id}" (${reason}), the rest are unaffected`),
    );
    const areas = fileAreasStore(join(workspace.root, areasDocument.path), (id, reason) =>
        logger.warn(`areas: skipping unreadable area "${id}" (${reason}); anyone fenced to it reaches nothing until it parses`),
    );
    // Hoisted: the drift sweep and the install-steering hook write the same ledger the /environment route reads.
    const runtimeInstalls = fileRuntimeInstallsStore(join(workspace.root, runtimeInstallsDocument.path));
    // Hoisted: the background probe runner writes the same cache the /chores route reads.
    const chores = fileChoresStore(join(workspace.root, PROBES_FILE), join(workspace.root, LEDGER_FILE));
    // Hoisted: the land check files into the same log and reads the same settings the routes do.
    const activity = fileActivityStore(join(config.historyRoot, "activity.jsonl"));
    const sandboxSettings = fileSandboxSettingsStore(join(workspace.root, settingsDocument.path));
    // Transcripts, session files and phrase search, and what a conversation's purge takes with it.
    const sessionsSlice = createSessionsSlice({
        historyRoot: config.historyRoot,
        workspaceRoot: workspace.root,
        logger,
        turnCheckpoints: conversationsParts.slice.turnCheckpoints,
        roster: () => [...agents.list(), ...agents.listArchived()].flatMap((summary) => agents.entry(summary.id) ?? []),
        forget: (conversationId) => secretsSlice.credentialGrants.forget(conversationId),
    });
    // A review's code-only counts outlive the process: a restart reopening every review tab reads them back.
    keepCodeCounts(statePath(workspace.root, ".intentic/local/cache/", "code-counts.db"));
    // One tool table per connected peer, shared by every door: what a turn lists for a machine or a browser that is
    // asleep right now, and the reason a restart doesn't make one vanish from the next turn's tools.
    const peerDoors = { historyRoot: config.historyRoot, logger, peerTools: filePeerTools(config.historyRoot, logger) };
    const bridged = createBridgedMembers({
        config,
        logger,
        workspace,
        heavyCommands: mainlineSlice.heavyCommands,
        landCheck: { ...mainlineSlice, workspace, processes: processesSlice.processes, logger, activity, events, sandboxSettings, agents, whole },
    });

    const services: Services = {
        ...authSlice,
        ...sessionsSlice.slice,
        ...workspaceSlice,
        ...processesSlice,
        ...mainlineSlice,
        ...conversationsParts.slice,
        ...capabilitiesParts.slice,
        ...secretsSlice,
        ...extensionsSlice,
        ...createAutomationsSlice({ workspaceRoot: workspace.root, archived: (conversationId) => agents.entry(conversationId)?.archivedAt !== undefined }),
        ...createLoopsSlice(workspace.root),
        ...createCiSlice({ workspace, capabilities, config, logger }),
        ...createGitSlice(),
        ...createHostsSlice({ ...peerDoors, whole }),
        ...createWebextSlice(peerDoors),
        ...createRunnersSlice(peerDoors),
        ...createResourcesSlice({
            workspaceRoot: workspace.root,
            perf,
            owners: () => ({
                transcriptSearch: transcriptSearchMetrics(),
                saidIndex: sessionsSlice.saidIndexMetrics(),
                ...conversationsParts.metrics(),
                iq: workspaceSlice.iq.metrics(),
            }),
        }),
        ...createProvidersSlice({
            ...providers.shared,
            historyRoot: config.historyRoot,
            conversations,
            whole,
            acpConnections,
            acpAgent: createAcpAgent(acpConnections),
            // Pi sessions sit beside other AI-provider state under authRoot, so a stable dir keeps them resumable.
            piAgent: createPiAgent(piSpawner(join(authRoot, "pi", "sessions"))),
            // A wake needs the finished Services to build a capability context, and the only caller is a turn.
            wakeLocalModel: async (id) => wakeLocalModelServer(capabilityCtx(whole()), id, LOCAL_MODEL_WAKE_MS),
        }),
        ...providers.areas,
        ...bridged,
        ...createDaemonMembers({ ...processesSlice, config, logger, workspace, capabilities, conversations, chores, runtimeInstalls, scanPorts: bridged.scanPorts, manifestHost: capabilitiesParts.manifestHost }),
        trial,
        platformTunnel,
        personas,
        areas,
        chores,
        invariants,
        activity,
        sandboxSettings,
        runtimeInstalls,
        push,
        pushSender: createPushSender(push, logger),
        events,
        reaper,
    };
    wireReactions(services);
    // Registration only; nothing runs until a boot phase drives a moment, so a test build carries it unpaid for.
    registerDaemonInvariants(invariants, {
        turnJournal: services.turnJournal,
        agents,
        conversations,
        agentWorktrees: services.agentWorktrees,
        areas,
        members: services.members,
        personas,
        manifest: capabilitiesParts.manifest,
        connectors: capabilitiesParts.connectors,
        // The decorated store, since the exit checks read kind and a country code, never a credential.
        capabilities,
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
