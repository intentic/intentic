import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type {
    AdmissionRule,
    AgentCapabilities,
    AgentEvent,
    CommandJudgeMode,
    PermissionMode,
    Rule,
    SystemPromptMode,
    TurnNote,
} from "@intentic/sandbox-contract";
import type { TurnPlacement } from "../../agents/worktrees/isolation.js";
import type { AccountsServerFactory } from "../../browser/tools/accounts-tools.js";
import type { ClassifiedInstall } from "../../environment/runtime-installs.js";
import type { JsExecutionPlan } from "../../execution/js-runtime.js";
import type { CommandGuardOptions } from "../../guard/command-guard.js";
import type { HostDeviceReach } from "../../hosts/self-host.js";
import type { PersonaScope } from "../../personas/persona-scope.js";
import type { HeavyCommands } from "../../platform/resources/heavy-commands.js";
import type { RuleCommandRun } from "../../rules/rule-command.js";
import type { FollowUpOutcome, TurnRuleCommand } from "../../rules/turn-ending.js";
import type { OwnBrowserReach } from "../../webext/webext-peer.js";
import type { DependencyIssue } from "../../workspace/deps/reconcile-deps.js";
import type { SteeringQueue } from "../checkpoints/agent-steering.js";
import type { PromptTrim } from "../prompt/system-prompt.js";
import type { ChildSupervisor } from "../subagents/children.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import type { DirtyFiles } from "../tools/agent-shell-edits.js";
import type { AgentTool } from "../tools/agent-tools.js";
import type { BackgroundJobSeed } from "../tools/background-jobs.js";
import type { EditReviewer } from "../verification/agent-diagnostics.js";
import type { TurnAllowance } from "./harness-credentials.js";
import type { ParkedCards } from "../../agents/actor/parked-cards.js";

// The one request every runtime is handed, in five groups: what to say and where (spec), what may happen (policy), what
// is mounted (tools), what authenticates it (credential), and what the daemon answers while it runs (hooks). A runtime
// reads the groups it has seams for, and exactly the credential variants its loop can spend.

// What to say and where: the words, where they run, the session they continue, and the model with its reasoning.
export interface TurnSpec {
    // The user's own words, read after `notes`; never the composed wire string, minted once at dispatch.
    readonly prompt: string;
    // Typed daemon-authored notes shown before the prompt, in order; absent means nothing was injected.
    readonly notes?: readonly TurnNote[];
    // Absolute paths of attached files; Codex sends images as native inputs, Claude folds them into the prompt.
    readonly attachments?: readonly string[];
    // Conversation this turn belongs to, for filing its subagents under the parent. Absent: unregistered.
    readonly conversationId?: string;
    // Working dir the agent edits, the workspace root; under `isolation` it's the root as seen inside the namespace.
    readonly cwd: string;
    // Whether that cwd is this conversation's own copy; absent reads as the owner's shared tree, the fail-safe side.
    readonly ownCheckout?: boolean;
    // Where this turn works, how strongly enforced; anchored, /work IS the worktree, else inputs are redirected.
    readonly isolation?: TurnPlacement;
    // Resume a prior turn's session for multi-message conversations.
    readonly sessionId?: string;
    // This conversation's runtime session store, where its checklist is read back from (sessions/session-store.ts).
    readonly sessionStore?: string;
    // Defaults to the account/subscription default; override with INTENTIC_AGENT_MODEL.
    readonly model?: string;
    // Reasoning controls forwarded to the model: effort level and extended thinking.
    readonly effort?: string;
    readonly thinking?: boolean;
    // Ask the harness to serve this turn at fast speed; only ever set for a native Claude turn, never a routed one.
    readonly fast?: boolean;
    // Which base this turn's system prompt is built on; absent uses 'intentic', the product default.
    readonly systemPromptMode?: SystemPromptMode;
    // Owner's own prompt, used only when mode is 'custom'; then it's the whole prompt, `systemAppend` included.
    readonly systemPrompt?: string;
    // Extra turn-scoped instructions appended to the system prompt (e.g. the CLI delegation note).
    readonly systemAppend?: string;
    // What the model's declared window would not pay for, already applied to the prompt fields above, so the adapter
    // sheds the same guidance the planner did and the disclosure shows the prompt that was actually sent.
    readonly contextTrim?: PromptTrim;
    // Mid-turn steering queue; when present the turn streams input and pushed messages inject between tool calls.
    readonly steering?: SteeringQueue;
}

// What may happen: the permission posture, which tools are allowed or withheld, the rules a command is held to, and
// what the turn must do before it ends.
export interface TurnPolicy {
    // How tool calls are gated this turn; defaults to bypassPermissions, safe since the container is the boundary.
    readonly permissionMode?: PermissionMode;
    // Narrows the turn to tool NAMES (SDK option), not the mounted servers; the Visitor chat allowlist.
    readonly allowedTools?: readonly string[];
    // Built-in tool names removed from context, e.g. Edit/Write when hashlineEdits routes through MCP tools instead.
    readonly disallowedTools?: readonly string[];
    // Where this persona's file tools may point, when its card limits them; absent wires no hook.
    readonly personaScope?: PersonaScope;
    // Sniffer's rulebook, verdicts per outbound call, enforced by the PreToolUse gate; empty wires no gate.
    readonly actionRules?: Readonly<Record<string, AdmissionRule>>;
    // Owner's safety policy the judge applies to a flagged command; absent uses the shipped default, always wired.
    readonly safetyPolicy?: string;
    // How much of the command gate is on: 'on' full design, 'watch' records only, 'off' skips the judge.
    readonly judging?: CommandJudgeMode;
    // What the serving runtime can do about the safety policy; absent defaults to 'hooks' (Claude Code).
    readonly rulebook?: AgentCapabilities["rulebook"];
    // Whether this turn was woken by outside content (a listener message, a webchat visitor), naming the source.
    readonly outsideWake?: string;
    // No one is watching this turn; plan/ask tools are withheld and the permission gate refuses rather than waits.
    readonly unattended?: boolean;
    // Whether the persona may install a missing dependency itself, read by the install-steering and deps hooks.
    readonly dependencyInstallAllowed?: boolean;
    // Owner's rules standing at turn.ending, read at Stop; empty wires nothing.
    readonly turnEndingRules?: readonly Rule[];
    // Harness's delegation ceilings: concurrent, per-turn, nesting; undefined leaves the CLI default in place.
    readonly subagentsAtOnce?: number;
    readonly subagentsPerTurn?: number;
    readonly subagentDepth?: number;
}

// What is mounted: the servers and plugins the model can call, the shell's environment and filters, and the browser stack.
export interface TurnTools {
    // Intent-declared internal services plus configured integrations, each a remote MCP server.
    readonly remote?: readonly AgentTool[];
    // In-process SDK MCP servers whose handlers run in the daemon itself, merged into mcpServers alongside `remote`.
    readonly sdkServers?: Record<string, McpServerConfig>;
    // Accounts tools as a factory rather than a built server, closed over this turn's event stream and abort signal.
    readonly accountsServer?: AccountsServerFactory;
    // Absolute plugin checkout dirs; the SDK's loader parses their skills/agents/hooks/commands/.mcp.json.
    readonly plugins?: readonly string[];
    // JS execution backend's plan; absent means it isn't mounted (projected as the `Code` tool).
    readonly jsExecution?: JsExecutionPlan;
    // Env vars for the agent's shell from cli-kind capability credentials (e.g. a bot token), merged in each turn.
    readonly cliEnv?: Record<string, string>;
    // Bash output-cleaner spec, forwarded as INTENTIC_OUTPUT_CLEANERS, or 'off' to disable filtering entirely.
    readonly outputCleaners?: string;
    // Fraction [0,1] of commands whose output bypasses cleaning, recorded as a baseline; 0/undefined disables it.
    readonly outputHoldout?: number;
    // Every named credential this sandbox stores: masked on read, resolved on shell exit, typed into browser fields.
    readonly secrets?: SecretAccess;
    // Heavy-command rules, read fresh per Bash command so an edit to the file binds immediately.
    readonly heavyCommands?: () => Promise<HeavyCommands>;
    // Whether the diagnostics server is mounted; withheld from a persona whose `files` power is `none`.
    readonly diagnostics?: boolean;
    // Whether the iq plugin is actually loaded, so the empty-search notice can name it only where it's real.
    readonly iqAvailable?: boolean;
    // The connected devices this turn carries servers for, and which of them runs this sandbox: what the prompt needs
    // to say "run it there yourself".
    readonly hostDevices?: HostDeviceReach | undefined;
    // The owner's own browsers this turn carries servers for, so the prompt can say the one they watch is right here.
    readonly ownBrowsers?: OwnBrowserReach | undefined;
    // Directory for browser tool artifacts (the `--output-dir` value); drives the redirect hook and read-back path.
    readonly browserOutputDir?: string;
    // Each browser profile owner's CDP debugging port, so the first browser call can register a watchable session.
    readonly browserPorts?: Record<string, number>;
    // Each logged-in profile owner's passkey store path, so the session observer arms pages with the software key.
    readonly browserPasskeys?: Record<string, string>;
    // Routed browser server's account-to-owner map, so the observer resolves a call's `account` to its profile.
    readonly browserAccounts?: Record<string, string>;
}

// What authenticates the turn, one variant per kind. `container` carries nothing: the runtime authenticates from what the
// container already holds (its env, or a credential the runtime stores itself).
export type TurnCredential =
    | { readonly kind: "container" }
    // A stored Claude account's subscription token; `refresh` re-mints it mid-turn on refusal, absent for a runner's.
    | {
          readonly kind: "claude-oauth";
          readonly token: string;
          readonly refresh?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
      }
    // A custom Anthropic endpoint and bearer, for a translator-served, minted or endpoint turn; whose allowance it spends.
    | { readonly kind: "routed"; readonly baseUrl: string; readonly authToken: string; readonly allowance?: TurnAllowance }
    // The platform's free trial: the translator's endpoint, with bounded retries and the trial's own failure frames.
    | { readonly kind: "trial"; readonly baseUrl: string; readonly authToken: string }
    // A native Codex turn on the subscription, via the translator; absent, Codex falls back to the container's key.
    | { readonly kind: "codex-endpoint"; readonly baseUrl: string; readonly authToken: string }
    // The selected Cursor account's key, passed per request since Cursor runs in-process with no child env to set.
    | { readonly kind: "cursor-key"; readonly apiKey: string };

// The credentials each loop can spend; a runtime's loop takes a request of its own kind, so a foreign one does not type.
export type ContainerCredential = Extract<TurnCredential, { readonly kind: "container" }>;
export type HarnessCredential = Extract<TurnCredential, { readonly kind: "container" | "claude-oauth" | "routed" | "trial" }>;
export type CodexCredential = Extract<TurnCredential, { readonly kind: "container" | "codex-endpoint" }>;
export type CursorCredential = Extract<TurnCredential, { readonly kind: "cursor-key" }>;

// What the daemon answers while the turn runs: attendance and restored grants, the rule and check callbacks the Stop
// reads, the safety judge and its log, and the child-agent and background-job seams.
export interface TurnHooks {
    // Where the turn parks a card a person answers (a question, a plan, a permission), so a reply finds it.
    readonly cards: ParkedCards;
    // Whether a person has steered this turn since it started, asked live; absent for a turn nobody can steer.
    readonly steered?: () => boolean;
    // Takes the permission a card restored after a restart already granted for this tool, once.
    readonly restoredGrant?: (toolName: string) => { readonly always: boolean } | undefined;
    // Project-scoped dependency answer for the command-failure hook, so one project's error stays its own.
    readonly dependencyIssue?: (command: string) => Promise<DependencyIssue | undefined>;
    // Which projects the daemon is installing, asked only after a turn-ending command has already failed.
    readonly dependencyInstalling?: () => Promise<readonly string[]>;
    // Files the tree says are dirty, by both names, so a Bash edit gets the same diagnostics as a native Edit.
    readonly dirtyFiles?: DirtyFiles;
    // Owner's file.edited rules bound to this turn's placement, run on every file an edit tool or shell writes.
    readonly editReviewers?: readonly EditReviewer[];
    // Every classified image-scoped install this turn attempts, for the install ledger; nothing reaches the model.
    readonly onImageInstall?: (installs: readonly ClassifiedInstall[], command: string) => void;
    // How to run a turn-ending rule's command, in this turn's own tree.
    readonly runRuleCommand?: TurnRuleCommand;
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
    // The judge and its writes, as functions so no runtime reaches for them; absent skips the judge.
    readonly judge?: CommandGuardOptions["judge"];
    readonly logSafety?: CommandGuardOptions["log"];
    readonly safetyAnswered?: CommandGuardOptions["answered"];
    readonly rememberSafety?: CommandGuardOptions["remember"];
    // Rebases onto main when the turn parks for a person or reaches its Stop's checks. Absent off-harness or main-tree.
    readonly resync?: () => Promise<AgentEvent | undefined>;
    // Supervision surface for runtimes that mount child-agent tools as their own, not through the harness's SDK.
    readonly children?: ChildSupervisor;
    // Where a `run_in_background` job's completion is delivered once this turn is gone; absent, it dies with the turn.
    readonly backgroundJobs?: BackgroundJobSeed;
}

export interface AgentRequest<C extends TurnCredential = TurnCredential> {
    readonly spec: TurnSpec;
    readonly policy: TurnPolicy;
    readonly tools: TurnTools;
    readonly credential: C;
    readonly hooks: TurnHooks;
    // The turn's cancel: aborted by /agent/stop, and the lifetime every loop and card waits under.
    readonly signal: AbortSignal;
}

// What the route and the planner build before a runtime is picked: everything but the credential, which is the arm's.
export type TurnBase = Omit<AgentRequest, "credential">;
