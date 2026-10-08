import { timedHooks } from "./hook-timing.js";
import type {
    CanUseTool,
    EffortLevel,
    HookCallbackMatcher,
    HookEvent,
    McpSdkServerConfigWithInstance,
    Options,
    PermissionResult,
    PermissionUpdate,
    SpawnedProcess,
    SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { whenAborted } from "@intentic/base/async";
import { refreshClaudeSdk, sdk } from "../../engines/claude-sdk.js";
import { spawnAs } from "../../workload/workload-class.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
    type AgentEvent,
    type AskQuestion,
    type RequestDocument,
    DEFAULT_SAFETY_POLICY,
    documentOf,
    isPlanDocumentPath,
    type PermissionMode,
    sendableEffort,
    sendableThinking,
    type UsageWindow,
} from "@intentic/sandbox-contract";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { join, normalize, relative, sep } from "node:path";
import { claudeStatePath } from "../../sessions/session-store.js";
import { z } from "zod";
import { daemonMountNs, handoffDirOf, type IsolationAnchor, ownWorktree, TMUX_NS_ENV } from "../../conversations/worktrees/isolation.js";
import { PANE_DOOR_PATH } from "../../workload/agent-domain-view.js";
import { namespaceTargetOf, nsenterArgv } from "../../workload/namespace-entry.js";
import { sandboxEnv } from "../../conversations/worktrees/turn-sandbox.js";
import { worktreeRedirectHooks } from "../../conversations/worktrees/worktree-redirect.js";
import { browserArtifactHooks } from "../../browser/cast/browser-artifacts.js";
import { browserSessionHooks } from "../../browser/sessions/browser-sessions.js";
import { depsNoticeHooks } from "../tools/agent-deps.js";
import { searchNoticeHooks } from "../verification/agent-search.js";
import { editDiagnosticsHooks } from "../verification/agent-diagnostics.js";
import { createShellEditTracker } from "../tools/agent-shell-edits.js";
import { EDIT_TOOL_NAMES } from "../../rules/edit-tools.js";
import { installSteeringHooks } from "../providers/agent-installs.js";
import { redactionHooks } from "../tools/agent-redaction.js";
import { secretCommandHooks } from "../tools/agent-secrets.js";
import { commandGateHooks } from "../../guard/command-guard.js";
import { outboundGuardHooks } from "../../guard/outbound-guard.js";
import { outsideResultHooks } from "../../guard/outside-results.js";
import { createTurnTaint, publishTurnTaint } from "../../guard/turn-taint.js";
import { personaScopeHooks } from "../../personas/persona-scope.js";
import { jsExecutionServer } from "../../execution/js-tool.js";
import { JS_TOOL_ALIAS, JS_TOOL_NAME } from "../../seams/js-tool-names.js";
import { mcpServersOf } from "../tools/agent-tools.js";
import { agentShellBusy, bashTmuxHooks, tmuxRunEnabled } from "../tools/agent-terminals.js";
import { terminalHelpServer } from "../../terminal/terminal-help.js";
import { EventQueue } from "./event-queue.js";
import { planRevision } from "../prompt/plan-revision.js";
import { trialUnavailableFrame } from "./error-frames.js";
import type { AgentRequest, HarnessCredential } from "../providers/agent-request.js";
import { harnessEnv } from "../providers/harness-credentials.js";
import { ONE_SHOT_OWNER, workloadStamp } from "../../seams/workload-stamp.js";
import { opt } from "../../opt.js";
import { readClaudeUsage } from "../../runtimes/claude/claude-usage.js";
import { routedEndpointOf } from "../providers/routed-refusal.js";
import { defaultQuery, promptInput, type QueryFn, streamSdk, type TurnPosture } from "./sdk-stream.js";
import { checklistCloseHooks } from "./checklist-close.js";
import { turnCheckHooks } from "./turn-checks.js";
import { settingsHookChangeHooks } from "./harness/settings-hook-gate.js";
import { checklistSeedOf } from "./task-store.js";
import { carriedCostOf } from "./carried-cost.js";
import { promptInputOf, sdkSystemPrompt, terminalMounted } from "../prompt/system-prompt.js";
import { storedPromptTitle } from "../prompt/turn-preamble.js";
import { noteChildWork } from "../subagents/child-verification.js";
import { closeSubagents, subagentInParentTree, subagentHooks, type SubagentTurn } from "../subagents/subagents.js";
import { ASK_TOOL_NAMES, answerFiles, formatAnswers } from "../tools/question-answers.js";
import { PAGE_TOOL_NAMES } from "../pages/page-names.js";
import { pageTools } from "../pages/page-tools.js";
import { McpAppHost } from "../pages/mcp-apps.js";
import { imageBlock, loadAttachments } from "../prompt/attachment-images.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { CLAUDE_INSTRUCTION_FILES } from "../../runtimes/claude/claude-builtins.js";

// The request the Claude Code loop runs: it spends a stored account's token, a routed endpoint, the trial, or the
// container's own credential.
export type HarnessRequest = AgentRequest<HarnessCredential>;

// Rebases only when quiet, skipped if the turn's shell or a subagent is still writing, which leaves the branch exactly
// where it was; answers the frame it pushed, if the branch moved.
const quietResync = async (
    conversations: Pick<ConversationActors, "holdings">,
    request: AgentRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
): Promise<AgentEvent | undefined> => {
    if (request.hooks.resync === undefined) {
        return undefined;
    }
    if (request.spec.conversationId !== undefined && subagentInParentTree(conversations, request.spec.conversationId)) {
        return undefined;
    }
    // allow(silent-catch): a shell tmux could not be asked about counts as busy, so this optional rebase waits for the
    // next quiet point instead of running under a shell that may be writing; nothing on this path has a logger.
    if (shell.sessionId !== undefined && (await agentShellBusy(shell.sessionId).catch(() => true))) {
        return undefined;
    }
    // Swallowed here so a rebase fault can't fail what called it; resync owns its own logging.
    const frame = await request.hooks.resync().catch(() => undefined);
    if (frame !== undefined) {
        push(frame);
    }
    return frame;
};

// Rebases only on an actual answer, not a dismissal/rejection.
const syncOnAnswer = async (
    conversations: Pick<ConversationActors, "holdings">,
    request: HarnessRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
    answered: boolean,
): Promise<void> => {
    if (answered) {
        await quietResync(conversations, request, push, shell);
    }
};

// Cap the stderr tail folded into an error message so a chatty failure can't flood the UI.
const STDERR_TAIL = 2000;

// Folds the Claude Code subprocess's stderr tail into the surfaced error, so a bare exit code becomes the actual
// reason.
const errorMessage = (error: unknown, stderr: string): string => {
    const base = error instanceof Error ? error.message : "agent failed";
    const detail = stderr.trim().slice(-STDERR_TAIL);
    return detail ? `${base}: ${detail}` : base;
};

// Maps output-cleaner settings to env vars for the Bash filter; 'off' disables it, everything else selects which
// cleaners run.
const cleanerEnv = (request: HarnessRequest): Record<string, string> => {
    if (request.tools.outputCleaners === "off") {
        return { INTENTIC_RUN_FILTER: "0" };
    }
    return {
        // Empty means the filter's default, so it's dropped the same as absent.
        ...opt("INTENTIC_OUTPUT_CLEANERS", request.tools.outputCleaners || undefined),
        ...opt(
            "INTENTIC_OUTPUT_HOLDOUT",
            request.tools.outputHoldout !== undefined && request.tools.outputHoldout > 0 ? String(request.tools.outputHoldout) : undefined,
        ),
    };
};

// The three env vars the CLI reads for delegation ceilings; the only way to move them since they aren't SDK options.
// Absent emits nothing, so the CLI's own default stands.
const subagentEnv = (request: HarnessRequest): Record<string, string> => ({
    ...opt("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", request.policy.subagentsAtOnce?.toString()),
    ...opt("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", request.policy.subagentsPerTurn?.toString()),
    ...opt("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", request.policy.subagentDepth?.toString()),
});

// Pins Claude Code's checklist tools on: newer models gate Task*/TodoWrite off by default, but the prompt and reducer
// both depend on them.
const CHECKLIST_ENV: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    CLAUDE_CODE_ENABLE_TASKS: "1",
};

// Turns off the CLI's own switch to another model when the provider's safety classifier stops a response, so a flagged
// turn ends for the person to choose (2026-09-30: asked every time, the owner's call over switching automatically).
const REFUSAL_ENV = { CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1" } as const;

// Hides CLI skills with no daemon equivalent: loop/schedule need a live process, keybindings-help/update-config target
// the CLI's own UI, and plugin-authoring writes mods whose panes and status lines nothing draws under the Agent SDK.
// Keeps the CLI's built-in AGENTS.md loader out of a turn the daemon composes AGENTS.md for (claude-builtins.ts).
const HEADLESS_SETTINGS: Exclude<NonNullable<Options["settings"]>, string> = {
    skillOverrides: { loop: "off", schedule: "off", "keybindings-help": "off", "update-config": "off", "plugin-authoring": "off" },
    ...CLAUDE_INSTRUCTION_FILES,
};

// The env keys that decide where the CLI sends a model request: its base URLs, the cloud-provider switches that send
// it to Bedrock, Vertex or Foundry instead, the unix socket it may dial, and the proxies that see every byte of it.
// A settings file's `env` overrides the process env the daemon hands the CLI, and the user's and the project's
// settings files are both writable from a turn, so one line there would send the next turn around the privacy
// shield's gateway, with the turn's credential (2026-10-06, measured on CLI 0.3.289). The flag layer outranks both.
const ROUTING_ENV = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_GATEWAY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
] as const;

// The settings keys whose value is a command the CLI runs on its own, outside every hook and gate: credential and
// endpoint helpers (apiKeyHelper ran from a project file before any approval) and the launcher prefix. The daemon
// supplies the turn's credential and endpoint itself, so none of them has anything to do in a turn; empty is unset.
const UNSET_COMMANDS = {
    apiKeyHelper: "",
    awsAuthRefresh: "",
    awsCredentialExport: "",
    gcpAuthRefresh: "",
    otelHeadersHelper: "",
    proxyAuthHelper: "",
    processWrapper: "",
};

// What the flag layer pins over every settings file: each routing key as the daemon's own env for the turn has it
// (empty where it has none, which the CLI reads as unset), and every command key emptied.
export const pinnedRouting = (env: Readonly<Record<string, string | undefined>>) => ({
    env: Object.fromEntries(ROUTING_ENV.map((key) => [key, env[key] ?? ""])),
    ...UNSET_COMMANDS,
});

// What an anchored turn's processes need told about where they run: a plain namespace hands tmux-run the daemon's own
// namespace to reach the shared server from; a fenced turn's sandbox names its own server, temp and log dirs; an agent
// domain names the pane door its tmux-run asks instead (terminal/pane-door.ts), and no terminal log dir, since the
// daemon's is not in its view.
const anchorEnv = (anchor: IsolationAnchor | undefined) => {
    if (anchor === undefined) {
        return {};
    }
    if (anchor.domain !== undefined) {
        return { INTENTIC_PANES_SOCKET: PANE_DOOR_PATH, INTENTIC_TERMINAL_LOGS_DIR: "", TMPDIR: "/tmp" };
    }
    return anchor.sandbox === undefined ? { [TMUX_NS_ENV]: daemonMountNs } : sandboxEnv(anchor.sandbox);
};

// The env a turn's CLI runs with; also what the flag layer pins its routing keys to (turnSettings).
const turnEnv = (request: HarnessRequest) => ({
    // The daemon's own environment, sealed at boot: every container secret was taken out of it once the config had read
    // it (seams/sealed-env.ts), so what is left is the image's toolchain and the daemon's non-secret settings.
    ...process.env,
    // cli-kind capability credentials the shell reads, rebuilt every turn; tmux panes get key names, not
    // values.
    ...request.tools.cliEnv,
    // IS_SANDBOX plus this turn's credential; a custom endpoint withholds the OAuth token for its own bearer.
    ...harnessEnv(request.credential, { model: request.spec.model }),
    // Output-cleaner spec/holdout the Bash to tmux-run pipeline reads.
    ...cleanerEnv(request),
    // Delegation ceilings this turn overrides, if any, on top of the harness defaults.
    ...subagentEnv(request),
    // Checklist tools the prompt advertises and the task list needs; not owner-tunable, see CHECKLIST_ENV.
    ...CHECKLIST_ENV,
    // A response the safety classifier stops is the person's to route (retry or another model, from the chat's
    // card), never a model the CLI swaps in by itself. Its one retry on the same model within the turn stays.
    ...REFUSAL_ENV,
    // Where tmux-run talks to tmux: the daemon's namespace, not the turn's, so it starts a server there if
    // needed. A fenced turn's sandbox has a tmux server of its own instead, and its own temp and log dirs.
    ...anchorEnv(request.spec.isolation?.anchor),
    // Whose work this is, for the leftovers sweep; unstamped with no conversation rather than a made-up owner.
    ...(request.spec.conversationId !== undefined ? workloadStamp(request.spec.conversationId) : {}),
});

// The flag layer, above the owner's settings.json. Fast mode is asked per session so it never persists sandbox-wide,
// and omitted rather than false so it never overrides theirs. Unapproved settings hooks switch off every file and
// plugin hook; the gate and the per-edit checks wired below are SDK callbacks, which still run. Where model requests go
// and which helper commands run are pinned whatever the files say (pinnedRouting).
const turnSettings = (request: HarnessRequest): Exclude<NonNullable<Options["settings"]>, string> => ({
    ...HEADLESS_SETTINGS,
    ...pinnedRouting(turnEnv(request)),
    ...(request.spec.fast === true ? { fastMode: true, fastModePerSessionOptIn: true } : {}),
    ...(request.policy.settingsHooks?.held === true ? { disableAllHooks: true } : {}),
});

// Refuses from a PreToolUse hook, which runs even under bypassPermissions where canUseTool is never asked.
const refuseEveryTool = (reason: string) =>
    ({
        PreToolUse: [
            {
                hooks: [
                    async () => ({
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: "deny" as const,
                            permissionDecisionReason: reason,
                        },
                    }),
                ],
            },
        ],
    }) satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;

// Everything a refresh changes about the turn it replays; none of it reaches the request's prefix.
const keepWarmOptions = (request: HarnessRequest): Partial<Options> => ({
    forkSession: true,
    persistSession: false,
    maxTurns: 1,
    hooks: refuseEveryTool("This request only refreshes the prompt cache; nothing runs."),
    settings: { ...turnSettings(request), disableAllHooks: true },
});

// Everything a sealed request (agent-request.ts `policy.sealed`) changes about a turn: its prompt is everything the model
// reads, so no built-in or MCP tool is offered (and a call is refused besides), no settings file or instruction file is
// read, nothing is saved, and one answer ends it. Its env is the credential's alone with the harness failing fast, since
// a helper is stepped over rather than resumed, stamped so an abandoned CLI is still swept (system/boot/leftovers.ts).
const sealedOptions = (request: HarnessRequest): Partial<Options> => ({
    tools: [],
    allowedTools: [],
    mcpServers: {},
    settingSources: [],
    persistSession: false,
    maxTurns: 1,
    // Written as disabled rather than left out unless the pin asked to think: left out is the SDK's own adaptive
    // default, which would make every unpinned helper think.
    thinking: { type: sendableThinking(request.spec.effort, request.spec.thinking) === true ? "adaptive" : "disabled" },
    hooks: refuseEveryTool("This request answers in words only; nothing runs."),
    settings: { ...turnSettings(request), disableAllHooks: true },
    env: {
        ...process.env,
        ...harnessEnv(request.credential, { helper: true, model: request.spec.model }),
        ...workloadStamp(ONE_SHOT_OWNER),
    },
});

// What a request that is not a turn changes about one: a cache refresh's options, a sealed request's, or nothing.
const profileOptions = (request: HarnessRequest): Partial<Options> => {
    if (request.policy.sealed === true) {
        return sealedOptions(request);
    }
    return request.policy.keepWarm === true ? keepWarmOptions(request) : {};
};

// The session a turn resumes, cut back to `resumeAt` when its re-run names one (a response the provider's safety
// classifier stopped, refusal-fork.ts): the cut means nothing without the session it was made in.
const resumeOptions = (spec: HarnessRequest["spec"]): Pick<Options, "resume" | "resumeSessionAt"> =>
    spec.sessionId === undefined ? {} : { resume: spec.sessionId, ...opt("resumeSessionAt", spec.resumeAt) };

// A new session is titled with the user's own words, since the SDK's list would otherwise title it by its first prompt
// flattened and cut at 200 characters: the daemon's notes, with the words past the cut. A resumed one keeps its title.
const sessionTitle = (request: HarnessRequest): Pick<Options, "title"> =>
    request.spec.sessionId === undefined ? opt("title", storedPromptTitle(request.spec.prompt)) : {};

// Concatenates hook matchers per event instead of spreading, so two producers of the same event (e.g. PreToolUse:Bash)
// both fire.
export const mergeHooks = (...sets: Partial<Record<HookEvent, HookCallbackMatcher[]>>[]): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
    for (const set of sets) {
        for (const [event, matchers] of Object.entries(set) as [HookEvent, HookCallbackMatcher[]][]) {
            merged[event] = [...(merged[event] ?? []), ...matchers];
        }
    }
    return merged;
};

// True only for a non-empty rulebook, so an absent or empty one wires no hook and costs nothing.
const hasRules = <T extends object>(rules: T | undefined): rules is T => rules !== undefined && Object.keys(rules).length > 0;

// CLI scheduling tools are dead here (the process dies at turn end); automations and the watch tools replace them.
const CLI_SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];

// Tools removed from the model: scheduler tools always, and the caller's own list. Plan and question tools stay on an
// unattended turn: their cards wait for the owner like every other.
const disallowedToolsOf = (request: HarnessRequest): string[] => [...CLI_SCHEDULER_TOOLS, ...(request.policy.disallowedTools ?? [])];

// The SDK writes every MCP server onto the CLI's argv as one inline JSON document. `/proc/<pid>/cmdline` is readable by
// anything running as this user, the agent's own Bash tool included, so that argv is both a credential leak (bearer
// headers, pair tokens) and a kill surface: `pkill -f` on any string inside it matches EVERY live agent's CLI at once.
// The flag equally accepts files, so the document moves into one, 0600, removed when the CLI exits.
const MCP_CONFIG_FLAG = "--mcp-config";

// `tmp` is where the file goes: a fenced turn's sandbox sees only its own temp dir, so its document must be written there.
export const mcpConfigOffArgv = (args: readonly string[], tmp: string = tmpdir()): { readonly args: string[]; readonly dispose: () => void } => {
    const at = args.indexOf(MCP_CONFIG_FLAG);
    if (at === -1) {
        return { args: [...args], dispose: () => {} };
    }
    const rewritten = [...args];
    let dir: string | undefined;
    // The flag is variadic: its values run to the next flag, and only an inline document (not an existing path) moves.
    for (let index = at + 1; index < rewritten.length; index += 1) {
        const value = rewritten[index];
        if (value === undefined || value.startsWith("-")) {
            break;
        }
        if (!value.startsWith("{")) {
            continue;
        }
        dir ??= mkdtempSync(join(tmp, "intentic-run-mcp-"));
        const path = join(dir, `${index - at}.json`);
        writeFileSync(path, value, { mode: 0o600 });
        rewritten[index] = path;
    }
    if (dir === undefined) {
        return { args: rewritten, dispose: () => {} };
    }
    const scratch = dir;
    return { args: rewritten, dispose: () => rmSync(scratch, { recursive: true, force: true }) };
};

// The CLI's spawn for every turn, in the agentRuntime class at this turn's spawn depth (workload-class.ts); an anchored
// turn's CLI is exec'd into its isolation anchor via nsenter instead of spawned plainly, and a failure there fails the
// turn rather than silently using the shared tree. The SDK still owns the child's stdio, exit and SIGTERM, but a custom
// spawn skips its stderr reader, so this one feeds `onStderr` itself: an unread pipe would stall a chatty CLI.
const runtimeSpawn =
    (anchor: IsolationAnchor | undefined, spawnDepth: number, onStderr: (data: string) => void) =>
    (options: SpawnOptions): SpawnedProcess => {
        const config = mcpConfigOffArgv(options.args, handoffDirOf(anchor));
        const { command, args } =
            anchor === undefined
                ? { command: options.command, args: config.args }
                : nsenterArgv(namespaceTargetOf(anchor), anchor.cwd, options.command, config.args);
        const child = spawnAs({ class: "agentRuntime", spawnDepth }, command, args, {
            ...(anchor === undefined ? opt("cwd", options.cwd) : {}),
            env: options.env,
            ...opt("signal", options.signal),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", onStderr);
        // The CLI reads the file at startup; outliving the process would leave the document on disk for the tmp sweep.
        child.once("exit", config.dispose);
        child.once("error", config.dispose);
        return child;
    };

// On a 401 the CLI asks this callback for a refreshed token and resumes on what comes back; the same token ends the
// turn. Untyped in sdk.d.ts (present in sdk.mjs), hence the OauthRecoveryOptions extension.
export type OauthRecoveryOptions = Options & {
    getOAuthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
};

// Effort and thinking are set together since the API only accepts certain combinations; sendableThinking/sendableEffort
// make the tier explicit even for a max turn with no thinking set.
const reasoningOptions = (request: HarnessRequest): { effort?: EffortLevel; thinking?: { type: "adaptive" | "disabled" } } => {
    const thinking = sendableThinking(request.spec.effort, request.spec.thinking);
    return {
        ...opt("effort", sendableEffort(request.spec.effort, request.spec.thinking) as EffortLevel | undefined),
        ...opt("thinking", thinking === undefined ? undefined : { type: thinking ? ("adaptive" as const) : ("disabled" as const) }),
    };
};

// Base SDK options for the turn.
const baseOptions = (
    request: HarnessRequest,
    abortController: AbortController,
    permissionMode: PermissionMode,
    tmuxEnabled: boolean,
    // Turn handle the subagent registry files children under; absent means no conversation (the bench).
    subagents: SubagentTurn | undefined,
    // Turn's event sink; the command gate uses it to park the turn on a card without ever calling canUseTool.
    push: (event: AgentEvent) => void,
): OauthRecoveryOptions => {
    // This turn's outside-content bit, set once here; the wrap hook sets it, the gate reads it per command.
    const taint = createTurnTaint(request.policy.outsideWake);
    // Published for consult sites outside this generator (wallet gate, host bridge); cleared when the turn settles.
    if (request.spec.conversationId !== undefined) {
        publishTurnTaint(request.spec.conversationId, taint, request.policy.unattended === true);
    }
    return {
        cwd: request.spec.cwd,
        // Only for a native Claude turn on a sandbox credential; other endpoints have no refresh token to mint from.
        ...opt("getOAuthToken", request.credential.kind === "claude-oauth" ? request.credential.refresh : undefined),
        includePartialMessages: true,
        // Forwards a subagent's prose and thinking, not just tool calls, so it renders as a conversation.
        forwardSubagentText: true,
        permissionMode,
        ...opt("allowedTools", request.policy.allowedTools?.slice()),
        abortController,
        // Loads the workspace's .claude/ config: skills, subagents, settings, hooks, .mcp.json; else none. Not the
        // owner's standing rules — those are composed for every runtime alike (workspace-memory.ts), so a CLAUDE.md
        // this still picks up is a repo's own file, not this product's memory. Its hooks run only once the owner
        // approved them (guard/hook-approvals.ts).
        settingSources: ["user", "project"],
        settings: turnSettings(request),
        env: turnEnv(request),
        // Hooks fire under bypassPermissions and for subagents: tmux wraps every Bash command, installs redirect to the
        // approved overlay, diagnostics type-checks native edits.
        // Each callback timed for perf.jsonl (hook-timing.ts) when the turn says where to report.
        hooks: timedHooks(
            mergeHooks(
                // Runs before the tmux wrapper, so the classifier and card see the agent's own command, not wrapper
                // boilerplate.
                commandGateHooks({
                    policy: request.policy.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
                    judging: request.policy.judging ?? "on",
                    unattended: request.policy.unattended === true,
                    // Read per command, not snapshotted beside it: attendance is the one fact about a turn that can arrive
                    // after it starts, and it arrives as a steering message.
                    steered: () => request.hooks.steered?.() === true,
                    push,
                    signal: request.signal,
                    cards: request.hooks.cards,
                    taint,
                    cwd: request.spec.cwd,
                    // Whether that cwd is this conversation's own copy; without it `git switch` in a worktree reads as moving a
                    // checkout somebody else shares.
                    ...opt("ownCheckout", request.spec.ownCheckout),
                    judge: request.hooks.judge,
                    log: request.hooks.logSafety,
                    answered: request.hooks.safetyAnswered,
                    remember: request.hooks.rememberSafety,
                    // The same install rule and ledger every runtime's gate is built with (vendor-gate.ts).
                    installs: request.hooks.projectInstalls,
                    onImageInstall: request.hooks.onImageInstall,
                }),
                // Wraps content pulled in mid-turn (a fetched page, a foreign MCP result); sets the taint the gate reads.
                outsideResultHooks((source) => {
                    taint.mark(source);
                }),
                // tmux wrapper carries the secret exit so the rewrites compose in order; without tmux the exit stands
                // alone.
                tmuxEnabled
                    ? bashTmuxHooks(
                          Object.keys(request.tools.cliEnv ?? {}),
                          request.spec.isolation,
                          request.spec.conversationId,
                          request.tools.secrets,
                          request.tools.heavyCommands,
                          request.tools.offloadCommands,
                          request.hooks.backgroundJobs,
                      )
                    : request.tools.secrets !== undefined
                      ? secretCommandHooks(request.tools.secrets)
                      : {},
                // Masks every stored credential to its reference in any tool result, not just Bash's.
                request.tools.secrets !== undefined ? redactionHooks(request.tools.secrets.list) : {},
                installSteeringHooks(),
                // Checks classified outbound calls against owner action rules before they run, even under
                // bypassPermissions.
                hasRules(request.policy.actionRules) ? outboundGuardHooks(request.policy.actionRules) : {},
                // Persona's folder limit and config-edit permission; the only layer between an unattended wake and a bad
                // path.
                request.policy.personaScope !== undefined ? personaScopeHooks(request.policy.personaScope) : {},
                // The harness's own ask: a checklist about to be left open is said back once, since
                // the board reads that list to tell a finished session from one that stopped short.
                checklistCloseHooks({ sessionStore: request.spec.sessionStore }),
                // The repositories' own `turn` checks, once, as an isolated turn is about to stop: what they found in its
                // change is said back, and the model fixes it or says why not. Nothing waits on them.
                turnCheckHooks(request.hooks.turnChecks, ownWorktree(request.spec.isolation)),
                // Refuses a mid-turn edit that would change which settings or skill hooks run, which the CLI applies live.
                settingsHookChangeHooks(request),
                // Apply worktree redirection only when no anchor already resolves paths.
                request.spec.isolation !== undefined && request.spec.isolation.anchor === undefined
                    ? worktreeRedirectHooks(request.spec.isolation.plan)
                    : {},
                // Rewrites a model-named screenshot path into the tool-owned output directory before the tool sees it.
                request.tools.browserOutputDir !== undefined ? browserArtifactHooks(request.tools.browserOutputDir) : {},
                // One-time advisory about rg vs grep and an empty result; never rewrites, since the two regex dialects
                // disagree.
                searchNoticeHooks(request.tools.iqAvailable === true),
                // Registers a watchable session the moment a browser call launches Chromium; the MCP owns its lifecycle.
                request.tools.browserPorts !== undefined
                    ? browserSessionHooks(
                          request.tools.browserPorts,
                          request.tools.browserPasskeys ?? {},
                          request.tools.browserAccounts ?? {},
                          request.spec.conversationId,
                      )
                    : {},
                // Pairs this turn's in-process children with their meta files (type, ask, model, report) and appends what
                // checked their work to each delegation's result.
                subagents !== undefined ? subagentHooks(subagents) : {},
                // A connected MCP server's app, drawn in the chat after a call to the tool it belongs to (mcp-apps.ts).
                appHooks(request, push),
                // Placed by the turn's isolation, since an anchored turn's dependencies exist only inside its own
                // namespace.
                editDiagnosticsHooks(
                    request.spec.isolation,
                    undefined,
                    undefined,
                    request.hooks.dirtyFiles === undefined ? undefined : createShellEditTracker(request.hooks.dirtyFiles),
                    request.hooks.editReviewers ?? [],
                ),
                // Flags a failing test/build caused by a genuinely missing package, checked first; asked of the main
                // checkout.
                depsNoticeHooks(request.hooks.dependencyIssue ?? (async () => undefined), request.policy.dependencyInstallAllowed === true),
            ),
            request.hooks.hookTimed,
        ),
        ...opt("model", request.spec.model),
        ...resumeOptions(request.spec),
        ...sessionTitle(request),
        ...opt(
            "plugins",
            request.tools.plugins?.map((path) => ({ type: "local" as const, path })),
        ),
        ...reasoningOptions(request),
        ...opt("disallowedTools", disallowedToolsOf(request)),
    };
};

// Most recent document the turn wrote, handed to every card it parks on. Filled as the turn runs rather than asking the
// model to repeat its write-up into the question.
export interface TurnDocuments {
    latest: RequestDocument | undefined;
}

// Latest completed assistant prose block, since ExitPlanMode's input carries no plan (the model writes prose first). A
// tool call other than ExitPlanMode clears `current`, so stale narration cannot resurface as a plan.
interface TurnProse {
    current: string;
    latest: string | undefined;
}

// Deltas accumulate, text_end commits to `latest`, and any other main-thread tool call clears it, except ExitPlanMode,
// whose own frame is enqueued before the control request that reads `latest`.
const trackProse = (prose: TurnProse, event: AgentEvent): void => {
    if (event.kind === "delta" && event.parentToolUseId === undefined) {
        prose.current += event.text;
        return;
    }
    if (event.kind === "text_end" && event.parentToolUseId === undefined) {
        const completed = prose.current.trim();
        prose.current = "";
        prose.latest = completed === "" ? undefined : completed;
        return;
    }
    if (event.kind === "tool_call" && event.parentToolUseId === undefined && event.name !== "ExitPlanMode") {
        prose.current = "";
        prose.latest = undefined;
    }
};

// The MCP Apps host's hook, where the owner leaves pages on and has an MCP server connected; nothing otherwise.
const appHooks = (request: HarnessRequest, push: (event: AgentEvent) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const pages = request.tools.pages;
    if (pages?.apps === undefined || pages.apps.length === 0) {
        return {};
    }
    return new McpAppHost({
        servers: pages.apps,
        workspaceRoot: pages.workspaceRoot,
        ...(request.spec.conversationId === undefined ? {} : { conversationId: request.spec.conversationId }),
        push,
    }).hooks();
};

// The API's own ceiling on one picture, base64; a bigger one stays a path for the Read tool, which downsizes.
const MAX_ANSWER_IMAGE_BASE64 = 5 * 1024 * 1024;

// A custom MCP tool, not the built-in, since the built-in's picker UI has nowhere to render headless; aliased onto the
// built-in's name so the model's trained call site still works. alwaysLoad keeps it out of tool search.
const askServer = (
    conversations: Pick<ConversationActors, "holdings">,
    request: HarnessRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
    documents: TurnDocuments,
): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "ui",
        alwaysLoad: true,
        tools: [
            // The page tools beside `ask` (agent/pages/page-tools.ts), only where the owner leaves them on: off, the turn
            // is not offered them at all.
            ...(request.tools.pages === undefined
                ? []
                : pageTools({
                      workspaceRoot: request.tools.pages.workspaceRoot,
                      cwd: request.spec.cwd,
                      placement: request.spec.isolation?.plan,
                      ...(request.spec.conversationId === undefined ? {} : { conversationId: request.spec.conversationId }),
                      push,
                      cards: request.hooks.cards,
                      signal: request.signal,
                      answered: (answered) => syncOnAnswer(conversations, request, push, shell, answered),
                  })),
            sdk().tool(
                "ask",
                'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option: a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
                {
                    questions: z
                        .array(
                            z.object({
                                question: z.string(),
                                header: z.string(),
                                // Defaulted as in the built-in AskUserQuestion, whose call site the model was trained on.
                                multiSelect: z.boolean().default(false),
                                options: z
                                    .array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() }))
                                    .min(2)
                                    .max(4),
                            }),
                        )
                        .min(1)
                        .max(4),
                },
                async (args) => {
                    const questions = args.questions as AskQuestion[];
                    // Named with its conversation: dismissing this ends the turn immediately, not on a second request.
                    const { id, wait } = request.hooks.cards.create(
                        "question",
                        { kind: "question", requestId: "", cancelled: true },
                        request.spec.conversationId,
                    );
                    // The turn's latest write-up rides along, already in hand, since a question about it needs it.
                    push({ kind: "question", requestId: id, questions, ...(documents.latest === undefined ? {} : { document: documents.latest }) });
                    const { reply, resolved } = await wait(request.signal);
                    // Picks belong in the frame log too, not just the tool result: a replayed transcript freezes the
                    // card with them.
                    push(resolved);
                    // Rebase happens before the model acts on the answer, announced to the transcript, not folded into
                    // what it reads.
                    await syncOnAnswer(conversations, request, push, shell, !reply.cancelled && reply.answers !== undefined);
                    // Pictures attached to the answer ride the result natively, so the model sees them without a
                    // Read; the text names every file either way, and an unreadable or oversized one only by path.
                    const { images } = await loadAttachments({ attachments: answerFiles(questions, reply, request.spec.cwd) }, true);
                    const seen = images.filter((image) => image.data.length <= MAX_ANSWER_IMAGE_BASE64).map(imageBlock);
                    return { content: [{ type: "text", text: formatAnswers(questions, reply, request.spec.cwd) }, ...seen] };
                },
                // An answer rebases the conversation's tree (syncOnAnswer), so it must not run beside reads.
                { annotations: toolAnnotations("write") },
            ),
        ],
    });

// Tools that must never raise a permission card: asking a question and entering plan mode are both deferring to the
// user.
const UNGATED = new Set([...ASK_TOOL_NAMES, ...PAGE_TOOL_NAMES, "EnterPlanMode"]);

// The only tools a planning turn is stopped from using: the ones that write a file (rules/edit-tools.ts).
const PLAN_WRITE_TOOLS = new Set<string>(EDIT_TOOL_NAMES);

// The CLI's plan mode tells the model to write its plan to `~/.claude/plans/<name>.md`, the one write planning is
// meant to make; refusing it leaves the model pasting the plan into chat instead. Normalized first, so a path that
// opens in the plans dir and climbs out with `..` is still refused.
const writesPlanFile = (input: Record<string, unknown>): boolean => {
    const raw = input["file_path"];
    if (typeof raw !== "string") {
        return false;
    }
    const state = claudeStatePath(normalize(raw));
    return state !== undefined && isPlanDocumentPath(state);
};

/* PLANNING ASKS NOBODY: the container is the boundary and the plan card is the decision, so no per-tool card is raised
 * while planning. A write is refused to the MODEL instead, since plan mode's promise is that the work waits; the plan
 * file itself is the exception. */
const planDecision = (toolName: string, input: Record<string, unknown>): PermissionResult =>
    PLAN_WRITE_TOOLS.has(toolName) && !writesPlanFile(input)
        ? {
              behavior: "deny",
              message: `${toolName} writes the workspace, and this turn is still planning. Finish the plan and call ExitPlanMode; the work runs once the user approves it.`,
          }
        : { behavior: "allow", updatedInput: input };

// Posture every approved plan executes in, since approval already covers everything it contains; also used by the
// restart path for a restored card.
export const POST_PLAN_MODE: PermissionMode = "bypassPermissions";

// 'Always' grants the whole tool for the session, not the SDK's narrower prefix suggestions, since the container is
// already the isolation boundary.
const toolWideAllow = (toolName: string): PermissionUpdate => ({
    type: "addRules",
    rules: [{ toolName }],
    behavior: "allow",
    destination: "session",
});

// What a permission the user has given produces; a live 'always' keeps the SDK's own suggestions, a restored grant has
// none to keep.
const allowDecision = (
    toolName: string,
    input: Record<string, unknown>,
    always: boolean,
    suggestions: readonly PermissionUpdate[],
): PermissionResult => ({
    behavior: "allow",
    updatedInput: input,
    decisionClassification: always ? "user_permanent" : "user_temporary",
    ...(always ? { updatedPermissions: [...suggestions, toolWideAllow(toolName)] } : {}),
});

// Workspace-root-relative path for the permission card, matching the app's route space; a path outside the workspace
// stays absolute.
const relativePath = (absolute: string | undefined, cwd: string): string | undefined => {
    if (absolute === undefined || absolute === "") {
        return undefined;
    }
    const rel = relative(cwd, absolute);
    return rel === "" || rel.startsWith("..") ? absolute : rel.split(sep).join("/");
};

/* What an approval card would show: the turn's latest prose, else a plan file it wrote, with that file attached when it
 * says more than the prose does. Consumes the prose either way, so a retry reads the next one, not this one again. */
const planRequest = (documents: TurnDocuments, prose: TurnProse): { text: string; document?: RequestDocument } | undefined => {
    const adjacent = prose.latest?.trim() ?? "";
    prose.latest = undefined;
    const file = documents.latest;
    if (adjacent === "") {
        // Nothing said in the turn: a plan file it wrote stands in for the prose, and nothing else does.
        return file?.plan === true && file.markdown.trim() !== "" ? { text: file.markdown.trim() } : undefined;
    }
    return file !== undefined && file.markdown.length > adjacent.length ? { text: adjacent, document: file } : { text: adjacent };
};

// Every permission decision the turn needs from the user; the two postures this branches on are plan, which asks
// nobody, and Manual, the only one that asks at all.
const permissionGate = (
    conversations: Pick<ConversationActors, "holdings">,
    request: HarnessRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
    documents: TurnDocuments,
    prose: TurnProse,
    // The posture as the SESSION holds it, which the CLI moves too, not only this gate (sdk-stream.ts).
    posture: TurnPosture,
): CanUseTool => {
    // The plan card: raised from the turn's latest prose, answered by the owner.
    // Raised whoever started the turn: an unattended turn's plan waits for the owner's answer like any other card.
    const decidePlan = async (input: Record<string, unknown>): Promise<PermissionResult> => {
        const card = planRequest(documents, prose);
        // A blank card approves nothing; keep plan mode and let the next prose, or a written plan file, retry.
        if (card === undefined) {
            return {
                behavior: "deny",
                message: "Write the complete plan in your response, then call ExitPlanMode again.",
            };
        }
        const { id, wait } = request.hooks.cards.create("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
        push({ kind: "plan", requestId: id, ...card });
        const { reply, resolved } = await wait(request.signal);
        push(resolved);
        if (!reply.approve) {
            // Framed as a rejection, so notes that read like consent ("proceed…") are not taken as leave to execute.
            return { behavior: "deny", message: planRevision(reply.feedback) };
        }
        // Setting the mode on the session is what actually moves the SDK out of plan mode.
        posture.mode = POST_PLAN_MODE;
        push({ kind: "mode", mode: POST_PLAN_MODE });
        // Rebase before the agent builds on the plan, so it isn't working against a moved tree; the agent isn't
        // told.
        await syncOnAnswer(conversations, request, push, shell, true);
        return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: [{ type: "setMode", mode: POST_PLAN_MODE, destination: "session" }],
            decisionClassification: "user_temporary",
        };
    };
    // The per-tool card: the turn parks here until somebody presses a button.
    const askOwner = async (toolName: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> => {
        const { id, wait } = request.hooks.cards.create("permission", {
            kind: "permission",
            requestId: "",
            decision: "deny",
            feedback: "The turn was cancelled before you answered.",
        });
        // Passes through the bridge's own prompt sentence, button label and reason rather than re-deriving copy.
        const suggestions = options.suggestions ?? [];
        const path = relativePath(options.blockedPath, request.spec.cwd);
        push({
            kind: "permission",
            requestId: id,
            toolName,
            ...opt("title", options.title),
            ...opt("displayName", options.displayName),
            ...opt("description", options.description),
            ...opt("reason", options.decisionReason),
            ...opt("path", path),
            // Always offered: a tool-wide rule can be written for any tool, whether or not the SDK suggested one of its
            // own.
            alwaysLabel: `Don't ask again for ${options.displayName ?? toolName}`,
        });
        const { reply, resolved } = await wait(request.signal);
        push(resolved);
        if (reply.decision === "deny") {
            // Feedback means redirection and the turn continues; a bare denial means the user is stopping the turn
            // outright.
            return {
                behavior: "deny",
                message:
                    reply.feedback?.trim() ||
                    `The user declined ${toolName} and stopped the turn. STOP what you are doing and wait for them to say how to proceed.`,
            };
        }
        return allowDecision(toolName, input, reply.decision === "always", suggestions);
    };
    return async (toolName, input, options) => {
        if (toolName === "ExitPlanMode") {
            return decidePlan(input);
        }
        if (UNGATED.has(toolName)) {
            // Also set by the stream's own mode frame, but the CLI can ask about the next tool in this block before
            // the consumer has drained that frame.
            if (toolName === "EnterPlanMode") {
                posture.mode = "plan";
            }
            return { behavior: "allow", updatedInput: input };
        }
        if (posture.mode === "plan") {
            return planDecision(toolName, input);
        }
        /* MANUAL IS THE ONLY POSTURE THAT ASKS A PERSON. Every other one runs the tool: this agent holds a container
         * and a worktree of its own, so a card per tool spends the user's attention on a boundary the sandbox already
         * is. */
        if (posture.mode !== "default") {
            return { behavior: "allow", updatedInput: input };
        }
        // Consumes an answer already given by a restored card, so the resumed turn's re-ask doesn't re-prompt.
        const granted = request.hooks.restoredGrant?.(toolName);
        if (granted !== undefined) {
            return allowDecision(toolName, input, granted.always, options.suggestions ?? []);
        }
        return askOwner(toolName, input, options);
    };
};

// What the stream reads of the turn's credential: whose allowance a routed turn spends, the translator endpoint a retry
// storm can ask whether it is refusing this model rather than having a bad minute, and whether this is the trial.
const streamCredentialOf = (
    credential: HarnessCredential,
    model: string | undefined,
): Pick<Parameters<typeof streamSdk>[0], "allowance" | "routed" | "trial"> => ({
    allowance: credential.kind === "routed" ? credential.allowance : undefined,
    routed: routedEndpointOf(credential, model),
    trial: credential.kind === "trial",
});

// Runs one agent turn over `request.spec.cwd`, streaming typed events; one path for every permission mode, the SDK decides
// which UI fires. canUseTool and the ask handler feed this stream through a bridging queue. `conversations` hold the
// children and background commands the turn starts.
export async function* runAgent(
    conversations: Pick<ConversationActors, "holdings" | "send">,
    request: HarnessRequest,
    queryFn: QueryFn = defaultQuery,
    usageFetch: typeof fetch = fetch,
): AsyncGenerator<AgentEvent> {
    // The SDK's own, not the turn's signal: it takes a controller and aborts it itself when its query closes, which must
    // not stop the turn. The turn's signal is linked into it where the SDK starts, below.
    const abortController = new AbortController();

    // Pins which installed Claude Code copy this turn uses, so the query fn, tool servers and CLI binary all match.
    await refreshClaudeSdk();

    const queue = new EventQueue<AgentEvent>();
    const push = (event: AgentEvent): void => queue.push(event);

    const permissionMode: PermissionMode = request.policy.permissionMode ?? "bypassPermissions";
    // One posture for the turn, seeded with the mode it launched in: the stream writes every move the CLI makes onto
    // it, the gate decides on it.
    const posture: TurnPosture = { mode: permissionMode };
    const tmuxEnabled = tmuxRunEnabled();
    // Read after the SDK copy is pinned, since the intentic base is cut from that copy's own preset.
    const systemPrompt = await sdkSystemPrompt(promptInputOf(request, terminalMounted(tmuxEnabled)), request.spec.cwd);
    // Shared handle for every agent this turn starts; no conversation means nothing to file children under.
    const subagents: SubagentTurn | undefined =
        request.spec.conversationId === undefined
            ? undefined
            : { conversationId: request.spec.conversationId, conversations, subagentsDir: undefined };
    // Seeded from the resumed session id, not empty, since an earlier turn's background job may still run in it.
    const shell: { sessionId: string | undefined } = { sessionId: request.spec.sessionId };
    // Per turn, deliberately: a question in a later turn shouldn't inherit a document written in an earlier one.
    const documents: TurnDocuments = { latest: undefined };
    // Adjacent assistant prose ExitPlanMode reads, filled from main-thread stream frames below.
    const prose: TurnProse = { current: "", latest: undefined };
    // Writes seen but not yet settled, keyed by call id; a Write's content is known at call time but can still fail.
    const writing = new Map<string, RequestDocument>();
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, permissionMode, tmuxEnabled, subagents, push),
        // Either built-in base plus this harness's guidance, or the owner's own prompt alone; SDK sends an empty prompt if
        // omitted.
        systemPrompt,
        // Legalizes bypassPermissions without activating it; a plan approval can switch into bypass mid-turn.
        allowDangerouslySkipPermissions: true,
        // Every turn's CLI is spawned here, so it starts in its class and, anchored, inside its namespace.
        spawnClaudeCodeProcess: runtimeSpawn(request.spec.isolation?.anchor, request.spec.spawnDepth ?? 0, (data) => {
            stderr += data;
        }),
        // Backs AskUserQuestion, on every turn: a question an unattended turn asks waits for the owner's answer.
        mcpServers: {
            // External MCP capabilities first, so every daemon-owned server below wins a name collision: a capability
            // whose id is `ui`, `code` or a browser router can't replace the real one. The capability routes refuse
            // those ids (reserved-servers.ts), and this last-wins order is the structural backstop behind that refusal.
            ...mcpServersOf(request.tools.remote ?? []),
            ui: askServer(conversations, request, push, shell, documents),
            // Accounts tools get the same live stream and abort signal handles the ask tool does.
            ...(request.tools.accountsServer === undefined ? {} : { accounts: request.tools.accountsServer(push, request.signal) }),
            // Hands the terminal to the owner with the same handles plus `shell`, naming which tmux session commands
            // run in.
            ...(!terminalMounted(tmuxEnabled)
                ? {}
                : {
                      terminal: terminalHelpServer({
                          shell,
                          ...(request.spec.conversationId === undefined ? {} : { conversationId: request.spec.conversationId }),
                          signal: request.signal,
                          push,
                          cards: request.hooks.cards,
                      }),
                  }),
            // JS execution backend, mounted from its own request field like `ui`/`terminal`, not the generic server
            // bags.
            // Spelled out literally (JS_SERVER_NAME): the outside-results conformance scan reads this block as text.
            ...(request.tools.jsExecution === undefined
                ? {}
                : {
                      code: jsExecutionServer({
                          plan: request.tools.jsExecution,
                          placement: request.spec.isolation,
                          signal: request.signal,
                          ...(request.tools.secrets === undefined ? {} : { secrets: request.tools.secrets }),
                      }),
                  }),
            ...request.tools.sdkServers,
        },
        // Aliases `Code` beside the built-in, so skills/prompts address the execution backend the way they address
        // Bash.
        toolAliases: { AskUserQuestion: "mcp__ui__ask", [JS_TOOL_ALIAS]: JS_TOOL_NAME },
        // Card renders markdown, so option previews arrive as markdown; pinned since the web-SDK default is HTML.
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        planModeInstructions:
            "Write the complete, clear, concise plan in your response, then call ExitPlanMode to ask for approval before executing. When you need the user to choose between options, ask with the AskUserQuestion tool rather than writing the choices as plain text.",
        canUseTool: permissionGate(conversations, request, push, shell, documents, prose, posture),
        ...profileOptions(request),
    };

    // Only a stored-account token reads usage pools at settle; other turns have no pool or account to file under. A sealed
    // request is waited on by its caller to the last frame, so it does not pay for the read either.
    const credential = request.credential;
    const readUsage =
        credential.kind !== "claude-oauth" || request.policy.sealed === true
            ? undefined
            : (): Promise<UsageWindow[]> => readClaudeUsage(credential.token, usageFetch).then((reading) => reading.windows);

    // Swallowed-prompt recovery: pushes the turn's own prompt back through the steering queue once.
    const steering = request.spec.steering;
    let redelivered = false;
    // Checklist rows the session already holds, read off the CLI's own store before it starts writing.
    const checklistSeed = await checklistSeedOf(request.spec);
    // What the resumed session already spent, which the CLI counts again in its first result.
    const carriedCostUsd = await carriedCostOf(request.spec);
    const redeliver =
        steering === undefined
            ? undefined
            : (): boolean => {
                  if (redelivered) {
                      return false;
                  }
                  redelivered = true;
                  return steering.push(request.spec.prompt);
              };

    // Linked here and not where the controller is made: nothing reads it before the SDK starts on the next line (a turn
    // stopped earlier still reaches it aborted), and from here every way out passes the `finally` that unlinks it, so
    // the turn's signal keeps no listener once the SDK has settled.
    const unlink = whenAborted(request.signal, () => abortController.abort());
    const pump = (async () => {
        try {
            for await (const event of streamSdk({
                queryFn,
                prompt: promptInput(request.spec.prompt, request.spec.steering),
                options,
                cwd: request.spec.cwd,
                tmuxEnabled,
                browserOutputDir: request.tools.browserOutputDir,
                steering: request.spec.steering,
                redeliver,
                readUsage,
                ...streamCredentialOf(credential, request.spec.model),
                subagents,
                checklistSeed,
                carriedCostUsd,
                posture,
            })) {
                // Turn's shell is named after this frame's session id (tmux session), so cards learn it here.
                if (event.kind === "session") {
                    shell.sessionId = event.sessionId;
                }
                // ExitPlanMode's current SDK input carries no plan; the completed prose before it does.
                trackProse(prose, event);
                // Held back until the call completes, since a Write's content is known at call time but the call can
                // still fail.
                if (event.kind === "tool_call") {
                    const written = documentOf(event.name, event.content);
                    if (written !== undefined) {
                        writing.set(event.id, written);
                    }
                }
                if (event.kind === "tool_call_update" && event.status !== undefined) {
                    const written = writing.get(event.id);
                    if (written !== undefined && event.status !== "pending" && event.status !== "in_progress") {
                        writing.delete(event.id);
                        documents.latest = event.status === "completed" ? written : documents.latest;
                    }
                }
                // Child tool calls carry the spawning call's id, so edits and checks attribute without a hook or join.
                if (event.kind === "tool_call") {
                    noteChildWork(conversations, event, event.parentToolUseId);
                } else if (event.kind === "tool_call_update") {
                    noteChildWork(conversations, event, undefined);
                }
                push(event);
            }
        } catch (error) {
            push(credential.kind === "trial" ? trialUnavailableFrame() : { kind: "error", message: errorMessage(error, stderr) });
        } finally {
            // Any child still marked live is closed as `killed` when the turn ends; nothing else reports it.
            if (subagents !== undefined) {
                for (const frame of closeSubagents(conversations, subagents.conversationId)) {
                    push(frame);
                }
            }
            // Closes streaming input so the SDK subprocess settles; late steer pushes report undelivered.
            request.spec.steering?.close();
            queue.end();
        }
    })();

    try {
        yield* queue;
    } finally {
        await pump;
        unlink();
    }
    yield { kind: "done" };
}
