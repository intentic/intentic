import {
    type CanUseTool,
    createSdkMcpServer,
    type EffortLevel,
    type HookCallbackMatcher,
    type HookEvent,
    type McpSdkServerConfigWithInstance,
    type McpServerConfig,
    type Options,
    type PermissionUpdate,
    query,
    type SDKAssistantMessage,
    type SDKMessage,
    type SDKUserMessage,
    type SlashCommand,
    type SpawnedProcess,
    type SpawnOptions,
    tool,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import {
    type AdmissionRule,
    type AgentEvent,
    type AgentReply,
    type AskQuestion,
    type CommandClass,
    type FastModeState,
    type PermissionMode,
    type Rule,
    sendableEffort,
    type SystemPromptMode,
    type UsageWindow,
} from "@intentic/sandbox-contract";
import { agentSessionName, browserSessionName } from "@intentic/sandbox-contract/session-names";
import { relative, sep } from "node:path";
import { z } from "zod";
import { daemonMountNs, type IsolationAnchor, nsenterArgv, TMUX_NS_ENV, type TurnPlacement } from "../agents/isolation.js";
import { worktreeRedirectHooks } from "../agents/worktree-redirect.js";
import { browserArtifactHooks, screenshotImage } from "../browser/browser-artifacts.js";
import { browserServerOfTool, browserSessionHooks } from "../browser/browser-sessions.js";
import { localCommandText, unknownCommandName } from "./agent-commands.js";
import { editDiagnosticsHooks } from "./agent-diagnostics.js";
import { installSteeringHooks } from "./agent-installs.js";
import { commandGateHooks } from "../guard/command-gate.js";
import { outboundGateHooks } from "../guard/outbound-gate.js";
import { type AgentTool, mcpServersOf } from "./agent-tools.js";
import { createRequest } from "./agent-requests.js";
import type { SteeringQueue } from "./agent-steering.js";
import { type TurnRuleCommand, turnEndingHooks } from "../rules/turn-ending.js";
import { agentShellBusy, bashTmuxHooks, tmuxRunEnabled } from "./agent-terminals.js";
import { withTurnPreamble } from "./turn-preamble.js";
import { EventQueue } from "./event-queue.js";
import { harnessEnv, type TurnAllowance } from "./harness-credentials.js";
import { workloadStamp } from "../platform/leftovers.js";
import { readClaudeUsage } from "../usage/claude-usage.js";
import type { TurnLimit } from "../usage/translator-usage.js";
import { sdkSystemPrompt } from "./system-prompt.js";
import { TaskChecklist } from "./task-checklist.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "./tool-calls.js";
import { isAuthFailureText, isEntitlementRefusalText, isUsageLimitText } from "./failure-sentences.js";
import {
    closeSubagents,
    noteDelegation,
    noteSubagentSpawn,
    noteSubagentTask,
    settleDelegation,
    subagentCountsOf,
    subagentHooks,
    type SubagentTaskMessage,
    type SubagentTurn,
} from "./subagents.js";

export interface AgentRequest {
    readonly prompt: string;
    // Which conversation this turn belongs to. Only the subagent registry reads it — a child is filed under the
    // parent whose turn spawned it, which is what lets the Subagents area group by agent and the fleet card count
    // its own. Absent ⇒ a turn with no conversation behind it (the bench), whose children are not registered.
    readonly conversationId?: string;
    // Absolute paths of user-attached files, consumed by the CODEX adapter (images ride as native
    // local_image inputs). The Claude path folds these into the prompt in streamAgent instead — its Read
    // tool handles images/PDFs from disk natively.
    readonly attachments?: readonly string[];
    // The working dir the agent edits — the workspace root, so it can touch all three repos. Under `isolation`
    // this is the root as seen INSIDE the namespace, where it resolves to the conversation's worktree.
    readonly cwd: string;
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
    // Re-mint `oauthToken` mid-turn. The CLI calls this when the API refuses the token it was given — expired
    // under a long turn, or revoked account-wide — and carries on with what comes back, so a credential that
    // dies while the agent is working costs a pause rather than the turn. Returning undefined (or the same
    // token) means no replacement exists, and the turn fails as it did before.
    readonly refreshOauthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
    // A custom Anthropic-Messages endpoint + bearer token for this turn, set when the Claude Code harness serves
    // a non-Claude provider (codex/grok) through the sandbox's translator. Injected as ANTHROPIC_BASE_URL /
    // ANTHROPIC_AUTH_TOKEN; when baseUrl is present the subscription OAuth token is WITHHELD so it never reaches
    // a foreign endpoint. Absent ⇒ native Anthropic endpoint with the OAuth token above.
    readonly baseUrl?: string;
    readonly authToken?: string;
    // Whose allowance a routed turn spends, and when a spent one reopens — neither readable from the harness,
    // which sees only that a 429 came back. Set alongside `baseUrl` by harness-credentials; absent on a native
    // Claude turn. See TurnAllowance.
    readonly allowance?: TurnAllowance;
    // The selected Codex account's CODEX_HOME for this turn (Codex path only). Absent ⇒ the adapter's default
    // base dir, which resolves the container's OPENAI_API_KEY fallback.
    readonly codexHome?: string;
    // Serve this NATIVE Codex turn through the sandbox translator's OpenAI-compatible endpoint on the connected
    // ChatGPT SUBSCRIPTION (Codex path only): the adapter points Codex's own Responses wire format at baseUrl
    // and authenticates with the fixed local bearer — no per-account OAuth auth.json. codexHome then holds only
    // sessions/rollouts, never a credential.
    readonly codexEndpoint?: { readonly baseUrl: string; readonly authToken: string };
    // How tool calls are gated this turn. Defaults to the autonomous sandbox posture (bypassPermissions) —
    // the container's isolation is what makes that safe. The agent can move itself out of it mid-turn.
    readonly permissionMode?: PermissionMode;
    /* Narrows the turn to these tool NAMES (the SDK option of the same name) — not to be confused with `tools`
     * below, which are MCP servers. Absent ⇒ the runtime's full toolbox.
     *
     * This is the only real bound on a turn nobody is watching. bypassPermissions above is the default posture
     * because the container is the isolation — but a Doorbell turn is driven by an anonymous website visitor,
     * where "the container is disposable" is not the whole answer: the automation's allowlist is what stops an
     * instruction smuggled into a support question from reaching Bash. */
    readonly allowedTools?: readonly string[];
    // Reasoning controls forwarded to the SDK (effort level / extended thinking).
    readonly effort?: string;
    readonly thinking?: boolean;
    // Ask the harness to serve this turn at fast speed. Only ever set for a NATIVE Claude turn — turn-plan
    // withholds it from a routed one, whose translator endpoint the harness would refuse as not first-party —
    // so by the time it is read here the only remaining questions (plan, model, pool) belong to the harness.
    readonly fast?: boolean;
    // The agent's MCP tools for this turn: intent-declared internal services (set in this container's env) plus
    // platform-configured external integrations. Each becomes a remote `http` MCP server. The daemon merges
    // both sources before calling; absent ⇒ the agent runs with no MCP tools (its plain autonomous posture).
    readonly tools?: readonly AgentTool[];
    // Env vars for the agent's shell from cli-kind capabilities (e.g. DISCORD_BOT_TOKEN) — the stored
    // credentials their CLI tools read. Merged into the SDK `env` each turn; absent ⇒ no extra env.
    readonly cliEnv?: Record<string, string>;
    /* The owner's rules standing at `turn.ending` (rules/rules.ts), plus the way to run one's command. Their
     * conditions are read at the Stop rather than here — a turn is planned before it runs, so nothing yet knows
     * which files it will touch (rules/turn-ending.ts).
     *
     * Absent/empty ⇒ the ledger and its Stop hook are not wired at all, so a workspace with no rule at this
     * moment pays nothing — not even the bookkeeping. */
    readonly turnEndingRules?: readonly Rule[];
    readonly runRuleCommand?: TurnRuleCommand;
    // Told when one of them actually said something, so the settings list can show which rules are earning
    // their place and which have been silent for three weeks.
    readonly onRuleFired?: (rule: Rule) => void;
    // Absolute Claude Code plugin checkout dirs from plugin-kind capabilities, rebuilt each turn (see
    // pluginDirsOf). The SDK's plugin loader parses their skills/agents/hooks/commands/.mcp.json — the daemon
    // never does, so the plugin format tracks Claude Code via SDK upgrades alone.
    readonly plugins?: readonly string[];
    // In-process SDK MCP servers — daemon-side tools whose handlers run in the daemon itself (e.g. the
    // Discord voice session tools). Merged into mcpServers alongside the remote `tools` above.
    readonly sdkServers?: Record<string, McpServerConfig>;
    // Where the browser tools' artifacts belong — the same directory `--output-dir` names, threaded here
    // because @playwright/mcp honours it only for the files IT names (browser/browser-artifacts.ts). Drives
    // both the redirect hook and the sentence that tells the agent where to Read a screenshot back from.
    readonly browserOutputDir?: string;
    // Each browser MCP server's CDP debugging port (server name → port), so the first browser tool call can
    // register a watchable session for the Chromium that call is launching (browser/browser-sessions.ts).
    // Absent ⇒ the turn has no browser tools at all, and nothing is watched.
    readonly browserPorts?: Record<string, number>;
    // Each logged-in browser server's passkey store path (server name → file), so the session observer arms
    // every page with the platform's software security key (browser/passkeys.ts). Absent for turns whose
    // browsers hold no identity.
    readonly browserPasskeys?: Record<string, string>;
    // Built-in tool names to remove from the model's context this turn (SDK disallowedTools). Set by the
    // hashlineEdits toggle to disable native Edit/Write so file mutations route through the hashline MCP tools.
    readonly disallowedTools?: readonly string[];
    // The Bash output-cleaner spec, forwarded to agent-output-filter via env (INTENTIC_OUTPUT_CLEANERS), or the
    // literal "off" to disable the filter (INTENTIC_RUN_FILTER=0, raw baseline). Empty/undefined ⇒ the filter's
    // all-on default. See settings/outputCleaners + bin/cleaners.mjs.
    readonly outputCleaners?: string;
    // The sniffer's rulebook (settings.actionRules) — verdicts per classified outbound call, enforced by the
    // PreToolUse outbound gate. Absent/empty ⇒ the gate is not wired at all (guard/outbound-gate.ts).
    readonly actionRules?: Readonly<Record<string, AdmissionRule>>;
    // The command gate's rulebook (settings.commandRules) — a verdict per class of shell command, enforced
    // before the command runs. A "hold" parks the turn on a permission card, in every posture, which is what
    // makes it the layer that still applies once bypassPermissions has taken the cards away
    // (guard/command-gate.ts). Absent/empty ⇒ no hook.
    readonly commandRules?: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    // Measurement control: a fraction [0,1] of commands whose output bypasses cleaning (INTENTIC_OUTPUT_HOLDOUT),
    // recorded raw so the savings report has a real cleaned-vs-raw baseline. 0/undefined ⇒ no holdout.
    readonly outputHoldout?: number;
    /* THE HARNESS'S OWN DELEGATION CEILINGS, each raised or lowered by the matching sandbox setting: how many
     * subagents may run at once, how many one conversation may spawn in total, and how deep they may nest.
     * Undefined ⇒ nothing is set in the environment and the CLI's own answer stands — which turn-plan relies on,
     * so an untouched setting cannot pin a default the harness means to be able to move.
     *
     * The refusals these produce are worth knowing when reading a transcript that stopped delegating: the agent
     * is told the limit and told NOT to retry, so the turn carries on doing the work itself rather than failing. */
    readonly subagentsAtOnce?: number;
    readonly subagentsPerTurn?: number;
    readonly subagentDepth?: number;
    // Extra turn-scoped instructions appended to the claude_code preset system prompt (e.g. the CLI
    // delegation note when Codex/Grok accounts are connected — see agent/delegation.ts).
    readonly systemAppend?: string;
    // Which base this turn's system prompt is built on (SandboxSettings.systemPromptMode). Absent ⇒ "intentic",
    // the product default, so a caller that constructs a request directly (the bench) gets what the app runs.
    readonly systemPromptMode?: SystemPromptMode;
    // The owner's own prompt text, used only when the mode is "custom" — it is then the entire system prompt
    // and nothing else is appended, `systemAppend` included. See system-prompt.ts.
    readonly systemPrompt?: string;
    // Mid-turn steering: when present, the turn runs in the SDK's streaming-input mode and messages pushed
    // onto this queue (via /agent/steer) are injected between tool calls. Absent ⇒ single-message mode.
    readonly steering?: SteeringQueue;
    /* PUT THE BRANCH BACK ON TODAY'S MAIN LINE — the pre-turn rebase (agents/sync.ts), offered again at the
     * moments this turn stops and waits for a person. agent.routes.ts owns what it does; this module owns
     * WHEN, because only the harness knows when the model is genuinely parked.
     *
     * A card is not a pause, it is a gap: measured over this sandbox's own transcripts a question card waits a
     * median 2.6 minutes and a plan approval up to ten, and the user's main line moves during one park in
     * five. Every one of those minutes the turn spends holding a base that is quietly going stale — and unlike
     * the gap between turns, nothing reconciles it before the work resumes. The answer arrives, the model
     * carries on against a dead base, and the auto-land at the end of the turn is where that surfaces.
     *
     * Answers with the pair the two audiences need — a frame for the transcript, a note for the model — and
     * with undefined on the ordinary settle where the branch was already current. Absent on a main-tree turn
     * (no branch to move) and on every runtime but the harness. */
    readonly resync?: () => Promise<ParkedSync | undefined>;
    // Nobody is watching this turn: it was started by a benchmark, a schedule or another program rather than
    // by someone sitting in front of the chat. The interactive surface is then not merely useless but a
    // DEADLOCK — a plan approval or a question card parks the turn on an answer that can never arrive, and the
    // turn burns until something aborts it. So an unattended turn is given no plan tools and no ask tool, and
    // its permission gate refuses rather than waits.
    readonly unattended?: boolean;
}

// What a turn needs from the SDK: the message stream and the session's slash-command list. The real `query`
// returns a Query, which satisfies both; the method is optional because a fake stream legitimately has none
// (it resolves a control request, which no canned generator answers).
export type AgentQuery = AsyncIterable<SDKMessage> & {
    readonly supportedCommands?: () => Promise<readonly SlashCommand[]>;
};

// The SDK `query` is injected so tests drive a fake message stream — no API calls, no bundled binary.
export type QueryFn = (args: { readonly prompt: string | AsyncIterable<SDKUserMessage>; readonly options: Options }) => AgentQuery;
const defaultQuery: QueryFn = (args) => query(args);

// The SDK's slash commands, mapped onto the wire shape the composer's `/` popover renders. `argumentHint`
// is always a string there (empty when the command takes no argument), so an empty one carries no hint.
const commandFrame = (commands: readonly SlashCommand[]): AgentEvent => ({
    kind: "commands",
    items: commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint !== "" ? { hint: command.argumentHint } : {}),
    })),
});

// The turn's prompt input: a steerable turn streams user messages (the initial prompt, then whatever the
// steer route pushes until the queue closes at turn end); an unsteerable one keeps single-message mode.
const promptInput = (request: AgentRequest): string | AsyncIterable<SDKUserMessage> =>
    request.steering === undefined ? request.prompt : steeredInput(request.prompt, request.steering);

async function* steeredInput(first: string, steering: SteeringQueue): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null };
    for await (const text of steering) {
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
}

// In streaming-input mode the SDK emits one `result` per TURN and keeps the stream open for further input: a
// steered message the running turn could not absorb runs as its own follow-up turn AFTER the result (observed
// to announce itself within ~2ms), while a steer absorbed mid-turn (injected between tool calls) produces no
// extra result — so no message count can tell "more coming" from "settled". Instead, after a result on a
// steered stream, the next SDK message is raced against this grace window: a message means another turn is
// underway; silence means the turn stream is over.
const STEER_GRACE_MS = 1000;

const nextWithinGrace = async (next: Promise<IteratorResult<SDKMessage, void>>): Promise<IteratorResult<SDKMessage, void> | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), STEER_GRACE_MS);
    });
    try {
        return await Promise.race([next, expired]);
    } finally {
        clearTimeout(timer);
    }
};

/* The background work a turn's end must WAIT for, by the task machine's own discriminant. These run inside
 * the turn's CLI process, so a stream ended while one is live kills it mid-flight — the failure the user meets
 * as "the session process exited and took all 14 agents with it", minutes after the model said it would come
 * back with their results. A backgrounded shell is deliberately absent: it runs in the turn's tmux session,
 * which the daemon owns and outlives the turn, and holding on one would keep a turn spinning for as long as a
 * dev server runs. `monitor` is ambient by design and lives exactly as long as the session — never waited on. */
const HELD_TASK_TYPES: ReadonlySet<string> = new Set(["subagent", "workflow", "local_workflow"]);

// The SDK message stream, ended at the right turn boundary. Unsteered (or never-steered) streams end at the
// first result, as before. Once a steer was delivered, each result instead arms the grace race above; when it
// goes silent, closing the input queue ends the SDK's streaming input and the stream drains to its natural
// end (settling the subprocess) — a turn that slipped in during the race still streams in full.
//
// A result with backgrounded CHILDREN still in flight is not the boundary either: they die with the
// subprocess, and the CLI wakes the model with a task notification when one settles — so the stream is held
// open and the wake turn (the "I'll come back with results") rides it like a steered follow-up. Membership
// comes from the SDK's own level signal (background_tasks_changed, replace semantics — a missed edge cannot
// wedge a stale hold), and once the last child settles, either a wake turn announces itself within the grace
// window or none is coming and closing the input drains the stream as above.
async function* sdkTurns(
    stream: AsyncIterable<SDKMessage>,
    steering: SteeringQueue | undefined,
    // Push the turn's prompt back through the streaming input, once — see the swallowed-prompt branch below.
    // Reports whether it did, so a stream that already redelivered ends at its result like any other.
    redeliver: (() => boolean) | undefined,
): AsyncGenerator<SDKMessage> {
    const iterator = stream[Symbol.asyncIterator]();
    let awaitingNextTurn = false;
    // Live in-process background work, off the latest level signal. Counts only what the boundary waits for.
    let heldTasks = 0;
    // A result passed while children were live: the stream is being held open for the CLI's wake turn.
    let held = false;
    // A main-thread model frame since the last result — a turn mid-stream always produces more messages, so
    // only the idle gaps BETWEEN turns are raced against the grace window while held. Children's own frames
    // (parented) keep arriving throughout the hold and must not read as a turn underway.
    let midTurn = false;
    // Whether the CLI produced ANYTHING since the last result — model output, a child's, or a local slash
    // command's. What separates a turn that legitimately never called the model from one that swallowed its
    // prompt (below).
    let sawWork = false;
    // A pending next() that lost the grace race is re-awaited on the following pass, never abandoned.
    let pending: Promise<IteratorResult<SDKMessage, void>> | undefined;
    try {
        for (;;) {
            const nextPromise = pending ?? iterator.next();
            pending = undefined;
            let step: IteratorResult<SDKMessage, void>;
            if (awaitingNextTurn) {
                awaitingNextTurn = false;
                const winner = await nextWithinGrace(nextPromise);
                if (winner === undefined) {
                    steering?.close();
                    pending = nextPromise;
                    continue;
                }
                step = winner;
            } else if (held && !midTurn && heldTasks === 0) {
                // The last child settled between turns: either the CLI's wake turn announces itself now, or no
                // wake is coming and closing the input is what lets the stream drain to its end.
                const winner = await nextWithinGrace(nextPromise);
                if (winner === undefined) {
                    held = false;
                    steering?.close();
                    pending = nextPromise;
                    continue;
                }
                step = winner;
            } else {
                step = await nextPromise;
            }
            if (step.done === true) {
                return;
            }
            const message = step.value;
            if (message.type === "system" && message.subtype === "background_tasks_changed") {
                heldTasks = message.tasks.filter((task) => HELD_TASK_TYPES.has(task.task_type)).length;
            } else if (
                (message.type === "assistant" || message.type === "stream_event" || message.type === "user") &&
                message.parent_tool_use_id === null
            ) {
                midTurn = true;
            }
            if (
                message.type === "assistant" ||
                message.type === "stream_event" ||
                (message.type === "system" && message.subtype === "local_command_output")
            ) {
                sawWork = true;
            }
            if (message.type !== "result") {
                yield message;
                continue;
            }
            midTurn = false;
            /* A SWALLOWED PROMPT: an instant "success" with num_turns 0 and not one frame of work behind it,
             * before anything was even delivered. The CLI does this when a resume wakes up to its own stale
             * background-task notifications (a previous turn's subagents killed at its end): it classifies the
             * whole run as a notification wake needing no response and results in milliseconds — while the
             * prompt it was just sent is dequeued into the dying run, stamped "No response requested." at the
             * next resume, and never answered. To the user that is a sent message producing nothing at all: no
             * reply, no error, no stopped state.
             *
             * The subprocess is still alive waiting on the streaming input, so the recovery is the one the user
             * performs by hand — say it again: the prompt goes back through the steering queue and runs as a
             * follow-up turn in the same process, whose notification debt the dead run just paid. The empty
             * result is not yielded — nothing settled, and its zero-usage frame would end the client's turn.
             * `sawWork` keeps a local slash command (the one legitimate num_turns-0 success) out of this branch,
             * and redeliver() is once per turn: a second empty answer is a different problem, and looping the
             * same prompt at it is noise, not recovery. `!held` keeps it off a stream held open for a wake turn:
             * children can settle without one frame of forwarded work, and an empty wake there is the hold
             * ending, not the prompt vanishing. */
            const idle = !sawWork;
            sawWork = false;
            if (!held && idle && message.subtype === "success" && message.num_turns === 0 && steering?.delivered === 0 && redeliver?.() === true) {
                awaitingNextTurn = true;
                continue;
            }
            yield message;
            if (heldTasks > 0) {
                held = true;
                continue;
            }
            held = false;
            if (steering === undefined || steering.delivered === 0) {
                // Close before returning (not just in runAgent's finally) so a steer racing this result
                // reports undelivered instead of landing in a queue nothing will ever consume.
                steering?.close();
                return;
            }
            awaitingNextTurn = true;
        }
    } finally {
        await iterator.return?.();
    }
}

// The modes the contract (and so the composer) models. The SDK also resolves 'dontAsk' and 'auto' — from a
// settings default, say — which have no UI here, so a mode frame is only emitted for one of these four.
const PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions"]);

// What the UI shows for an API-level failure. The SDK's `error` field is only a CATEGORY, and 'unknown' is its
// catch-all for everything it can't bucket — every 4xx lands there. The synthetic assistant message carrying it
// holds the API's actual sentence in its text block ("API Error: 400 output_config.effort 'max' is not supported
// when thinking is disabled on this model", say), which is the only part anyone can act on: reporting the
// category alone turns a precise, fixable complaint into a shrug. Text wins, category is the fallback.
const apiErrorMessage = (message: SDKAssistantMessage): string => {
    const content = message.message.content as ReadonlyArray<{ type: string; text?: string }>;
    const explained = content.find((block) => block.type === "text" && block.text !== undefined && block.text.trim() !== "")?.text;
    return explained ?? `agent error: ${message.error}`;
};

/* THE PROXY'S OWN ANSWER ABOUT WHEN TO COME BACK, when it survives the trip. CLIProxyAPI refuses a fleet-wide
 * cooldown with a JSON body — {"error":{"code":"model_cooldown","message":"All credentials for model X are
 * cooling down","reset_seconds":N}} — and the harness prints that body as the API error's text. `reset_seconds`
 * is the one number separating a credential cooling for a minute from a weekly wall days out, and it is read off
 * the proxy's own scheduler rather than inferred from a snapshot up to five minutes stale, so it wins over the
 * recorded quota wherever it appears.
 *
 * Both markers are required because the number alone is not the claim — some other provider's error body may
 * carry a `reset_seconds` meaning something else entirely. Absent on the api_retry path, which carries counters
 * and a category and no body at all: this is an upgrade over the recorded quota, never a dependency on it. */
const proxyCooldownReset = (explained: string, now: number = Date.now()): number | undefined => {
    const seconds = /"reset_seconds"\s*:\s*(\d+)/.exec(explained);
    return seconds === null || !explained.includes(`"model_cooldown"`) ? undefined : Math.ceil(now / 1000) + Number(seconds[1]);
};

/* WHAT A SPENT ALLOWANCE READS AS — three situations wearing one 429, and the reason a single sentence could
 * never be right about all of them.
 *
 * `vendor` because the harness is not the vendor on a routed turn (see TurnAllowance): naming Anthropic for a
 * Google quota sends the user to the wrong account. The POOL because Google meters Gemini separately from the
 * Claude and GPT models off one sign-in, so "the allowance" names two different things depending on the model
 * that was running. And the COUNTS because there is no "this account" behind a translator that balances across
 * every credential it holds — that phrasing is only true of a native Claude turn, which is exactly where it is
 * kept.
 *
 * The middle case is the one that cost the most. Headroom left on file means the quota is NOT what refused this
 * turn: the translator had every credential cooling for some other reason — a transient upstream error cools one
 * for a minute — and sending someone away until Monday over a condition that clears in seconds is worse than
 * saying nothing at all. */
const limitSentence = (vendor: string, limit: TurnLimit | undefined): string => {
    if (limit === undefined) {
        return `${vendor} usage limit reached — this account's allowance is exhausted, not a provider outage. Send again once it resets to carry on from here.`;
    }
    const allowance = limit.pool === undefined ? `allowance` : `${limit.pool} allowance`;
    if (limit.withHeadroom > 0) {
        const total = limit.withHeadroom + limit.spent;
        return (
            `${vendor} refused this turn, but ${limit.withHeadroom} of ${total} connected accounts still ` +
            `${limit.withHeadroom === 1 ? `has` : `have`} headroom${limit.pool === undefined ? `` : ` for ${limit.pool}`} — every ` +
            `credential is cooling down rather than spent, so this clears in moments rather than at a reset.`
        );
    }
    // Nothing measured either way: the pool was never polled, or the provider has renamed the bucket it is
    // reported under. Say a limit was hit and claim nothing about a fleet we cannot see.
    if (limit.spent === 0) {
        return `${vendor} usage limit reached — the ${allowance} is exhausted, not a provider outage. Send again once it resets to carry on from here.`;
    }
    const accounts = limit.spent === 1 ? `the connected account` : `all ${limit.spent} connected accounts`;
    return `${vendor} usage limit reached — the ${allowance} is spent on ${accounts}, not a provider outage. Send again once it resets to carry on from here.`;
};

// One frame for both ways a spent subscription allowance reaches us: an assistant refusal after the harness
// gives up, and the earlier api_retry frame whose long delay says it intends to wait for the reset. Keeping it
// here prevents the live-retry path from drifting back into calling the same condition an outage while the
// terminal path calls it a limit. `named` is what the failure ITSELF said about when to come back — see the two
// call sites, which have different things to offer and neither of which is always right on its own.
const rateLimitFrame = async (allowance: TurnAllowance | undefined, named: number | undefined): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const limit = await allowance?.limit();
    const resetsAt = named ?? limit?.reopensAt;
    return {
        kind: "error",
        code: "rate_limit",
        message: limitSentence(allowance?.vendor ?? "Claude", limit),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
};

/* WHICH CONDITION an API failure actually is — the frame the client branches on.
 *
 * Two of these read the CATEGORY the SDK filed, and two read the SENTENCE, and the split is not arbitrary. A
 * spent allowance and a refused credential arrive as prose under whatever category the failing layer happened to
 * pick (see failure-sentences.ts), so there the text is the only signal. A provider outage
 * does not: the harness buckets every 5xx, every 529 at capacity, and every dropped socket as `server_error`, and
 * a pre-retry capacity refusal as `overloaded`. Those two categories mean precisely "the provider failed us and
 * the request is worth making again", which is the one claim an automatic resume has to be right about — so it is
 * read from the category and never from the wording, which changes with every CLI release.
 *
 * Everything else stays uncoded and reads as the red line it is: 4xx all land in the SDK's `unknown` bucket, and
 * a malformed request re-sent on a timer is a loop, not a recovery. */
const errorFrame = async (message: SDKAssistantMessage, allowance: TurnAllowance | undefined): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    // rate_limit is the subscription usage cap, not a workspace fault — tag it so the UI can render it as a
    // "wait and retry" notice instead of a red crash line (see conversation.ts). A limit hit the SDK filed under
    // another category keeps its own sentence (the CLI's "You've hit your session limit · resets …" names the
    // reset; our canned line doesn't) but carries the same code, so every spent-allowance failure reaches the
    // client as one condition. This is the ONE path that still holds the API's body, so it is the only one that
    // can offer the translator's own reset — see proxyCooldownReset.
    if (message.error === "rate_limit") {
        return rateLimitFrame(allowance, proxyCooldownReset(apiErrorMessage(message)));
    }
    if (message.error === "server_error" || message.error === "overloaded") {
        return { kind: "error", code: "provider-outage", message: apiErrorMessage(message) };
    }
    const explained = apiErrorMessage(message);
    if (isUsageLimitText(explained)) {
        return { kind: "error", code: "rate_limit", message: explained };
    }
    /* The seat, not the credential: this account authenticates perfectly and its organization has switched
     * Claude Code off for it. ABOVE the auth branch because the two are only distinguishable by the sentence and
     * the recoveries are opposite — a re-mint is what a refused token wants and the one thing that cannot help
     * here, so coding this as that would spend a retry, fail identically, and leave the user reconnecting an
     * account that was never disconnected. */
    if (isEntitlementRefusalText(explained)) {
        return { kind: "error", code: "claude-not-entitled", message: explained };
    }
    // A credential the CLI has stopped trying to use (failure-sentences.ts). Coded so the route can re-mint and
    // resume the turn instead of leaving a dead tab for a human to restart by hand — the same "not a workspace
    // fault" treatment a spent allowance gets.
    if (isAuthFailureText(explained)) {
        return { kind: "error", code: "claude-token-refused", message: explained };
    }
    return { kind: "error", message: explained };
};

// Normalize the SDK's SDKMessage stream onto AgentEvents. High-value block types get a dedicated frame;
// any SDK message without a mapping is dropped. Does NOT emit the terminal `done` (runAgent does that once
// the whole turn settles).
async function* streamSdk(
    queryFn: QueryFn,
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: Options,
    cwd: string,
    tmuxEnabled: boolean,
    // Where this turn's browser artifacts land — how a screenshot's answer is turned back into a picture the
    // chat can show. Absent on a turn with no browser tools at all.
    browserOutputDir: string | undefined,
    steering: SteeringQueue | undefined,
    // The swallowed-prompt recovery sdkTurns fires — see its result branch. Absent on an unsteerable turn,
    // which has no road back into the streaming input.
    redeliver: (() => boolean) | undefined,
    // Reads the credential's plan-limit pools at turn settle; absent when the turn ran on a credential with no
    // pools to read (an API endpoint, the container env) — no read, no frame.
    readUsage: (() => Promise<UsageWindow[]>) | undefined,
    // Whose allowance this turn spends and when it reopens; absent on a native Claude turn, whose harness
    // answers both by itself. See TurnAllowance.
    allowance: TurnAllowance | undefined,
    // The turn handle children are filed under; absent ⇒ no conversation to file them against (the bench).
    subagents: SubagentTurn | undefined,
): AsyncGenerator<AgentEvent> {
    let sessionSent = false;
    let terminalSent = false;
    // The agent's live tmux terminal is surfaced twice: once at the first Bash tool_use (so a long command is
    // watchable live) and once at that command's tool_result (by then tmux-run has definitely created the
    // session, so a first-command cold-start that outran the tool_use relist still gets a tab). surface() is
    // idempotent, so the double emit is harmless.
    let terminalResurfaced = false;
    let agentSession: string | undefined;
    // Same idea for the agent's browser: named once, at the first browser tool call, so the client can offer
    // "watch this" from the card that asked the question. The PreToolUse hook is what actually registers the
    // session (browser/browser-sessions.ts); this frame only tells the client its name.
    let browserSent = false;
    const bashToolIds = new Set<string>();
    // Bash calls that turned out to be a delegated CLI agent, so their result settles the registry record too.
    const delegationToolIds = new Set<string>();
    // tool_use ids of browser screenshots, so the result can be turned into a picture the chat actually shows
    // instead of the literal "[image]" a non-text block collapses to (browser/browser-artifacts.ts).
    const screenshotToolIds = new Set<string>();
    // tool_use ids whose tool_call already carried the authoritative diff (derived from the Edit/Write input),
    // so the success result's redundant "file updated" text must not REPLACE it (update content is a snapshot).
    const diffToolIds = new Set<string>();
    // The agent's working checklist, reassembled from the Task tool family across both branches below. Their
    // tool_use ids are remembered so the result branch suppresses their cards too — the list IS their render.
    const checklist = new TaskChecklist();
    const checklistToolIds = new Set<string>();
    // Context-window fill for the turn: the latest message_start reports the request's input size (grows
    // monotonically within a turn); the result reports the model's contextWindow. Paired into one
    // context_usage frame at the result so the UI can warn as the chat nears auto-compaction.
    let contextTokens: number | undefined;
    let contextModel: string | undefined;
    // The text content block currently streaming, per agent — the main turn under "", each subagent under its
    // Task tool id — so a content_block_stop closes exactly the prose its own deltas were writing (see the
    // text_end frame). Keyed and index-matched rather than a bare flag so neither a stop belonging to some
    // other block (thinking, a tool's input JSON) nor a subagent's interleaved stream can retire the wrong one.
    // A block's stop always precedes its message's `assistant` frame, so the boundary lands BEFORE the tool
    // calls that block introduced, which is what puts them under it rather than above it in the transcript.
    const textBlocks = new Map<string, number>();
    // The turn's live permission mode, so the composer can follow it. The SDK has no mode-change message —
    // `init` states the resolved starting mode, `status` piggybacks the current one, and the agent's own
    // EnterPlanMode is only visible as a tool call — so the three are folded here and de-duplicated.
    let mode: PermissionMode | undefined;
    const modeChange = (next: PermissionMode | undefined): AgentEvent | undefined => {
        if (next === undefined || next === mode || !PERMISSION_MODES.has(next)) {
            return undefined;
        }
        mode = next;
        return { kind: "mode", mode: next };
    };
    /* What speed the harness is actually serving this turn at, folded and de-duplicated exactly like the mode
     * above: it is reported on `init` and again on the result, and restating an unchanged answer would put a
     * second identical row in front of the user for no new information.
     *
     * De-duplicated on the PAIR rather than on the state, because the reason moves on its own and the move is
     * the informative part: `init` can answer `off`/`pending` — the harness has not finished asking — and the
     * result then names why, which is the difference between "we're checking" and "your plan doesn't include
     * it". A state change alone is the other case worth a frame: a turn that exhausts the fast-mode pool
     * mid-flight (it has its own, separate from the model's) drops to `cooldown` and finishes at standard
     * speed, and the bill will say so whether or not the transcript does. */
    let fastReported: string | undefined;
    const fastModeChange = (state: FastModeState | undefined, reason: string | undefined): AgentEvent | undefined => {
        if (state === undefined) {
            return undefined;
        }
        const reported = `${state}:${reason ?? ""}`;
        if (reported === fastReported) {
            return undefined;
        }
        fastReported = reported;
        return { kind: "fast_mode", state, ...(reason !== undefined ? { reason } : {}) };
    };
    // Bound rather than inlined into sdkTurns: the turn also reads the session's slash-command list off this
    // handle at `init` (see below), which the bare AsyncIterable it is consumed as does not expose.
    const session = queryFn({ prompt, options });
    for await (const message of sdkTurns(session, steering, redeliver)) {
        const sessionId = (message as { session_id?: string }).session_id;
        if (!sessionSent && typeof sessionId === "string" && sessionId !== "") {
            sessionSent = true;
            yield { kind: "session", sessionId };
        }
        // The session a child's transcript is filed under, onto the handle the hooks close over — see SubagentTurn.
        if (subagents !== undefined && subagents.sessionId === undefined && typeof sessionId === "string" && sessionId !== "") {
            subagents.sessionId = sessionId;
        }
        // Frames produced inside a subagent (Task tool) carry its id so the UI can group them.
        const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
        const withParent = parent !== undefined ? { parentToolUseId: parent } : {};

        if (message.type === "stream_event") {
            // Token deltas — text and extended thinking both arrive here (partial messages are enabled). Each
            // request's message_start also reports its usage, which is the current context-window fill.
            const event = message.event as {
                type: string;
                index?: number;
                content_block?: { type?: string };
                delta?: { type: string; text?: string; thinking?: string };
                message?: {
                    model?: string;
                    usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
                };
            };
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
                yield { kind: "delta", text: event.delta.text, ...withParent };
            } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
                yield { kind: "thinking", text: event.delta.thinking, ...withParent };
            } else if (event.type === "content_block_start" && event.content_block?.type === "text" && event.index !== undefined) {
                textBlocks.set(parent ?? "", event.index);
            } else if (event.type === "content_block_stop" && event.index !== undefined && textBlocks.get(parent ?? "") === event.index) {
                textBlocks.delete(parent ?? "");
                yield { kind: "text_end", ...withParent };
            } else if (event.type === "message_start" && event.message?.usage !== undefined) {
                // Full input sent for this request = the context fill right now (input + both cache buckets).
                const usage = event.message.usage;
                contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
                contextModel = event.message.model;
            }
        } else if (message.type === "assistant") {
            // Text/thinking already streamed as deltas above; here we only surface tool calls (and the
            // TodoWrite checklist, which is a tool call we render as its own live list).
            if (message.error !== undefined) {
                yield await errorFrame(message, allowance);
            } else {
                const content = message.message.content as ReadonlyArray<{ type: string; id?: string; name?: string; input?: unknown }>;
                for (const block of content) {
                    // A tool_use without an id can't be correlated to its result — real streams always carry one.
                    if (block.type !== "tool_use" || typeof block.name !== "string" || block.id === undefined) {
                        continue;
                    }
                    // The checklist, which renders as its own live list rather than as tool cards — one card per
                    // task creation and per status flip would bury the transcript. A create can only render from
                    // its RESULT (that is where it learns its task id); an update names the id in its input, so
                    // the list moves the instant the agent says so.
                    if (block.name === "TaskCreate" || block.name === "TaskList") {
                        if (block.name === "TaskCreate") {
                            checklist.created(block.id, block.input);
                        }
                        checklistToolIds.add(block.id);
                        continue;
                    }
                    if (block.name === "TaskUpdate") {
                        const items = checklist.updated(block.input);
                        checklistToolIds.add(block.id);
                        if (items !== undefined) {
                            yield { kind: "todos", items };
                        }
                        continue;
                    }
                    // The agent moving itself into planning. Nothing else reports it — there is no mode-change
                    // SDK message — so the tool call IS the signal. ExitPlanMode is NOT mirrored here: the user's
                    // approval chooses the mode it lands in, and canUseTool pushes that frame.
                    if (block.name === "EnterPlanMode") {
                        const changed = modeChange("plan");
                        if (changed !== undefined) {
                            yield changed;
                        }
                    }
                    /* The call that starts another AGENT. Its input is the only place that says whether the
                     * parent walked away from the child (subagents.ts), and background is the tool's own
                     * default — an explicit `false` is the one shape that means the turn blocks on it. `Agent`
                     * is the Claude SDK's name for the tool, and the SDK task stream is the only thing that
                     * files these children. */
                    if (
                        block.name === "Agent" &&
                        subagents !== undefined &&
                        (block.input as { run_in_background?: unknown })?.run_in_background !== false
                    ) {
                        noteSubagentSpawn(block.id);
                    }
                    // First Bash of the turn: name the live `agent-<id>` tmux session so the browser surfaces
                    // that terminal. Same derivation the PreToolUse hook routes commands through, so they match.
                    // Remember every Bash tool_use id so the tool_result below can re-surface (the session may
                    // not exist yet at tool_use — the SDK can lag before actually running the command).
                    if (block.name === "Bash" && tmuxEnabled && typeof sessionId === "string") {
                        agentSession ??= agentSessionName(sessionId);
                        if (agentSession !== undefined) {
                            bashToolIds.add(block.id);
                            if (!terminalSent) {
                                terminalSent = true;
                                yield { kind: "terminal", session: agentSession };
                            }
                        }
                    }
                    /* A Bash command can also BE an agent: `codex exec` / `opencode run` drive the user's other
                     * connected accounts (delegation.ts), and the command line is the only place that is visible.
                     * Registered off the same block the terminal frame comes from, so a delegation and the shell
                     * it runs in are named together — and detected for every Bash call, tmux or not, because
                     * whether the daemon can WATCH it is a different question from whether it happened. */
                    if (block.name === "Bash" && subagents !== undefined) {
                        const input = block.input as { command?: unknown; run_in_background?: unknown } | undefined;
                        const command = input?.command;
                        if (typeof command === "string") {
                            const spawned = noteDelegation(subagents, {
                                id: block.id,
                                command,
                                // A backgrounded command's result announces its START, so it may not end the
                                // record it opens (settleDelegation).
                                background: input?.run_in_background === true,
                                ...(agentSession !== undefined ? { terminal: agentSession } : {}),
                            });
                            if (spawned !== undefined) {
                                delegationToolIds.add(block.id);
                                yield spawned;
                            }
                        }
                    }
                    // First browser tool of the turn: name the `browser-<id>` session so the card can offer to
                    // watch it. Unlike Bash there is no resurface pass — the session is registered by the same
                    // call's PreToolUse hook, which has already run by the time this block is streamed.
                    if (browserServerOfTool(block.name) !== undefined) {
                        if (block.name.endsWith("__browser_take_screenshot")) {
                            screenshotToolIds.add(block.id);
                        }
                        if (!browserSent && typeof sessionId === "string") {
                            const browser = browserSessionName(sessionId);
                            if (browser !== undefined) {
                                browserSent = true;
                                yield { kind: "browser", session: browser };
                            }
                        }
                    }
                    const target = toolTarget(block.input);
                    const locations = toolLocations(block.input, cwd);
                    const diff = editDiffContent(block.name, block.input, cwd);
                    if (diff !== undefined) {
                        diffToolIds.add(block.id);
                    }
                    yield {
                        kind: "tool_call",
                        id: block.id,
                        // Through the shared vocabulary like every other backend's: Claude's own tool names have
                        // no entry and pass through untouched, and an MCP browser tool stops being
                        // `mcp__web__browser_navigate` on the card.
                        name: displayNameOf(block.name),
                        category: toolCategoryOf(block.name),
                        status: "in_progress",
                        ...(target !== undefined ? { target } : {}),
                        ...(locations !== undefined ? { locations } : {}),
                        ...(diff !== undefined ? { content: [diff] } : {}),
                        ...withParent,
                    };
                }
            }
        } else if (message.type === "user") {
            // Tool results come back as tool_result blocks on a (usually synthetic) user message — this is
            // where edit diffs and bash output live.
            const content = message.message.content;
            if (Array.isArray(content)) {
                for (const block of content as ReadonlyArray<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
                    // A result without a tool_use_id can't be correlated — real streams always carry one.
                    if (block.type !== "tool_result" || block.tool_use_id === undefined) {
                        continue;
                    }
                    // Backstop: the first Bash tool_result guarantees tmux-run has created the session, so
                    // re-surface the terminal in case the tool_use-time relist raced ahead of session creation.
                    if (!terminalResurfaced && agentSession !== undefined && bashToolIds.has(block.tool_use_id)) {
                        terminalResurfaced = true;
                        yield { kind: "terminal", session: agentSession };
                    }
                    // A checklist verb: no card was emitted for the call, so none is updated here. A create
                    // learns its task id from this result ("Task #1 created successfully"), and a TaskList
                    // result is the authoritative set — it adopts tasks made before this turn attached.
                    if (checklistToolIds.has(block.tool_use_id)) {
                        const items = checklist.resolved(block.tool_use_id, block.content) ?? checklist.listed(block.content);
                        if (items !== undefined) {
                            yield { kind: "todos", items };
                        }
                        continue;
                    }
                    // A successful Edit/Write result is only the redundant "file updated" snippet — status alone,
                    // so the call-time diff stays the card's content. Errors DO replace it (the text is the reason).
                    const failed = block.is_error === true;
                    const text = resultText(block.content);
                    // The delegate stopped. Its last words are its report, which is what a finished child is read
                    // for — so the registry takes them from the same text the card shows.
                    if (delegationToolIds.has(block.tool_use_id)) {
                        const settled = settleDelegation(block.tool_use_id, { failed, output: text });
                        if (settled !== undefined) {
                            yield settled;
                        }
                    }
                    // A screenshot's answer names the file it wrote; carry the picture alongside the text so the
                    // card can show what the agent looked at, not just say that it looked.
                    const image =
                        !failed && screenshotToolIds.has(block.tool_use_id) && browserOutputDir !== undefined
                            ? screenshotImage(text, cwd, browserOutputDir)
                            : undefined;
                    yield {
                        kind: "tool_call_update",
                        id: block.tool_use_id,
                        status: failed ? "failed" : "completed",
                        ...(diffToolIds.has(block.tool_use_id) && !failed
                            ? {}
                            : { content: [{ type: "text" as const, text }, ...(image !== undefined ? [image] : [])] }),
                    };
                }
            }
        } else if (message.type === "system") {
            if (message.subtype === "init") {
                // Guard the model: the frame's schema requires a string, so never forward an empty init.
                if (message.model) {
                    yield { kind: "init", model: message.model };
                }
                const changed = modeChange(message.permissionMode as PermissionMode);
                if (changed !== undefined) {
                    yield changed;
                }
                // The harness's answer to "am I serving this turn fast?", at the earliest point it can be asked
                // — before a single token has been spent, which is when it is still actionable.
                const speed = fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
                if (speed !== undefined) {
                    yield speed;
                }
                // The session's slash commands — built-ins plus the workspace's own .claude/commands and any
                // plugin/skill commands, all of which load because baseOptions sets settingSources. Read HERE
                // rather than before the stream on purpose: supportedCommands() awaits the SDK's initialize
                // response, and `init` is proof that response already landed, so it resolves immediately. Asked
                // any earlier, a CLI that dies during startup would hang the turn on a promise that never
                // settles instead of surfacing as the stream error it is.
                const commands = await session.supportedCommands?.().catch(() => undefined);
                if (commands !== undefined && commands.length > 0) {
                    yield commandFrame(commands);
                }
            } else if (message.subtype === "status") {
                // `status` carries the CURRENT mode when it knows it — the backstop that catches any mode move
                // the two signals above miss (a hook, a settings default, a /mode-style slash command).
                const changed = modeChange(message.permissionMode as PermissionMode);
                if (changed !== undefined) {
                    yield changed;
                }
            } else if (message.subtype === "commands_changed") {
                // A mid-session republish of the WHOLE list (skills discovered as the agent works in a
                // subdirectory, a reloaded plugin). The SDK's contract is replace-wholesale, which is exactly
                // what this frame means to the client — supportedCommands() is captured at initialize and
                // never reflects these, so re-asking it would return the stale init list.
                yield commandFrame(message.commands);
            } else if (message.subtype === "compact_boundary") {
                const meta = message.compact_metadata;
                yield {
                    kind: "compact",
                    trigger: meta.trigger,
                    preTokens: meta.pre_tokens,
                    ...(meta.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
                };
            } else if (message.subtype === "local_command_output") {
                /* What a slash command the CLI answers ITSELF produced — no model request ran, so none of the
                 * frames above carry it. Dropping it (which this did) made every such command look broken: the
                 * turn ends with the composer's own echo and nothing else, whatever the command actually said.
                 *
                 * The unknown-command case is the one that costs the user their words: the CLI claims a leading
                 * `/`, finds no such command, and discards the REST of the message — the model never sees it.
                 * turn-plan.ts stops that before it happens whenever the command list is known; this is the
                 * backstop for when it isn't (a daemon that has run no turn yet), so it carries a code the
                 * client can act on rather than a line of red text the user has to read and re-type around. */
                const output = localCommandText(message.content);
                const unknown = unknownCommandName(output);
                yield unknown !== undefined
                    ? {
                          kind: "error",
                          code: "unknown-command",
                          message: `\`/${unknown}\` isn't a command this agent has, so it read your message as one and dropped the rest.`,
                      }
                    : { kind: "delta", text: output, ...withParent };
                if (unknown === undefined) {
                    yield { kind: "text_end", ...withParent };
                }
            } else if (message.subtype === "api_retry") {
                /* A spent allowance is not an outage to ride out in a live process. The SDK names it directly
                 * and sets its retry delay to the closed window's remaining lifetime; turn that into the same
                 * terminal rate_limit frame as an assistant refusal, carrying the reset instant so the daemon's
                 * existing resume scheduler can park the turn and bring its session back after the reset. Aside
                 * from telling the truth, this frees the conversation's live-run lock instead of leaving a CLI
                 * spinner attached to it for minutes or hours. Returning closes the SDK iterator in sdkTurns'
                 * finally; runAgent then supplies the ordinary terminal done frame. */
                if (message.error === "rate_limit") {
                    /* WHEN THE SPENT WINDOW REOPENS, from the only party that knows — and on this path only one
                     * of the two ever does. A NATIVE Claude turn's harness sets its retry delay to the closed
                     * window's remaining lifetime, so the delay IS the reset and arithmetic on it is exact. On a
                     * routed turn it is nothing of the sort: the delay is the SDK's own 620ms-and-doubling
                     * backoff, and turning that into an instant is what produced "Resets 5:32 PM" for a Google
                     * weekly quota five days out. So it is offered on the native path and withheld on the routed
                     * one, where the recorded quota answers instead — and may name no instant at all, which the
                     * client renders as a plain notice. That is the truth; an invented clock time is not. */
                    yield await rateLimitFrame(
                        allowance,
                        allowance === undefined ? Math.ceil((Date.now() + message.retry_delay_ms) / 1000) : undefined,
                    );
                    return;
                }
                /* Every other retry is still happening INSIDE this turn, so nothing has failed yet and there is
                 * nothing in the transcript to write. Forwarded because the retry budget is deliberately long
                 * (CLAUDE_CODE_RETRY_WATCHDOG in harness-credentials.ts): without this status a turn riding out
                 * an outage is indistinguishable from one that hung. */
                yield {
                    kind: "provider_retry",
                    attempt: message.attempt,
                    maxAttempts: message.max_retries,
                    nextAttemptAt: Date.now() + message.retry_delay_ms,
                    ...(message.error_status !== null ? { status: message.error_status } : {}),
                };
                /* THE SDK'S SUBAGENT LIFECYCLE — the four messages that used to be dropped here for having "no UI
                 * mapping". They are the only account of a child between its tool_use and its result: what it is,
                 * what it is spending, what it is doing right now, whether it finished or failed. Which for a
                 * BACKGROUNDED child (the Agent tool's default) is the entire account, because its result may not
                 * land for minutes. The registry owns the fold; this only forwards what came back. */
            } else if (subagents !== undefined && message.subtype.startsWith("task_")) {
                const frame = noteSubagentTask(subagents, message as SubagentTaskMessage);
                if (frame !== undefined) {
                    yield frame;
                }
            }
        } else if (message.type === "rate_limit_event") {
            // Claude subscription usage for the turn: which window is active, how much of it is spent, and when
            // it resets. The SDK reports it on the stream at no token cost — we'd otherwise drop it below. Only
            // Claude turns emit it (Codex/Grok have no equivalent).
            const info = message.rate_limit_info;
            yield {
                kind: "rate_limit_info",
                status: info.status,
                ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
                ...(info.rateLimitType !== undefined ? { rateLimitType: info.rateLimitType } : {}),
                ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
            };
        } else if (message.type === "result") {
            // Only surface accounting when the SDK actually reported it (real turns always do; the empty
            // frame would be noise).
            if (message.usage !== undefined || message.total_cost_usd !== undefined) {
                yield {
                    kind: "usage",
                    ...(message.total_cost_usd !== undefined ? { costUsd: message.total_cost_usd } : {}),
                    ...(message.usage?.input_tokens !== undefined ? { inputTokens: message.usage.input_tokens } : {}),
                    ...(message.usage?.output_tokens !== undefined ? { outputTokens: message.usage.output_tokens } : {}),
                    ...(message.usage?.cache_read_input_tokens !== undefined ? { cacheReadTokens: message.usage.cache_read_input_tokens } : {}),
                    ...(message.usage?.cache_creation_input_tokens !== undefined
                        ? { cacheCreationTokens: message.usage.cache_creation_input_tokens }
                        : {}),
                    ...(message.duration_ms !== undefined ? { durationMs: message.duration_ms } : {}),
                    ...(message.num_turns !== undefined ? { numTurns: message.num_turns } : {}),
                };
            }
            // Context-window fill: pair the latest message_start input size with the model's window (a static
            // per-model constant carried on the result). Key by the turn's model, fall back to the sole entry.
            if (contextTokens !== undefined) {
                const window =
                    (contextModel !== undefined ? message.modelUsage[contextModel]?.contextWindow : undefined) ??
                    Object.values(message.modelUsage)[0]?.contextWindow;
                if (window !== undefined && window > 0) {
                    yield { kind: "context_usage", tokens: contextTokens, contextWindow: window };
                }
            }
            // The settled answer on speed. Usually a no-op — `init` already said it and nothing moved — but it
            // is the frame that catches a turn dropped into cooldown partway through, and the one that replaces
            // an init-time `pending` with the real reason.
            const speed = fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
            if (speed !== undefined) {
                yield speed;
            }
            if (message.subtype !== "success") {
                yield { kind: "error", message: `agent did not complete (${message.subtype})` };
            }
            // The account's headroom, re-read now that the turn has settled — the freshest this account's
            // limits get without spending anything to find out. After the result frames on purpose: the read
            // is a network round trip, and nothing about it should sit between the user and the answer they
            // were waiting for. An empty read (no pools reported, a failed request) yields no frame at all
            // rather than an empty window list, which would read as "measured, and you have no limits".
            const windows = readUsage === undefined ? [] : await readUsage();
            if (windows.length > 0) {
                yield { kind: "account_usage", windows };
            }
            // NOT the end of the stream: sdkTurns owns the turn boundary — a steered stream can carry a
            // follow-up turn after this result, whose frames keep flowing through the same cases above.
        }
        // Any other SDK message type (hook / task / plugin / status / …) has no UI mapping — dropped, as
        // before. New high-value types earn a dedicated frame above; the rest stay silent rather than noisy.
    }
}

// Render the user's question picks (or a dismissal) as the `ask` tool's text result. A dismissal is not a
// quieter answer: the client stops the turn on it (and the stand-in an aborted turn settles with lands here
// too), so this text is read on the NEXT turn, where "proceed on defaults" would be an instruction to resume
// work the user just pulled the plug on.
const formatAnswers = (questions: AskQuestion[], reply: Extract<AgentReply, { kind: "question" }>): string => {
    if (reply.cancelled || reply.answers === undefined) {
        return "The user dismissed the questions without answering and stopped the turn. STOP what you are doing and wait for them to say how to proceed.";
    }
    const answers = reply.answers;
    const lines = questions.map((q) => {
        const picks = answers[q.question] ?? [];
        return `- ${q.header || q.question}: ${picks.length > 0 ? picks.join(", ") : "(no answer)"}`;
    });
    return `The user answered:\n${lines.join("\n")}`;
};

/* What a rebase taken under a parked card produces: the frames that say where the turn is standing and what it
 * was just told, and the note that tells the model its reads went stale. Built by the route, which owns the git —
 * this module only decides when to ask for it and where the halves go.
 *
 * `frames` rather than one, because the news has two audiences and telling only the model is what this used to
 * do. The worktree frame gives the reader a summary line; the preamble frame carries the note itself, so the
 * words the model is acting on are a click away instead of nowhere. */
export interface ParkedSync {
    readonly frames: readonly AgentEvent[];
    readonly note: string;
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
 * ways nobody sees — files swapped mid-read, and a half-written one swept into the commit the rebase takes
 * first. Two writers can outlive the card and they are asked about separately because they are separately
 * invisible: a command still running in the turn's shell (agent-terminals.ts — a background job, a build, a
 * pane the user is typing in), and a subagent, which does its own editing and answers to nothing here. Either
 * one skips the sync: the branch stays where it is, which is exactly where it would have stayed if the agent
 * had never asked.
 *
 * The frame goes to the transcript at the point it happened; the note is returned for the caller to fold into
 * whatever text the model reads next, so the news arrives in the same breath as the answer rather than as a
 * separate turn nobody prompted. */
const syncOnAnswer = async (
    request: AgentRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
    answered: boolean,
): Promise<string | undefined> => {
    if (!answered || request.resync === undefined) {
        return undefined;
    }
    if (request.conversationId !== undefined && subagentCountsOf(request.conversationId).running > 0) {
        return undefined;
    }
    if (shell.sessionId !== undefined && (await agentShellBusy(shell.sessionId))) {
        return undefined;
    }
    /* THE ANSWER OUTRANKS THE REBASE, so a fault in it cannot reach the card. The user has already clicked;
     * a throw from here would come back to them as a failed question or a plan approval that did not take —
     * losing the one thing this whole exchange was for, to report a branch that simply stayed where it was.
     *
     * Silent because it is not silent where it happens: the implementation this calls owns the git and logs
     * its own faults (agent.routes.ts). This is the harness refusing to let a side channel it does not own
     * take down the card, not a swallowed error nobody will ever see. */
    const synced = await request.resync().catch(() => undefined);
    if (synced === undefined) {
        return undefined;
    }
    for (const frame of synced.frames) {
        push(frame);
    }
    return synced.note;
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
 * default. The literal "off" — the master toggle — turns the filter off outright, which is the only thing that
 * can: every other value here selects WHICH cleaners run, not WHETHER any do. */
const cleanerEnv = (request: AgentRequest): Record<string, string> => {
    if (request.outputCleaners === "off") {
        return { INTENTIC_RUN_FILTER: "0" };
    }
    return {
        ...(request.outputCleaners !== undefined && request.outputCleaners !== "" ? { INTENTIC_OUTPUT_CLEANERS: request.outputCleaners } : {}),
        ...(request.outputHoldout !== undefined && request.outputHoldout > 0 ? { INTENTIC_OUTPUT_HOLDOUT: String(request.outputHoldout) } : {}),
    };
};

/* The delegation ceilings, in the harness's own vocabulary — the three env vars the CLI reads before it lets an
 * Agent tool call through, and the ONLY way to move them: they are read inside the CLI process, not passed as
 * options, and each refusal it raises names the variable for the user to raise ("ask them to increase
 * CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"). Which is what makes this worth a setting rather than a container env:
 * the agent's own escalation path used to end at a file the user cannot edit from the app.
 *
 * An absent field emits nothing, so the CLI's default answers — see the request fields for why that is not the
 * same as sending today's default back to it. */
const subagentEnv = (request: AgentRequest): Record<string, string> => ({
    ...(request.subagentsAtOnce !== undefined ? { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(request.subagentsAtOnce) } : {}),
    ...(request.subagentsPerTurn !== undefined ? { CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: String(request.subagentsPerTurn) } : {}),
    ...(request.subagentDepth !== undefined ? { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(request.subagentDepth) } : {}),
});

// Combine hook sets, CONCATENATING the matchers registered for the same event. A plain object spread would
// have the last contributor silently win the key — two producers of PreToolUse:Bash (the tmux wrapper and the
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

// The two built-ins that are a conversation with the USER rather than an action on the workspace — which is
// why an unattended turn cannot have them.
const PLAN_TOOLS = ["EnterPlanMode", "ExitPlanMode"];

// Tools removed from the model's context: the caller's own list (hashlineEdits drops the native Edit/Write),
// plus — on an unattended turn — the plan tools, which would park the turn on an approval nobody can give.
const disallowedToolsOf = (request: AgentRequest): string[] => [
    ...(request.disallowedTools ?? []),
    ...(request.unattended === true ? PLAN_TOOLS : []),
];

/* The CLI's mid-turn credential recovery. On a 401 it raises an `oauth_token_refresh` control request; the SDK
 * answers it from this callback and the turn RESUMES on the returned token instead of dying. Without it the
 * subscription token is a snapshot taken at spawn: a turn outliving its token — or caught by an account-wide
 * revocation, which kills tokens that still look valid — fails outright, mid-work, with
 * "Failed to authenticate. API Error: 401 ...". That is the difference between this harness and the VSCode
 * extension, which owns the whole credential (refresh token included) and re-mints it in place.
 *
 * Declared here because `@anthropic-ai/claude-agent-sdk@0.3.220` implements the option in sdk.mjs (it is
 * destructured alongside `canUseTool` and gates `hasBidirectionalNeeds`) but omits it from sdk.d.ts. Returning
 * the SAME token the CLI already holds is how we say "no refresh available"; it detects that and stops. */
/* The SDK's spawn seam, used for what it was built for — running the CLI somewhere other than plainly here.
 * The command and args are handed straight through; only the namespace they land in changes, because
 * `nsenter` execs the CLI into the turn's anchor (isolation.ts) rather than supervising it. So the SDK still
 * owns a direct child: its stdio pipes, its exit code, and the SIGTERM it sends on abort all reach the real
 * CLI.
 *
 * `cwd` comes from the anchor, not from `options`: it is the workspace root as the namespace sees it, which
 * inside IS the worktree. A failure here is a failed turn rather than a silent fall back to the shared tree —
 * an agent that quietly gets the main checkout is the exact bug this whole path exists to prevent. */
const namespacedSpawn =
    (anchor: IsolationAnchor) =>
    (options: SpawnOptions): SpawnedProcess => {
        const { command, args } = nsenterArgv(anchor.pid, anchor.cwd, options.command, options.args);
        return spawn(command, args, {
            env: options.env,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            stdio: ["pipe", "pipe", "pipe"],
        });
    };

export type OauthRecoveryOptions = Options & {
    getOAuthToken?: (context: { readonly signal: AbortSignal }) => Promise<string | undefined>;
};

// The two reasoning knobs, together — because the API refuses one combination of them and the picker's filter
// (effortAllowed) only covers turns that came from the picker. sendableEffort holds the rule and the reason.
const reasoningOptions = (request: AgentRequest): { effort?: EffortLevel; thinking?: { type: "adaptive" | "disabled" } } => {
    const effort = sendableEffort(request.effort, request.thinking);
    return {
        ...(effort !== undefined ? { effort: effort as EffortLevel } : {}),
        ...(request.thinking !== undefined ? { thinking: { type: request.thinking ? "adaptive" : "disabled" } } : {}),
    };
};

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
    // gate is the one that needs to — its whole point is holding a command in the posture where canUseTool is
    // never called at all.
    push: (event: AgentEvent) => void,
): OauthRecoveryOptions => ({
    cwd: request.cwd,
    // Only for a native Claude turn on a sandbox-owned credential: a translator endpoint authenticates with its
    // own bearer, and the container-env fallback has no refresh token behind it to mint from.
    ...(request.baseUrl === undefined && request.refreshOauthToken !== undefined ? { getOAuthToken: request.refreshOauthToken } : {}),
    includePartialMessages: true,
    // Forward a subagent's own prose and thinking, not just its tool calls. Without it a child's transcript is a
    // list of tool rows with no narration — enough for the parent's card (whose report arrives as the tool's
    // result anyway) and nowhere near enough for the Subagents area, which renders the child as a conversation.
    forwardSubagentText: true,
    permissionMode,
    ...(request.allowedTools !== undefined ? { allowedTools: [...request.allowedTools] } : {}),
    abortController,
    // Claude Code's coding-tuned preset plus this harness's own guidance — or, when the owner has written a
    // system prompt of their own, that text alone (system-prompt.ts owns the choice and everything it drops).
    // The preset matters because the Agent SDK sends an EMPTY system prompt when this is omitted, which is the
    // main reason a bare SDK turn feels weaker at coding than the CLI/VSCode product.
    systemPrompt: sdkSystemPrompt({
        mode: request.systemPromptMode ?? "intentic",
        custom: request.systemPrompt,
        append: request.systemAppend,
        unattended: request.unattended === true,
        browserOutputDir: request.browserOutputDir,
    }),
    // Load the workspace's .claude/ config: CLAUDE.md memory, skills, subagents (.claude/agents), settings,
    // hooks, and .mcp.json — plus the user tier. The SDK default is [] (loads nothing), so every filesystem
    // capability was invisible until now. New skills/subagents/hooks then arrive as files, no code change.
    settingSources: ["user", "project"],
    /* THE FAST-MODE OPT-IN. Fast mode is off for an SDK consumer until it asks — the harness reports exactly
     * that as `sdk_opt_in_required` — and this inline `settings` object is the ask. It lands in the harness's
     * "flag settings" layer, above the user/project files loaded by settingSources and below managed policy, so
     * a workspace that pins its own answer in .claude/settings.json is overridden for this turn and an
     * IT-managed policy still wins. Everything else about fast mode (which plans have it, which models offer
     * it, whether the pool is in cooldown) stays the harness's to decide — this only says the consumer is
     * willing.
     *
     * `fastModePerSessionOptIn` is the load-bearing half. Without it the harness PERSISTS the choice to the
     * settings file, and the sandbox's user tier is shared by every conversation in the container — so one
     * chat's toggle would silently start billing every other chat, and every automation and doorbell turn, at
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
        // ANTHROPIC_BASE_URL default. Shared with the quick-model one-shot — see harnessEnv.
        ...harnessEnv(request),
        // The output-cleaner spec/holdout (or the filter-off flag) that the agent's Bash → tmux-run → agent-output-filter reads.
        ...cleanerEnv(request),
        // How much this turn may delegate — only the ceilings the owner moved off the harness's own defaults.
        ...subagentEnv(request),
        // Where bin/tmux-run must stand to talk to tmux, so the server it may have to START is the daemon's
        // and not this turn's (isolation.ts). Only for an anchored turn — the only one whose wrapper runs
        // inside a namespace at all.
        ...(request.isolation?.anchor !== undefined ? { [TMUX_NS_ENV]: daemonMountNs } : {}),
        /* Whose work this is, for the sweep that reclaims what a turn leaves behind (platform/leftovers.ts).
         * The CLI's MCP servers and their browsers inherit this without knowing it exists, which is the whole
         * reason it is an env var: nothing below the CLI is ours to hold a handle on. A turn with no
         * conversation behind it (the bench) is left unstamped rather than given a made-up owner — the sweep
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
        request.commandRules !== undefined && Object.keys(request.commandRules).length > 0
            ? commandGateHooks({
                  rules: request.commandRules,
                  unattended: request.unattended === true,
                  push,
                  signal: request.signal,
              })
            : {},
        tmuxEnabled ? bashTmuxHooks(Object.keys(request.cliEnv ?? {}), request.isolation) : {},
        installSteeringHooks(),
        // The outbound sniffer's enforcing half: classified provider calls (a discord curl) are checked against
        // the owner's action rules BEFORE they run — and hooks fire even under bypassPermissions, which is what
        // makes this hold for unattended automation turns. No rules ⇒ no hook (turn-plan forwards none).
        request.actionRules !== undefined && Object.keys(request.actionRules).length > 0 ? outboundGateHooks(request.actionRules) : {},
        /* The `turn.ending` moment: every rule the owner has standing where a turn tries to finish — the proof
         * ledger's follow-up, a standing instruction, a command that has to pass first. No rule ⇒ nothing is
         * wired, so a workspace that has never opened this pays nothing for it. */
        turnEndingHooks(request.turnEndingRules ?? [], {
            isolation: request.isolation?.plan,
            runCommand: request.runRuleCommand,
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
        // Browser, the other half: a browser tool call is the moment the agent's Chromium becomes real, so it
        // is where the watchable session is registered. The hook only names what already exists — the browser
        // is the MCP's to launch and to kill (browser/browser-sessions.ts).
        request.browserPorts !== undefined ? browserSessionHooks(request.browserPorts, request.browserPasskeys ?? {}) : {},
        // Subagents, the same way: the ids a child's transcript is READ with are only ever named to a hook, so
        // this pair is what makes the Subagents area's door open on anything (agent/subagents.ts). Pure
        // record-keeping — the card already learned the child exists from the task stream.
        subagents !== undefined ? subagentHooks(subagents) : {},
        // Handed the turn's placement whole, because where the check STANDS is the difference between an answer
        // and a fiction: an anchored turn's dependencies exist only inside its namespace, so the check is placed
        // in there and speaks the agent's own paths (agent-diagnostics.ts).
        editDiagnosticsHooks(request.cwd, request.isolation),
    ),
    // Enter the namespace by wrapping the CLI's own spawn: the agent process (and everything it forks) is born
    // inside it, so there is no window in which the turn can see the shared tree.
    ...(request.isolation?.anchor !== undefined ? { spawnClaudeCodeProcess: namespacedSpawn(request.isolation.anchor) } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.sessionId !== undefined ? { resume: request.sessionId } : {}),
    ...(request.plugins !== undefined ? { plugins: request.plugins.map((path) => ({ type: "local" as const, path })) } : {}),
    ...reasoningOptions(request),
    ...(disallowedToolsOf(request).length > 0 ? { disallowedTools: disallowedToolsOf(request) } : {}),
});

// The `ask` tool behind AskUserQuestion. It is an SDK MCP tool rather than the built-in of the same name
// because the built-in renders its own picker inside the CLI — headless, that UI has nowhere to go. Aliasing
// the built-in NAME onto this tool (see toolAliases below) keeps the model's trained call site working while
// the answer round-trips through our own card. `alwaysLoad` keeps it in the prompt instead of behind tool
// search: a tool the model has to go looking for is a tool it writes plain-text options instead of using.
const askServer = (
    request: AgentRequest,
    push: (event: AgentEvent) => void,
    shell: { sessionId: string | undefined },
): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: "ui",
        alwaysLoad: true,
        tools: [
            tool(
                "ask",
                'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option — a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
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
                    push({ kind: "question", requestId: id, questions });
                    const { reply, resolved } = await wait(request.signal);
                    // The picks belong in the frame log, not just in this tool result: they are what a replayed
                    // or second-window transcript freezes the card with (see the `resolved` frame).
                    push(resolved);
                    // Then the ground, before the model acts on what it just heard. The note rides the same
                    // tool result as the answer — one thing to read, at the one moment the model is re-deciding
                    // what to do, instead of a second frame it has no reason to look for.
                    const moved = await syncOnAnswer(request, push, shell, !reply.cancelled && reply.answers !== undefined);
                    const text = formatAnswers(questions, reply);
                    return { content: [{ type: "text", text: moved === undefined ? text : `${text}\n\n${moved}` }] };
                },
            ),
        ],
    });

// Tools that must never raise a permission card: asking the user a question, and entering plan mode, are both
// the agent deferring TO the user. Prompting for permission to prompt would be a dead end.
const UNGATED = new Set(["mcp__ui__ask", "AskUserQuestion", "EnterPlanMode"]);

/* The posture EVERY approved plan executes in, whatever the turn started in and whichever client approved it.
 * Approval is the one moment the user has read what the agent intends to do and said yes to all of it, so
 * re-asking per tool afterwards interrupts without adding a decision — the shape this replaces landed a turn
 * that started in plan mode on `acceptEdits`, which auto-accepts edits but still raised a card for every Bash
 * command, so approving a plan bought the user a permission prompt for `git log`.
 *
 * The container is the isolation boundary, exactly as it is for toolWideAllow below. A user who wants per-tool
 * approvals still has them: they are a posture the composer picks for the turn, not a tax on planning. */
const POST_PLAN_MODE: PermissionMode = "bypassPermissions";

// What "always" persists on top of the SDK's own suggestions: allow this TOOL, for the rest of the session.
// The suggestions are narrowly scoped — for Bash they carry the command prefix (`pnpm install:*`), so the next
// command re-asks — which is not what a button reading "Don't ask again for Bash" promises. The container IS
// the isolation boundary here, so the tool-wide grant is the honest reading of the button. Session-scoped: a
// settings-file rule would be written into a throwaway worktree nobody reads twice.
const toolWideAllow = (toolName: string): PermissionUpdate => ({
    type: "addRules",
    rules: [{ toolName }],
    behavior: "allow",
    destination: "session",
});

// A workspace-root-relative path for the permission card, matching the tree/file route space the rest of the
// UI uses. A path outside the workspace (rare — an additionalDirectories read) stays absolute.
const relativePath = (absolute: string | undefined, cwd: string): string | undefined => {
    if (absolute === undefined || absolute === "") {
        return undefined;
    }
    const rel = relative(cwd, absolute);
    return rel === "" || rel.startsWith("..") ? absolute : rel.split(sep).join("/");
};

// Every permission decision the turn needs from the user, as the SDK's canUseTool. The SDK only calls this
// when the active mode actually requires a prompt (bypassPermissions never does; acceptEdits skips edits;
// default skips reads), so there is no mode branching here — if we were called, the user is the decider.
const permissionGate =
    (request: AgentRequest, push: (event: AgentEvent) => void, shell: { sessionId: string | undefined }): CanUseTool =>
    async (toolName, input, options) => {
        // Nobody can answer, so refuse rather than park: a card raised here would hang the turn until its
        // timeout, which reads as the agent freezing rather than as a decision nobody was there to make.
        if (request.unattended === true) {
            return { behavior: "deny", message: `${toolName} needs a person to answer, and this turn is running unattended. Proceed another way.` };
        }
        if (toolName === "ExitPlanMode") {
            const { id, wait } = createRequest("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
            push({ kind: "plan", requestId: id, text: String((input as { plan?: unknown }).plan ?? "") });
            const { reply, resolved } = await wait(request.signal);
            push(resolved);
            if (!reply.approve) {
                return { behavior: "deny", message: reply.feedback?.trim() || "Keep refining the plan — do not exit plan mode yet." };
            }
            // Setting the mode on the session is what actually moves the SDK out of plan mode.
            push({ kind: "mode", mode: POST_PLAN_MODE });
            /* Then the ground, before the agent starts building on a plan it wrote against an older tree —
             * the longest park of the three cards, and the one followed by the most writing.
             *
             * An approved plan has no text channel back to the model: `allow` carries a decision, not a
             * sentence. So the note rides the steering queue, the same road /agent/steer uses to tell a
             * running turn something, wrapped as a preamble over an empty message — that is what makes a
             * restored transcript DROP it rather than redraw the daemon's words as the user's
             * (turn-preamble.ts, and both restore paths already skip a message that strips to nothing). The
             * cost is the one grace window a delivered steer arms at the end of the turn. */
            const moved = await syncOnAnswer(request, push, shell, true);
            if (moved !== undefined) {
                request.steering?.push(withTurnPreamble([moved], ""));
            }
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
        const { id, wait } = createRequest("permission", {
            kind: "permission",
            requestId: "",
            decision: "deny",
            feedback: "The turn was cancelled before you answered.",
        });
        // The bridge already rendered the prompt sentence, the button noun, and the reason — pass them
        // through rather than re-deriving worse copy from the raw tool name and input.
        const suggestions = options.suggestions ?? [];
        const path = relativePath(options.blockedPath, request.cwd);
        push({
            kind: "permission",
            requestId: id,
            toolName,
            ...(options.title !== undefined ? { title: options.title } : {}),
            ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
            ...(options.description !== undefined ? { description: options.description } : {}),
            ...(options.decisionReason !== undefined ? { reason: options.decisionReason } : {}),
            ...(path !== undefined ? { path } : {}),
            // Always offered: the tool-wide rule below is a memory we can write for any tool, with or without
            // the SDK suggesting one of its own.
            alwaysLabel: `Don't ask again for ${options.displayName ?? toolName}`,
        });
        const { reply, resolved } = await wait(request.signal);
        push(resolved);
        if (reply.decision === "deny") {
            // A denial carrying feedback is a redirection — the turn runs on and takes it. A bare one is the
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
// of it actually fires is the SDK's call given the turn's mode — which the agent itself can change mid-turn
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
    /* The turn's tmux session, by the id the CLI mints for it — read by the parked cards to ask whether a
     * command is still running before anything rebases under it. Mutable for the same reason the subagent
     * handle is: the ask tool and the permission gate are wired here, before a fresh turn's id exists.
     *
     * Seeded from the RESUMED id rather than left empty, because the session outlives the turn and so do its
     * panes: a background job an earlier turn started is still running in this same session, and it is exactly
     * the writer this gate exists to notice. Empty only on a conversation's first turn, which by definition has
     * no earlier pane to disturb. */
    const shell: { sessionId: string | undefined } = { sessionId: request.sessionId };
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, permissionMode, tmuxEnabled, subagents, push),
        /* Always on, whatever mode the turn STARTS in: the flag legalises bypassPermissions, it does not
         * activate it — `permissionMode` above still decides the posture. Any turn can land in bypass
         * mid-session (an approved plan setModes to POST_PLAN_MODE), and the CLI refuses that switch unless
         * the session was LAUNCHED with the flag — gating it on the starting mode is how an approved plan
         * silently fell to `default` and re-asked for every Bash and Write. */
        allowDangerouslySkipPermissions: true,
        stderr: (data) => {
            stderr += data;
        },
        // The `ui` server backs AskUserQuestion; the agent's remote MCP tools are merged in alongside it (a
        // same-named tool would override `ui`, but `ui` is reserved). An unattended turn gets no `ui`: a
        // question would be asked of a user who is not there, and the turn would wait for them forever.
        mcpServers: {
            ...(request.unattended === true ? {} : { ui: askServer(request, push, shell) }),
            ...request.sdkServers,
            ...mcpServersOf(request.tools ?? []),
        },
        toolAliases: { AskUserQuestion: "mcp__ui__ask" },
        // Our card renders markdown, so option previews should arrive as markdown (the CLI default, pinned
        // here because the web-SDK default is HTML and would render as escaped source in the card).
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
        planModeInstructions:
            "Propose a clear, concise approach for the user's request, then call ExitPlanMode to ask for approval before executing. When you need the user to choose between options, ask with the AskUserQuestion tool rather than writing the choices as plain text.",
        canUseTool: permissionGate(request, push, shell),
    };

    // A turn that authenticated with a stored account's OAuth token can read that plan's limit pools at settle
    // (usage/claude-usage.ts, the same reader the idle sweep uses); translator, endpoint and container-env turns
    // have no pools to read — and no account to file a reading under (agent.routes persists only attributed
    // frames).
    const oauthToken = request.oauthToken;
    const readUsage =
        oauthToken === undefined
            ? undefined
            : (): Promise<UsageWindow[]> => readClaudeUsage(oauthToken, usageFetch).then((reading) => reading.windows);

    // The swallowed-prompt recovery (sdkTurns): the turn's own prompt, pushed back through the steering queue,
    // once. Built here because this is where both halves live — the prompt text and the queue the streaming
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
            for await (const event of streamSdk(
                queryFn,
                promptInput(request),
                options,
                request.cwd,
                tmuxEnabled,
                request.browserOutputDir,
                request.steering,
                redeliver,
                readUsage,
                request.allowance,
                subagents,
            )) {
                // The turn's shell lives under the id this frame carries (agent-terminals.ts names the tmux
                // session after it), so the cards learn it here rather than from a second seam into the stream.
                if (event.kind === "session") {
                    shell.sessionId = event.sessionId;
                }
                push(event);
            }
        } catch (error) {
            push({ kind: "error", message: errorMessage(error, stderr) });
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
