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
import { claudeCliPath, refreshClaudeSdk, sdk } from "../claude/claude-sdk.js";
import { spawn } from "node:child_process";
import {
    type AdmissionRule,
    type AgentCapabilities,
    type AgentEvent,
    type AskQuestion,
    type CardDocument,
    type CommandClass,
    type DependencyFreshness,
    documentOf,
    type PermissionMode,
    type Rule,
    sendableEffort,
    type SystemPromptMode,
    type TurnNote,
    type UsageWindow,
} from "@intentic/sandbox-contract";
import { relative, sep } from "node:path";
import { z } from "zod";
import { daemonMountNs, type IsolationAnchor, nsenterArgv, TMUX_NS_ENV, type TurnPlacement } from "../agents/isolation.js";
import { worktreeRedirectHooks } from "../agents/worktree-redirect.js";
import type { AccountsServerFactory } from "../browser/accounts-tools.js";
import type { ChildSupervisor } from "../children/children.js";
import { browserArtifactHooks } from "../browser/browser-artifacts.js";
import { browserSessionHooks } from "../browser/browser-sessions.js";
import { depsNoticeHooks } from "./agent-deps.js";
import type { FreshnessResolver } from "../dependencies/registry-freshness.js";
import type { WorkspacePins } from "../dependencies/workspace-pins.js";
import { freshnessHooks } from "./agent-freshness.js";
import { testStrengthHooks } from "./agent-test-strength.js";
import { searchNoticeHooks } from "./agent-search.js";
import type { DependencyIssue } from "../workspace/reconcile-deps.js";
import { editDiagnosticsHooks } from "./agent-diagnostics.js";
import { installSteeringHooks } from "./agent-installs.js";
import type { ClassifiedInstall } from "../environment/runtime-installs.js";
import { redactionHooks } from "./agent-redaction.js";
import { type SecretAccess, secretCommandHooks } from "./agent-secrets.js";
import { type CommandGateOptions, commandGateHooks } from "../guard/command-gate.js";
import { outboundGateHooks } from "../guard/outbound-gate.js";
import { outsideResultHooks } from "../guard/outside-results.js";
import { createTurnTaint, publishTurnTaint } from "../guard/turn-taint.js";
import { type PersonaScope, personaScopeHooks } from "../personas/persona-scope.js";
import type { JsExecutionPlan } from "../execution/js-runtime.js";
import { JS_TOOL_ALIAS, JS_TOOL_NAME, jsExecutionServer } from "../execution/js-tool.js";
import { type AgentTool, mcpServersOf } from "./agent-tools.js";
import { createRequest } from "./agent-requests.js";
import type { SteeringQueue } from "./agent-steering.js";
import { type TurnRuleCommand, turnEndingHooks } from "../rules/turn-ending.js";
import { agentShellBusy, bashTmuxHooks, tmuxRunEnabled } from "./agent-terminals.js";
import type { HeavyCommands } from "../platform/heavy-commands.js";
import { terminalHelpServer } from "../terminal/terminal-help.js";
import { EventQueue } from "./event-queue.js";
import { trialUnavailableFrame } from "./error-frames.js";
import { harnessEnv, type TurnAllowance } from "./harness-credentials.js";
import { workloadStamp } from "../platform/leftovers.js";
import { opt } from "./opt.js";
import { readClaudeUsage } from "../usage/claude-usage.js";
import { defaultQuery, promptInput, type QueryFn, streamSdk } from "./sdk-stream.js";
import { sdkSystemPrompt } from "./system-prompt.js";
import { noteChildWork } from "./child-verification.js";
import { closeSubagents, subagentInParentTree, subagentHooks, type SubagentTurn } from "./subagents.js";
import { ASK_TOOL_NAMES, formatAnswers } from "./question-answers.js";

export interface AgentRequest {
    /* What the model reads AFTER the notes below: the user's own words (plus, on the Claude arm, the
     * attachment trailer). Never the composed wire string, that is minted from this pair exactly once, at
     * dispatch (agent.routes.ts, composeWirePrompt), so nothing upstream ever has to parse it back apart. */
    readonly prompt: string;
    /* What the daemon tells the model ahead of the user's message, TYPED, in reading order (turn-preamble.ts).
     * Canonical: the `preamble` frame and the transcript record are fed from this list, and the wire prompt is
     * its serialization. Absent ⇒ nothing was injected, the common case for a hand-built request. */
    readonly notes?: readonly TurnNote[];
    // Which conversation this turn belongs to. Only the subagent registry reads it, a child is filed under the
    // parent whose turn spawned it, which is what lets the Subagents area group by agent and the fleet card count
    // its own. Absent ⇒ a turn with no conversation behind it (the bench), whose children are not registered.
    readonly conversationId?: string;
    // Absolute paths of user-attached files, consumed by the CODEX adapter (images ride as native
    // local_image inputs). The Claude path folds these into the prompt in streamAgent instead, its Read
    // tool handles images/PDFs from disk natively.
    readonly attachments?: readonly string[];
    // The working dir the agent edits, the workspace root, so it can touch all three repos. Under `isolation`
    // this is the root as seen INSIDE the namespace, where it resolves to the conversation's worktree.
    readonly cwd: string;
    // The MAIN checkout, as the DAEMON sees it, which `cwd` is not, for an isolated turn (it names the
    // worktree) nor for a persona that starts in a subfolder. Carried for the daemon-side readers that must ask
    // about the real workspace: the installed dependency tree an isolated turn merely mounts is the main one,
    // so a question about it asked anywhere else finds empty directories and answers nonsense. Every planned
    // turn sets it (turn-plan's `honoured`); absent only where a caller builds a request by hand, and `cwd` is
    // the workspace root in every one of those.
    readonly workspaceRoot?: string;
    // A project-scoped dependency answer for the command-failure hook. It is bound while planning, where the
    // persona's logical start directory and mutation authority are still known; the hook must not flatten the
    // whole workspace and excuse one project's error with another project's missing package.
    readonly dependencyIssue?: (command: string) => Promise<DependencyIssue | undefined>;
    readonly dependencyInstallAllowed?: boolean;
    /* How far the version-freshness check may go, and what asks the registry (agent-freshness.ts). Two
     * fields rather than one because the RESOLVER is a turn-scoped object with a cache in it, bound while
     * planning where the workspace root is known, while the MODE is the owner's setting and is what decides
     * whether any hook is wired at all. Absent mode ⇒ off, which wires nothing and costs nothing. */
    readonly dependencyFreshness?: DependencyFreshness;
    readonly freshnessResolver?: FreshnessResolver;
    // What this workspace already pins, so a new package taking the catalog's version is not reported as
    // stale. Bound while planning, for the same reason as the resolver: the workspace root is still known.
    readonly workspacePins?: WorkspacePins;
    /* Whether a test the agent just wrote is re-run against the code as it was before this turn
     * (agent-test-strength.ts). One boolean rather than a mode: there is only one question to ask, and the answer
     * is either wanted or it is not. False ⇒ no hook is wired and no suite is ever run. */
    readonly testFaultDetection?: boolean;
    // Every image-scoped install this turn attempts, classified, for the runtime-install ledger behind the
    // environment drift sweep (environment/runtime-installs.ts). Silent: nothing about it reaches the model.
    readonly onImageInstall?: (installs: readonly ClassifiedInstall[], command: string) => void;
    // Where this turn works, and how strongly that is enforced (agents/isolation.ts). With an anchor the turn
    // runs in its own mount namespace and its /work IS its worktree; without one the same mapping is applied
    // to tool inputs instead (agents/worktree-redirect.ts). Absent entirely ⇒ a main-tree turn, which means
    // the shared checkout and says so.
    readonly isolation?: TurnPlacement;
    // Resume a prior turn's session for multi-message conversations.
    readonly sessionId?: string;
    readonly signal: AbortSignal;
    // Defaults to the account/subscription default; override with INTENTIC_AGENT_MODEL.
    readonly model?: string;
    // The user's Claude subscription token, injected into the SDK for this turn. Resolved by the daemon from
    // the sandbox's own stored credentials (the platform no longer relays it); undefined falls back to the
    // container's ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env.
    readonly oauthToken?: string;
    // Re-mint `oauthToken` mid-turn. The CLI calls this when the API refuses the token it was given, expired
    // under a long turn, or revoked account-wide, and carries on with what comes back, so a credential that
    // dies while the agent is working costs a pause rather than the turn. Returning undefined (or the same
    // token) means no replacement exists, and the turn fails as it did before.
    readonly refreshOauthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
    // A custom Anthropic-Messages endpoint + bearer token for this turn, set when the Claude Code harness serves
    // a non-Claude provider (codex/grok) through the sandbox's translator. Injected as ANTHROPIC_BASE_URL /
    // ANTHROPIC_AUTH_TOKEN; when baseUrl is present the subscription OAuth token is WITHHELD so it never reaches
    // a foreign endpoint. Absent ⇒ native Anthropic endpoint with the OAuth token above.
    readonly baseUrl?: string;
    readonly authToken?: string;
    // Whose allowance a routed turn spends, and when a spent one reopens, neither readable from the harness,
    // which sees only that a 429 came back. Set alongside `baseUrl` by harness-credentials; absent on a native
    // Claude turn. See TurnAllowance.
    readonly allowance?: TurnAllowance;
    // Platform-owned free trial: bound retries and use trial-specific failure frames/copy.
    readonly trial?: boolean;
    // The selected Codex account's CODEX_HOME for this turn (Codex path only). Absent ⇒ the adapter's default
    // base dir, which resolves the container's OPENAI_API_KEY fallback.
    readonly codexHome?: string;
    // Serve this NATIVE Codex turn through the sandbox translator's OpenAI-compatible endpoint on the connected
    // ChatGPT SUBSCRIPTION (Codex path only): the adapter points Codex's own Responses wire format at baseUrl
    // and authenticates with the fixed local bearer, no per-account OAuth auth.json. codexHome then holds only
    // sessions/rollouts, never a credential.
    readonly codexEndpoint?: { readonly baseUrl: string; readonly authToken: string };
    /* The selected Cursor account's user API key for this turn (Cursor path only), resolved by planCursorTurn
     * from the sandbox's own store.
     *
     * Passed per REQUEST rather than per process, unlike every other credential on this shape, and the reason
     * is that Cursor's runtime is in-process: there is no child to give an environment to, and CURSOR_API_KEY
     * in the daemon's own env would silently become the credential for every Cursor turn in the sandbox,
     * including ones the user pointed at a different account. Every SDK call this adapter makes takes the key
     * explicitly, so the account a turn was planned against is the account it spends. */
    readonly cursorApiKey?: string;
    // How tool calls are gated this turn. Defaults to the autonomous sandbox posture (bypassPermissions),
    // the container's isolation is what makes that safe. The agent can move itself out of it mid-turn.
    readonly permissionMode?: PermissionMode;
    /* Narrows the turn to these tool NAMES (the SDK option of the same name), not to be confused with `tools`
     * below, which are MCP servers. Absent ⇒ the runtime's full toolbox.
     *
     * This is the only real bound on a turn nobody is watching. bypassPermissions above is the default posture
     * because the container is the isolation, but a Front Desk turn is driven by an anonymous website visitor,
     * where "the container is disposable" is not the whole answer: the automation's allowlist is what stops an
     * instruction smuggled into a support question from reaching Bash. */
    readonly allowedTools?: readonly string[];
    // Reasoning controls forwarded to the SDK (effort level / extended thinking).
    readonly effort?: string;
    readonly thinking?: boolean;
    // Ask the harness to serve this turn at fast speed. Only ever set for a NATIVE Claude turn, turn-plan
    // withholds it from a routed one, whose translator endpoint the harness would refuse as not first-party,
    // so by the time it is read here the only remaining questions (plan, model, pool) belong to the harness.
    readonly fast?: boolean;
    // The agent's MCP tools for this turn: intent-declared internal services (set in this container's env) plus
    // platform-configured external integrations. Each becomes a remote `http` MCP server. The daemon merges
    // both sources before calling; absent ⇒ the agent runs with no MCP tools (its plain autonomous posture).
    readonly tools?: readonly AgentTool[];
    // Env vars for the agent's shell from cli-kind capabilities (e.g. DISCORD_BOT_TOKEN), the stored
    // credentials their CLI tools read. Merged into the SDK `env` each turn; absent ⇒ no extra env.
    readonly cliEnv?: Record<string, string>;
    /* The JS execution backend's plan for this turn (execution/js-runtime.ts), what a script may read, write
     * and start, resolved from the persona's card where every runtime's request is assembled (turn-plan's
     * honoured) and carried as a first-class peer of `cliEnv` and `isolation`. Absent ⇒ the backend is not
     * mounted at all: the card switched it off, or the serving runtime doesn't host it
     * (AgentCapabilities.execution). This loop projects it as the `Code` tool below, under the same command
     * gate and secret exit its Bash runs through. */
    readonly jsExecution?: JsExecutionPlan;
    /* The owner's rules standing at `turn.ending` (rules/rules.ts), plus the way to run one's command. Their
     * conditions are read at the Stop rather than here, a turn is planned before it runs, so nothing yet knows
     * which files it will touch (rules/turn-ending.ts).
     *
     * Absent/empty ⇒ the ledger and its Stop hook are not wired at all, so a workspace with no rule at this
     * moment pays nothing, not even the bookkeeping. */
    readonly turnEndingRules?: readonly Rule[];
    readonly runRuleCommand?: TurnRuleCommand;
    // Which projects the daemon is installing, asked only when a turn-ending command has already failed: a
    // check run against a tree being rewritten has measured nothing (rules/turn-ending.ts).
    readonly dependencyInstalling?: () => Promise<readonly string[]>;
    // Told when one of them actually said something, so the settings list can show which rules are earning
    // their place and which have been silent for three weeks.
    readonly onRuleFired?: (rule: Rule) => void;
    // Absolute Claude Code plugin checkout dirs from plugin-kind capabilities, rebuilt each turn (see
    // pluginDirsOf). The SDK's plugin loader parses their skills/agents/hooks/commands/.mcp.json, the daemon
    // never does, so the plugin format tracks Claude Code via SDK upgrades alone.
    readonly plugins?: readonly string[];
    // In-process SDK MCP servers, daemon-side tools whose handlers run in the daemon itself (e.g. the
    // Discord voice session tools). Merged into mcpServers alongside the remote `tools` above.
    readonly sdkServers?: Record<string, McpServerConfig>;
    // The accounts tools (browser/accounts-tools.ts) as a FACTORY rather than a built server, because two of its
    // inputs exist only here: the turn's event stream (request_help raises a card on it, the askServer pattern)
    // and its abort signal. turn-plan closes it over the capability store and this turn's account list; absent ⇒
    // the turn reaches no browser accounts and gets no accounts tools.
    readonly accountsServer?: AccountsServerFactory;
    // Where the browser tools' artifacts belong, the same directory `--output-dir` names, threaded here
    // because @playwright/mcp honours it only for the files IT names (browser/browser-artifacts.ts). Drives
    // both the redirect hook and the sentence that tells the agent where to Read a screenshot back from.
    readonly browserOutputDir?: string;
    // Whether turn-plan mounted the daemon's diagnostics server this turn (it withholds it from a persona whose
    // `files` power is `none`), so the prompt names those tools exactly where they can be loaded
    // (system-prompt.ts DIAGNOSTICS_GUIDANCE) and nowhere else.
    readonly diagnostics?: boolean;
    // Whether the iq plugin is actually loaded for this turn (turn-plan.ts resolves the gate: the `iqSearch`
    // setting, its holdout arm, and the plugin dir existing at all). Carried rather than re-derived so the
    // empty-search notice can name iq exactly where it is real and nowhere else (agent-search.ts).
    readonly iqAvailable?: boolean;
    // Each browser profile owner's CDP debugging port (owner or `web` → port), so the first browser tool call
    // can register a watchable session for the Chromium that call is launching (browser/browser-sessions.ts).
    // Absent ⇒ the turn has no browser tools at all, and nothing is watched.
    readonly browserPorts?: Record<string, number>;
    // Each logged-in profile owner's passkey store path (owner → file), so the session observer arms every
    // page with the platform's software security key (browser/passkeys.ts). Absent for turns whose browsers
    // hold no identity.
    readonly browserPasskeys?: Record<string, string>;
    // The routed browser server's account→owner map (browser/browser-tools.ts), so the observer resolves a
    // call's `account` argument to the profile it drives, the tool prefix no longer says.
    readonly browserAccounts?: Record<string, string>;
    // Built-in tool names to remove from the model's context this turn (SDK disallowedTools). Set by the
    // hashlineEdits toggle to disable native Edit/Write so file mutations route through the hashline MCP tools,
    // and by the persona's own shelves for every power it switched off (personas/personas.ts).
    readonly disallowedTools?: readonly string[];
    // Where this persona's file tools may point, when its card limits them at all (personas/persona-scope.ts).
    // Absent ⇒ no hook is wired, so a workspace that has never set a folder limit pays nothing for it.
    readonly personaScope?: PersonaScope;
    // The Bash output-cleaner spec, forwarded to agent-output-filter via env (INTENTIC_OUTPUT_CLEANERS), or the
    // literal "off" to disable the filter (INTENTIC_RUN_FILTER=0, raw baseline). Empty/undefined ⇒ the filter's
    // all-on default. See settings/outputCleaners + bin/cleaners.mjs.
    readonly outputCleaners?: string;
    // The sniffer's rulebook (settings.actionRules), verdicts per classified outbound call, enforced by the
    // PreToolUse outbound gate. Absent/empty ⇒ the gate is not wired at all (guard/outbound-gate.ts).
    readonly actionRules?: Readonly<Record<string, AdmissionRule>>;
    /* The command gate's rulebook (settings.commandRules), a verdict per class of shell command, enforced
     * before the command runs. A "hold" parks the turn on a permission card, in every posture, which is what
     * makes it the layer that still applies once bypassPermissions has taken the cards away
     * (guard/command-gate.ts). Absent/empty is no longer "no hook": the gate is wired on every turn because it
     * also carries the taint floor, which is not the owner's rulebook but a property of what this turn has
     * read. A turn with no rules and no outside content still reaches every decide and is allowed by all of
     * them, which costs one classify per Bash call. */
    readonly commandRules?: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    /* Turn a held program into one plain sentence for its card (settings.explainCommands, wired in
     * turn-plan.ts). Absent ⇒ cards go out with the program alone, which is the default.
     *
     * A FUNCTION ON THE REQUEST rather than a flag, for the reason every service-shaped dependency here is:
     * this module is handed what it needs to run a turn and does not reach for `Services`, so the account
     * chain, the quota memo and the provider walk stay behind one seam (agent/command-explainer.ts) that a
     * test can replace with a stub. */
    readonly explainCommand?: CommandGateOptions["explain"];
    /* What the serving runtime can DO about that rulebook, from the pair's capability record
     * (capabilitiesOf().rulebook). The vendor adapters read it to shape their gate: "none" gets no consult and a
     * permanently-set taint bit, "refuse-only" cannot park on a card so holds refuse, "approval" and "hooks"
     * park. Absent ⇒ "hooks", the Claude Code loop, which is the only caller that builds its gate by hand
     * because it is the only one that can also MARK taint mid-turn. */
    readonly rulebook?: AgentCapabilities["rulebook"];
    /* Whether this turn was woken BY outside content, a listener message, a webchat visitor, carrying the
     * source's name. The mid-turn half (a fetched page, a foreign MCP result) marks itself through the wrap
     * seam; this is the half only the caller knows (guard/turn-taint.ts). */
    readonly outsideWake?: string;
    // Measurement control: a fraction [0,1] of commands whose output bypasses cleaning (INTENTIC_OUTPUT_HOLDOUT),
    // recorded raw so the savings report has a real cleaned-vs-raw baseline. 0/undefined ⇒ no holdout.
    readonly outputHoldout?: number;
    /* Every named credential this sandbox stores, and the ledger their uses feed, the one object behind all
     * three secret seams: the read path masks each value to its `{{secret:name}}` reference in every tool
     * result (agent/agent-redaction.ts), the shell exit resolves references back to values as a command runs
     * (agent/agent-secrets.ts), and the browser exit types one into a focused field
     * (browser/secrets-tools.ts). Absent ⇒ none of the three is wired. */
    readonly secrets?: SecretAccess;
    /* The heavy-command rules, read fresh per Bash command so an edit to the file binds immediately
     * (platform/heavy-commands.ts). Absent ⇒ this sandbox queues nothing: either the image has no queue-run
     * baked in or the operator opted out, both answered once by terminal-run.ts queueRunEnabled. */
    readonly heavyCommands?: () => Promise<HeavyCommands>;
    /* THE HARNESS'S OWN DELEGATION CEILINGS, each raised or lowered by the matching sandbox setting: how many
     * subagents may run at once, how many one conversation may spawn in total, and how deep they may nest.
     * Undefined ⇒ nothing is set in the environment and the CLI's own answer stands, which turn-plan relies on,
     * so an untouched setting cannot pin a default the harness means to be able to move.
     *
     * The refusals these produce are worth knowing when reading a transcript that stopped delegating: the agent
     * is told the limit and told NOT to retry, so the turn carries on doing the work itself rather than failing. */
    readonly subagentsAtOnce?: number;
    readonly subagentsPerTurn?: number;
    readonly subagentDepth?: number;
    // Extra turn-scoped instructions appended to the claude_code preset system prompt (e.g. the CLI
    // delegation note when Codex/Grok accounts are connected, see agent/delegation.ts).
    readonly systemAppend?: string;
    // Which base this turn's system prompt is built on (SandboxSettings.systemPromptMode). Absent ⇒ "intentic",
    // the product default, so a caller that constructs a request directly (the bench) gets what the app runs.
    readonly systemPromptMode?: SystemPromptMode;
    // The owner's own prompt text, used only when the mode is "custom", it is then the entire system prompt
    // and nothing else is appended, `systemAppend` included. See system-prompt.ts.
    readonly systemPrompt?: string;
    // Mid-turn steering: when present, the turn runs in the SDK's streaming-input mode and messages pushed
    // onto this queue (via /agent/steer) are injected between tool calls. Absent ⇒ single-message mode.
    readonly steering?: SteeringQueue;
    /* PUT THE BRANCH BACK ON TODAY'S MAIN LINE, the pre-turn rebase (agents/sync.ts), offered again at the
     * moments this turn stops and waits for a person. agent.routes.ts owns what it does; this module owns
     * WHEN, because only the harness knows when the model is genuinely parked.
     *
     * A card is not a pause, it is a gap: measured over this sandbox's own transcripts a question card waits a
     * median 2.6 minutes and a plan approval up to ten, and the user's main line moves during one park in
     * five. Every one of those minutes the turn spends holding a base that is quietly going stale, and unlike
     * the gap between turns, nothing reconciles it before the work resumes. The answer arrives, the model
     * carries on against a dead base, and the auto-land at the end of the turn is where that surfaces.
     *
     * Answers with the frame the transcript needs, and with undefined on the ordinary settle where the branch
     * was already current. The MODEL is told nothing, the rebase is a mechanism, not news it has to act on
     * (turn-preamble.ts). Absent on a main-tree turn (no branch to move) and on every runtime but the harness. */
    readonly resync?: () => Promise<AgentEvent | undefined>;
    // Nobody is watching this turn: it was started by a benchmark, a schedule or another program rather than
    // by someone sitting in front of the chat. The interactive surface is then not merely useless but a
    // DEADLOCK, a plan approval or a question card parks the turn on an answer that can never arrive, and the
    // turn burns until something aborts it. So an unattended turn is given no plan tools and no ask tool, and
    // its permission gate refuses rather than waits.
    readonly unattended?: boolean;
    /* The child-agent supervision surface (children/children.ts) — spawn on any connected provider, steer or
     * follow-up a child, answer its questions — for the runtimes that mount it as tools of their own rather
     * than through the harness's SDK server: Cursor's custom tools read it here (cursor/cursor-tools.ts).
     * Present exactly when the turn's persona holds the delegate shelf and full agency and the route injected
     * the engine — the same predicate that arms the shell door — so an adapter never has to re-derive the
     * gate. Absent ⇒ the runtime offers no supervision tools. */
    readonly children?: ChildSupervisor;
}

/* THE REBASE A SETTLED CARD EARNS, and the two conditions on taking it.
 *
 * ANSWERED, not merely settled: a dismissed question and a rejected plan both stop the turn, and moving the
 * ground under work the user just pulled the plug on buys nothing and costs a diff they did not ask for.
 * Reading `answered` from the caller rather than re-deriving it here keeps that decision at the card, where
 * the difference between an answer and an abort stand-in is already known (agent-requests.ts).
 *
 * QUIET, because this is the one difference from the same pass at turn start: there, nothing of the turn's is
 * running yet. Here the model is parked but the TURN need not be, and a rebase under a live writer fails in
 * ways nobody sees, files swapped mid-read, and a half-written one swept into the commit the rebase takes
 * first. Two writers can outlive the card and they are asked about separately because they are separately
 * invisible: a command still running in the turn's shell (agent-terminals.ts, a background job, a build, a
 * pane the user is typing in), and a subagent, which does its own editing and answers to nothing here. Either
 * one skips the sync: the branch stays where it is, which is exactly where it would have stayed if the agent
 * had never asked.
 *
 * The frame goes to the transcript at the point it happened, and that is the whole output: the model is not
 * told, because a rebase it is told about is a rebase it goes and verifies. */
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
    /* THE ANSWER OUTRANKS THE REBASE, so a fault in it cannot reach the card. The user has already clicked;
     * a throw from here would come back to them as a failed question or a plan approval that did not take,
     * losing the one thing this whole exchange was for, to report a branch that simply stayed where it was.
     *
     * Silent because it is not silent where it happens: the implementation this calls owns the git and logs
     * its own faults (agent.routes.ts). This is the harness refusing to let a side channel it does not own
     * take down the card, not a swallowed error nobody will ever see. */
    const frame = await request.resync().catch(() => undefined);
    if (frame !== undefined) {
        push(frame);
    }
};

// Cap the stderr tail folded into an error message so a chatty failure can't flood the UI.
const STDERR_TAIL = 2000;

// Fold the Claude Code subprocess's stderr tail into the surfaced error, so a bare "exited with code 1"
// becomes the actual reason. Without this the SDK's terminal error is opaque (this is how the
// root/`--dangerously-skip-permissions` failure was found).
const errorMessage = (error: unknown, stderr: string): string => {
    const base = error instanceof Error ? error.message : "agent failed";
    const detail = stderr.trim().slice(-STDERR_TAIL);
    return detail ? `${base}: ${detail}` : base;
};

/* Map the output-cleaner settings to the env the Bash output filter reads: a spec selects cleaners, a non-zero
 * holdout bypasses that fraction of commands as a measured control, and empty leaves it at the filter's all-on
 * default. The literal "off", the master toggle, turns the filter off outright, which is the only thing that
 * can: every other value here selects WHICH cleaners run, not WHETHER any do. */
const cleanerEnv = (request: AgentRequest): Record<string, string> => {
    if (request.outputCleaners === "off") {
        return { INTENTIC_RUN_FILTER: "0" };
    }
    return {
        // Empty means "the filter's default", so it is dropped the same as absent.
        ...opt("INTENTIC_OUTPUT_CLEANERS", request.outputCleaners || undefined),
        ...opt(
            "INTENTIC_OUTPUT_HOLDOUT",
            request.outputHoldout !== undefined && request.outputHoldout > 0 ? String(request.outputHoldout) : undefined,
        ),
    };
};

/* The delegation ceilings, in the harness's own vocabulary, the three env vars the CLI reads before it lets an
 * Agent tool call through, and the ONLY way to move them: they are read inside the CLI process, not passed as
 * options, and each refusal it raises names the variable for the user to raise ("ask them to increase
 * CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"). Which is what makes this worth a setting rather than a container env:
 * the agent's own escalation path used to end at a file the user cannot edit from the app.
 *
 * An absent field emits nothing, so the CLI's default answers, see the request fields for why that is not the
 * same as sending today's default back to it. */
const subagentEnv = (request: AgentRequest): Record<string, string> => ({
    ...opt("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", request.subagentsAtOnce?.toString()),
    ...opt("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", request.subagentsPerTurn?.toString()),
    ...opt("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", request.subagentDepth?.toString()),
});

/* THE CHECKLIST TOOLS, PINNED ON, because the CLI turned them off underneath this harness.
 *
 * Claude Code 2.1.233 gates the whole checklist family behind a model-version table (opus ≥ 4-8, sonnet ≥ 5,
 * fable ≥ 5, mythos ≥ 5): at or above that line TaskCreate/TaskGet/TaskUpdate/TaskList AND TodoWrite all answer
 * isEnabled() false unless a remote gate is on, and it is off by default. Every model this sandbox runs is over
 * the line, so on 2026-08-15, the day the pin moved off 2.1.220, the checklist tools stopped existing.
 *
 * Nothing announced it, and the failure was silent in the worst direction: the system prompt tells EVERY turn to
 * load them (CHECKLIST_GUIDANCE), so the turns kept asking. 259 of them ran `ToolSearch
 * select:TaskCreate,TaskUpdate,TaskList` into "No matching deferred tools found", against 237 that succeeded on
 * 2.1.220, and TaskCreate calls fell from 1,551 to 47. There was no fallback either: TodoWrite is behind the
 * same predicate, so a turn lost the checklist outright rather than dropping to the older tool, and the
 * operator's task list (task-checklist.ts, the thing that makes a 150-step unattended run watchable) went blank.
 *
 * CLAUDE_CODE_ENABLE_TODO_TOOLS is the documented override for that gate; CLAUDE_CODE_ENABLE_TASKS picks which
 * half of the family it turns on, Task* when true (the CLI's own default) and TodoWrite when false. BOTH are
 * pinned, unlike the ceilings above, because neither is a tunable here: the prompt names the Task verbs and the
 * checklist reducer parses their results, so a container that set either one to off would silently take the
 * operator's task list with it. Measured against the pinned CLI on claude-opus-4-8, the turn's tool list goes
 * from 21 tools with no checklist verb at all to 25 with the four Task verbs deferred behind ToolSearch. */
const CHECKLIST_ENV: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    CLAUDE_CODE_ENABLE_TASKS: "1",
};

// Combine hook sets, CONCATENATING the matchers registered for the same event. A plain object spread would
// have the last contributor silently win the key, two producers of PreToolUse:Bash (the tmux wrapper and the
// install steer) and only one of them would ever fire.
export const mergeHooks = (...sets: Partial<Record<HookEvent, HookCallbackMatcher[]>>[]): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
    for (const set of sets) {
        for (const [event, matchers] of Object.entries(set) as [HookEvent, HookCallbackMatcher[]][]) {
            merged[event] = [...(merged[event] ?? []), ...matchers];
        }
    }
    return merged;
};

// A rulebook counts only when it holds at least one rule: an absent AND an empty one wire no hook, so a
// workspace that never opened the feature pays nothing for it (turn-plan forwards none either way).
const hasRules = <T extends object>(rules: T | undefined): rules is T => rules !== undefined && Object.keys(rules).length > 0;

// The two built-ins that are a conversation with the USER rather than an action on the workspace, which is
// why an unattended turn cannot have them.
const PLAN_TOOLS = ["EnterPlanMode", "ExitPlanMode"];

/* The CLI's own scheduling tools, removed from EVERY turn. Claude Code implements them inside a process that
 * stays alive to fire them, its interactive terminal app, and here the CLI dies when the turn settles, so a
 * wakeup or cron job is accepted and then never fires: a dead letter the model cannot see is one. Worse than
 * useless, because the tools still ANSWER, an agent that needed to outwait a CI run found ScheduleWakeup,
 * read its way to "not for this", and hand-rolled a polling loop instead. The daemon-side replacements are
 * the automations scheduler (owner-configured) and the watch tools (agent-armed, agent/watchers.ts). */
const CLI_SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];

// Tools removed from the model's context: the scheduler tools always (dead letters here, see above), the
// caller's own list (hashlineEdits drops the native Edit/Write), plus, on an unattended turn, the plan
// tools, which would park the turn on an approval nobody can give.
const disallowedToolsOf = (request: AgentRequest): string[] => [
    ...CLI_SCHEDULER_TOOLS,
    ...(request.disallowedTools ?? []),
    ...(request.unattended === true ? PLAN_TOOLS : []),
];

/* The CLI's mid-turn credential recovery. On a 401 it raises an `oauth_token_refresh` control request; the SDK
 * answers it from this callback and the turn RESUMES on the returned token instead of dying. Without it the
 * subscription token is a snapshot taken at spawn: a turn outliving its token, or caught by an account-wide
 * revocation, which kills tokens that still look valid, fails outright, mid-work, with
 * "Failed to authenticate. API Error: 401 ...". That is the difference between this harness and the VSCode
 * extension, which owns the whole credential (refresh token included) and re-mints it in place.
 *
 * Declared here because `@anthropic-ai/claude-agent-sdk@0.3.257` implements the option in sdk.mjs (it is
 * destructured alongside `canUseTool` and gates `hasBidirectionalNeeds`) but omits it from sdk.d.ts. Returning
 * the SAME token the CLI already holds is how we say "no refresh available"; it detects that and stops. */
/* The SDK's spawn seam, used for what it was built for, running the CLI somewhere other than plainly here.
 * The command and args are handed straight through; only the namespace they land in changes, because
 * `nsenter` execs the CLI into the turn's anchor (isolation.ts) rather than supervising it. So the SDK still
 * owns a direct child: its stdio pipes, its exit code, and the SIGTERM it sends on abort all reach the real
 * CLI.
 *
 * `cwd` comes from the anchor, not from `options`: it is the workspace root as the namespace sees it, which
 * inside IS the worktree. A failure here is a failed turn rather than a silent fall back to the shared tree,
 * an agent that quietly gets the main checkout is the exact bug this whole path exists to prevent. */
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

// The two reasoning knobs, together, because the API refuses one combination of them and the picker's filter
// (effortAllowed) only covers turns that came from the picker. sendableEffort holds the rule and the reason.
const reasoningOptions = (request: AgentRequest): { effort?: EffortLevel; thinking?: { type: "adaptive" | "disabled" } } => ({
    ...opt("effort", sendableEffort(request.effort, request.thinking) as EffortLevel | undefined),
    ...opt("thinking", request.thinking === undefined ? undefined : { type: request.thinking ? ("adaptive" as const) : ("disabled" as const) }),
});

/* Whether the routed browser has anyone behind it this turn. The same account→owner map the session observer
 * resolves calls with, asked as a yes/no: it decides whether the browser sentence names that server at all.
 * Its own function so the answer costs baseOptions no branch of its own. */
const holdsBrowserAccounts = (accounts: Record<string, string> | undefined): boolean => Object.keys(accounts ?? {}).length > 0;

// Base SDK options for the turn.
const baseOptions = (
    request: AgentRequest,
    abortController: AbortController,
    permissionMode: PermissionMode,
    tmuxEnabled: boolean,
    // The turn handle the subagent registry files children under. Absent ⇒ this turn belongs to no conversation
    // (the bench), so its children are not surfaced and the hooks are not wired.
    subagents: SubagentTurn | undefined,
    // The turn's event sink. A hook can park the turn on a card the same way canUseTool does, and the command
    // gate is the one that needs to, its whole point is holding a command in the posture where canUseTool is
    // never called at all.
    push: (event: AgentEvent) => void,
): OauthRecoveryOptions => {
    /* This turn's outside-content bit, minted once here because the two seams that share it are both built
     * below: the wrap hook SETS it (a page fetched, a foreign server answered) and the command gate READS it
     * per command. Born set when a stranger caused the wake at all (guard/turn-taint.ts). */
    const taint = createTurnTaint(request.outsideWake);
    /* Published for the consult sites that live OUTSIDE this generator, today the wallet's payment gate,
     * which runs in the daemon's HTTP layer and suspends the owner's auto-approve band while this is set
     * (guard/turn-taint.ts). Cleared when the turn settles, wired in composition.ts. */
    if (request.conversationId !== undefined) {
        publishTurnTaint(request.conversationId, taint);
    }
    return {
        cwd: request.cwd,
        /* The CLI this turn spawns, named rather than left to the SDK's own resolution. Absent on the image's
         * copy, where the SDK resolves its sibling platform package correctly and naming a path would only be
         * a second chance to get it wrong; present for a store copy, so the binary that runs is the one this
         * daemon chose, from the same installed prefix as the JS half above it (claude/claude-sdk.ts). */
        ...opt("pathToClaudeCodeExecutable", claudeCliPath()),
        // Only for a native Claude turn on a sandbox-owned credential: a translator endpoint authenticates with its
        // own bearer, and the container-env fallback has no refresh token behind it to mint from.
        ...opt("getOAuthToken", request.baseUrl === undefined ? request.refreshOauthToken : undefined),
        includePartialMessages: true,
        // Forward a subagent's own prose and thinking, not just its tool calls. Without it a child's transcript is a
        // list of tool rows with no narration, enough for the parent's card (whose report arrives as the tool's
        // result anyway) and nowhere near enough for the Subagents area, which renders the child as a conversation.
        forwardSubagentText: true,
        permissionMode,
        ...opt("allowedTools", request.allowedTools?.slice()),
        abortController,
        // Claude Code's coding-tuned preset plus this harness's own guidance, or, when the owner has written a
        // system prompt of their own, that text alone (system-prompt.ts owns the choice and everything it drops).
        // The preset matters because the Agent SDK sends an EMPTY system prompt when this is omitted, which is the
        // main reason a bare SDK turn feels weaker at coding than the CLI/VSCode product.
        systemPrompt: sdkSystemPrompt({
            mode: request.systemPromptMode ?? "intentic",
            custom: request.systemPrompt,
            append: request.systemAppend,
            unattended: request.unattended === true,
            browserOutputDir: request.browserOutputDir,
            browserAccounts: holdsBrowserAccounts(request.browserAccounts),
            diagnostics: request.diagnostics === true,
        }),
        // Load the workspace's .claude/ config: CLAUDE.md memory, skills, subagents (.claude/agents), settings,
        // hooks, and .mcp.json, plus the user tier. The SDK default is [] (loads nothing), so every filesystem
        // capability was invisible until now. New skills/subagents/hooks then arrive as files, no code change.
        settingSources: ["user", "project"],
        /* THE FAST-MODE OPT-IN. Fast mode is off for an SDK consumer until it asks, the harness reports exactly
         * that as `sdk_opt_in_required`, and this inline `settings` object is the ask. It lands in the harness's
         * "flag settings" layer, above the user/project files loaded by settingSources and below managed policy, so
         * a workspace that pins its own answer in .claude/settings.json is overridden for this turn and an
         * IT-managed policy still wins. Everything else about fast mode (which plans have it, which models offer
         * it, whether the pool is in cooldown) stays the harness's to decide, this only says the consumer is
         * willing.
         *
         * `fastModePerSessionOptIn` is the half that matters. Without it the harness PERSISTS the choice to the
         * settings file, and the sandbox's user tier is shared by every conversation in the container, so one
         * chat's toggle would silently start billing every other chat, and every automation and front desk turn, at
         * fast-mode rates. Per-session keeps it what the composer says it is: a property of this turn.
         *
         * Omitted entirely when the turn didn't ask, rather than sent as `false`: a `false` in the flag layer would
         * override a user's own settings.json opt-in, which is theirs to make on turns we say nothing about. */
        ...(request.fast === true ? { settings: { fastMode: true, fastModePerSessionOptIn: true } } : {}),
        env: {
            ...process.env,
            // cli-kind capability credentials (e.g. DISCORD_BOT_TOKEN) the agent's shell reads. Rebuilt every turn,
            // so a newly-added CLI capability is picked up on the next message with no restart. The Bash hook below
            // forwards the KEY NAMES per command, so the values also reach the tmux panes commands actually run in
            // (pane env is the tmux server's snapshot, not this subprocess env).
            ...request.cliEnv,
            // IS_SANDBOX (we run with --dangerously-skip-permissions, which Claude Code refuses under root unless
            // the environment is marked already-sandboxed) plus this turn's credential. A custom endpoint points the
            // harness at ANTHROPIC_BASE_URL + its bearer and WITHHOLDS the subscription OAuth token; a native Claude
            // turn keeps the token and the default (unset) base URL. The per-turn value wins over any container-env
            // ANTHROPIC_BASE_URL default. Shared with the quick-model one-shot, see harnessEnv.
            ...harnessEnv(request),
            // The output-cleaner spec/holdout (or the filter-off flag) that the agent's Bash → tmux-run → agent-output-filter reads.
            ...cleanerEnv(request),
            // How much this turn may delegate, only the ceilings the owner moved off the harness's own defaults.
            ...subagentEnv(request),
            // The Task verbs the prompt advertises and the operator's task list is reassembled from, which the
            // CLI now hides from every frontier model unless asked. Not a tunable: see CHECKLIST_ENV.
            ...CHECKLIST_ENV,
            // Where bin/tmux-run must stand to talk to tmux, so the server it may have to START is the daemon's
            // and not this turn's (isolation.ts). Only for an anchored turn, the only one whose wrapper runs
            // inside a namespace at all.
            ...(request.isolation?.anchor !== undefined ? { [TMUX_NS_ENV]: daemonMountNs } : {}),
            /* Whose work this is, for the sweep that reclaims what a turn leaves behind (platform/leftovers.ts).
             * The CLI's MCP servers and their browsers inherit this without knowing it exists, which is the whole
             * reason it is an env var: nothing below the CLI is ours to hold a handle on. A turn with no
             * conversation behind it (the bench) is left unstamped rather than given a made-up owner, the sweep
             * reclaims only what it can attribute, and an owner nothing can report on would read as finished. */
            ...(request.conversationId !== undefined ? workloadStamp(request.conversationId) : {}),
        },
        // Hooks fire even under bypassPermissions, and for subagents too. tmux: every Bash command runs inside an
        // `agent-*` tmux session (bin/tmux-run) so the terminal panel can watch the agent work live. Installs: an image-scoped install
        // is pointed at the owner-approved overlay, and so is a command that came back `not found`, which is the
        // same problem noticed one step earlier. Diagnostics: every native Edit/Write is type-checked by the
        // resident lsp service and compile errors ride back as additionalContext.
        hooks: mergeHooks(
            /* The command gate goes FIRST, ahead of the tmux wrapper, so the classifier and the card both read the
             * agent's own command line rather than ~100 characters of daemon boilerplate wrapped around it. Nothing
             * downstream is skipped by that order: a denied command never reaches the wrapper, and an approved one
             * is rewritten exactly as it would have been. */
            commandGateHooks({
                rules: request.commandRules ?? {},
                unattended: request.unattended === true,
                push,
                signal: request.signal,
                taint,
                cwd: request.cwd,
                explain: request.explainCommand,
            }),
            /* The outside-content envelope on everything the agent PULLS IN mid-turn, a fetched page, a foreign
             * MCP server's answer, the output of a curl that reached the internet (guard/outside-results.ts). Its
             * twin wraps a stranger's message at turn birth, before the prompt exists. Wrapping is also what sets
             * the taint the command gate above reads, so the two are one mechanism seen from both ends. */
            outsideResultHooks((source) => {
                taint.mark(source);
            }),
            /* The tmux wrapper also carries the shell secret exit, `{{secret:name}}` resolved into the line the
             * pane executes, inside the same rewrite so the two compose in a known order. Without tmux the exit
             * still exists, as its own matcher (a reference passed through literally would land in a config as
             * text). */
            tmuxEnabled
                ? bashTmuxHooks(Object.keys(request.cliEnv ?? {}), request.isolation, request.conversationId, request.secrets, request.heavyCommands)
                : request.secrets !== undefined
                  ? secretCommandHooks(request.secrets)
                  : {},
            /* Every stored credential masked to its reference in every tool RESULT. The Bash filter masks the
             * terminal lane and only that one, so which of Read/Grep/an MCP call fetched a secret decided whether
             * the model saw it, this makes the answer the same for all of them (agent/agent-redaction.ts). */
            request.secrets !== undefined ? redactionHooks(request.secrets.list) : {},
            installSteeringHooks(request.dependencyInstallAllowed === true, request.onImageInstall),
            /* The version about to be pinned, checked against the registry that publishes it
             * (agent-freshness.ts). Sits next to the install steering because they read the same commands and
             * answer different halves of one question: that one is about WHERE an install lands, this one is
             * about whether the version in it is the version the registry actually has. Mode "off" or no
             * resolver ⇒ no hook is wired and nothing is fetched. */
            freshnessHooks(request.dependencyFreshness, request.freshnessResolver, request.workspacePins),
            /* The test just written, re-run against the code as it was before this turn (agent-test-strength.ts).
             * Sits with the freshness check because they are the same posture from two directions: both know
             * something the model cannot see about work it has just done, both hand it over as a fact, and
             * neither refuses. Off ⇒ no hook, and no suite is ever run. */
            testStrengthHooks(request.testFaultDetection, request.workspaceRoot),
            // The outbound sniffer's enforcing half: classified provider calls (a discord curl) are checked against
            // the owner's action rules BEFORE they run, and hooks fire even under bypassPermissions, which is what
            // makes this hold for unattended automation turns. No rules ⇒ no hook (turn-plan forwards none).
            hasRules(request.actionRules) ? outboundGateHooks(request.actionRules) : {},
            // The persona's folder limit, and its answer to whether this session may edit the sandbox's own
            // configuration. Same posture as the gate above and for the same reason, an unattended wake has no
            // permission cards, so a hook is the only layer between it and the path it was told to open.
            request.personaScope !== undefined ? personaScopeHooks(request.personaScope) : {},
            /* The `turn.ending` moment: every rule the owner has standing where a turn tries to finish, the proof
             * ledger's follow-up, a standing instruction, a command that has to pass first. No rule ⇒ nothing is
             * wired, so a workspace that has never opened this pays nothing for it. */
            turnEndingHooks(request.turnEndingRules ?? [], {
                isolation: request.isolation?.plan,
                runCommand: request.runRuleCommand,
                installing: request.dependencyInstalling,
                cwd: request.cwd,
                onFired: request.onRuleFired,
            }),
            // The worktree the namespace could not build. Only when this turn is isolated AND unanchored: with an
            // anchor the paths already mean the worktree, and rewriting them a second time would aim the tool at a
            // worktree-inside-the-worktree that does not exist.
            request.isolation !== undefined && request.isolation.anchor === undefined ? worktreeRedirectHooks(request.isolation.plan) : {},
            // Browser: a model-named screenshot resolves against the agent's cwd, not `--output-dir`, so the
            // filename is rewritten into the tool-owned directory before the tool ever sees it. Named here rather
            // than left to the prompt because a convention only holds for the agents that happen to read it.
            request.browserOutputDir !== undefined ? browserArtifactHooks(request.browserOutputDir) : {},
            // Shell search hygiene: one word about `rg` the first time a turn walks the repo with `grep`, and one
            // about what an empty `rg` already proved. Advisory and once per turn; the command has run and its
            // answer stands (agent-search.ts). Never rewrites: the two regex dialects disagree.
            searchNoticeHooks(request.iqAvailable === true),
            // Browser, the other half: a browser tool call is the moment the agent's Chromium becomes real, so it
            // is where the watchable session is registered. The hook only names what already exists, the browser
            // is the MCP's to launch and to kill (browser/browser-sessions.ts).
            request.browserPorts !== undefined
                ? browserSessionHooks(request.browserPorts, request.browserPasskeys ?? {}, request.browserAccounts ?? {}, request.conversationId)
                : {},
            // Subagents, the same way: the ids a child's transcript is READ with are only ever named to a hook, so
            // this pair is what makes the Subagents area's door open on anything (agent/subagents.ts). Pure
            // record-keeping, the card already learned the child exists from the task stream.
            subagents !== undefined ? subagentHooks(subagents) : {},
            // Handed the turn's placement whole, because where the check STANDS is the difference between an answer
            // and a fiction: an anchored turn's dependencies exist only inside its namespace, so the check is placed
            // in there and speaks the agent's own paths (agent-diagnostics.ts).
            editDiagnosticsHooks(request.isolation),
            // The same misreading the diagnostics hook heads off after an edit, headed off after a COMMAND: a test
            // or a build that failed on a package the tree is genuinely missing says so once, having checked first
            // (agent-deps.ts). Asked of the main checkout, which is what an isolated turn's dependencies are.
            depsNoticeHooks(request.dependencyIssue ?? (async () => undefined), request.dependencyInstallAllowed === true),
        ),
        // Enter the namespace by wrapping the CLI's own spawn: the agent process (and everything it forks) is born
        // inside it, so there is no window in which the turn can see the shared tree.
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

/* WHAT THE TURN HAS WRITTEN FOR THE READER, only the latest of it, handed to every card the turn parks on
 * (the contract's documents.ts decides what counts as one).
 *
 * A turn-scoped mutable handle, exactly like the `shell` one and for the same reason: the cards are wired
 * before the turn runs, and what they will need to say is not known until it does. The alternative was asking
 * the MODEL to repeat its own write-up into the question, which spends context on every ask, duplicates a
 * document that then drifts from the file, and only works on the one backend that was told to do it. The daemon
 * saw the write go past; nothing needs to be asked of anyone. */
export interface TurnDocuments {
    latest: CardDocument | undefined;
}

/* THE MAIN TURN'S MOST RECENT COMPLETED PROSE BLOCK. ExitPlanMode no longer carries the plan in its input
 * (the SDK's current input is empty apart from a deprecated allowedPrompts field): the model writes the plan
 * as assistant prose, then calls the tool. The stream has already seen those words when the permission gate
 * runs, so keep the adjacent block on the same kind of turn-scoped live handle as documents and the shell.
 *
 * `current` is deliberately separate from `latest`: only a text_end makes prose eligible to become a plan,
 * and a main-thread tool call clears it so an empty ExitPlanMode cannot resurrect narration from before the
 * agent's latest exploration step. Subagent prose never enters this handle. */
interface TurnProse {
    current: string;
    latest: string | undefined;
}

/* One stream frame's effect on that handle. Deltas accumulate, a text_end commits, and any other main-thread
 * tool call invalidates, EXCEPT ExitPlanMode itself: its frame is read off the assistant message carrying the
 * tool_use block, and the SDK enqueues that message BEFORE dispatching the can_use_tool control request the
 * gate answers (Query.readMessages dispatches control requests un-awaited, past a queue this turn's pump
 * drains on its own schedule). Counting it as an invalidator erased the plan one frame before the gate read
 * it, which is the blank approval card this seam exists to prevent. */
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

// The `ask` tool behind AskUserQuestion. It is an SDK MCP tool rather than the built-in of the same name
// because the built-in renders its own picker inside the CLI, headless, that UI has nowhere to go. Aliasing
// the built-in NAME onto this tool (see toolAliases below) keeps the model's trained call site working while
// the answer round-trips through our own card. `alwaysLoad` keeps it in the prompt instead of behind tool
// search: a tool the model has to go looking for is a tool it writes plain-text options instead of using.
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
                    // Named with its conversation, unlike the plan and permission cards: dismissing this one
                    // ends the turn, and the route that takes the dismissal ends it there rather than waiting
                    // for the browser to send a second request for it (agent.routes' reply handler).
                    const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, request.conversationId);
                    // Whatever the turn wrote for the reader rides along (see TurnDocuments): a question about a
                    // write-up is unanswerable without it, and by the time it is asked that document is usually a
                    // folded card well up the scroll. Nothing here reaches for it, it is already in hand.
                    push({ kind: "question", requestId: id, questions, ...(documents.latest === undefined ? {} : { document: documents.latest }) });
                    const { reply, resolved } = await wait(request.signal);
                    // The picks belong in the frame log, not just in this tool result: they are what a replayed
                    // or second-window transcript freezes the card with (see the `resolved` frame).
                    push(resolved);
                    // Then the ground, before the model acts on what it just heard. The tool result carries the
                    // user's answer and nothing else, the rebase is announced to the transcript, not folded
                    // into the words the model reads next.
                    await syncOnAnswer(request, push, shell, !reply.cancelled && reply.answers !== undefined);
                    return { content: [{ type: "text", text: formatAnswers(questions, reply) }] };
                },
            ),
        ],
    });

// Tools that must never raise a permission card: asking the user a question, and entering plan mode, are both
// the agent deferring TO the user. Prompting for permission to prompt would be a dead end.
const UNGATED = new Set([...ASK_TOOL_NAMES, "EnterPlanMode"]);

/* The posture EVERY approved plan executes in, whatever the turn started in and whichever client approved it.
 * Approval is the one moment the user has read what the agent intends to do and said yes to all of it, so
 * re-asking per tool afterwards interrupts without adding a decision, the shape this replaces landed a turn
 * that started in plan mode on `acceptEdits`, which auto-accepts edits but still raised a card for every Bash
 * command, so approving a plan bought the user a permission prompt for `git log`.
 *
 * The container is the isolation boundary, exactly as it is for toolWideAllow below. A user who wants per-tool
 * approvals still has them: they are a posture the composer picks for the turn, not a tax on planning.
 *
 * Exported for the restart path, which owes an approval the SAME posture: a plan approved on a restored card
 * runs as a resumed turn rather than through the gate below, and starting that turn in anything narrower would
 * make "the sandbox restarted in between" cost the user a permission prompt per tool (turn-resume.ts). */
export const POST_PLAN_MODE: PermissionMode = "bypassPermissions";

/* A PERMISSION THE USER GRANTED ACROSS A RESTART, one tool, one conversation, consumed by the first ask.
 *
 * The live gate hands an allow straight back to the SDK's waiting canUseTool; a RESTORED permission card has no
 * waiting tool call, the process holding it died, so its "Allow" starts a resumed turn that re-runs the tool
 * (turn-resume.ts). That re-run asks the gate again, and without this the user would answer the same question
 * twice, the second time with less faith in the first click. The grant is the first answer, carried to the ask
 * it belongs to.
 *
 * Deliberately narrow: keyed by conversation, matched by tool name, deleted on use, and expired after a few
 * minutes so a resumed turn that never re-attempts the tool cannot leave a standing allow behind for some
 * later turn's identically-named ask. `always` carries the "don't ask again" flavour through, so the one click
 * writes the same session-wide rule it would have written live. */
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

// What "always" persists on top of the SDK's own suggestions: allow this TOOL, for the rest of the session.
// The suggestions are narrowly scoped, for Bash they carry the command prefix (`pnpm install:*`), so the next
// command re-asks, which is not what a button reading "Don't ask again for Bash" promises. The container IS
// the isolation boundary here, so the tool-wide grant is the honest reading of the button. Session-scoped: a
// settings-file rule would be written into a throwaway worktree nobody reads twice.
const toolWideAllow = (toolName: string): PermissionUpdate => ({
    type: "addRules",
    rules: [{ toolName }],
    behavior: "allow",
    destination: "session",
});

// A workspace-root-relative path for the permission card, matching the tree/file route space the rest of the
// UI uses. A path outside the workspace (rare, an additionalDirectories read) stays absolute.
const relativePath = (absolute: string | undefined, cwd: string): string | undefined => {
    if (absolute === undefined || absolute === "") {
        return undefined;
    }
    const rel = relative(cwd, absolute);
    return rel === "" || rel.startsWith("..") ? absolute : rel.split(sep).join("/");
};

// Every permission decision the turn needs from the user, as the SDK's canUseTool. The SDK only calls this
// when the active mode actually requires a prompt (bypassPermissions never does; acceptEdits skips edits;
// default skips reads), so there is no mode branching here, if we were called, the user is the decider.
const permissionGate =
    (
        request: AgentRequest,
        push: (event: AgentEvent) => void,
        shell: { sessionId: string | undefined },
        documents: TurnDocuments,
        prose: TurnProse,
    ): CanUseTool =>
    async (toolName, input, options) => {
        // Nobody can answer, so refuse rather than park: a card raised here would hang the turn until its
        // timeout, which reads as the agent freezing rather than as a decision nobody was there to make.
        if (request.unattended === true) {
            return { behavior: "deny", message: `${toolName} needs a person to answer, and this turn is running unattended. Proceed another way.` };
        }
        if (toolName === "ExitPlanMode") {
            const adjacent = prose.latest?.trim();
            prose.latest = undefined;
            const written = documents.latest?.plan === true ? documents.latest.markdown.trim() : undefined;
            const text = adjacent ?? written;
            /* A blank approval card asks the user to approve nothing. Keep the model in plan mode and tell it
             * how to satisfy the SDK's current protocol instead; the next completed prose block becomes the
             * retry's plan. A written plan is also sufficient when the model put the plan in a file. */
            if (text === undefined || text === "") {
                return {
                    behavior: "deny",
                    message: "Write the complete plan in your response, then call ExitPlanMode again.",
                };
            }
            const { id, wait } = createRequest("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
            /* The write-up this prose POINTS at, when it points at one. A model that wrote the real plan to a file
             * and summarised it in the adjacent prose would otherwise be asking for a yes to a document the reader
             * cannot see. When no prose was emitted, the document itself became `text` above and needs no duplicate
             * attachment. */
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
            /* Then the ground, before the agent starts building on a plan it wrote against an older tree,
             * the longest park of the three cards, and the one followed by the most writing. The move itself
             * is the point; the agent is not told it happened (turn-preamble.ts). */
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
        // An answer the user already gave: the restored card's "Allow", waiting for the re-attempt it belongs
        // to (see grantRestoredPermission). Consumed here so the resumed turn's first ask for this tool sails
        // through instead of raising the same card twice across one restart.
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
        // The bridge already rendered the prompt sentence, the button noun, and the reason, pass them
        // through rather than re-deriving worse copy from the raw tool name and input.
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
            // Always offered: the tool-wide rule below is a memory we can write for any tool, with or without
            // the SDK suggesting one of its own.
            alwaysLabel: `Don't ask again for ${options.displayName ?? toolName}`,
        });
        const { reply, resolved } = await wait(request.signal);
        push(resolved);
        if (reply.decision === "deny") {
            // A denial carrying feedback is a redirection, the turn runs on and takes it. A bare one is the
            // user pulling the plug (the card has no free-text field, and the client stops the turn on it), so
            // "find another way" would be a standing order to work around a refusal, read back on the next turn.
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
            // The SDK's own suggestions ride along with the tool-wide grant: they carry the directory adds a
            // blocked path needs, which a tool rule alone does not cover.
            ...(reply.decision === "always" ? { updatedPermissions: [...suggestions, toolWideAllow(toolName)] } : {}),
        };
    };

// Run one agent turn over `request.cwd`, streaming typed events. ONE path for every permission mode: the
// interactive surface (question cards, plan approval, per-tool permission prompts) is always wired, and which
// of it actually fires is the SDK's call given the turn's mode, which the agent itself can change mid-turn
// via EnterPlanMode/ExitPlanMode. `canUseTool` and the `ask` handler run concurrently with the SDK loop, so a
// queue bridges their events and the stream's into this generator.
//
// A throwing/aborted turn surfaces as an `error` event (errors are reported to the UI, not swallowed), then
// the stream closes with `done`.
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

    /* WHICH COPY OF CLAUDE CODE THIS TURN RUNS, decided once, here, before a single option is built. The
     * engine store can have moved since the last turn (an owner pressed Update, the daily check took a blessed
     * version), and a turn has to be built out of ONE version: the JS half `query` comes from, the tool servers
     * built below, and the CLI binary named in the options are all the same installed prefix from this point on.
     * Cheap when nothing moved, which is nearly always (claude/claude-sdk.ts). */
    await refreshClaudeSdk();

    const queue = new EventQueue<AgentEvent>();
    const push = (event: AgentEvent): void => queue.push(event);

    const permissionMode: PermissionMode = request.permissionMode ?? "bypassPermissions";
    const tmuxEnabled = tmuxRunEnabled();
    // One handle for every agent this turn starts, shared by the hooks (wired below, before the session id
    // exists) and the stream (which fills it in). No conversation ⇒ nothing to file children under, so the whole
    // surface stays off rather than accumulating records nothing can list.
    const subagents: SubagentTurn | undefined =
        request.conversationId === undefined
            ? undefined
            : { conversationId: request.conversationId, cwd: request.cwd, sessionId: undefined, subagentsDir: undefined };
    /* The turn's tmux session, by the id the CLI mints for it, read by the parked cards to ask whether a
     * command is still running before anything rebases under it. Mutable for the same reason the subagent
     * handle is: the ask tool and the permission gate are wired here, before a fresh turn's id exists.
     *
     * Seeded from the RESUMED id rather than left empty, because the session outlives the turn and so do its
     * panes: a background job an earlier turn started is still running in this same session, and it is exactly
     * the writer this gate exists to notice. Empty only on a conversation's first turn, which by definition has
     * no earlier pane to disturb. */
    const shell: { sessionId: string | undefined } = { sessionId: request.sessionId };
    // What this turn has written for the reader, filled from the stream below and read by every card it parks
    // on (see TurnDocuments). Per TURN, deliberately: a question asked in a later turn is not about a document
    // written in an earlier one, and attaching one on that guess would be the harness making things up.
    const documents: TurnDocuments = { latest: undefined };
    // The adjacent assistant prose ExitPlanMode now points at, filled from main-thread stream frames below.
    const prose: TurnProse = { current: "", latest: undefined };
    // Writes seen but not yet settled, by tool-call id: a Write carries its whole file at CALL time and can
    // still be refused or fail, so a document is only somebody's to read once the call says it landed.
    const writing = new Map<string, CardDocument>();
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, permissionMode, tmuxEnabled, subagents, push),
        /* Always on, whatever mode the turn STARTS in: the flag legalises bypassPermissions, it does not
         * activate it, `permissionMode` above still decides the posture. Any turn can land in bypass
         * mid-session (an approved plan setModes to POST_PLAN_MODE), and the CLI refuses that switch unless
         * the session was LAUNCHED with the flag, gating it on the starting mode is how an approved plan
         * silently fell to `default` and re-asked for every Bash and Write. */
        allowDangerouslySkipPermissions: true,
        stderr: (data) => {
            stderr += data;
        },
        // The `ui` server backs AskUserQuestion; the agent's remote MCP tools are merged in alongside it (a
        // same-named tool would override `ui`, but `ui` is reserved). An unattended turn gets no `ui`: a
        // question would be asked of a user who is not there, and the turn would wait for them forever.
        mcpServers: {
            ...(request.unattended === true ? {} : { ui: askServer(request, push, shell, documents) }),
            // The accounts tools get the same two live handles the ask tool does: the stream their help card
            // rides, and the signal that settles a park when the turn dies under it.
            ...(request.accountsServer === undefined ? {} : { accounts: request.accountsServer(push, request.signal) }),
            /* Handing the TERMINAL to the owner (terminal/terminal-help.ts), the same handles again, plus the
             * `shell` handle that names which tmux session this turn's commands run in. Two gates, and both are
             * about the tool being answerable rather than about taste: an unattended turn would park on a person
             * who is not there (the `ui` and request_help rule), and without the tmux wrapper the agent's Bash
             * runs in no pane at all, so there would be nothing for the owner to type into. */
            ...(request.unattended === true || !tmuxEnabled
                ? {}
                : {
                      terminal: terminalHelpServer({
                          shell,
                          ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
                          signal: request.signal,
                          push,
                      }),
                  }),
            /* The JS execution backend, mounted from its own request field the way `ui` and `terminal` are
             * from theirs, never through the generic server bags below, whose entries the backend is not one
             * of. Its PreToolUse gate is already wired (commandGateHooks reads the script), its results ride
             * the matcher-less redaction, and its `{{secret:name}}` exit runs in the handler. */
            // `code` is the literal JS_SERVER_NAME, spelled out (and first inside its brace) because the
            // outside-results conformance scan reads this block textually, a computed key, or a comment
            // between the brace and the key, hides the mount from it.
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
        // `Code` beside the built-in alias: skills and prompts can address the execution backend the way they
        // address Bash, whichever name the model emits.
        toolAliases: { AskUserQuestion: "mcp__ui__ask", [JS_TOOL_ALIAS]: JS_TOOL_NAME },
        // Our card renders markdown, so option previews should arrive as markdown (the CLI default, pinned
        // here because the web-SDK default is HTML and would render as escaped source in the card).
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        planModeInstructions:
            "Write the complete, clear, concise plan in your response, then call ExitPlanMode to ask for approval before executing. When you need the user to choose between options, ask with the AskUserQuestion tool rather than writing the choices as plain text.",
        canUseTool: permissionGate(request, push, shell, documents, prose),
    };

    // A turn that authenticated with a stored account's OAuth token can read that plan's limit pools at settle
    // (usage/claude-usage.ts, the same reader the idle sweep uses); translator, endpoint and container-env turns
    // have no pools to read, and no account to file a reading under (agent.routes persists only attributed
    // frames).
    const oauthToken = request.oauthToken;
    const readUsage =
        oauthToken === undefined
            ? undefined
            : (): Promise<UsageWindow[]> => readClaudeUsage(oauthToken, usageFetch).then((reading) => reading.windows);

    // The swallowed-prompt recovery (sdkTurns): the turn's own prompt, pushed back through the steering queue,
    // once. Built here because this is where both halves live, the prompt text and the queue the streaming
    // input reads. An unsteerable turn has no road back, so the empty result then ends the turn as before.
    const steering = request.steering;
    let redelivered = false;
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
                trial: request.trial === true,
                subagents,
            })) {
                // The turn's shell lives under the id this frame carries (agent-terminals.ts names the tmux
                // session after it), so the cards learn it here rather than from a second seam into the stream.
                if (event.kind === "session") {
                    shell.sessionId = event.sessionId;
                }
                // ExitPlanMode's current SDK input carries no plan; the completed prose before it does.
                trackProse(prose, event);
                /* And the same seam for what the turn WROTE: every write comes past here as a frame carrying the
                 * file whole, so the cards learn what they are about from the stream they are already in rather
                 * than from a second pass over the transcript or a re-read off disk. Latest wins: the newest
                 * write-up is the one a question asked after it is about.
                 *
                 * Held back until the call COMPLETES, because a Write's content is known at call time and the
                 * call can still be refused (the permission gate) or fail. A card offering the reader a document
                 * that was never written, as the thing they are being asked about, is worse than one offering
                 * nothing: it reads as fact. */
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
                /* And the same seam again for WHAT THIS TURN'S CHILDREN PROVED. A subagent's own tool calls
                 * ride this stream carrying the spawning call's id, which is the child's record id, so the
                 * edits and checks of every child are attributable here without a hook, a meta file, or a
                 * join (child-verification.ts). An update names only its call, so it is routed by the
                 * ownership the opening frame established; a frame of the PARENT'S own work has no child to
                 * name and is dropped, which is why an undelegating turn pays one comparison. */
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
            /* Any child still marked live goes to `killed` as the turn ends. Nothing else can say so: a stopped
             * turn, or a CLI that died under one, reports no terminal status for the children it was running, and
             * a subagent left "running" forever in the list is precisely the lie the registry exists to remove. */
            if (subagents !== undefined) {
                for (const frame of closeSubagents(subagents.conversationId)) {
                    push(frame);
                }
            }
            // Ends the streaming input, so the SDK subprocess settles; late steer pushes then report undelivered.
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
