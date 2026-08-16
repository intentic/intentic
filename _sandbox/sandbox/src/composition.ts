import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
    AcpAgentConfig,
    AgentEvent,
    FileDiff,
    GitBranch,
    GitChange,
    GitCommit,
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
import { createResidentEngine, type ResidentEngine } from "@intentic/iq-engine";
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
import { createProviderCatalogs, type ProviderCatalog } from "./agent/provider-catalogs.js";
import { type CliProxyClient, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/translator.js";
import { type ApprovalsStore, fileApprovalsStore } from "./automations/approvals-store.js";
import { type AutomationsStore, fileAutomationsStore } from "./automations/automations-store.js";
import { fileLoopDesignsStore, fileLoopsStore, type LoopDesignsStore, type LoopsStore } from "./loops/loops-store.js";
import { fileWorkflowRunsStore, fileWorkflowsStore, type WorkflowRunsStore, type WorkflowsStore } from "./workflows/workflows-store.js";
import { type ChoresStore, fileChoresStore, LEDGER_FILE, PROBES_FILE } from "./chores/chores-store.js";
import { createProbeRunner, type ProbeRunner } from "./chores/probe-runner.js";
import { type CapabilitiesStore, fileCapabilitiesStore, vaultManifestSecrets, withSecretVault } from "./capabilities/capabilities-store.js";
import { contributionRegistry } from "./capabilities/contributions.js";
import { fileSecretVault } from "./capabilities/secret-vault.js";
import { type NamedSecret, secretRegistryOf } from "./secrets/secret-registry.js";
import { fileSecretUses, type SecretUsesStore } from "./secrets/secret-uses.js";
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
import { createClaudeCatalog } from "./claude/claude-models.js";
import { type ClaudeStore, fileClaudeStore } from "./claude/claude-credentials.js";
import { type ClaudeSeatStore, fileClaudeSeatStore } from "./claude/claude-seats.js";
import { type AccountUsageStore, fileAccountUsageStore } from "./usage/account-usage.js";
import { type ClaudeUsageRefresher, createClaudeUsageRefresher } from "./usage/claude-usage.js";
import { fileProviderRefusalStore, type ProviderRefusalStore } from "./usage/provider-refusals.js";
import { createCodexAgent } from "./codex/codex-agent.js";
import { type CodexCatalog, createCodexCatalog } from "./codex/codex-catalog.js";
import { codexThreadExists } from "./sessions/codex-sessions.js";
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
import { type EndpointCatalog, createEndpointCatalog } from "./endpoints/endpoint-catalog.js";
import { createGeminiCatalog } from "./gemini/gemini-catalog.js";
import { createGrokAgent, createGrokRunner } from "./grok/grok-agent.js";
import { createOpenCodeService, OPENCODE_GEMINI_PROVIDER, type OpenCodeService } from "./grok/opencode.js";
import { createKimiCatalog } from "./kimi/kimi-catalog.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history/history.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { type ManagedProcesses, createManagedProcesses } from "./processes/managed-processes.js";
import { createPreviewRouteEnsurer } from "./panels/preview-route.js";
import { type PushStore, filePushStore } from "./push/push-store.js";
import { createPushSender, type PushSender } from "./push/push.js";
import { type PortForwards, createPortForwards } from "./ports/port-forwards.js";
import { type ListeningPort, scanListeningPorts, withOwningSessions } from "./ports/port-scan.js";
import {
    listWorkspaceSessions,
    readWorkspaceSession,
    searchWorkspaceSessions,
    type SessionSummary,
    workspaceSessionExists,
} from "./sessions/sessions.js";
import { transcriptSearchMetrics, type SpokenLine } from "./sessions/transcript-search.js";
import { fileThreadSessionsStore, type ThreadSessionsStore } from "./sessions/thread-sessions.js";
import {
    agentTranscript,
    type AgentTranscriptDeps,
    createSpokenLinesReader,
    storedTranscript,
    type TranscriptAgent,
} from "./sessions/agent-transcript.js";
import { fileTranscriptRecord } from "./sessions/transcript-record.js";
import { fileShareStore, type ShareStore } from "./share/share-store.js";
import { createSpeech, type Speech } from "./speech/transcribe.js";
import { purgeConversationState } from "./sessions/conversation-purge.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { type RuleFiringsStore, fileRuleFiringsStore } from "./rules/rule-firings.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { onTurnSettled, turnRunOf } from "./agent/turn-runs.js";
import { type Announcer, createAnnouncer } from "./platform/announce.js";
import { type ReachReporter, createReachReporter } from "./platform/reach-report.js";
import { type BootTracker, createBootTracker } from "./platform/boot.js";
import { DAEMON_OWNER } from "./platform/leftovers.js";
import { startPlatformTunnel } from "./platform/local-tunnel.js";
import { createResourceReaper, type ResourceReaper } from "./platform/reaper.js";
import { createPerfTracker, type PerfTracker } from "./platform/perf.js";
import { createTerminalRunner, type TerminalRunner } from "./terminal/terminal-run.js";
import { panePids } from "./terminal/terminal-session.js";
import { version } from "./version.js";
import { type AgentTool, internalTools } from "./agent/agent-tools.js";
import { type UsageStore, fileUsageStore } from "./usage/usage-store.js";
import { createExtensionBackend, type ExtensionBackend } from "./extensions/backend/backend-supervisor.js";
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

/* The daemon's collaborators, wired once at boot and handed to the route factories — the injection seam the
 * route tests build fakes against (the equivalent of the old createDaemon `deps` object). Stateful members
 * (appProcesses, the agent/intentic process runners, the credential/tool stores) live here; the in-memory
 * plan/question bridge stays a module singleton in agent-requests.ts (the agent routes call it directly).
 *
 * WHAT A MODULE SHOULD TAKE OF IT. This type is the composition root's, not every consumer's. A module that
 * reads a few seams declares those and nothing else — `export type PortsRoutesDeps = Pick<Services, "config" |
 * "portForwards" | ...>` — because the surface a module depends on is the surface a test has to stand up, and
 * the surface a change somewhere else can reach it through. Twenty-two of the daemon's route modules and their
 * leaf stores are written that way, and their tests build three or four seams instead of a hundred and thirty.
 *
 * The exception is real and is the reason the rest still take `Services` whole: a module that ORCHESTRATES the
 * daemon — the agent turn, the land pass, the capability handlers, the workspace routes — hands `services`
 * onward to machinery that legitimately reaches most of it. A `Pick` of forty members there would be a
 * transcription of `Services` that goes stale, which is the exact failure this file's fakes used to have. Take
 * the whole thing where you pass the whole thing on; name what you use where you use a few. */
export interface Services {
    readonly config: Config;
    readonly logger: Logger;
    // Where the daemon's time goes. Every expensive path (git subprocesses, the Changes scan, repo-lock waits,
    // HTTP requests, event fan-out) measures itself through this, so a "the panel felt slow" report has a log
    // line naming the op instead of a stall with no attribution — see platform/perf.ts.
    readonly perf: PerfTracker;
    // Cardinalities of the resident structures whose growth should explain heap growth in the durable resource
    // series. Reading this must stay allocation-light: the sampler calls it every minute on the daemon loop.
    readonly resourceOwners: () => Readonly<Record<string, unknown>>;
    // Where the boot chain is. main.ts declares its steps and drives it; app.ts gates every data route on its
    // `converged` promise, and /events streams its progress so the browser can WAIT VISIBLY instead of firing
    // a workspace's worth of reads at a daemon that will only park them (see platform/boot.ts).
    readonly boot: BootTracker;
    // The platform registration, same split as `boot`: main starts/stops it, /health reports its state — the
    // one setup link nothing outside the container can probe (see platform/announce.ts).
    readonly announcer: Announcer;
    // Whether this sandbox's PUBLIC address actually answers, established by the box probing itself and
    // reported to the platform (see platform/reach-report.ts). The announce's missing other half: registering
    // proves the daemon started, this proves somebody can reach it.
    readonly reach: ReachReporter;
    readonly workspace: WorkspacePaths;
    // Per-repository operator panels: the in-memory process manager the /panels routes and the preview proxy
    // drive (discovery of which repo has a panel is convention-only — see panels/panels.ts).
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
    // Discovers every listening TCP socket via procfs, each traced back to the terminal it runs in — the
    // discovery seam behind both the Ports view and a repo's answering dev servers.
    readonly scanPorts: () => Promise<ListeningPort[]>;
    // Runs user-triggered shell commands inside visible job-* tmux sessions (window per command) — the
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
    // A per-boot secret the AGENT's host tools carry (as their MCP bearer) to reach /mcp/hosts/:id — the door
    // onto a connected computer of the user's. Deliberately NOT the machine's own enrollment token: that one
    // lives on /history where the agent cannot read it, and this one dies with the daemon and works only from
    // inside the container. What it opens is still bounded by the scopes that machine enforces (hosts/).
    readonly hostBridgeToken: string;
    // The user's own computers: enrollment (a durable per-machine token, digests on /history) …
    readonly hosts: HostsStore;
    // … and who is actually holding a socket right now, with the JSON-RPC correlation over it.
    readonly hostHub: HostHub;
    // Owner-minted, hashed, revocable tokens for anything driving this sandbox from outside the browser — the
    // ACP editor bridge today (x-intentic-control header). Each carries the scope it was minted with; what a
    // scope reaches is auth/control-tokens.ts. Persisted in /work/.intentic like owner/members.
    readonly controlTokens: ControlTokens;
    // This sandbox's identity for the platform's Connections card; undefined ⇒ /info returns {} (loopback/test).
    readonly info:
        | {
              readonly name: string;
              readonly image: string;
              readonly version: string;
              // The release channel this sandbox follows and the image it would roll back to — both runner-set
              // container env (see env.config.ts). Absent when this sandbox predates channels, or has never
              // been swapped, in which case the Update card offers no rollback.
              readonly channel?: string;
              readonly previousImage?: string;
          }
        | undefined;
    // Intent-declared internal MCP tools (constant for the sandbox), merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest (.intentic/capabilities.json) — DevOps/mcp/service/integration. Reads also
    // carry the daemon-provisioned free-trial endpoint when the platform serves one (trial/trial-endpoint.ts);
    // it is never written to the file.
    readonly capabilities: CapabilitiesStore;
    // Moves any credential still sitting in the READABLE manifest into the vault, answering the ids it moved.
    // A boot step (main.ts), and an invariant rather than a one-time conversion — the manifest is a file the
    // agent may edit, so a real value can arrive in it at any time (capabilities/capabilities-store.ts).
    readonly vaultManifestSecrets: () => Promise<readonly string[]>;
    // Every credential this sandbox stores under its stable name — the capability vault, the DevOps .env and
    // the deploy engine's generated values — read by the agent's masking (values → `{{secret:name}}`) and by
    // the two exits that resolve the same reference back (secrets/secret-registry.ts).
    readonly secretRegistry: () => Promise<readonly NamedSecret[]>;
    // The use ledger those exits feed — one row per resolved reference or typed field, joined onto the
    // secrets inventory as each entry's "last used" (secrets/secret-uses.ts).
    readonly secretUses: SecretUsesStore;
    // Whether this sandbox can chat before any AI account is connected, and how much of today's allowance is
    // left. Answered by the platform, so a sandbox with no platform never has one.
    readonly trial: TrialService;
    // Recommendations the owner has declined (.intentic/capability-dismissals.json), so a "no" survives the
    // page load that would otherwise re-derive the same suggestion straight back onto the catalog.
    readonly capabilityDismissals: DismissalsStore;
    // The named personas this sandbox shows the outside world (.intentic/personas.json) — which connected
    // accounts each speaks for. The turn path reads it to decide what a wake may act through.
    readonly personas: PersonasStore;
    // Scheduled agent wake-ups (.intentic/automations.json) — the scheduler polls it; /automations edits it.
    // Their run history is the untracked ledger beside it (.intentic/automation-runs.json), joined on read so
    // that nothing above this store knows the two are separate files.
    readonly automations: AutomationsStore;
    // Ralph loops (.intentic/loops.json): the pump drives them, /loops starts and stops them, and the record is
    // its own restart journal — a loop still marked `running` at boot is one the daemon died under.
    readonly loops: LoopsStore;
    // Saved loops (.intentic/loop-designs.json): the manifest half of the same feature — a loop's machinery with
    // its goal left out, so the composer can arm one and the message supplies the job.
    readonly loopDesigns: LoopDesignsStore;
    // Workflow designs (.intentic/workflows.json): a manifest the user authors and edits, changing at human
    // speed. /workflows edits it; nothing fires it on its own.
    readonly workflows: WorkflowsStore;
    // Workflow runs (.intentic/workflow-runs.json): the ledger the scheduler writes several times per step.
    // Kept out of the manifest so a run's writes cannot rewrite the user's designs, and so a run of a deleted
    // workflow stays readable — it snapshotted its definition. Its own restart journal, like the loops one.
    readonly workflowRuns: WorkflowRunsStore;
    // Maintenance evidence (.intentic/chores/): the probe cache the background runner fills, and the ledger of
    // what has been done about it. /chores reads both; @intentic/sandbox-contract/chores turns them into verdicts, in the
    // browser, where the panel and the rail badge share one computation.
    readonly chores: ChoresStore;
    // The background sweep that keeps the probe cache from expiring. Serialized across the whole sandbox and
    // skipped entirely while any turn is live — maintenance is the least urgent thing this daemon does.
    readonly probeRunner: ProbeRunner;
    // CI state (.intentic/ci.json): the webhook secret + the per repo+branch conclusion memory that makes a
    // success after a failure read as `pipeline_fixed`.
    readonly ciStore: CiStore;
    // The dependency verifier's memory (.intentic/verify.json): last check verdict per project + consecutive
    // red count — what makes `deps.fixed` an edge and lets a fix chore's guard cap its own retries.
    readonly verifyStore: VerifyStore;
    // The Pipelines view's read model: webhook deliveries freshen it, /ci/runs backfills it when stale.
    readonly ciRuns: RunsCache;
    // Keeps every mapped repo's provider webhook pointing at this sandbox; its warnings ride /ci/runs.
    readonly ciHooks: CiHookReconciler;
    // Wakes from `requireApproval` automations, held for the owner (.intentic/approvals/, one file per wake) —
    // the /automations pending routes approve (run the held wake) or reject them.
    readonly approvals: ApprovalsStore;
    // Which sandbox conversation each inbound THREAD owns (.intentic/thread-sessions.json) — a Doorbell
    // visitor's chat, a Discord or Slack channel. What makes a stream of messages one agent that remembers
    // instead of one fresh worktree per message; a thread past its TTL starts over.
    readonly threadSessions: ThreadSessionsStore;
    // Agent-proposed post drafts (.intentic/drafts/, one file per draft) — the agent writes them; /drafts is
    // the owner's approve/edit/reject side.
    readonly drafts: DraftsStore;
    // What is in flight right now (historyRoot/turns/, one file per in-flight turn or automation fire). Written
    // at the turn's start, cleared when it settles — so whatever is still there at boot is exactly what the
    // daemon died under, which is what turn-resume re-runs. On the HISTORY volume: it holds full prompts, and
    // it must outlive the container recreates (rebuild, update, dev-sandbox.sh swap) that cause the deaths.
    readonly turnJournal: TurnJournal;
    // What each conversation message can be put back to (historyRoot/turn-anchors.json) — a workspace
    // checkpoint for a main-tree turn, that conversation's own per-repo commits for an isolated one. Written at
    // every turn's start, read by the rewind route, by a fork asking for the files as they were, and by a
    // transcript being read back — see agent/turn-anchors.ts for why this is a map and not the commit.
    readonly turnAnchors: TurnAnchors;
    // The activity audit log (historyRoot/activity.jsonl, outside the agent's reach): inbound wakes,
    // sniffed outbound provider calls, voice sessions, failures. /activity reads it; only the daemon appends.
    readonly activity: ActivityStore;
    // The durable spend ledger (historyRoot/usage.jsonl, outside the agent's reach): one row per attributed
    // turn, NEVER pruned — unlike the activity log, whose rolling window makes spend totals shrink over time.
    // streamAgent appends at turn end; /usage/rollup and /system/usage project it.
    readonly usage: UsageStore;
    // Per-sandbox agent settings (.intentic/settings.json) — /settings edits it; streamAgent reads it to gate
    // per-turn agent behavior (iq plugin, hashline tools, output cleaning, prompt stability) and it carries the
    // owner's rule table (rules/rules.ts).
    readonly sandboxSettings: SandboxSettingsStore;
    // When each rule last did something (.intentic/rule-firings.json). Beside the settings rather than in them:
    // a firing is not an edit, so it must not make every push a write of the owner's configuration.
    readonly ruleFirings: RuleFiringsStore;
    // Web-push state: this sandbox's VAPID keypair + one entry per subscribed browser. On the HISTORY volume,
    // outside the agent's reach, because the private key can forge notifications to the owner's devices.
    readonly push: PushStore;
    // Sends those notifications. `notifyIfAway` (the turn/approval triggers) is suppressed while anyone is
    // actively watching; `notify` (the settings test button) always fires.
    readonly pushSender: PushSender;
    // Claude subscription accounts (one <id>.json per account under .intentic/auth/claude), several per sandbox.
    readonly claudeStore: ClaudeStore;
    // Which of those accounts an organization has switched Claude Code off for (claude/seats.json, beside them).
    // Kept apart from the account record because that record is rewritten whole on every token rotation, by every
    // sandbox sharing the auth dir — see claude-seats.ts. The picker skips a refused seat outright.
    readonly claudeSeats: ClaudeSeatStore;
    // The latest plan-limit snapshot per account of ANY provider (historyRoot/account-usage.json). streamAgent
    // records what a Claude turn's stream reports and the translator client records what it pulls for the
    // routed subscriptions; /claude/accounts and /translator/accounts each merge it into their own rows, so
    // every account the user can see reports its headroom from one place.
    readonly accountUsage: AccountUsageStore;
    // Keeps the Claude half of that store current for accounts NO turn is running on — the native counterpart
    // to cliProxy.refreshUsage. /claude/accounts waits on it (briefly) so a Usage tab reports what claude.ai
    // would report at that moment rather than what was true at the end of the last turn.
    readonly claudeUsage: ClaudeUsageRefresher;
    // The last time each PROVIDER refused a turn outright (historyRoot/provider-refusals.json) — a spent plan or
    // a credential the API would not take. The observed counterpart to the polled snapshot above: streamAgent
    // records it from the turn that was refused, and /agent/refusals serves it to the account surfaces, which
    // read the two together (a healthy meter beside a fresh refusal means the meter is stale).
    readonly providerRefusals: ProviderRefusalStore;
    // Every native provider's live model catalog, keyed by provider — what /providers/{provider}/models serves
    // the picker, what the quick model compares over, and what a routed turn validates its pick against. One
    // table rather than a field per provider, so those three readers do a lookup instead of each growing its own
    // chain over the five; see provider-catalogs.ts for what a catalog owes and what stays provider-specific.
    readonly providerCatalogs: Record<NativeProvider, ProviderCatalog>;
    // OpenAI/Codex's catalog is ALSO held directly, unlike the other four: a native Codex turn resolves its model
    // here so it never sends the SDK's rejected gpt-5-codex default, and a turn's self-heal `record`s the ids the
    // subscription proved valid. Neither is a question the shared table asks.
    readonly codexModels: CodexCatalog;
    // What each `endpoint` capability's own server publishes — the user's model APIs, wherever they run. Keyed by
    // capability id because these are user-created and unbounded, unlike the fixed native catalogs above, and
    // there is no seed floor: only the server can say what it serves. Read by the picker route, by the capability
    // card, and by the translator reconciler that turns each one into a routable provider.
    readonly endpointModels: EndpointCatalog;
    // The bundled translator (CLIProxyAPI): connects/lists/disconnects the routed providers' SUBSCRIPTION OAuth
    // (codex → ChatGPT, grok → SuperGrok, kimi → Kimi Code, gemini → Google). Codex, Kimi and Gemini have no
    // other credential. /translator drives the connect; streamAgent reads `accounts` to gate a routed turn.
    readonly cliProxy: CliProxyClient;
    // The sandbox-wide CODEX_HOME (sessions + the config.toml selecting the translator provider). The codex
    // adapter defaults to it, and the Claude agent's shell delegation points `codex` at it.
    readonly codexHome: string;
    // Whether a Codex thread's rollout still exists in the sandbox-wide CODEX_HOME, so a resume of a
    // deleted/lost thread opens a fresh thread seeded from the record instead of failing opaquely mid-turn.
    readonly codexThreadExists: (threadId: string) => Promise<boolean>;
    // The shared OpenCode runtime backing the Grok provider: the warm server/client plus xAI OAuth
    // connect/disconnect. OpenCode owns the xAI credential, so there's no GrokStore twin.
    readonly openCode: OpenCodeService;
    // The AI-provider credential root (also OpenCode's XDG_DATA_HOME) — the delegation note points the
    // agent's `opencode run` commands at it.
    readonly authRoot: string;
    // Daemon-owned workspace snapshots on /history (outside the agent's reach): auto-captured per turn + on an
    // interval, diffed and restored through the /history routes.
    readonly history: WorkspaceHistory;
    // The provider adapters — one function shape, four native agent runtimes. streamAgent picks per turn.
    readonly agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly codexAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly grokAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    // Gemini's native runtime: the SAME OpenCode loop grokAgent runs on, bound to a different model backend —
    // which is why it is built from the same factory rather than being a fourth adapter file.
    readonly geminiAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    // The generic ACP adapter serving every `agent`-kind capability (any provider id outside NATIVE_PROVIDERS);
    // streamAgent resolves the capability and passes it in. The pool keeps one warm subprocess per agent.
    readonly acpAgent: (id: string, config: AcpAgentConfig, request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly acpConnections: AcpConnections;
    // The Pi adapter serving the reserved `pi` agent-kind capability over Pi's RPC protocol — one process per
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
        // The unabbreviated HEAD sha — the form a sha-pinned capability config stores (extension revert).
        readonly fullHead: (dir: string) => Promise<string>;
        readonly sync: (dir: string) => Promise<GitSyncResult>;
        // The Changes review verbs (git/changes.ts): working-tree status split into the index and worktree sides,
        // the index moves, the two whole-repo commit shapes, per-path discard, and the per-side file diffs.
        readonly changedFiles: (dir: string) => Promise<{ branch?: string; conflicted: GitChange[]; staged: GitChange[]; unstaged: GitChange[] }>;
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
        readonly remoteState: (dir: string) => Promise<GitRemoteState>;
        readonly fetchRemote: (dir: string) => Promise<ActionResult>;
        readonly pullRemote: (dir: string) => Promise<ActionResult>;
        readonly pushBranch: (dir: string, options: { branch?: string }) => Promise<ActionResult>;
        // The working tree's two diffs, one per side the Changes panel lists — a partially staged file has two
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
        // file list, and the diff of whichever side the commit will record — a commit that stages first reads
        // the worktree (`all`, or just the `paths` it will stage), a bare one reads the index.
        readonly collectRepoDiff: (repo: string, dir: string, scope: CommitScope) => Promise<RepoDiff>;
        readonly commitChanges: (dir: string, sha: string) => Promise<GitChange[]>;
        readonly commitFileDiff: (dir: string, sha: string, path: string) => Promise<FileDiff>;
        // The halted-operation pair. Never something this daemon's own verbs leave behind (they abort
        // themselves) — this is for what a terminal left: an agent's `git rebase` that stopped on a conflict.
        readonly operationInProgress: (dir: string) => Promise<GitOperation | undefined>;
        readonly abortOperation: (dir: string, operation: GitOperation) => Promise<void>;
        /* The stash — the one part of a repository's real state nothing here used to read, so a `git stash` in a
         * terminal made the work invisible. An entry is a commit, which is why it reads like one. */
        readonly stashList: (dir: string) => Promise<StashEntry[]>;
        readonly stashChanges: (dir: string, ref: string) => Promise<GitChange[]>;
        readonly stashPush: (
            dir: string,
            options: { message?: string; includeUntracked?: boolean },
        ) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashApply: (dir: string, ref: string, pop: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>;
        readonly stashDrop: (dir: string, ref: string) => Promise<void>;
        // Walking the current branch back off its own reflog — the ref-level complement to a checkpoint restore.
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
    // The fleet registry (persisted at historyRoot/agents.json + runtime turn state) — one entry per isolated
    // conversation. streamAgent begins/observes/finishes turns; /agents lists, lands, and discards.
    readonly agents: AgentsRegistry;
    // The per-conversation worktree compositions on /history/worktrees (create/repair/remove/prune).
    readonly agentWorktrees: AgentWorktrees;
    // Everything a stopped conversation still holds — its processes, terminals, browsers, temp state — reclaimed
    // on the conversation's own stop clock. main starts it (container role only); archive/discard call its hard
    // stop (see platform/reaper.ts for the whole policy).
    readonly reaper: ResourceReaper;
    // Which copy of the workspace a file read means — the shared tree, or one conversation's checkout (see
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
        // One bounded window of a file's text, for the route the browser reads through — see
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
    // memory — /workspace/search runs in-process (no per-query CLI spawn), revalidation rides the workspace
    // watcher (main.ts) instead of the query path. The agent's Bash `iq` calls share the same on-disk index.
    // Indexing itself runs on the engine's own worker thread; only queries touch this one.
    readonly iq: ResidentEngine;
    readonly sessions: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<RestoredMessage[]>;
        readonly search: (dir: string, query: string, caseSensitive: boolean) => Promise<SessionSummary[]>;
        readonly exists: (dir: string, id: string) => Promise<boolean>;
    };
    /* A CONVERSATION's transcript, as opposed to a SESSION's — keyed by conversationId, which is the identity
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
        // What the conversation said, per side, cached against the record's size — what /agents/search matches
        // per entry per keystroke, instead of re-reading the whole store (see createSpokenLinesReader).
        readonly lines: (agent: TranscriptAgent) => Promise<readonly SpokenLine[]>;
        // How many messages are stored — the position the next turn starts at, which its checkpoint is filed
        // under so a rewind can address it (see transcript-record.ts).
        readonly count: (agent: TranscriptAgent) => Promise<number>;
        // Drop everything after the message a rewind went back to; returns how many went.
        readonly truncate: (agent: TranscriptAgent, keep: number) => Promise<number>;
    };
    /* Which conversations have been published as pages anyone with the link can read (historyRoot/shares.json).
     * The index only — the pages themselves live in the workspace's outbox. See share/share-store.ts. */
    readonly shares: ShareStore;
    // The composer's voice input: whisper.cpp over browser-recorded WAV utterances, with the serialized run
    // queue and the first-use model download that make it stateful (see speech/transcribe.ts).
    readonly speech: Speech;
    readonly purgeConversationState: NonNullable<AgentArchiveDeps["purgeConversationState"]>;
    // Attaches a batch of share names (`preview-<panel>` / `port-<slot>` labels) to this box's own account on
    // the tunnel fabric before the hostnames reach a browser; never rejects (see panels/preview-route.ts).
    readonly ensurePreviewRoutes: (labels: readonly string[]) => Promise<void>;
    // Shared-access grants — the emails authorized besides the owner. Always present; the /members routes read
    // and write it, and the authorizer consults it. The daemon is the enforcer; the platform only mirrors these.
    readonly members: MembersStore;
    // When set, the daemon is exposed directly and verifies the caller's bearer (a daemon-minted session, or a
    // Google ID token) on every route but /health; CORS is emitted for `allowOrigins`. Undefined ⇒ loopback mode
    // (tests / host-internal preview). authorizeOwner gates the owner-only member-management routes; mintSession
    // backs system.session — the Google-verified exchange that makes sessions the steady-state credential.
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
    // concurrent sandboxes can race a token refresh (recoverable: reconnect once) — split auth.json out /
    // per-provider locks if either bites.
    const authRoot = config.agentAuthDir !== "" ? config.agentAuthDir : statePath(workspace.root, ".intentic/auth/");
    // Base dir under which each Codex account gets its own CODEX_HOME (`<authRoot>/codex/<id>`); also the
    // adapter's default (the OPENAI_API_KEY fallback home when a turn resolved no account).
    const codexBase = join(authRoot, "codex");
    // Hoisted because two services share it: the turn stream records Claude's readings into it, and the
    // translator client both reads and records the routed subscriptions' through the same file.
    const accountUsage = fileAccountUsageStore(join(config.historyRoot, "account-usage.json"));
    const cliProxy = createCliProxyClient({
        managementUrl: cliProxyManagementUrl(config),
        token: config.translator.token,
        configPath: cliProxyConfigPath(config),
        usageStore: accountUsage,
    });
    // Hoisted above the OpenCode service (it is also a row in the provider table below): Gemini's NATIVE runtime
    // is that same OpenCode loop pointed at the translator, and OpenCode fixes provider config at spawn — so the
    // model ids have to be readable by the time it boots.
    const geminiModels = createGeminiCatalog(config, join(authRoot, "gemini", "models.json"));
    // Referenced twice below: as the openCode service field and to build the Grok adapter's runner. Its data dir
    // (OpenCode's XDG_DATA_HOME) is the credential root so xAI OAuth tokens persist across restarts.
    //
    // Gemini brings no credential of its own here — the translator holds Google's, exactly as it does for a
    // Gemini turn on the Claude Code harness. An unbaked translator (the dev profile) leaves the config absent
    // and the loop serves Grok alone.
    const openCode = createOpenCodeService(authRoot, {
        // Where a non-isolated conversation delegates from, and so the one directory whose delegation watcher is
        // worth opening at boot — event streams are per-directory, and a turn registers its own worktree itself.
        workspaceRoot: config.workspaceRoot,
        ...(config.translator.url === ""
            ? {}
            : {
                  gemini: {
                      baseUrl: config.translator.url,
                      token: config.translator.token,
                      models: async () => (await geminiModels.models()).models.map((model) => model.id),
                  },
              }),
    });
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
    const members = fileMembersStore(statePath(workspace.root, ".intentic/members.json"));
    // The session secret lives under historyRoot (like the activity/usage ledgers) — daemon-private, outside
    // the workspace, and persistent, so a daemon restart doesn't sign every browser out.
    const sessions = createSessions(join(config.historyRoot, "session-secret"));
    const authConnections = createAuthConnections();
    const browserAccess = fileBrowserAccess(join(config.historyRoot, "browser-access-disabled"));
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
                  session: sessions.verify,
                  owner: fileOwnerStore(statePath(workspace.root, ".intentic/owner.json")),
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

    const claudeStore = fileClaudeStore(join(authRoot, "claude"), logger);
    const claudeSeats = fileClaudeSeatStore(join(authRoot, "claude", "seats.json"), logger);
    // Reads each Claude account's plan limits into the store above. Hoisted here because two callers share it:
    // /claude/accounts waits on a sweep before answering, and main.ts keeps one running on a timer.
    const claudeUsage = createClaudeUsageRefresher({ store: claudeStore, usage: accountUsage });

    // Hoisted because it is BOTH a row in the provider table below and a member in its own right: a native Codex
    // turn resolves its model from it, and a turn's self-heal records the ids the subscription proved valid.
    // Claude's, Kimi's and Gemini's are locals — the table is the only thing that reads them.
    const codexModels = createCodexCatalog(config, join(codexBase, "models.json"));
    const providerCatalogs = createProviderCatalogs({
        claude: createClaudeCatalog(claudeStore, config, workspace.root, join(authRoot, "claude", "models.json")),
        codex: codexModels,
        gemini: geminiModels,
        kimi: createKimiCatalog(cliProxy),
        openCode,
    });

    // Hoisted: the members below that measure themselves (the worktree op chains, the git routes' Changes scan)
    // must file into the SAME tracker the summary line reads, or each would rank its own slice in isolation.
    const perf = createPerfTracker(logger);

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
        // together) — bulk agent-plane IO that must lose to the daemon's own loop under contention.
        politeGit,
    );
    // Hoisted: the Changes scan's per-file attribution reads the SAME registry the turns write to — a
    // second instance would answer from a stale agents.json.
    // The presences are held by name too, because their caches report into the resource series below.
    const landedPresences = createLandedPresences(agentWorktrees, logger);
    const agents = createAgentsRegistry(
        fileAgentsStore(join(config.historyRoot, "agents.json")),
        createLandStandings(agentWorktrees),
        landedPresences,
    );
    /* The reaper, keyed to the same three facts everything else keys to: whose work (the workload stamp),
     * whether it is live (the turn registry), and whether it is OURS (this registry knows the conversation).
     * The reserved owners answer for themselves — what the daemon keeps warm on purpose (the ACP/Pi pools, the
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
    // Hoisted like the presences above, and for the same reason: the attribution caches report into the
    // resource series — they are the structures whose silent growth was once the daemon's memory leak.
    const agentOrigins = createAgentOrigins({ agents, logger });
    // Hoisted: the CI hook reconciler reads the same manifest the routes edit.
    /* The free trial is laid OVER the manifest, never into it (trial/trial-endpoint.ts): every consumer of
     * `capabilities` — the translator's compat entries, the endpoint catalog, the picker's provider list —
     * therefore sees the trial as an ordinary endpoint and needs no knowledge of it, while the file on disk
     * stays exactly what the user put there. Availability is the platform's answer, probed on boot below. */
    const trial = createTrialService(config);
    /* And the one thing between the trial and a platform running on the developer's own machine: the bundled
     * translator opens the trial's connection itself and verifies the certificate, which a self-signed dev
     * platform cannot satisfy. Opens nothing at all against a deployed platform (platform/local-tunnel.ts). */
    const platformTunnel = startPlatformTunnel(config.platform.url, logger);
    const capabilityManifest = fileCapabilitiesStore(statePath(workspace.root, ".intentic/capabilities.json"), (id, reason) =>
        logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}) — the rest of the manifest is unaffected`),
    );
    /* The credential values, off /work (secret-vault.ts). Sited beside the AI-provider logins under
     * AGENT_AUTH_DIR, which is already outside the file routes, the tree walk and the search index. */
    const secretVault = fileSecretVault(join(authRoot, "capability-secrets.json"));
    /* The connector registry this needs to know which of an entry's fields are credentials, resolved against the
     * RAW manifest rather than the vaulted store — enumerating extensions reads capability entries, so pointing
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
            `capabilities: "${id}" holds non-string credential field(s) ${fields.join(", ")} — left in the manifest, which the agent can read`,
        );
    const capabilities = withTrialEndpoint(
        withSecretVault(capabilityManifest, secretVault, secretFieldConnectors, onUnvaultable),
        config,
        trial,
        platformTunnel,
    );
    const personas = filePersonasStore(statePath(workspace.root, ".intentic/personas.json"), (id, reason) =>
        logger.warn(`personas: skipping unreadable card "${id}" (${reason}) — the rest are unaffected`),
    );
    const ciStore = fileCiStore(statePath(workspace.root, ".intentic/ci.json"));
    const verifyStore = fileVerifyStore(statePath(workspace.root, ".intentic/verify.json"));
    // Hoisted: the background probe runner writes the same cache the /chores route reads, and a second store
    // instance would answer a poll from a file the runner had already moved past.
    const chores = fileChoresStore(join(workspace.root, PROBES_FILE), join(workspace.root, LEDGER_FILE));
    // Bound once, and against the SAME registry instance above — `sessionIdOf` answers from live turn state as
    // well as the persisted entry, so a second registry would report no session for a first turn still running.
    const turnAnchors = fileTurnAnchors(join(config.historyRoot, "turn-anchors.json"));
    const transcriptDeps: AgentTranscriptDeps = {
        record: fileTranscriptRecord(join(config.historyRoot, "transcripts")),
        turnAnchors,
        root: workspace.root,
        codexHome: codexBase,
        sessionIdOf: agents.sessionIdOf,
        readClaudeSession: readWorkspaceSession,
    };
    const transcriptLines = createSpokenLinesReader(transcriptDeps);
    /* A COLD INDEX REBUILD USED TO ANNOUNCE ITSELF NOWHERE, and that silence was the whole bug report.
     *
     * Rebuilding every vector in the workspace is ~30 minutes at four cores. Nothing said so: the machine simply
     * went busy, the index reported a sweep that never completed and a change queue that only grew, and no line
     * in this log connected the three. It reads exactly like a wedged worker, and it cost a full investigation
     * to find out it was working correctly the whole time.
     *
     * Logged at a human cadence — the first slice, every 30s after, and the finish — so the load has a name
     * while it is happening. `backlogActive` is what makes the closing line fire only for a backlog that was
     * actually announced: with no model configured the worker reports 0 forever, and a "complete" for work that
     * never started is noise. */
    const BACKLOG_LOG_MS = 30_000;
    let backlogLoggedAt = 0;
    let backlogActive = false;
    const iq = createResidentEngine({
        root: workspace.root,
        indexDir: statePath(workspace.root, ".intentic/cache/", "iq"),
        // An index pass that fails once warm() has settled has no caller to reject — without this the index
        // would stop tracking disk and search would just quietly get older.
        onIndexError: (error) => logger.warn({ err: error }, "iq index pass failed — search results may be stale"),
        onIndexProgress: (remaining) => {
            if (remaining === 0) {
                if (backlogActive) {
                    backlogActive = false;
                    logger.info("iq index embeddings complete — semantic search at full coverage");
                }
                return;
            }
            const now = Date.now();
            if (backlogActive && now - backlogLoggedAt < BACKLOG_LOG_MS) {
                return;
            }
            backlogActive = true;
            backlogLoggedAt = now;
            logger.info({ remaining }, "iq index building embeddings — semantic search fills in as it goes");
        },
        // The query worker owns the semantic scan and the cross-encoder. Losing it does not fail a search,
        // it silently narrows one to keyword matching — so it has to be visible here.
        onQueryError: (error) => logger.warn({ err: error }, "iq query worker failed — search fell back to keyword matching"),
        ...(config.iqModelDir !== "" ? { modelDir: config.iqModelDir } : {}),
        ...(config.iqRgPath !== "" ? { rgPath: config.iqRgPath } : {}),
    });

    /* The backend supervisor enumerates extensions through the finished services object (the same
     * ExtensionHost seam every other consumer uses), which does not exist until the literal below is built —
     * so it takes a thunk bound afterwards. Nothing calls it before main() starts the boot chain. */
    const servicesHolder: { current?: Services } = {};
    const services: Services = {
        config,
        logger,
        perf,
        resourceOwners: () => {
            const operations = perf.ranked();
            return {
                transcriptSearch: transcriptSearchMetrics(),
                conversationTranscriptSearch: transcriptLines.metrics(),
                agentOrigins: agentOrigins.metrics(),
                landedPresences: landedPresences.metrics(),
                iq: iq.metrics(),
                perf: { operations: operations.length, spans: operations.reduce((total, operation) => total + operation.count, 0) },
            };
        },
        // Born converged — main() declares the chain and closes the gate behind it, so a services object built
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
        secretRegistry: secretRegistryOf(secretVault, () => workspace.repos["desired-state"]),
        secretUses: fileSecretUses(statePath(workspace.root, ".intentic/secret-uses.json")),
        trial,
        capabilityDismissals: fileDismissalsStore(statePath(workspace.root, ".intentic/capability-dismissals.json")),
        personas,
        ciStore,
        verifyStore,
        ciRuns: createRunsCache(),
        ciHooks: createCiHookReconciler({ workspace, capabilities, ciStore, config, logger }),
        controlTokens: fileControlTokens(statePath(workspace.root, ".intentic/control-tokens.json")),
        automations: fileAutomationsStore(
            statePath(workspace.root, ".intentic/automations.json"),
            statePath(workspace.root, ".intentic/automation-runs.json"),
        ),
        loops: fileLoopsStore(statePath(workspace.root, ".intentic/loops.json")),
        loopDesigns: fileLoopDesignsStore(statePath(workspace.root, ".intentic/loop-designs.json")),
        workflows: fileWorkflowsStore(statePath(workspace.root, ".intentic/workflows.json")),
        workflowRuns: fileWorkflowRunsStore(statePath(workspace.root, ".intentic/workflow-runs.json")),
        chores,
        probeRunner: createProbeRunner({ workspace, chores, agents, logger }),
        approvals: fileApprovalsStore(statePath(workspace.root, ".intentic/approvals/")),
        threadSessions: fileThreadSessionsStore(statePath(workspace.root, ".intentic/thread-sessions.json")),
        drafts: fileDraftsStore(statePath(workspace.root, ".intentic/drafts/")),
        turnJournal: fileTurnJournal(join(config.historyRoot, "turns")),
        // The same instance the transcript reader holds — two would answer a read from a file the other had
        // already moved past, exactly the argument the chores store above makes.
        turnAnchors,
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        usage: fileUsageStore(join(config.historyRoot, "usage.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(statePath(workspace.root, ".intentic/settings.json")),
        ruleFirings: fileRuleFiringsStore(statePath(workspace.root, ".intentic/rule-firings.json")),
        push: pushStore,
        pushSender: createPushSender(pushStore, logger),
        claudeStore,
        claudeSeats,
        accountUsage,
        claudeUsage,
        providerRefusals: fileProviderRefusalStore(join(config.historyRoot, "provider-refusals.json")),
        providerCatalogs,
        codexModels,
        endpointModels: createEndpointCatalog(join(authRoot, "endpoints")),
        cliProxy,
        codexHome: codexBase,
        codexThreadExists: (threadId) => codexThreadExists(codexBase, threadId),
        openCode,
        authRoot,
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
        agent: runAgent,
        codexAgent: createCodexAgent({ codexHome: codexBase }),
        grokAgent: createGrokAgent(createGrokRunner(openCode)),
        // One warm OpenCode server serves both, so the runner is the same shape — only the model backend the
        // prompt names differs (opencode.ts registers it as an OpenAI-compatible provider on the translator).
        geminiAgent: createGrokAgent(createGrokRunner(openCode), OPENCODE_GEMINI_PROVIDER),
        acpAgent: createAcpAgent(acpConnections),
        acpConnections,
        // Pi sessions sit beside the other AI-provider state under authRoot, so a dev sandbox pointing
        // AGENT_AUTH_DIR at a stable dir keeps its Pi conversations resumable across resets too.
        piAgent: createPiAgent(piSpawner(join(authRoot, "pi", "sessions"))),
        // Bound to the daemon logger so every CLI run's lifecycle (spawn/kill/exit) is attributable from
        // daemon.log — the runs themselves are transient subprocesses whose absence proves nothing.
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
            search: searchWorkspaceSessions,
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
            append: (agent, messages) => transcriptDeps.record.append(agent.id, messages),
            lines: transcriptLines,
            count: (agent) => transcriptDeps.record.count(agent.id),
            truncate: (agent, keep) => transcriptDeps.record.truncate(agent.id, keep),
        },
        shares: fileShareStore(join(config.historyRoot, "shares.json")),
        speech: createSpeech({ workspaceRoot: workspace.root, log: (message) => logger.info(`speech: ${message}`) }),
        purgeConversationState: (removed, retained) => purgeConversationState(workspace.root, config.historyRoot, removed, retained),
        ensurePreviewRoutes: createPreviewRouteEnsurer(config, logger),
        members,
        auth,
    };
    servicesHolder.current = services;
    return services;
};
