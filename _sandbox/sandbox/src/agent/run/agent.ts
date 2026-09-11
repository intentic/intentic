import type {
    CanUseTool,
    EffortLevel,
    HookCallbackMatcher,
    HookEvent,
    McpSdkServerConfigWithInstance,
    McpServerConfig,
    Options,
    PermissionUpdate,
    SpawnedProcess,
    SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeCliPath, refreshClaudeSdk, sdk } from "../../runtimes/claude/claude-sdk.js";
import { spawn } from "node:child_process";
import {
    type AdmissionRule,
    type AgentCapabilities,
    type AgentEvent,
    type AskQuestion,
    type CardDocument,
    type CommandJudgeMode,
    DEFAULT_SAFETY_POLICY,
    type DependencyFreshness,
    documentOf,
    type PermissionMode,
    type Rule,
    sendableEffort,
    sendableThinking,
    type SystemPromptMode,
    type TurnNote,
    type UsageWindow,
} from "@intentic/sandbox-contract";
import { relative, sep } from "node:path";
import { z } from "zod";
import { daemonMountNs, type IsolationAnchor, nsenterArgv, TMUX_NS_ENV, type TurnPlacement } from "../../agents/worktrees/isolation.js";
import { worktreeRedirectHooks } from "../../agents/worktrees/worktree-redirect.js";
import type { AccountsServerFactory } from "../../browser/tools/accounts-tools.js";
import type { ChildSupervisor } from "../subagents/children.js";
import { browserArtifactHooks } from "../../browser/cast/browser-artifacts.js";
import { browserSessionHooks } from "../../browser/sessions/browser-sessions.js";
import { depsNoticeHooks } from "../tools/agent-deps.js";
import type { FreshnessResolver } from "../../dependencies/registry-freshness.js";
import type { WorkspacePins } from "../../dependencies/workspace-pins.js";
import { freshnessHooks } from "../providers/agent-freshness.js";
import { searchNoticeHooks } from "../verification/agent-search.js";
import type { DependencyIssue } from "../../workspace/deps/reconcile-deps.js";
import { editDiagnosticsHooks, type EditReviewer } from "../verification/agent-diagnostics.js";
import { createShellEditTracker, type DirtyFiles } from "../tools/agent-shell-edits.js";
import type { RuleCommandRun } from "../../rules/rule-command.js";
import { installSteeringHooks } from "../providers/agent-installs.js";
import type { ClassifiedInstall } from "../../environment/runtime-installs.js";
import { redactionHooks } from "../tools/agent-redaction.js";
import { type SecretAccess, secretCommandHooks } from "../tools/agent-secrets.js";
import { type CommandGateOptions, commandGateHooks } from "../../guard/command-gate.js";
import { outboundGateHooks } from "../../guard/outbound-gate.js";
import { outsideResultHooks } from "../../guard/outside-results.js";
import { createTurnTaint, publishTurnTaint } from "../../guard/turn-taint.js";
import { type PersonaScope, personaScopeHooks } from "../../personas/persona-scope.js";
import type { JsExecutionPlan } from "../../execution/js-runtime.js";
import { JS_TOOL_ALIAS, JS_TOOL_NAME, jsExecutionServer } from "../../execution/js-tool.js";
import { type AgentTool, mcpServersOf } from "../tools/agent-tools.js";
import { createRequest } from "../tools/agent-requests.js";
import { type SteeringQueue, turnSteered } from "../anchors/agent-steering.js";
import { type FollowUpOutcome, type TurnRuleCommand, turnEndingHooks } from "../../rules/turn-ending.js";
import { agentShellBusy, bashTmuxHooks, tmuxRunEnabled } from "../tools/agent-terminals.js";
import type { HeavyCommands } from "../../platform/resources/heavy-commands.js";
import { terminalHelpServer } from "../../terminal/terminal-help.js";
import { EventQueue } from "./event-queue.js";
import { trialUnavailableFrame } from "./error-frames.js";
import { harnessEnv, type TurnAllowance } from "../providers/harness-credentials.js";
import { workloadStamp } from "../../platform/boot/leftovers.js";
import { opt } from "./opt.js";
import { readClaudeUsage } from "../../usage/claude-usage.js";
import { routedEndpointOf } from "../providers/routed-refusal.js";
import { defaultQuery, promptInput, type QueryFn, streamSdk } from "./sdk-stream.js";
import { checklistCloseHooks } from "./checklist-close.js";
import { checklistSeedOf } from "./task-store.js";
import { sdkSystemPrompt } from "../prompt/system-prompt.js";
import type { HostDeviceReach } from "../../hosts/self-host.js";
import { noteChildWork } from "../subagents/child-verification.js";
import { closeSubagents, subagentInParentTree, subagentHooks, type SubagentTurn } from "../subagents/subagents.js";
import { ASK_TOOL_NAMES, formatAnswers } from "../tools/question-answers.js";

export interface AgentRequest {
    // The user's own words, read after `notes`; never the composed wire string, minted once at dispatch.
    readonly prompt: string;
    // Typed daemon-authored notes shown before the prompt, in order; absent means nothing was injected.
    readonly notes?: readonly TurnNote[];
    // Conversation this turn belongs to, for filing its subagents under the parent. Absent: unregistered.
    readonly conversationId?: string;
    // Absolute paths of attached files; Codex sends images as native inputs, Claude folds them into the prompt.
    readonly attachments?: readonly string[];
    // Working dir the agent edits, the workspace root; under `isolation` it's the root as seen inside the namespace.
    readonly cwd: string;
    // Main checkout as the daemon sees it, unlike `cwd` under isolation or a subfolder; used for the real deps.
    readonly workspaceRoot?: string;
    // Project-scoped dependency answer for the command-failure hook, so one project's error stays its own.
    readonly dependencyIssue?: (command: string) => Promise<DependencyIssue | undefined>;
    readonly dependencyInstallAllowed?: boolean;
    // How far freshness checks may go, and the turn-scoped resolver that answers them; absent mode wires no hook.
    readonly dependencyFreshness?: DependencyFreshness;
    readonly freshnessResolver?: FreshnessResolver;
    // What this workspace already pins, so a new package matching the catalog's version isn't reported as stale.
    readonly workspacePins?: WorkspacePins;
    // Files the tree says are dirty, by both names, so a Bash edit gets the same diagnostics as a native Edit.
    readonly dirtyFiles?: DirtyFiles;
    // Owner's file.edited rules bound to this turn's placement, run on every file an edit tool or shell writes.
    readonly editReviewers?: readonly EditReviewer[];
    // Every classified image-scoped install this turn attempts, for the install ledger; nothing reaches the model.
    readonly onImageInstall?: (installs: readonly ClassifiedInstall[], command: string) => void;
    // Where this turn works, how strongly enforced; anchored, /work IS the worktree, else inputs are redirected.
    readonly isolation?: TurnPlacement;
    // Resume a prior turn's session for multi-message conversations.
    readonly sessionId?: string;
    readonly signal: AbortSignal;
    // Defaults to the account/subscription default; override with INTENTIC_AGENT_MODEL.
    readonly model?: string;
    // User's Claude subscription token, resolved from stored credentials; else falls back to the container env.
    readonly oauthToken?: string;
    // Re-mints `oauthToken` mid-turn on refusal; undefined or the same token ends the turn as before.
    readonly refreshOauthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
    // Custom Anthropic endpoint + bearer for a translator-served turn; when set, the OAuth token is withheld.
    readonly baseUrl?: string;
    readonly authToken?: string;
    // Whose allowance a routed turn spends and when it reopens; set alongside `baseUrl`. See TurnAllowance.
    readonly allowance?: TurnAllowance;
    // Platform-owned free trial: bound retries and use trial-specific failure frames/copy.
    readonly trial?: boolean;
    // Selected Codex account's CODEX_HOME (Codex path only); absent falls back to the container's OPENAI_API_KEY.
    readonly codexHome?: string;
    // Serves a native Codex turn via the translator, on the subscription; codexHome then holds sessions only.
    readonly codexEndpoint?: { readonly baseUrl: string; readonly authToken: string };
    // Selected Cursor account's API key, passed per request since Cursor runs in-process with no child env to set.
    readonly cursorApiKey?: string;
    // How tool calls are gated this turn; defaults to bypassPermissions, safe since the container is the boundary.
    readonly permissionMode?: PermissionMode;
    // Narrows the turn to tool NAMES (SDK option), not `tools` below (MCP servers); the Front Desk allowlist.
    readonly allowedTools?: readonly string[];
    // Reasoning controls forwarded to the SDK: effort level and extended thinking.
    readonly effort?: string;
    readonly thinking?: boolean;
    // Ask the harness to serve this turn at fast speed; only ever set for a native Claude turn, never a routed one.
    readonly fast?: boolean;
    // This turn's MCP tools: intent-declared internal services plus configured integrations, each a remote server.
    readonly tools?: readonly AgentTool[];
    // Env vars for the agent's shell from cli-kind capability credentials (e.g. a bot token), merged in each turn.
    readonly cliEnv?: Record<string, string>;
    // JS execution backend's plan; absent means it isn't mounted (projected as the `Code` tool below).
    readonly jsExecution?: JsExecutionPlan;
    // Owner's rules standing at turn.ending, and how to run one's command; read at Stop. Empty: nothing wired.
    readonly turnEndingRules?: readonly Rule[];
    readonly runRuleCommand?: TurnRuleCommand;
    // Which projects the daemon is installing, asked only after a turn-ending command has already failed.
    readonly dependencyInstalling?: () => Promise<readonly string[]>;
    // Told when a rule actually fires, so settings can show which rules are earning their place.
    readonly onRuleFired?: (rule: Rule) => void;
    // Told what every command rule's run said, so end-of-turn landing can hold work whose check went red.
    readonly onCheckRun?: (rule: Rule, run: RuleCommandRun) => void;
    // What the model did after a turn.ending follow-up, at the Stop that followed it.
    readonly onFollowUpOutcome?: (rule: Rule, outcome: FollowUpOutcome) => void;
    // The verify-tests built-in's answer for this tree, bound while planning; absent means it says nothing.
    readonly verifyTests?: () => Promise<string | undefined>;
    // What the tree says the turn changed, for the Stop's conditions: a shell edit is invisible to the edit ledger.
    readonly changedPaths?: () => Promise<readonly string[]>;
    // This tree's repositories, for a rule aimed at one; asked at the Stop only when such a rule stands.
    readonly turnRepos?: () => Promise<readonly string[]>;
    // Absolute plugin checkout dirs; the SDK's loader parses their skills/agents/hooks/commands/.mcp.json.
    readonly plugins?: readonly string[];
    // In-process SDK MCP servers whose handlers run in the daemon itself, merged into mcpServers alongside `tools`.
    readonly sdkServers?: Record<string, McpServerConfig>;
    // Accounts tools as a factory rather than a built server, closed over this turn's event stream and abort signal.
    readonly accountsServer?: AccountsServerFactory;
    // Directory for browser tool artifacts (the `--output-dir` value); drives the redirect hook and read-back path.
    readonly browserOutputDir?: string;
    // Whether turn-plan mounted the diagnostics server; withheld from a persona whose `files` power is `none`.
    readonly diagnostics?: boolean;
    // The connected devices this turn carries servers for, which of them runs this sandbox (when the daemon's held
    // readings name it) and this container's slug out there: what the prompt needs to say "run it there yourself".
    readonly hostDevices?: HostDeviceReach | undefined;
    // Whether the iq plugin is actually loaded, so the empty-search notice can name it only where it's real.
    readonly iqAvailable?: boolean;
    // Each browser profile owner's CDP debugging port, so the first browser call can register a watchable session.
    readonly browserPorts?: Record<string, number>;
    // Each logged-in profile owner's passkey store path, so the session observer arms pages with the software key.
    readonly browserPasskeys?: Record<string, string>;
    // Routed browser server's account-to-owner map, so the observer resolves a call's `account` to its profile.
    readonly browserAccounts?: Record<string, string>;
    // Built-in tool names removed from context, e.g. Edit/Write when hashlineEdits routes through MCP tools instead.
    readonly disallowedTools?: readonly string[];
    // Where this persona's file tools may point, when its card limits them; absent wires no hook.
    readonly personaScope?: PersonaScope;
    // Bash output-cleaner spec, forwarded as INTENTIC_OUTPUT_CLEANERS, or 'off' to disable filtering entirely.
    readonly outputCleaners?: string;
    // Sniffer's rulebook, verdicts per outbound call, enforced by the PreToolUse gate; empty wires no gate.
    readonly actionRules?: Readonly<Record<string, AdmissionRule>>;
    // Owner's safety policy the judge applies to a flagged command; absent uses the shipped default, always wired.
    readonly safetyPolicy?: string;
    // How much of the command gate is on: 'on' full design, 'watch' records only, 'off' skips the judge.
    readonly judging?: CommandJudgeMode;
    // The judge and its writes, as functions so this module never reaches for `Services`; absent skips the judge.
    readonly judge?: CommandGateOptions["judge"];
    readonly logSafety?: CommandGateOptions["log"];
    readonly safetyAnswered?: CommandGateOptions["answered"];
    readonly rememberSafety?: CommandGateOptions["remember"];
    // What the serving runtime can do about the safety policy; absent defaults to 'hooks' (Claude Code).
    readonly rulebook?: AgentCapabilities["rulebook"];
    // Whether this turn was woken by outside content (a listener message, a webchat visitor), naming the source.
    readonly outsideWake?: string;
    // Fraction [0,1] of commands whose output bypasses cleaning, recorded as a baseline; 0/undefined disables it.
    readonly outputHoldout?: number;
    // Every named credential this sandbox stores: masked on read, resolved on shell exit, typed into browser fields.
    readonly secrets?: SecretAccess;
    // Heavy-command rules, read fresh per Bash command so an edit to the file binds immediately.
    readonly heavyCommands?: () => Promise<HeavyCommands>;
    // Harness's delegation ceilings: concurrent, per-turn, nesting; undefined leaves the CLI default in place.
    readonly subagentsAtOnce?: number;
    readonly subagentsPerTurn?: number;
    readonly subagentDepth?: number;
    // Extra turn-scoped instructions appended to the system prompt (e.g. the CLI delegation note).
    readonly systemAppend?: string;
    // Which base this turn's system prompt is built on; absent uses 'intentic', the product default.
    readonly systemPromptMode?: SystemPromptMode;
    // Owner's own prompt, used only when mode is 'custom'; then it's the whole prompt, `systemAppend` included.
    readonly systemPrompt?: string;
    // Mid-turn steering queue; when present the turn streams input and pushed messages inject between tool calls.
    readonly steering?: SteeringQueue;
    // Rebases onto main when the turn parks for a person; the model isn't told. Absent off-harness or main-tree.
    readonly resync?: () => Promise<AgentEvent | undefined>;
    // No one is watching this turn; plan/ask tools are withheld and the permission gate refuses rather than waits.
    readonly unattended?: boolean;
    // Supervision surface for runtimes that mount child-agent tools as their own, not through the harness's SDK.
    readonly children?: ChildSupervisor;
}

// Rebases only on an actual answer, not a dismissal/rejection; and only when quiet, skipped if the turn's shell or a
// subagent is still writing. Either case leaves the branch exactly where it was.
const syncOnAnswer = async (
    request: AgentRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
    answered: boolean,
): Promise<void> => {
    if (!answered || request.resync === undefined) {
        return;
    }
    if (request.conversationId !== undefined && subagentInParentTree(request.conversationId)) {
        return;
    }
    if (shell.sessionId !== undefined && (await agentShellBusy(shell.sessionId))) {
        return;
    }
    // Swallowed here so a rebase fault can't fail a card the user already answered; resync owns its own logging.
    const frame = await request.resync().catch(() => undefined);
    if (frame !== undefined) {
        push(frame);
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
const cleanerEnv = (request: AgentRequest): Record<string, string> => {
    if (request.outputCleaners === "off") {
        return { INTENTIC_RUN_FILTER: "0" };
    }
    return {
        // Empty means the filter's default, so it's dropped the same as absent.
        ...opt("INTENTIC_OUTPUT_CLEANERS", request.outputCleaners || undefined),
        ...opt(
            "INTENTIC_OUTPUT_HOLDOUT",
            request.outputHoldout !== undefined && request.outputHoldout > 0 ? String(request.outputHoldout) : undefined,
        ),
    };
};

// The three env vars the CLI reads for delegation ceilings; the only way to move them since they aren't SDK options.
// Absent emits nothing, so the CLI's own default stands.
const subagentEnv = (request: AgentRequest): Record<string, string> => ({
    ...opt("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", request.subagentsAtOnce?.toString()),
    ...opt("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", request.subagentsPerTurn?.toString()),
    ...opt("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", request.subagentDepth?.toString()),
});

// Pins Claude Code's checklist tools on: newer models gate Task*/TodoWrite off by default, but the prompt and reducer
// both depend on them.
const CHECKLIST_ENV: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    CLAUDE_CODE_ENABLE_TASKS: "1",
};

// Hides CLI skills with no daemon equivalent: loop/schedule need a live process, keybindings-help/update-config target
// the CLI's own UI.
const HEADLESS_SETTINGS: Exclude<NonNullable<Options["settings"]>, string> = {
    skillOverrides: { loop: "off", schedule: "off", "keybindings-help": "off", "update-config": "off" },
};

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

// Tools that converse with the user rather than act on the workspace; withheld from an unattended turn.
const PLAN_TOOLS = ["EnterPlanMode", "ExitPlanMode"];

// CLI scheduling tools are dead here (the process dies at turn end); automations and the watch tools replace them.
const CLI_SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];

// Tools removed from the model: scheduler tools always, the caller's own list, plus plan tools on an unattended turn.
const disallowedToolsOf = (request: AgentRequest): string[] => [
    ...CLI_SCHEDULER_TOOLS,
    ...(request.disallowedTools ?? []),
    ...(request.unattended === true ? PLAN_TOOLS : []),
];

// On a 401 the CLI asks this callback for a refreshed token and resumes on what comes back; the same token ends the
// turn. Untyped in sdk.d.ts (present in sdk.mjs), hence the OauthRecoveryOptions extension.
// Execs the CLI into the turn's isolation anchor via nsenter instead of spawning plainly; the SDK still owns the
// child's stdio, exit and SIGTERM. A failure here fails the turn rather than silently using the shared tree.
const namespacedSpawn =
    (anchor: IsolationAnchor) =>
    (options: SpawnOptions): SpawnedProcess => {
        const { command, args } = nsenterArgv(anchor.pid, anchor.cwd, options.command, options.args);
        return spawn(command, args, {
            env: options.env,
            ...opt("signal", options.signal),
            stdio: ["pipe", "pipe", "pipe"],
        });
    };

export type OauthRecoveryOptions = Options & {
    getOAuthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
};

// Effort and thinking are set together since the API only accepts certain combinations; sendableThinking/sendableEffort
// make the tier explicit even for a max turn with no thinking set.
const reasoningOptions = (request: AgentRequest): { effort?: EffortLevel; thinking?: { type: "adaptive" | "disabled" } } => {
    const thinking = sendableThinking(request.effort, request.thinking);
    return {
        ...opt("effort", sendableEffort(request.effort, request.thinking) as EffortLevel | undefined),
        ...opt("thinking", thinking === undefined ? undefined : { type: thinking ? ("adaptive" as const) : ("disabled" as const) }),
    };
};

// Whether the routed browser has any account behind it, deciding if the system prompt names that server at all.
const holdsBrowserAccounts = (accounts: Record<string, string> | undefined): boolean => Object.keys(accounts ?? {}).length > 0;

// Whether the terminal hand-off server is mounted, kept as one predicate so the mount and its prompt sentence never
// drift; off when unattended or without the tmux wrapper.
const terminalMounted = (request: AgentRequest, tmuxEnabled: boolean): boolean => tmuxEnabled && request.unattended !== true;

// Base SDK options for the turn.
const baseOptions = (
    request: AgentRequest,
    abortController: AbortController,
    permissionMode: PermissionMode,
    tmuxEnabled: boolean,
    // Turn handle the subagent registry files children under; absent means no conversation (the bench).
    subagents: SubagentTurn | undefined,
    // Turn's event sink; the command gate uses it to park the turn on a card without ever calling canUseTool.
    push: (event: AgentEvent) => void,
): OauthRecoveryOptions => {
    // This turn's outside-content bit, set once here; the wrap hook sets it, the gate reads it per command.
    const taint = createTurnTaint(request.outsideWake);
    // Published for consult sites outside this generator (wallet gate, host bridge); cleared when the turn settles.
    if (request.conversationId !== undefined) {
        publishTurnTaint(request.conversationId, taint, request.unattended === true);
    }
    return {
        cwd: request.cwd,
        // Named for a store copy so the CLI spawned is the one this daemon chose; absent on the image's copy.
        ...opt("pathToClaudeCodeExecutable", claudeCliPath()),
        // Only for a native Claude turn on a sandbox credential; other endpoints have no refresh token to mint from.
        ...opt("getOAuthToken", request.baseUrl === undefined ? request.refreshOauthToken : undefined),
        includePartialMessages: true,
        // Forwards a subagent's prose and thinking, not just tool calls, so it renders as a conversation.
        forwardSubagentText: true,
        permissionMode,
        ...opt("allowedTools", request.allowedTools?.slice()),
        abortController,
        // Claude Code's coding preset plus this harness's guidance, or the owner's own prompt alone; SDK sends an empty
        // prompt if omitted.
        systemPrompt: sdkSystemPrompt({
            mode: request.systemPromptMode ?? "intentic",
            custom: request.systemPrompt,
            append: request.systemAppend,
            unattended: request.unattended === true,
            browserOutputDir: request.browserOutputDir,
            browserAccounts: holdsBrowserAccounts(request.browserAccounts),
            diagnostics: request.diagnostics === true,
            terminal: terminalMounted(request, tmuxEnabled),
            hostDevices: request.hostDevices,
        }),
        // Loads the workspace's .claude/ config: skills, subagents, settings, hooks, .mcp.json; else none. Not the
        // owner's standing rules — those are composed for every runtime alike (workspace-memory.ts), so a CLAUDE.md
        // this still picks up is a repo's own file, not this product's memory.
        settingSources: ["user", "project"],
        // Fast-mode opt-in, per-session so the choice doesn't persist sandbox-wide; omitted (not false) so it never
        // overrides the owner's settings.json.
        settings: {
            ...HEADLESS_SETTINGS,
            ...(request.fast === true ? { fastMode: true, fastModePerSessionOptIn: true } : {}),
        },
        env: {
            ...process.env,
            // cli-kind capability credentials the shell reads, rebuilt every turn; tmux panes get key names, not
            // values.
            ...request.cliEnv,
            // IS_SANDBOX plus this turn's credential; a custom endpoint withholds the OAuth token for its own bearer.
            ...harnessEnv(request),
            // Output-cleaner spec/holdout the Bash to tmux-run pipeline reads.
            ...cleanerEnv(request),
            // Delegation ceilings this turn overrides, if any, on top of the harness defaults.
            ...subagentEnv(request),
            // Checklist tools the prompt advertises and the task list needs; not owner-tunable, see CHECKLIST_ENV.
            ...CHECKLIST_ENV,
            // Where tmux-run talks to tmux: the daemon's namespace, not the turn's, so it starts a server there if
            // needed.
            ...(request.isolation?.anchor !== undefined ? { [TMUX_NS_ENV]: daemonMountNs } : {}),
            // Whose work this is, for the leftovers sweep; unstamped with no conversation rather than a made-up owner.
            ...(request.conversationId !== undefined ? workloadStamp(request.conversationId) : {}),
        },
        // Hooks fire under bypassPermissions and for subagents: tmux wraps every Bash command, installs redirect to the
        // approved overlay, diagnostics type-checks native edits.
        hooks: mergeHooks(
            // Runs before the tmux wrapper, so the classifier and card see the agent's own command, not wrapper
            // boilerplate.
            commandGateHooks({
                policy: request.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
                judging: request.judging ?? "on",
                unattended: request.unattended === true,
                // Read per command, not snapshotted beside it: attendance is the one fact about a turn that can arrive
                // after it starts, and it arrives as a steering message.
                steered: () => request.conversationId !== undefined && turnSteered(request.conversationId),
                push,
                signal: request.signal,
                taint,
                cwd: request.cwd,
                judge: request.judge,
                log: request.logSafety,
                answered: request.safetyAnswered,
                remember: request.rememberSafety,
            }),
            // Wraps content pulled in mid-turn (a fetched page, a foreign MCP result); sets the taint the gate reads.
            outsideResultHooks((source) => {
                taint.mark(source);
            }),
            // tmux wrapper carries the secret exit so the rewrites compose in order; without tmux the exit stands
            // alone.
            tmuxEnabled
                ? bashTmuxHooks(Object.keys(request.cliEnv ?? {}), request.isolation, request.conversationId, request.secrets, request.heavyCommands)
                : request.secrets !== undefined
                  ? secretCommandHooks(request.secrets)
                  : {},
            // Masks every stored credential to its reference in any tool result, not just Bash's.
            request.secrets !== undefined ? redactionHooks(request.secrets.list) : {},
            installSteeringHooks(request.dependencyInstallAllowed === true, request.onImageInstall),
            // Checks a version about to be pinned against the registry; absent mode or resolver wires no hook.
            freshnessHooks(request.dependencyFreshness, request.freshnessResolver, request.workspacePins),
            // Checks classified outbound calls against owner action rules before they run, even under
            // bypassPermissions.
            hasRules(request.actionRules) ? outboundGateHooks(request.actionRules) : {},
            // Persona's folder limit and config-edit permission; the only layer between an unattended wake and a bad
            // path.
            request.personaScope !== undefined ? personaScopeHooks(request.personaScope) : {},
            // Every owner rule standing at turn.ending: the proof ledger, a standing instruction, a required command.
            turnEndingHooks(request.turnEndingRules ?? [], {
                isolation: request.isolation?.plan,
                runCommand: request.runRuleCommand,
                installing: request.dependencyInstalling,
                cwd: request.cwd,
                onFired: request.onRuleFired,
                onCheckRun: request.onCheckRun,
                onFollowUpOutcome: request.onFollowUpOutcome,
                tests: request.verifyTests,
                changedPaths: request.changedPaths,
                repos: request.turnRepos,
            }),
            // The harness's own ask beside the owner's rules: a checklist about to be left open is said back once, since
            // the board reads that list to tell a finished session from one that stopped short.
            checklistCloseHooks({ workspaceRoot: request.workspaceRoot }),
            // Only when isolated and unanchored; an anchor already resolves paths to the worktree, so rewriting doubles
            // it.
            request.isolation !== undefined && request.isolation.anchor === undefined ? worktreeRedirectHooks(request.isolation.plan) : {},
            // Rewrites a model-named screenshot path into the tool-owned output directory before the tool sees it.
            request.browserOutputDir !== undefined ? browserArtifactHooks(request.browserOutputDir) : {},
            // One-time advisory about rg vs grep and an empty result; never rewrites, since the two regex dialects
            // disagree.
            searchNoticeHooks(request.iqAvailable === true),
            // Registers a watchable session the moment a browser call launches Chromium; the MCP owns its lifecycle.
            request.browserPorts !== undefined
                ? browserSessionHooks(request.browserPorts, request.browserPasskeys ?? {}, request.browserAccounts ?? {}, request.conversationId)
                : {},
            // Names the ids a child's transcript is read by, opening the Subagents area for this turn's children.
            subagents !== undefined ? subagentHooks(subagents) : {},
            // Placed by the turn's isolation, since an anchored turn's dependencies exist only inside its own
            // namespace.
            editDiagnosticsHooks(
                request.isolation,
                undefined,
                undefined,
                request.dirtyFiles === undefined ? undefined : createShellEditTracker(request.dirtyFiles),
                request.editReviewers ?? [],
            ),
            // Flags a failing test/build caused by a genuinely missing package, checked first; asked of the main
            // checkout.
            depsNoticeHooks(request.dependencyIssue ?? (async () => undefined), request.dependencyInstallAllowed === true),
        ),
        // Wraps the CLI's own spawn so the agent process and everything it forks is born inside the namespace.
        ...(request.isolation?.anchor !== undefined ? { spawnClaudeCodeProcess: namespacedSpawn(request.isolation.anchor) } : {}),
        ...opt("model", request.model),
        ...opt("resume", request.sessionId),
        ...opt(
            "plugins",
            request.plugins?.map((path) => ({ type: "local" as const, path })),
        ),
        ...reasoningOptions(request),
        ...opt("disallowedTools", disallowedToolsOf(request)),
    };
};

// Most recent document the turn wrote, handed to every card it parks on. Filled as the turn runs rather than asking the
// model to repeat its write-up into the question.
export interface TurnDocuments {
    latest: CardDocument | undefined;
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

// A custom MCP tool, not the built-in, since the built-in's picker UI has nowhere to render headless; aliased onto the
// built-in's name so the model's trained call site still works. alwaysLoad keeps it out of tool search.
const askServer = (
    request: AgentRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
    documents: TurnDocuments,
): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "ui",
        alwaysLoad: true,
        tools: [
            sdk().tool(
                "ask",
                'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option: a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
                {
                    questions: z
                        .array(
                            z.object({
                                question: z.string(),
                                header: z.string(),
                                multiSelect: z.boolean(),
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
                    const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, request.conversationId);
                    // The turn's latest write-up rides along, already in hand, since a question about it needs it.
                    push({ kind: "question", requestId: id, questions, ...(documents.latest === undefined ? {} : { document: documents.latest }) });
                    const { reply, resolved } = await wait(request.signal);
                    // Picks belong in the frame log too, not just the tool result: a replayed transcript freezes the
                    // card with them.
                    push(resolved);
                    // Rebase happens before the model acts on the answer, announced to the transcript, not folded into
                    // what it reads.
                    await syncOnAnswer(request, push, shell, !reply.cancelled && reply.answers !== undefined);
                    return { content: [{ type: "text", text: formatAnswers(questions, reply) }] };
                },
            ),
        ],
    });

// Tools that must never raise a permission card: asking a question and entering plan mode are both deferring to the
// user.
const UNGATED = new Set([...ASK_TOOL_NAMES, "EnterPlanMode"]);

// Posture every approved plan executes in, since approval already covers everything it contains; also used by the
// restart path for a restored card.
export const POST_PLAN_MODE: PermissionMode = "bypassPermissions";

// A permission granted before a restart, consumed once by the resumed turn's re-run of the same tool so the gate
// doesn't ask twice. Keyed by conversation and tool name, deleted on use, expires after 10 minutes.
const RESTORED_GRANT_TTL_MS = 10 * 60_000;
const restoredGrants = new Map<string, { tool: string; always: boolean; grantedAt: number }>();
export const grantRestoredPermission = (conversationId: string, toolName: string, always: boolean, now: number = Date.now()): void => {
    restoredGrants.set(conversationId, { tool: toolName, always, grantedAt: now });
};
const consumeRestoredGrant = (conversationId: string | undefined, toolName: string, now: number = Date.now()): { always: boolean } | undefined => {
    if (conversationId === undefined) {
        return undefined;
    }
    const grant = restoredGrants.get(conversationId);
    if (grant === undefined || grant.tool !== toolName || now - grant.grantedAt > RESTORED_GRANT_TTL_MS) {
        return undefined;
    }
    restoredGrants.delete(conversationId);
    return { always: grant.always };
};

// 'Always' grants the whole tool for the session, not the SDK's narrower prefix suggestions, since the container is
// already the isolation boundary.
const toolWideAllow = (toolName: string): PermissionUpdate => ({
    type: "addRules",
    rules: [{ toolName }],
    behavior: "allow",
    destination: "session",
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

// Whether a card raised now would reach nobody: how the turn STARTED, corrected by whether a person has since steered
// it. An unattended turn somebody is typing into has an audience, and a card is pushed to that same chat, so refusing
// it refuses the one person who is demonstrably there (agent-steering.ts).
const nobodyToAsk = (request: AgentRequest): boolean =>
    request.unattended === true && !(request.conversationId !== undefined && turnSteered(request.conversationId));

// Every permission decision the turn needs from the user. The SDK only calls this when the active mode requires a
// prompt, so there's no mode branching here.
const permissionGate =
    (
        request: AgentRequest,
        push: (event: AgentEvent) => void,
        shell: { sessionId: string | undefined },
        documents: TurnDocuments,
        prose: TurnProse,
    ): CanUseTool =>
    async (toolName, input, options) => {
        // Refuses rather than parks: nobody can answer, and a hung card would read as the agent freezing.
        if (nobodyToAsk(request)) {
            return { behavior: "deny", message: `${toolName} needs a person to answer, and this turn is running unattended. Proceed another way.` };
        }
        if (toolName === "ExitPlanMode") {
            const adjacent = prose.latest?.trim();
            prose.latest = undefined;
            const written = documents.latest?.plan === true ? documents.latest.markdown.trim() : undefined;
            const text = adjacent ?? written;
            // A blank card approves nothing; keep plan mode and let the next prose, or a written plan file, retry.
            if (text === undefined || text === "") {
                return {
                    behavior: "deny",
                    message: "Write the complete plan in your response, then call ExitPlanMode again.",
                };
            }
            const { id, wait } = createRequest("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
            // The write-up this prose points at, attached only when the file's plan is longer than the summary text
            // itself.
            const document =
                adjacent !== undefined && documents.latest !== undefined && documents.latest.markdown.length > text.length
                    ? documents.latest
                    : undefined;
            push({ kind: "plan", requestId: id, text, ...(document === undefined ? {} : { document }) });
            const { reply, resolved } = await wait(request.signal);
            push(resolved);
            if (!reply.approve) {
                return { behavior: "deny", message: reply.feedback?.trim() || "Keep refining the plan, do not exit plan mode yet." };
            }
            // Setting the mode on the session is what actually moves the SDK out of plan mode.
            push({ kind: "mode", mode: POST_PLAN_MODE });
            // Rebase before the agent builds on the plan, so it isn't working against a moved tree; the agent isn't
            // told.
            await syncOnAnswer(request, push, shell, true);
            return {
                behavior: "allow",
                updatedInput: input,
                updatedPermissions: [{ type: "setMode", mode: POST_PLAN_MODE, destination: "session" }],
                decisionClassification: "user_temporary",
            };
        }
        if (UNGATED.has(toolName)) {
            return { behavior: "allow", updatedInput: input };
        }
        // Consumes an answer already given by a restored card, so the resumed turn's re-ask doesn't re-prompt.
        const granted = consumeRestoredGrant(request.conversationId, toolName);
        if (granted !== undefined) {
            return {
                behavior: "allow",
                updatedInput: input,
                decisionClassification: granted.always ? "user_permanent" : "user_temporary",
                ...(granted.always ? { updatedPermissions: [...(options.suggestions ?? []), toolWideAllow(toolName)] } : {}),
            };
        }
        const { id, wait } = createRequest("permission", {
            kind: "permission",
            requestId: "",
            decision: "deny",
            feedback: "The turn was cancelled before you answered.",
        });
        // Passes through the bridge's own prompt sentence, button label and reason rather than re-deriving copy.
        const suggestions = options.suggestions ?? [];
        const path = relativePath(options.blockedPath, request.cwd);
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
        return {
            behavior: "allow",
            updatedInput: input,
            decisionClassification: reply.decision === "always" ? "user_permanent" : "user_temporary",
            // SDK's own suggestions ride with the tool-wide grant, since they carry directory adds a blocked path
            // needs.
            ...(reply.decision === "always" ? { updatedPermissions: [...suggestions, toolWideAllow(toolName)] } : {}),
        };
    };

// Runs one agent turn over `request.cwd`, streaming typed events; one path for every permission mode, the SDK decides
// which UI fires. canUseTool and the ask handler feed this stream through a bridging queue.
export async function* runAgent(
    request: AgentRequest,
    queryFn: QueryFn = defaultQuery,
    usageFetch: typeof fetch = fetch,
): AsyncGenerator<AgentEvent> {
    const abortController = new AbortController();
    if (request.signal.aborted) {
        abortController.abort();
    } else {
        request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    // Pins which installed Claude Code copy this turn uses, so the query fn, tool servers and CLI binary all match.
    await refreshClaudeSdk();

    const queue = new EventQueue<AgentEvent>();
    const push = (event: AgentEvent): void => queue.push(event);

    const permissionMode: PermissionMode = request.permissionMode ?? "bypassPermissions";
    const tmuxEnabled = tmuxRunEnabled();
    // Shared handle for every agent this turn starts; no conversation means nothing to file children under.
    const subagents: SubagentTurn | undefined =
        request.conversationId === undefined
            ? undefined
            : { conversationId: request.conversationId, cwd: request.cwd, sessionId: undefined, subagentsDir: undefined };
    // Seeded from the resumed session id, not empty, since an earlier turn's background job may still run in it.
    const shell: { sessionId: string | undefined } = { sessionId: request.sessionId };
    // Per turn, deliberately: a question in a later turn shouldn't inherit a document written in an earlier one.
    const documents: TurnDocuments = { latest: undefined };
    // Adjacent assistant prose ExitPlanMode reads, filled from main-thread stream frames below.
    const prose: TurnProse = { current: "", latest: undefined };
    // Writes seen but not yet settled, keyed by call id; a Write's content is known at call time but can still fail.
    const writing = new Map<string, CardDocument>();
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, permissionMode, tmuxEnabled, subagents, push),
        // Legalizes bypassPermissions without activating it; a plan approval can switch into bypass mid-turn.
        allowDangerouslySkipPermissions: true,
        stderr: (data) => {
            stderr += data;
        },
        // Backs AskUserQuestion; withheld on an unattended turn, since nobody is there to answer.
        mcpServers: {
            ...(request.unattended === true ? {} : { ui: askServer(request, push, shell, documents) }),
            // Accounts tools get the same live stream and abort signal handles the ask tool does.
            ...(request.accountsServer === undefined ? {} : { accounts: request.accountsServer(push, request.signal) }),
            // Hands the terminal to the owner with the same handles plus `shell`, naming which tmux session commands
            // run in.
            ...(!terminalMounted(request, tmuxEnabled)
                ? {}
                : {
                      terminal: terminalHelpServer({
                          shell,
                          ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
                          signal: request.signal,
                          push,
                      }),
                  }),
            // JS execution backend, mounted from its own request field like `ui`/`terminal`, not the generic server
            // bags.
            // Spelled out literally (JS_SERVER_NAME): the outside-results conformance scan reads this block as text.
            ...(request.jsExecution === undefined
                ? {}
                : {
                      code: jsExecutionServer({
                          plan: request.jsExecution,
                          placement: request.isolation,
                          signal: request.signal,
                          ...(request.secrets === undefined ? {} : { secrets: request.secrets }),
                      }),
                  }),
            ...request.sdkServers,
            ...mcpServersOf(request.tools ?? []),
        },
        // Aliases `Code` beside the built-in, so skills/prompts address the execution backend the way they address
        // Bash.
        toolAliases: { AskUserQuestion: "mcp__ui__ask", [JS_TOOL_ALIAS]: JS_TOOL_NAME },
        // Card renders markdown, so option previews arrive as markdown; pinned since the web-SDK default is HTML.
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        planModeInstructions:
            "Write the complete, clear, concise plan in your response, then call ExitPlanMode to ask for approval before executing. When you need the user to choose between options, ask with the AskUserQuestion tool rather than writing the choices as plain text.",
        canUseTool: permissionGate(request, push, shell, documents, prose),
    };

    // Only a stored-account token reads usage pools at settle; other turns have no pool or account to file under.
    const oauthToken = request.oauthToken;
    const readUsage =
        oauthToken === undefined
            ? undefined
            : (): Promise<UsageWindow[]> => readClaudeUsage(oauthToken, usageFetch).then((reading) => reading.windows);

    // Swallowed-prompt recovery: pushes the turn's own prompt back through the steering queue once.
    const steering = request.steering;
    let redelivered = false;
    // Checklist rows the session already holds, read off the CLI's own store before it starts writing.
    const checklistSeed = await checklistSeedOf(request);
    const redeliver =
        steering === undefined
            ? undefined
            : (): boolean => {
                  if (redelivered) {
                      return false;
                  }
                  redelivered = true;
                  return steering.push(request.prompt);
              };

    const pump = (async () => {
        try {
            for await (const event of streamSdk({
                queryFn,
                prompt: promptInput(request.prompt, request.steering),
                options,
                cwd: request.cwd,
                tmuxEnabled,
                browserOutputDir: request.browserOutputDir,
                steering: request.steering,
                redeliver,
                readUsage,
                allowance: request.allowance,
                // Translator endpoint, so a retry storm can ask if it's refusing this model rather than having a bad
                // minute.
                routed: routedEndpointOf(request),
                trial: request.trial === true,
                subagents,
                checklistSeed,
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
                    noteChildWork(event, event.parentToolUseId);
                } else if (event.kind === "tool_call_update") {
                    noteChildWork(event, undefined);
                }
                push(event);
            }
        } catch (error) {
            push(request.trial === true ? trialUnavailableFrame() : { kind: "error", message: errorMessage(error, stderr) });
        } finally {
            // Any child still marked live is closed as `killed` when the turn ends; nothing else reports it.
            if (subagents !== undefined) {
                for (const frame of closeSubagents(subagents.conversationId)) {
                    push(frame);
                }
            }
            // Closes streaming input so the SDK subprocess settles; late steer pushes report undelivered.
            request.steering?.close();
            queue.end();
        }
    })();

    try {
        yield* queue;
    } finally {
        await pump;
    }
    yield { kind: "done" };
}
