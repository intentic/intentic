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
import { type ControlTokens, fileControlTokens } from "./auth/control-tokens.js";
import { createMediaTickets, type MediaTickets } from "./auth/media-tickets.js";
import { createWsTickets, type WsTickets } from "./auth/ws-tickets.js";
import { type ActivityStore, fileActivityStore } from "./activity/activity-store.js";
import { type AgentRequest, runAgent } from "./agent/agent.js";
import { type CliProxyClient, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/translator.js";
import { type ApprovalsStore, fileApprovalsStore } from "./automations/approvals-store.js";
import { type AutomationsStore, fileAutomationsStore } from "./automations/automations-store.js";
import { fileLoopsStore, type LoopsStore } from "./loops/loops-store.js";
import { fileWorkflowRunsStore, fileWorkflowsStore, type WorkflowRunsStore, type WorkflowsStore } from "./workflows/workflows-store.js";
import { type ChoresStore, fileChoresStore, LEDGER_FILE, PROBES_FILE } from "./chores/chores-store.js";
import { createProbeRunner, type ProbeRunner } from "./chores/probe-runner.js";
import { type CapabilitiesStore, fileCapabilitiesStore } from "./capabilities/capabilities-store.js";
import { type DismissalsStore, fileDismissalsStore } from "./capabilities/dismissals-store.js";
import { type CiStore, fileCiStore } from "./ci/ci-store.js";
import { fileVerifyStore, type VerifyStore } from "./workspace/verify-store.js";
import { type CiHookReconciler, createCiHookReconciler } from "./ci/hooks.js";
import { createRunsCache, type RunsCache } from "./ci/runs-cache.js";
import { fileKomodoStore, type KomodoStore } from "./komodo/komodo-store.js";
import { createAuthorizer, createGoogleVerifier, fileMembersStore, fileOwnerStore, type MembersStore, type VerifiedIdentity } from "./auth/auth.js";
import { createSessions, type MintedSession } from "./auth/session.js";
import { type ClaudeCatalog, createClaudeCatalog } from "./claude/claude-models.js";
import { type ClaudeStore, fileClaudeStore } from "./claude/claude-credentials.js";
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
import { fileRewindPoints, type RewindPoints } from "./agent/rewind-points.js";
import type { Config } from "./env.config.js";
import { createAgentsRegistry, type AgentsRegistry } from "./agents/agents-registry.js";
import { fileAgentsStore } from "./agents/agents-store.js";
import { createTurnIsolation, type TurnIsolation } from "./agents/isolation.js";
import { createAgentOrigins, type AgentOrigins } from "./agents/origins.js";
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
import { type GeminiCatalog, createGeminiCatalog } from "./gemini/gemini-catalog.js";
import { createGrokAgent, createGrokRunner } from "./grok/grok-agent.js";
import { createOpenCodeService, type OpenCodeService } from "./grok/opencode.js";
import { type KimiCatalog, createKimiCatalog } from "./kimi/kimi-catalog.js";
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
import { readSessionPrompts } from "./sessions/prompt-index.js";
import { fileThreadSessionsStore, type ThreadSessionsStore } from "./sessions/thread-sessions.js";
import {
    agentTranscript,
    type AgentTranscriptDeps,
    createAgentPromptsReader,
    storedTranscript,
    type TranscriptAgent,
} from "./sessions/agent-transcript.js";
import { fileTranscriptRecord } from "./sessions/transcript-record.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { type BootTracker, createBootTracker } from "./platform/boot.js";
import { createPerfTracker, type PerfTracker } from "./platform/perf.js";
import { postToPlatform, type PlatformResponse } from "./platform/platform-client.js";
import { createTerminalRunner, type TerminalRunner } from "./terminal/terminal-run.js";
import { panePids } from "./terminal/terminal-session.js";
import { version } from "./version.js";
import { type AgentTool, internalTools } from "./agent/agent-tools.js";
import { type UsageStore, fileUsageStore } from "./usage/usage-store.js";
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
import { statePath } from "./workspace/state-paths.js";

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
    // Where the boot chain is. main.ts declares its steps and drives it; app.ts gates every data route on its
    // `converged` promise, and /events streams its progress so the browser can WAIT VISIBLY instead of firing
    // a workspace's worth of reads at a daemon that will only park them (see platform/boot.ts).
    readonly boot: BootTracker;
    readonly workspace: WorkspacePaths;
    // Per-repository operator panels: the in-memory process manager the /panels routes and the preview proxy
    // drive (discovery of which repo has a panel is convention-only — see panels/panels.ts).
    readonly processes: ManagedProcesses;
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
    // A per-boot secret the in-container `vpn` CLI presents (x-intentic-agent), written to a 0600 file at
    // AGENT_TOKEN_PATH so the agent's shell and the owner's terminals can both read it. UNLIKE panelToken it is
    // scoped hard to the /vpn routes (vpnScoped in app.ts): the agent may dial and drop the owner's tunnels,
    // never read the credentials behind them. Never leaves the container.
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
    // The unified capability manifest (.intentic/capabilities.json) — DevOps/mcp/service/integration.
    readonly capabilities: CapabilitiesStore;
    // Recommendations the owner has declined (.intentic/capability-dismissals.json), so a "no" survives the
    // page load that would otherwise re-derive the same suggestion straight back onto the catalog.
    readonly capabilityDismissals: DismissalsStore;
    // Scheduled agent wake-ups (.intentic/automations.json) — the scheduler polls it; /automations edits it.
    readonly automations: AutomationsStore;
    // Ralph loops (.intentic/loops.json): the pump drives them, /loops starts and stops them, and the record is
    // its own restart journal — a loop still marked `running` at boot is one the daemon died under.
    readonly loops: LoopsStore;
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
    // When the owner last looked at each connected Komodo's deployments (.intentic/komodo.json) — what
    // silences the Deployments rail badge for incidents already read.
    readonly komodoStore: KomodoStore;
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
    // Which checkpoint each conversation message can be restored to (historyRoot/rewind-points.json). Written
    // at every main-tree turn's start beside the `checkpoint` frame, read by the rewind route and by a
    // transcript being read back — see agent/rewind-points.ts for why this is a map and not the commit.
    readonly rewindPoints: RewindPoints;
    // The activity audit log (historyRoot/activity.jsonl, outside the agent's reach): inbound wakes,
    // sniffed outbound provider calls, voice sessions, failures. /activity reads it; only the daemon appends.
    readonly activity: ActivityStore;
    // The durable spend ledger (historyRoot/usage.jsonl, outside the agent's reach): one row per attributed
    // turn, NEVER pruned — unlike the activity log, whose rolling window makes spend totals shrink over time.
    // streamAgent appends at turn end; /usage/rollup and /system/usage project it.
    readonly usage: UsageStore;
    // Per-sandbox agent settings (.intentic/settings.json) — /settings edits it; streamAgent reads it to gate
    // per-turn agent behavior (iq plugin, hashline tools, output cleaning, prompt stability).
    readonly sandboxSettings: SandboxSettingsStore;
    // Web-push state: this sandbox's VAPID keypair + one entry per subscribed browser. On the HISTORY volume,
    // outside the agent's reach, because the private key can forge notifications to the owner's devices.
    readonly push: PushStore;
    // Sends those notifications. `notifyIfAway` (the turn/approval triggers) is suppressed while anyone is
    // actively watching; `notify` (the settings test button) always fires.
    readonly pushSender: PushSender;
    // Claude subscription accounts (one <id>.json per account under .intentic/claude), several per sandbox.
    readonly claudeStore: ClaudeStore;
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
    // Claude's live model catalog from the Agent SDK's supportedModels() (alias fallback, never empty). Serves
    // /claude/models for the picker so new tiers + effort levels need no code change.
    readonly claudeModels: ClaudeCatalog;
    // OpenAI/Codex's live model catalog (discovery → persisted → seed floor, never empty). A Codex turn resolves
    // its model here so it never sends the SDK's rejected gpt-5-codex default; /codex/models serves the picker;
    // a turn's self-heal `record`s the ids the subscription proved valid.
    readonly codexModels: CodexCatalog;
    // Kimi Code's model catalog from CLIProxyAPI's provider-scoped definitions (seed floor, never empty).
    // The same translator owns the subscription and executes each Kimi turn; /kimi/models serves the picker.
    readonly kimiModels: KimiCatalog;
    // Gemini's live model catalog, read from the translator's /v1/models (persisted → seed floor, never empty).
    // A Gemini turn resolves its model here; /gemini/models serves the picker. There is no geminiStore twin:
    // Gemini is routed-only, so the translator owns the credential.
    readonly geminiModels: GeminiCatalog;
    // What each `endpoint` capability's own server publishes — the user's model APIs, wherever they run. Keyed by
    // capability id because these are user-created and unbounded, unlike the four fixed catalogs above, and there
    // is no seed floor: only the server can say what it serves. Read by the picker route, by the capability card,
    // and by the translator reconciler that turns each one into a routable provider.
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
    // The provider adapters — one function shape, three native agent runtimes. streamAgent picks per turn.
    readonly agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly codexAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly grokAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    // The generic ACP adapter serving every `agent`-kind capability (any provider id outside NATIVE_PROVIDERS);
    // streamAgent resolves the capability and passes it in. The pool keeps one warm subprocess per agent.
    readonly acpAgent: (id: string, config: AcpAgentConfig, request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly acpConnections: AcpConnections;
    readonly intentic: (run: IntenticRun, signal?: AbortSignal) => AsyncGenerator<IntenticLine>;
    readonly git: {
        readonly init: (dir: string, separateGitDir?: string) => Promise<void>;
        readonly status: (dir: string) => Promise<GitStatus>;
        readonly listFiles: (dir: string) => Promise<string[]>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly clone: (parentDir: string, name: string, cloneUrl: string, options?: GitCloneOptions) => Promise<void>;
        readonly checkout: (dir: string, ref: string) => Promise<void>;
        readonly head: (dir: string) => Promise<string>;
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
        readonly search: (dir: string, query: string) => Promise<SessionSummary[]>;
        // The user's own prompts in one session, for the fleet filter (agents.search matches them per AGENT,
        // which the session list can't do — only the registry knows which session a card owns, and the
        // archive's are off that list entirely). Cached and append-fed daemon-side; see sessions/prompt-index.ts.
        readonly prompts: (dir: string, id: string) => Promise<readonly string[]>;
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
        // The conversation's user prompts, cached against the record's size — what /agents/search matches per
        // entry per keystroke, instead of re-reading the whole store (see createAgentPromptsReader).
        readonly prompts: (agent: TranscriptAgent) => Promise<readonly string[]>;
        // How many messages are stored — the position the next turn starts at, which its checkpoint is filed
        // under so a rewind can address it (see transcript-record.ts).
        readonly count: (agent: TranscriptAgent) => Promise<number>;
        // Drop everything after the message a rewind went back to; returns how many went.
        readonly truncate: (agent: TranscriptAgent, keep: number) => Promise<number>;
    };
    // platformHostTunnel relays to the platform (connect-token auth) to mint an intentic-provided host tunnel,
    // which needs intentic's platform Cloudflare account the daemon doesn't hold.
    readonly platformHostTunnel: (hostName: string) => Promise<PlatformResponse>;
    // Relays to the platform (connect-token auth) to mint a batch of preview routes (`preview-<panel>` /
    // `port-<slot>` labels) on the sandbox's intentic-provided tunnel before the hostnames reach a browser;
    // never rejects (see panels/preview-route.ts).
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
              readonly authorize: (bearer: string, firstBind: string | undefined) => Promise<VerifiedIdentity>;
              readonly authorizeOwner: (bearer: string) => Promise<void>;
              readonly mintSession: (identity: VerifiedIdentity) => Promise<MintedSession>;
              // Re-key the session signer: every browser holding a session for this sandbox is signed out at
              // once (auth/session.ts rotate). Backs the owner-only "sign out everywhere" route.
              readonly rotateSessions: () => Promise<void>;
              // The browser origins CORS is emitted for (config.webOrigin, split on commas). Never a wildcard:
              // /health answers without a credential, so this is the only gate in front of it.
              readonly allowOrigins: readonly string[];
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
    const authRoot = config.agentAuthDir !== "" ? config.agentAuthDir : join(workspace.root, ".intentic");
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
    // Referenced twice below: as the openCode service field and to build the Grok adapter's runner. Its data dir
    // (OpenCode's XDG_DATA_HOME) is the credential root so xAI OAuth tokens persist across restarts.
    const openCode = createOpenCodeService(authRoot);
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
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
                  session: sessions.verify,
                  owner: fileOwnerStore(statePath(workspace.root, ".intentic/owner.json")),
                  members,
                  ...(config.connectToken !== "" ? { connectToken: config.connectToken } : {}),
                  ...(config.owner.email !== "" ? { expectedOwner: config.owner.email } : {}),
              })
            : undefined;
    const auth = authorizer
        ? {
              authorize: authorizer.authorize,
              authorizeOwner: authorizer.authorizeOwner,
              mintSession: sessions.mint,
              rotateSessions: sessions.rotate,
              // Comma-separated so one sandbox can serve the hosted SPA and a local dev origin at once. Never
              // empty in practice — env.config collapses a blank WEB_ORIGIN onto the hosted default.
              allowOrigins: config.webOrigin
                  .split(",")
                  .map((origin) => origin.trim())
                  .filter((origin) => origin !== ""),
          }
        : undefined;

    const claudeStore = fileClaudeStore(join(authRoot, "claude"), logger);
    // Reads each Claude account's plan limits into the store above. Hoisted here because two callers share it:
    // /claude/accounts waits on a sweep before answering, and main.ts keeps one running on a timer.
    const claudeUsage = createClaudeUsageRefresher({ store: claudeStore, usage: accountUsage });

    // Hoisted: the members below that measure themselves (the worktree op chains, the git routes' Changes scan)
    // must file into the SAME tracker the summary line reads, or each would rank its own slice in isolation.
    const perf = createPerfTracker(logger);

    // Hoisted (not inline in the literal below): the ACP connection pool implements ACP terminal/* over the
    // same runner, so both must share one instance (and its `visible` gate).
    const terminalRun = createTerminalRunner();
    const acpConnections = createAcpConnections(logger, terminalRun);
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
    const agents = createAgentsRegistry(fileAgentsStore(join(config.historyRoot, "agents.json")), createLandStandings(agentWorktrees));
    // Hoisted: the CI hook reconciler reads the same manifest the routes edit.
    const capabilities = fileCapabilitiesStore(statePath(workspace.root, ".intentic/capabilities.json"), (id, reason) =>
        logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}) — the rest of the manifest is unaffected`),
    );
    const ciStore = fileCiStore(statePath(workspace.root, ".intentic/ci.json"));
    const verifyStore = fileVerifyStore(statePath(workspace.root, ".intentic/verify.json"));
    // Hoisted: the background probe runner writes the same cache the /chores route reads, and a second store
    // instance would answer a poll from a file the runner had already moved past.
    const chores = fileChoresStore(join(workspace.root, PROBES_FILE), join(workspace.root, LEDGER_FILE));
    // Bound once, and against the SAME registry instance above — `sessionIdOf` answers from live turn state as
    // well as the persisted entry, so a second registry would report no session for a first turn still running.
    const rewindPoints = fileRewindPoints(join(config.historyRoot, "rewind-points.json"));
    const transcriptDeps: AgentTranscriptDeps = {
        record: fileTranscriptRecord(join(config.historyRoot, "transcripts")),
        rewindPoints,
        root: workspace.root,
        codexHome: codexBase,
        sessionIdOf: agents.sessionIdOf,
        readClaudeSession: readWorkspaceSession,
    };

    return {
        config,
        logger,
        perf,
        // Born converged — main() declares the chain and closes the gate behind it, so a services object built
        // for a test or the host-internal preview has nothing to wait for.
        boot: createBootTracker(logger),
        workspace,
        processes: createManagedProcesses(),
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
        capabilityDismissals: fileDismissalsStore(statePath(workspace.root, ".intentic/capability-dismissals.json")),
        ciStore,
        verifyStore,
        ciRuns: createRunsCache(),
        ciHooks: createCiHookReconciler({ workspace, capabilities, ciStore, config, logger }),
        komodoStore: fileKomodoStore(statePath(workspace.root, ".intentic/komodo.json")),
        controlTokens: fileControlTokens(statePath(workspace.root, ".intentic/control-tokens.json")),
        automations: fileAutomationsStore(statePath(workspace.root, ".intentic/automations.json")),
        loops: fileLoopsStore(statePath(workspace.root, ".intentic/loops.json")),
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
        rewindPoints,
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        usage: fileUsageStore(join(config.historyRoot, "usage.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(statePath(workspace.root, ".intentic/settings.json")),
        push: pushStore,
        pushSender: createPushSender(pushStore, logger),
        claudeStore,
        accountUsage,
        claudeUsage,
        providerRefusals: fileProviderRefusalStore(join(config.historyRoot, "provider-refusals.json")),
        claudeModels: createClaudeCatalog(claudeStore, config, workspace.root, join(authRoot, "claude", "models.json")),
        codexModels: createCodexCatalog(config, join(codexBase, "models.json")),
        kimiModels: createKimiCatalog(cliProxy),
        geminiModels: createGeminiCatalog(config, join(authRoot, "gemini", "models.json")),
        endpointModels: createEndpointCatalog(join(authRoot, "endpoints")),
        cliProxy,
        codexHome: codexBase,
        codexThreadExists: (threadId) => codexThreadExists(codexBase, threadId),
        openCode,
        authRoot,
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
        agent: runAgent,
        codexAgent: createCodexAgent(codexBase),
        grokAgent: createGrokAgent(createGrokRunner(openCode)),
        acpAgent: createAcpAgent(acpConnections),
        acpConnections,
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
        turnIsolation,
        agentOrigins: createAgentOrigins({ agents, logger }),
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
        iq: createResidentEngine({
            root: workspace.root,
            // An index pass that fails once warm() has settled has no caller to reject — without this the index
            // would stop tracking disk and search would just quietly get older.
            onIndexError: (error) => logger.warn({ err: error }, "iq index pass failed — search results may be stale"),
            ...(config.iqModelDir !== "" ? { modelDir: config.iqModelDir } : {}),
            ...(config.iqRgPath !== "" ? { rgPath: config.iqRgPath } : {}),
        }),
        sessions: {
            list: listWorkspaceSessions,
            read: readWorkspaceSession,
            search: searchWorkspaceSessions,
            prompts: readSessionPrompts,
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
            prompts: createAgentPromptsReader(transcriptDeps),
            count: (agent) => transcriptDeps.record.count(agent.id),
            truncate: (agent, keep) => transcriptDeps.record.truncate(agent.id, keep),
        },
        platformHostTunnel: (hostName) => postToPlatform(config, "/sandbox/host-tunnel", { hostName }),
        ensurePreviewRoutes: createPreviewRouteEnsurer(config, logger),
        members,
        auth,
    };
};
