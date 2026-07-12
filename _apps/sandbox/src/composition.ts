import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentEvent, FileDiff, GitChange, IntenticLine, WorkspaceChildren, WorkspaceTree } from "@intentic/sandbox-contract";
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
    gitPush,
    gitStatus,
    gitSync,
} from "@intentic/scaffold";
import type { Logger } from "pino";
import { type ActivityStore, fileActivityStore } from "./activity/activity-store.js";
import { type AgentRequest, runAgent } from "./agent/agent.js";
import { type ApprovalsStore, fileApprovalsStore } from "./automations/approvals-store.js";
import { type AutomationsStore, fileAutomationsStore } from "./automations/automations-store.js";
import { type CapabilitiesStore, fileCapabilitiesStore } from "./capabilities/capabilities-store.js";
import { createAuthorizer, createGoogleVerifier, fileMembersStore, fileOwnerStore, type MembersStore, type VerifiedIdentity } from "./auth/auth.js";
import { type ClaudeStore, fileClaudeStore } from "./claude/claude-credentials.js";
import { createCodexAgent } from "./codex/codex-agent.js";
import { type CodexReauthNeeded, type CodexStore, fileCodexStore, probeCodexHealth } from "./codex/codex-credentials.js";
import { locateCodexThread } from "./sessions/codex-sessions.js";
import { type DraftsStore, fileDraftsStore } from "./drafts/drafts-store.js";
import type { Config } from "./env.config.js";
import { changedFiles, commitPaths, discardPaths, workingFileDiff } from "./git/changes.js";
import { createGrokAgent, createGrokRunner } from "./grok/grok-agent.js";
import { createOpenCodeService, type OpenCodeService } from "./grok/opencode.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history/history.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { type PanelProcesses, createPanelProcesses } from "./panels/panel-processes.js";
import { createPreviewRouteEnsurer } from "./panels/preview-route.js";
import {
    listWorkspaceSessions,
    readWorkspaceSession,
    searchWorkspaceSessions,
    type SessionSummary,
    type SessionTranscriptMessage,
    workspaceSessionExists,
} from "./sessions/sessions.js";
import { type SandboxSettingsStore, fileSandboxSettingsStore } from "./settings/settings-store.js";
import { postToPlatform, type PlatformResponse } from "./system/platform-client.js";
import { createTerminalRunner, type TerminalRunner } from "./system/terminal-run.js";
import { version } from "./version.js";
import { type AgentTool, internalTools } from "./workspace/tools.js";
import { type WorkspacePaths, workspacePaths } from "./workspace/workspace.js";
import {
    copyWorkspacePath,
    makeWorkspaceDir,
    moveWorkspacePath,
    readWorkspaceFile,
    readWorkspaceFileBytes,
    removeWorkspacePath,
    setWorkspaceMtime,
    statWorkspaceFileSize,
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
    readonly workspace: WorkspacePaths;
    // Per-repository operator panels: the in-memory process manager the /panels routes and the preview proxy
    // drive (discovery of which repo has a panel is convention-only — see panels/panels.ts).
    readonly panelProcesses: PanelProcesses;
    // Runs user-triggered shell commands inside visible job-* tmux sessions (window per command) — the
    // surfacing substrate for capability adds and the infra check (see terminal-run.ts for the principle).
    readonly terminalRun: TerminalRunner;
    // A per-boot secret injected into every panel process (INTENTIC_PANEL_TOKEN) so a panel's own backend can
    // call the daemon from inside the sandbox without the browser's Google token. Never leaves the container.
    readonly panelToken: string;
    // This sandbox's identity for the platform's Connections card; undefined ⇒ /info returns {} (loopback/test).
    readonly info: { readonly name: string; readonly image: string; readonly version: string } | undefined;
    // Intent-declared internal MCP tools (constant for the sandbox), merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest (.intentic/capabilities.json) — DevOps/mcp/service/integration.
    readonly capabilities: CapabilitiesStore;
    // Scheduled agent wake-ups (.intentic/automations.json) — the scheduler polls it; /automations edits it.
    readonly automations: AutomationsStore;
    // Wakes from `requireApproval` automations, held for the owner (.intentic/approvals/, one file per wake) —
    // the /automations pending routes approve (run the held wake) or reject them.
    readonly approvals: ApprovalsStore;
    // Agent-proposed post drafts (.intentic/drafts/, one file per draft) — the agent writes them; /drafts is
    // the owner's approve/edit/reject side.
    readonly drafts: DraftsStore;
    // The agent-activity audit log (historyRoot/activity.jsonl, outside the agent's reach): inbound wakes,
    // sniffed outbound provider calls, voice sessions, failures. /activity reads it; only the daemon appends.
    readonly activity: ActivityStore;
    // Per-sandbox agent settings (.intentic/settings.json) — /settings edits it; streamAgent reads it to gate
    // the search_past_chats tool.
    readonly sandboxSettings: SandboxSettingsStore;
    // Claude subscription accounts (one <id>.json per account under .intentic/claude), several per sandbox.
    readonly claudeStore: ClaudeStore;
    // ChatGPT (Codex) accounts, each in Codex's native auth.json under its own CODEX_HOME (.intentic/codex/<id>).
    readonly codexStore: CodexStore;
    // Proactive Codex credential health: undefined ⇒ healthy/unknown, else the "needs reconnect" verdict. Cached
    // briefly so back-to-back account-list loads don't re-hit OpenAI's token endpoint on a revoked account.
    // /codex/accounts and the turn gate read it to surface a revoked sign-in before an opaque mid-turn failure.
    readonly codexHealth: (id: string) => Promise<CodexReauthNeeded | undefined>;
    // Locate which CODEX_HOME minted a thread so a resume runs under the home that holds its rollout — the
    // connected-account set can change between turns (a thread minted under the OPENAI_API_KEY fallback home, then
    // the user signs into ChatGPT). undefined ⇒ no home owns it ⇒ the turn emits session-not-found.
    readonly locateCodexThread: (threadId: string) => Promise<{ home: string; accountId?: string } | undefined>;
    // The shared OpenCode runtime backing the Grok provider: the warm server/client plus xAI OAuth
    // connect/disconnect. OpenCode owns the xAI credential, so there's no GrokStore twin.
    readonly openCode: OpenCodeService;
    // The AI-provider credential root (also OpenCode's XDG_DATA_HOME) — the delegation note points the
    // agent's `opencode run` commands at it.
    readonly authRoot: string;
    // Daemon-owned workspace snapshots on /history (outside the agent's reach): auto-captured per turn + on an
    // interval, diffed and restored through the /history routes.
    readonly history: WorkspaceHistory;
    // The provider adapters — one function shape, three agent runtimes. streamAgent picks per turn.
    readonly agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly codexAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly grokAgent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly intentic: (run: IntenticRun, signal?: AbortSignal) => AsyncGenerator<IntenticLine>;
    readonly git: {
        readonly init: (dir: string, separateGitDir?: string) => Promise<void>;
        readonly status: (dir: string) => Promise<GitStatus>;
        readonly listFiles: (dir: string) => Promise<string[]>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly push: (dir: string, branch: string) => Promise<void>;
        readonly clone: (parentDir: string, name: string, cloneUrl: string, options?: GitCloneOptions) => Promise<void>;
        readonly checkout: (dir: string, ref: string) => Promise<void>;
        readonly head: (dir: string) => Promise<string>;
        readonly sync: (dir: string) => Promise<GitSyncResult>;
        // The Changes review verbs (git/changes.ts): working-tree status, per-path commit/discard, HEAD↔worktree diff.
        readonly changedFiles: (dir: string) => Promise<{ branch?: string; changes: GitChange[] }>;
        readonly commitPaths: (dir: string, message: string, paths: readonly string[], author: { name: string; email: string }) => Promise<boolean>;
        readonly discardPaths: (dir: string, paths?: readonly string[]) => Promise<void>;
        readonly fileDiff: (dir: string, path: string) => Promise<FileDiff>;
    };
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
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
    readonly sessions: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<SessionTranscriptMessage[]>;
        readonly search: (dir: string, query: string) => Promise<SessionSummary[]>;
        readonly exists: (dir: string, id: string) => Promise<boolean>;
    };
    // platformHostTunnel relays to the platform (connect-token auth) to mint an intentic-provided host tunnel,
    // which needs intentic's platform Cloudflare account the daemon doesn't hold.
    readonly platformHostTunnel: (hostName: string) => Promise<PlatformResponse>;
    // Relays to the platform (connect-token auth) to mint a panel's preview route on the sandbox's
    // intentic-provided tunnel before the panel starts; never rejects (see panels/preview-route.ts).
    readonly ensurePreviewRoute: (panel: string) => Promise<void>;
    // Shared-access grants — the emails authorized besides the owner. Always present; the /members routes read
    // and write it, and the authorizer consults it. The daemon is the enforcer; the platform only mirrors these.
    readonly members: MembersStore;
    // When set, the daemon is exposed directly and verifies the owner's Google ID token on every route but
    // /health; CORS is emitted for `allowOrigin`. Undefined ⇒ loopback mode (tests / host-internal preview).
    // authorizeOwner gates the owner-only member-management routes.
    readonly auth:
        | {
              readonly authorize: (bearer: string, firstBind: string | undefined) => Promise<VerifiedIdentity>;
              readonly authorizeOwner: (bearer: string) => Promise<void>;
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
    // Referenced twice below: as the openCode service field and to build the Grok adapter's runner. Its data dir
    // (OpenCode's XDG_DATA_HOME) is the credential root so xAI OAuth tokens persist across restarts.
    const openCode = createOpenCodeService(authRoot);
    const info =
        config.sandbox.name !== "" && config.sandbox.image !== "" ? { name: config.sandbox.name, image: config.sandbox.image, version } : undefined;
    const members = fileMembersStore(join(workspace.root, ".intentic", "members.json"));
    const authorizer =
        config.google.clientId !== ""
            ? createAuthorizer({
                  verify: createGoogleVerifier(config.google.clientId),
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
              ...(config.webOrigin !== "" ? { allowOrigin: config.webOrigin } : {}),
          }
        : undefined;

    const codexStore = fileCodexStore(codexBase);
    // Short-lived verdict cache: the offline gate already makes healthy probes network-free, so this only spares
    // OpenAI's token endpoint from repeated failing refreshes on a revoked account across back-to-back /accounts
    // loads. A fresh probe on daemon restart is fine (cheap, offline-gated).
    const codexHealthCache = new Map<string, { verdict: CodexReauthNeeded | undefined; expiresAt: number }>();
    const CODEX_HEALTH_TTL_MS = 60_000;
    const codexHealth = async (id: string): Promise<CodexReauthNeeded | undefined> => {
        const cached = codexHealthCache.get(id);
        if (cached !== undefined && Date.now() < cached.expiresAt) {
            return cached.verdict;
        }
        const verdict = await probeCodexHealth(codexStore, id);
        codexHealthCache.set(id, { verdict, expiresAt: Date.now() + CODEX_HEALTH_TTL_MS });
        return verdict;
    };

    return {
        config,
        logger,
        workspace,
        panelProcesses: createPanelProcesses(),
        terminalRun: createTerminalRunner(),
        panelToken: randomBytes(32).toString("hex"),
        info,
        tools: internalTools(config.intenticAgentTools),
        capabilities: fileCapabilitiesStore(join(workspace.root, ".intentic", "capabilities.json")),
        automations: fileAutomationsStore(join(workspace.root, ".intentic", "automations.json")),
        approvals: fileApprovalsStore(join(workspace.root, ".intentic", "approvals")),
        drafts: fileDraftsStore(join(workspace.root, ".intentic", "drafts")),
        activity: fileActivityStore(join(config.historyRoot, "activity.jsonl")),
        sandboxSettings: fileSandboxSettingsStore(join(workspace.root, ".intentic", "settings.json")),
        claudeStore: fileClaudeStore(join(authRoot, "claude")),
        codexStore,
        codexHealth,
        locateCodexThread: async (threadId) =>
            locateCodexThread(
                codexBase,
                (await codexStore.list()).map((account) => ({ home: codexStore.home(account.id), accountId: account.id })),
                threadId,
            ),
        openCode,
        authRoot,
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
        agent: runAgent,
        codexAgent: createCodexAgent(codexBase),
        grokAgent: createGrokAgent(createGrokRunner(openCode)),
        // Bound to the daemon logger so every CLI run's lifecycle (spawn/kill/exit) is attributable from
        // daemon.log — the runs themselves are transient subprocesses whose absence proves nothing.
        intentic: (run, signal) => runIntentic(run, signal, logger),
        git: {
            init: gitInit,
            status: gitStatus,
            listFiles: gitListFiles,
            commitAll: gitCommitAll,
            push: gitPush,
            clone: gitClone,
            checkout: gitCheckout,
            head: gitHead,
            sync: gitSync,
            changedFiles,
            commitPaths,
            discardPaths,
            fileDiff: workingFileDiff,
        },
        files: {
            read: readWorkspaceFile,
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
        sessions: { list: listWorkspaceSessions, read: readWorkspaceSession, search: searchWorkspaceSessions, exists: workspaceSessionExists },
        platformHostTunnel: (hostName) => postToPlatform(config, "/sandbox/host-tunnel", { hostName }),
        ensurePreviewRoute: createPreviewRouteEnsurer(config, logger),
        members,
        auth,
    };
};
