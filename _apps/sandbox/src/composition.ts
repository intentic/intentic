import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
    AcpAgentConfig,
    AgentEvent,
    FileDiff,
    GitBranch,
    GitChange,
    GitCommit,
    GitRemoteState,
    IntenticLine,
    RestoredMessage,
    WorkspaceChildren,
    WorkspaceTree,
} from "@intentic/sandbox-contract";
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
import { type BridgeTokens, fileBridgeTokens } from "./auth/bridge-tokens.js";
import { type ActivityStore, fileActivityStore } from "./activity/activity-store.js";
import { type AgentRequest, runAgent } from "./agent/agent.js";
import { type CliProxyClient, cliProxyConfigPath, cliProxyManagementUrl, createCliProxyClient } from "./agent/translator.js";
import { type ApprovalsStore, fileApprovalsStore } from "./automations/approvals-store.js";
import { type AutomationsStore, fileAutomationsStore } from "./automations/automations-store.js";
import { type CapabilitiesStore, fileCapabilitiesStore } from "./capabilities/capabilities-store.js";
import { type CiStore, fileCiStore } from "./ci/ci-store.js";
import { type CiHookReconciler, createCiHookReconciler } from "./ci/hooks.js";
import { createRunsCache, type RunsCache } from "./ci/runs-cache.js";
import { fileGateStore, type GateStore } from "./gate/gate-store.js";
import { createAuthorizer, createGoogleVerifier, fileMembersStore, fileOwnerStore, type MembersStore, type VerifiedIdentity } from "./auth/auth.js";
import { createSessions, type MintedSession } from "./auth/session.js";
import { type ClaudeCatalog, createClaudeCatalog } from "./claude/claude-models.js";
import { type ClaudeStore, fileClaudeStore } from "./claude/claude-credentials.js";
import { type ClaudeUsageStore, fileClaudeUsageStore } from "./claude/claude-usage.js";
import { createCodexAgent } from "./codex/codex-agent.js";
import { type CodexCatalog, createCodexCatalog } from "./codex/codex-catalog.js";
import { codexThreadExists } from "./sessions/codex-sessions.js";
import { type DraftsStore, fileDraftsStore } from "./drafts/drafts-store.js";
import { fileTurnJournal, type TurnJournal } from "./agent/turn-journal.js";
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
    changesAgainstBase,
    changesBetweenRefs,
    checkoutRef,
    cherryPick,
    commitChanges,
    commitFileDiff,
    commitIndex,
    commitLog,
    createBranchAt,
    createTagAt,
    discardPaths,
    dropCommit,
    mergeCommit,
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
import { collectRepoDiff, type RepoDiff } from "./git/commit-message.js";
import { createBranch, deleteBranch, listBranches } from "./git/branches.js";
import { fetchRemote, pullRemote, pushBranch, remoteState } from "./git/remote.js";
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
import { type ListeningPort, scanListeningPorts } from "./ports/port-scan.js";
import {
    listWorkspaceSessions,
    readWorkspaceSession,
    searchWorkspaceSessions,
    type SessionSummary,
    workspaceSessionExists,
} from "./sessions/sessions.js";
import { readSessionPrompts } from "./sessions/prompt-index.js";
import { agentTranscript, type AgentTranscriptDeps, storedTranscript, type TranscriptAgent } from "./sessions/agent-transcript.js";
import { fileTranscriptRecord } from "./sessions/transcript-record.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { type BootTracker, createBootTracker } from "./platform/boot.js";
import { postToPlatform, type PlatformResponse } from "./platform/platform-client.js";
import { createTerminalRunner, type TerminalRunner } from "./terminal/terminal-run.js";
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

// The daemon's collaborators, wired once at boot and handed to the route factories — the injection seam the
// route tests build fakes against (the equivalent of the old createDaemon `deps` object). Stateful members
// (appProcesses, the agent/intentic process runners, the credential/tool stores) live here; the in-memory
// plan/question bridge stays a module singleton in agent-requests.ts (the agent routes call it directly).
export interface Services {
    readonly config: Config;
    readonly logger: Logger;
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
    // Discovers every listening TCP socket via procfs — the /ports routes' discovery seam.
    readonly scanPorts: () => Promise<ListeningPort[]>;
    // Runs user-triggered shell commands inside visible job-* tmux sessions (window per command) — the
    // surfacing substrate for capability adds and the infra check (see terminal-run.ts for the principle).
    readonly terminalRun: TerminalRunner;
    // A per-boot secret injected into every panel process (INTENTIC_PANEL_TOKEN) so a panel's own backend can
    // call the daemon from inside the sandbox without the browser's Google token. Never leaves the container.
    readonly panelToken: string;
    // A per-boot secret the in-container `vpn` CLI presents (x-intentic-agent), written to a 0600 file at
    // AGENT_TOKEN_PATH so the agent's shell and the owner's terminals can both read it. UNLIKE panelToken it is
    // scoped hard to the /vpn routes (vpnScoped in app.ts): the agent may dial and drop the owner's tunnels,
    // never read the credentials behind them. Never leaves the container.
    readonly agentToken: string;
    // Owner-minted, hashed, revocable tokens for the ACP editor bridge (x-intentic-bridge header) — scoped to
    // the agent-conversation routes by bridgeScoped. Persisted in /work/.intentic like owner/members.
    readonly bridgeTokens: BridgeTokens;
    // This sandbox's identity for the platform's Connections card; undefined ⇒ /info returns {} (loopback/test).
    readonly info: { readonly name: string; readonly image: string; readonly version: string } | undefined;
    // Intent-declared internal MCP tools (constant for the sandbox), merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest (.intentic/capabilities.json) — DevOps/mcp/service/integration.
    readonly capabilities: CapabilitiesStore;
    // Scheduled agent wake-ups (.intentic/automations.json) — the scheduler polls it; /automations edits it.
    readonly automations: AutomationsStore;
    // CI state (.intentic/ci.json): the webhook secret + the per repo+branch conclusion memory that makes a
    // success after a failure read as `pipeline_fixed`.
    readonly ciStore: CiStore;
    // The landing gate's last verdict (.intentic/gate.json) — see gate/gate-store.ts. The gate SERVICE is a
    // module singleton rather than a member here (gate/gate.ts): it needs a WakeFn, and taking one would put
    // composition downstream of agent.routes.
    readonly gateStore: GateStore;
    // The Pipelines view's read model: webhook deliveries freshen it, /ci/runs backfills it when stale.
    readonly ciRuns: RunsCache;
    // Keeps every mapped repo's provider webhook pointing at this sandbox; its warnings ride /ci/runs.
    readonly ciHooks: CiHookReconciler;
    // Wakes from `requireApproval` automations, held for the owner (.intentic/approvals/, one file per wake) —
    // the /automations pending routes approve (run the held wake) or reject them.
    readonly approvals: ApprovalsStore;
    // Agent-proposed post drafts (.intentic/drafts/, one file per draft) — the agent writes them; /drafts is
    // the owner's approve/edit/reject side.
    readonly drafts: DraftsStore;
    // What is in flight right now (historyRoot/turns/, one file per in-flight turn or automation fire). Written
    // at the turn's start, cleared when it settles — so whatever is still there at boot is exactly what the
    // daemon died under, which is what turn-resume re-runs. On the HISTORY volume: it holds full prompts, and
    // it must outlive the container recreates (rebuild, update, dev-sandbox.sh swap) that cause the deaths.
    readonly turnJournal: TurnJournal;
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
    // The latest usage-window snapshot per Claude account (historyRoot/claude-usage.json). streamAgent records
    // what the turn stream reports; /claude/accounts merges it in so the picker shows each account's headroom.
    readonly claudeUsage: ClaudeUsageStore;
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
    // The bundled translator (CLIProxyAPI): connects/lists/disconnects the routed providers' SUBSCRIPTION OAuth
    // (codex → ChatGPT, grok → SuperGrok, kimi → Kimi Code, gemini → Google). Codex, Kimi and Gemini have no
    // other credential. /translator drives the connect; streamAgent reads `accounts` to gate a routed turn.
    readonly cliProxy: CliProxyClient;
    // The sandbox-wide CODEX_HOME (sessions + the config.toml selecting the translator provider). The codex
    // adapter defaults to it, and the Claude agent's shell delegation points `codex` at it.
    readonly codexHome: string;
    // Whether a Codex thread's rollout still exists in the sandbox-wide CODEX_HOME, so a resume of a
    // deleted/lost thread surfaces session-not-found instead of an opaque mid-turn failure.
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
        readonly createBranch: (dir: string, name: string, start: string | undefined, checkout: boolean) => Promise<void>;
        readonly deleteBranch: (dir: string, name: string, force: boolean) => Promise<void>;
        readonly remoteState: (dir: string) => Promise<GitRemoteState>;
        readonly fetchRemote: (dir: string) => Promise<ActionResult>;
        readonly pullRemote: (dir: string) => Promise<ActionResult>;
        readonly pushBranch: (dir: string, options: { branch?: string }) => Promise<ActionResult>;
        // The working tree's two diffs, one per side the Changes panel lists — a partially staged file has two
        // of them, and HEAD↔worktree is neither. `fileDiff`'s `ref` is the before side for the AGENTS review,
        // whose worktree has no index to split (a conversation's recorded base sha).
        readonly stagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly unstagedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly conflictedFileDiff: (dir: string, path: string) => Promise<FileDiff>;
        readonly fileDiff: (dir: string, path: string, ref: string) => Promise<FileDiff>;
        readonly changesAgainstBase: (dir: string, base: string) => Promise<GitChange[]>;
        // The same two reads for an ARCHIVED agent, whose checkout is retired: both sides come from refs in the
        // main repo (shared object store) rather than from a working tree that no longer exists.
        readonly changesBetweenRefs: (dir: string, base: string, tip: string) => Promise<GitChange[]>;
        readonly refFileDiff: (dir: string, path: string, base: string, tip: string) => Promise<FileDiff>;
        // The git-history graph (read-only): one repo's commit log across all refs, and lazy per-commit detail
        // (changed files, then a file's before/after AT the commit).
        readonly commitLog: (dir: string, limit: number) => Promise<{ branch?: string; commits: GitCommit[] }>;
        // What one repo contributes to an AI-drafted commit message: its recent subjects (the house style), the
        // file list, and the diff of whichever side the commit will record — `all` reads the worktree the way
        // "Commit all" does, absent reads the index the way a bare commit does.
        readonly collectRepoDiff: (repo: string, dir: string, all: boolean) => Promise<RepoDiff>;
        readonly commitChanges: (dir: string, sha: string) => Promise<GitChange[]>;
        readonly commitFileDiff: (dir: string, sha: string, path: string) => Promise<FileDiff>;
        // Graph write actions (VSCode "Git Graph" parity). Non-destructive refs (branch/tag) and the
        // HEAD-movers (checkout/reset) return void + propagate git errors; the sequence ops return an
        // ActionResult so a conflict is a value. The route auto-checkpoints every destructive one.
        readonly createBranchAt: (dir: string, name: string, sha: string) => Promise<void>;
        readonly createTagAt: (dir: string, name: string, sha: string) => Promise<void>;
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
        readonly append: (agent: TranscriptAgent, messages: readonly RestoredMessage[]) => Promise<void>;
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
    // Google ID token) on every route but /health; CORS is emitted for `allowOrigin`. Undefined ⇒ loopback mode
    // (tests / host-internal preview). authorizeOwner gates the owner-only member-management routes; mintSession
    // backs system.session — the Google-verified exchange that makes sessions the steady-state credential.
    readonly auth:
        | {
              readonly authorize: (bearer: string, firstBind: string | undefined) => Promise<VerifiedIdentity>;
              readonly authorizeOwner: (bearer: string) => Promise<void>;
              readonly mintSession: (identity: VerifiedIdentity) => Promise<MintedSession>;
              readonly allowOrigin?: string;
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
    const cliProxy = createCliProxyClient({
        managementUrl: cliProxyManagementUrl(config),
        token: config.translator.token,
        configPath: cliProxyConfigPath(config),
    });
    // Referenced twice below: as the openCode service field and to build the Grok adapter's runner. Its data dir
    // (OpenCode's XDG_DATA_HOME) is the credential root so xAI OAuth tokens persist across restarts.
    const openCode = createOpenCodeService(authRoot);
    const info =
        config.sandbox.name !== "" && config.sandbox.image !== "" ? { name: config.sandbox.name, image: config.sandbox.image, version } : undefined;
    const members = fileMembersStore(join(workspace.root, ".intentic", "members.json"));
    // The session secret lives under historyRoot (like the activity/usage ledgers) — daemon-private, outside
    // the workspace, and persistent, so a daemon restart doesn't sign every browser out.
    const sessions = createSessions(join(config.historyRoot, "session-secret"));
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
                  session: sessions.verify,
                  owner: fileOwnerStore(join(workspace.root, ".intentic", "owner.json")),
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
              ...(config.webOrigin !== "" ? { allowOrigin: config.webOrigin } : {}),
          }
        : undefined;

    const claudeStore = fileClaudeStore(join(authRoot, "claude"), logger);

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
        },
        // Demoted git: a worktree ensure is a whole-monorepo checkout (and several conversations start
        // together) — bulk agent-plane IO that must lose to the daemon's own loop under contention.
        politeGit,
    );
    // Hoisted: the Changes scan's per-file attribution reads the SAME registry the turns write to — a
    // second instance would answer from a stale agents.json.
    const agents = createAgentsRegistry(fileAgentsStore(join(config.historyRoot, "agents.json")), createLandStandings(agentWorktrees));
    // Hoisted: the CI hook reconciler reads the same manifest the routes edit.
    const capabilities = fileCapabilitiesStore(join(workspace.root, ".intentic", "capabilities.json"), (id, reason) =>
        logger.warn(`capabilities: skipping unreadable entry "${id}" (${reason}) — the rest of the manifest is unaffected`),
    );
    const ciStore = fileCiStore(join(workspace.root, ".intentic", "ci.json"));
    const gateStore = fileGateStore(join(workspace.root, ".intentic", "gate.json"));
    // Bound once, and against the SAME registry instance above — `sessionIdOf` answers from live turn state as
    // well as the persisted entry, so a second registry would report no session for a first turn still running.
    const transcriptDeps: AgentTranscriptDeps = {
        record: fileTranscriptRecord(join(config.historyRoot, "transcripts")),
        root: workspace.root,
        codexHome: codexBase,
        sessionIdOf: agents.sessionIdOf,
        readClaudeSession: readWorkspaceSession,
    };

    return {
        config,
        logger,
        // Born converged — main() declares the chain and closes the gate behind it, so a services object built
        // for a test or the host-internal preview has nothing to wait for.
        boot: createBootTracker(logger),
        workspace,
        processes: createManagedProcesses(),
        portForwards: createPortForwards(),
        scanPorts: () => scanListeningPorts(),
        terminalRun,
        panelToken: randomBytes(32).toString("hex"),
        agentToken: randomBytes(32).toString("hex"),
        info,
        tools: internalTools(config.intenticAgentTools),
        capabilities,
        ciStore,
        gateStore,
        ciRuns: createRunsCache(),
        ciHooks: createCiHookReconciler({ workspace, capabilities, ciStore, config, logger }),
        bridgeTokens: fileBridgeTokens(join(workspace.root, ".intentic", "bridge-tokens.json")),
        automations: fileAutomationsStore(join(workspace.root, ".intentic", "automations.json")),
        approvals: fileApprovalsStore(join(workspace.root, ".intentic", "approvals")),
        drafts: fileDraftsStore(join(workspace.root, ".intentic", "drafts")),
        turnJournal: fileTurnJournal(join(config.historyRoot, "turns")),
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        usage: fileUsageStore(join(config.historyRoot, "usage.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(join(workspace.root, ".intentic", "settings.json")),
        push: pushStore,
        pushSender: createPushSender(pushStore, logger),
        claudeStore,
        claudeUsage: fileClaudeUsageStore(join(config.historyRoot, "claude-usage.json")),
        claudeModels: createClaudeCatalog(claudeStore, config, workspace.root, join(authRoot, "claude", "models.json")),
        codexModels: createCodexCatalog(config, join(codexBase, "models.json")),
        kimiModels: createKimiCatalog(cliProxy),
        geminiModels: createGeminiCatalog(config, join(authRoot, "gemini", "models.json")),
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
            changesAgainstBase,
            changesBetweenRefs,
            refFileDiff,
            commitLog,
            collectRepoDiff,
            commitChanges,
            commitFileDiff,
            createBranchAt,
            createTagAt,
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
            append: (agent, messages) => transcriptDeps.record.append(agent.id, messages),
        },
        platformHostTunnel: (hostName) => postToPlatform(config, "/sandbox/host-tunnel", { hostName }),
        ensurePreviewRoutes: createPreviewRouteEnsurer(config, logger),
        members,
        auth,
    };
};
