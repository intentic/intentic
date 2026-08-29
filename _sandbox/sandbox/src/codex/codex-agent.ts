import type { AgentEvent, AgentReply, AskQuestion, ToolCallLocation } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import type { AgentRequest } from "../agent/agent.js";
import { splitAttachments, withFileNote } from "../agent/attachment-note.js";
import { unsentParameterFrame } from "../agent/error-frames.js";
import { isUnsentParameterRefusalText } from "../agent/failure-sentences.js";
import { EXECUTE_PROMPT, type ExecutePhase, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import { toolCategoryOf, workspacePath } from "../agent/tool-calls.js";
import { openBrowserSession } from "../browser/browser-sessions.js";
import { ROUTED_BROWSER_SERVER } from "../browser/browser-tools.js";
import { type CommandGate, vendorSubject } from "../guard/command-gate.js";
import { createTurnGate } from "../guard/turn-gate.js";
import {
    type CodexEvent,
    type CodexItem,
    type CodexQuestion,
    type CodexReasoningEffort,
    type CodexRunner,
    type CodexSandboxMode,
    type CodexThreadOptions,
    type CodexTurn,
    createCodexAppServerRunner,
    type JsonValue,
} from "./codex-app-server.js";
import { persistCodexImageArtifact } from "./codex-image-artifacts.js";
import { codexInstructionConfig } from "./codex-instructions.js";
import { CODEX_ADVISORY, CODEX_MODEL_INVALID } from "./codex-models.js";

/* The Codex provider adapter: same seam as agent.ts's runAgent. AgentRequest in, AgentEvent frames out, but
 * backed by the Codex CLI's provider-native app-server instead of the Claude Agent SDK. Provider differences
 * stay inside this file; the wire contract, routes, and UI are shared.
 *
 * App-server publishes whole item completions plus lifecycle, usage, image-generation, and compaction events.
 * Intentic still leaves approval requests disabled: the container is the isolation boundary (the Claude path
 * already runs bypassPermissions for the same reason), and this adapter deliberately declines server requests. */

// Codex app-server's reasoning-effort scale uses "xhigh" where Intentic's shared scale uses "max".
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const reasoningEffort = (effort: string): CodexReasoningEffort | undefined => {
    if (effort === "max") {
        return "xhigh";
    }
    return EFFORT_LEVELS.has(effort) ? (effort as CodexReasoningEffort) : undefined;
};

// process.env with undefined entries dropped, cli-kind capability credentials merged, and CODEX_HOME pinned to
// the workspace-scoped auth/session store. App-server inherits only this explicit environment.
//
// CODEX_API_KEY is NOT inherited: it is the translator bearer, and the only turn entitled to one is the turn that
// resolved a codexEndpoint (which sets it explicitly below). A daemon whose own environment carries a bearer,
// exactly what a sandbox running the translator looks like, would otherwise hand it to native account turns too.
const codexEnv = (codexHome: string, cliEnv: Record<string, string> | undefined): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEX_API_KEY") {
            env[key] = value;
        }
    }
    return { ...env, ...cliEnv, CODEX_HOME: codexHome };
};

// The subscription-served provider block: Codex speaks its own Responses wire format to the translator
// (CLIProxyAPI), which serves it on the connected ChatGPT subscription; auth is the fixed local bearer via
// env_key (never a rotating OAuth token, so nothing races the translator's own refresh loop).
// supports_websockets=false is required: the translator's inbound is plain POST SSE, and without it Codex
// burns five WebSocket connect retries per turn before falling back.
// One turn's provider block with its instruction and MCP keys folded in. Kept here rather than inlined so the
// merge order is stated once: the two sets never share a key, and if one ever does, this is the line that decides.
const withRuntimeConfig = (
    provider: Pick<CodexTurn, "modelProvider" | "config">,
    instructions: Record<string, JsonValue>,
): Pick<CodexTurn, "modelProvider" | "config"> => ({ ...provider, config: { ...instructions, ...provider.config } });

// What every turn of one run carries identically: the environment, the provider block, and the mount namespace
// its app-server is born in. Only the prompt, the sandbox mode and the session id differ between them.
type CodexTurnBase = Pick<CodexTurn, "env" | "modelProvider" | "config" | "namespace">;

/* App-server reads the same MCP tables as the Codex CLI. Intentic's browser layer already produces stdio
 * server specs for the Claude Agent SDK, so project those process fields into Codex's per-thread config rather
 * than starting a second browser stack. SDK-instance servers are deliberately skipped: they are live objects
 * in this daemon, not processes app-server can spawn, which is why the Codex capability row claims browser MCP
 * rather than the full harness ceiling.
 *
 * Only environment DELTAS ride the config. Browser specs carry a snapshot of process.env because the Claude
 * SDK starts their children itself; app-server already inherits that same turn environment, and serialising it
 * again would put every unrelated credential into the thread config. The one browser value that really differs
 * (DISPLAY for a headed, eager server) remains. */
const codexMcpConfig = (servers: AgentRequest["sdkServers"], inheritedEnv: Readonly<Record<string, string>>): Record<string, JsonValue> => {
    const config: Record<string, JsonValue> = {};
    for (const [name, server] of Object.entries(servers ?? {})) {
        if (server.type !== undefined && server.type !== "stdio") {
            continue;
        }
        const env =
            server.env === undefined
                ? undefined
                : Object.fromEntries(Object.entries(server.env).filter(([key, value]) => inheritedEnv[key] !== value));
        config[`mcp_servers.${name}`] = {
            command: server.command,
            ...(server.args === undefined ? {} : { args: server.args }),
            ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
            ...(server.timeout === undefined ? {} : { tool_timeout_sec: Math.ceil(server.timeout / 1_000) }),
        };
    }
    return config;
};

const translatorProvider = (baseUrl: string): Pick<CodexTurn, "modelProvider" | "config"> => ({
    modelProvider: "translator",
    config: {
        "model_providers.translator": {
            name: "translator",
            base_url: `${baseUrl.replace(/\/$/, "")}/v1`,
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            // Codex exposes its image extension to actor-authorized proxies. This fixed, non-secret marker only
            // reaches the loopback translator: pinned CLIProxyAPI deliberately rebuilds the upstream header set,
            // drops it, and authenticates /images/* from its own ChatGPT subscription credential instead.
            http_headers: { "x-openai-actor-authorization": "intentic" },
            supports_websockets: false,
        },
    },
});

/* THE QUESTION TOOL, DECIDED EXPLICITLY ON EVERY TURN. `tools.experimental_request_user_input` is a TABLE, and
 * `enabled` inside it is the flag Codex reads before it will offer the model any way to ask a person something.
 * The bare boolean this key once took is now a config-load FAILURE ("invalid type: boolean `true`, expected
 * struct ExperimentalRequestUserInput"), which killed a turn before its first token. On for an ordinary turn
 * because the adapter answers the request it produces (`item/tool/requestUserInput` → a question card → the
 * picks, back on the same request).
 *
 * OFF, AND SAID SO, FOR AN UNATTENDED TURN, for the reason the Claude Code loop withholds its own ask tool: a
 * benchmark, a schedule or another program started this turn, so a card is not merely useless but a DEADLOCK, it
 * parks the turn on an answer that can never arrive and burns until something aborts it. Written out rather than
 * left off, because Codex registers this tool when the table is ABSENT: saying nothing now means asking. */
const questionToolConfig = (request: AgentRequest): Readonly<Record<string, JsonValue>> => ({
    "tools.experimental_request_user_input.enabled": request.unattended !== true,
});

/* THE CARD A CODEX QUESTION BECOMES. Single-pick always: Codex's questions carry no multi-select flag, and the
 * free-text answer every card already offers covers its `isOther` case without a field of ours. A question that
 * arrives with no options is asked as the open one it is.
 *
 * WHAT IS NOT PUT ON A CARD is the secret one. A card's answers are recorded on purpose, the frame log a second
 * window replays, the journal a restarted daemon restores a parked turn from, so a password typed into one is a
 * password written down in three places. The refusal names the road this runtime really has instead: a connected
 * credential is already in the turn's environment (planCodexTurn's cliEnv), and the reference language the
 * Claude Code loop's shell hook resolves is deliberately NOT claimed here, because nothing in app-server's shell
 * would substitute it. */
const askQuestion = (question: CodexQuestion): AskQuestion => ({
    question: question.question,
    header: question.header,
    multiSelect: false,
    options: question.options.map((option) => ({ label: option.label, description: option.description })),
});

const SECRET_REFUSED =
    "This client does not collect secrets on a question card, because a card's answers are recorded. " +
    "A credential the owner has connected is already in this turn's environment: read it from there, " +
    "or say which connection is missing and stop rather than asking anyone to paste one.";

const QUESTIONS_DISMISSED = "The user dismissed the questions without answering and stopped the turn.";

// One answer per question id, in the shape app-server's request is waiting for. A secret question is refused
// with the sentence above whatever the user did; a dismissal answers every question with the same, because Codex
// is blocked on this reply and a turn about to be aborted must not leave it holding the line.
const codexAnswers = (questions: readonly CodexQuestion[], reply: Extract<AgentReply, { kind: "question" }>): Record<string, readonly string[]> =>
    Object.fromEntries(
        questions.map((question) => {
            if (question.secret) {
                return [question.id, [SECRET_REFUSED]];
            }
            if (reply.cancelled || reply.answers === undefined) {
                return [question.id, [QUESTIONS_DISMISSED]];
            }
            return [question.id, reply.answers[question.question] ?? []];
        }),
    );

/* ONE CONSUMER FOR THE TURN'S STEERING QUEUE, LENT OUT ONE PHASE AT A TIME.
 *
 * The daemon's queue belongs to the whole turn (agent-steering.ts), but a Codex plan turn is TWO app-servers with
 * a person's approval in between. Letting both phases pull from the queue directly loses exactly the message that
 * matters most: one typed while the plan is being read wakes the phase that has already closed, which delivers it
 * to a dead socket and swallows the refusal.
 *
 * So the queue is drained here, once, and what arrives while no phase is listening waits. Each phase borrows a
 * channel that ends when its stream does, and the next one starts by draining what the pause collected. One
 * channel is open at a time, the phases are sequential, which is what lets a single wake handle do. */
interface SteeringChannel {
    readonly steering: AsyncIterable<string>;
    readonly close: () => void;
}

const steeringRelay = (queue: AsyncIterable<string>): (() => SteeringChannel) => {
    const waiting: string[] = [];
    let wake: (() => void) | undefined;
    let drained = false;
    void (async () => {
        for await (const text of queue) {
            waiting.push(text);
            wake?.();
        }
        drained = true;
        wake?.();
    })();
    return () => {
        let closed = false;
        return {
            steering: {
                async *[Symbol.asyncIterator](): AsyncGenerator<string> {
                    for (;;) {
                        // A message still waiting when the phase closes stays in the relay: it belongs to the
                        // next phase, not to the app-server that is already shutting down.
                        if (closed) {
                            return;
                        }
                        const next = waiting.shift();
                        if (next !== undefined) {
                            yield next;
                            continue;
                        }
                        if (drained) {
                            return;
                        }
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                        wake = undefined;
                    }
                },
            },
            close: () => {
                closed = true;
                wake?.();
            },
        };
    };
};

const threadOptions = (request: AgentRequest, sandboxMode: CodexSandboxMode, gated: boolean): CodexThreadOptions => {
    const effort = request.effort !== undefined ? reasoningEffort(request.effort) : undefined;
    return {
        workingDirectory: request.cwd,
        sandboxMode,
        /* The container is the isolation boundary, so the standing posture is that Codex asks nothing, exactly
         * as it always did. `gated` flips it when the owner's command rulebook has something it could refuse
         * (or the turn is carrying somebody else's words): then Codex raises an approval per command and the
         * gate answers from the same decide fn a Claude turn uses. */
        approvalPolicy: gated ? "untrusted" : "never",
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(effort !== undefined ? { modelReasoningEffort: effort } : {}),
    };
};

// Flatten an MCP result's content blocks to plain text, like agent.ts's resultText.
const mcpResultText = (item: Extract<CodexItem, { type: "mcp_tool_call" }>): string => {
    if (item.error !== undefined) {
        return item.error.message;
    }
    const content = item.result?.content;
    if (!Array.isArray(content)) {
        return "";
    }
    return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("");
};

/* Codex's IN-TURN stream retry, which arrives on the same error channels a real failure does. The CLI lost the
 * response stream mid-turn, is reconnecting, and the turn carries on from where it was, the message is
 * `Reconnecting... <attempt>/<max> (<reason>)`, minted by codex's own retry loop (core/src/responses_retry.rs)
 * and forwarded with `will_retry: true`, which its JSONL surface then drops.
 *
 * Read as a failure it painted a red error line under a turn that answered normally four minutes later, wrote a
 * turn.error into the activity log, reddened the agent's card on the fleet board, and, in plan mode, would
 * have dropped the plan (plan-emulation abandons an errored phase). It is still worth SAYING, because a turn
 * riding out a dropped socket goes quiet and silence reads as a hang: it says it as the wait it is, on the
 * `provider_retry` frame the Claude path emits for exactly this (agent.ts, api_retry), which takes over the
 * chat's loader line and retires itself on the next frame.
 *
 * No `nextAttemptAt`: codex reports the counters but not its backoff, and the contract makes the instant
 * optional rather than have this guess one. */
const CODEX_STREAM_RETRY = /^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)/;

/* Older Codex builds reported successful auto-compaction as this warning. Current app-server emits the named
 * contextCompaction item handled below; retaining the warning classifier also keeps a warning from reddening a
 * healthy turn when the pinned CLI chooses that channel. */
const CODEX_COMPACTED = /long threads and multiple compactions/i;

/* What a codex error message actually is, when it is not a failure. Both of codex's error channels run through
 * here so a notice reads the same whichever one carries it, the CLI has moved them before (an advisory rides
 * the item channel, a stream retry the top-level event) and the two are one `error` kind by the time they reach
 * us. Undefined ⇒ a real failure, which is every other message. */
const codexNotice = (message: string): AgentEvent | undefined => {
    const retry = CODEX_STREAM_RETRY.exec(message);
    if (retry !== null) {
        return { kind: "provider_retry", attempt: Number(retry[1]), maxAttempts: Number(retry[2]) };
    }
    if (CODEX_COMPACTED.test(message)) {
        return { kind: "compact", trigger: "auto" };
    }
    // An advisory shares this channel with real failures but is not one, the turn answers normally after it. So
    // it must not mark the phase errored: a plan turn that hit one still has a plan to propose (CODEX_ADVISORY).
    return CODEX_ADVISORY.test(message) ? { kind: "error", code: "codex-advisory", message } : undefined;
};

/* WHAT A TERMINAL CODEX FAILURE IS CODED AS, for both channels that can carry one (turn.failed and the
 * top-level error, plus the process-exit wrapper below).
 *
 * The parameter refusal is read FIRST, and the order is the point rather than tidiness. `400
 * prompt_cache_retention is not supported on this model` ends in the words "this model", which is the shape
 * CODEX_MODEL_INVALID exists to catch, and that code has a side effect: the client reloads the catalog and drops
 * the user's pinned model. Filing a provider's own bad default as a bad PICK would therefore punish the pick,
 * fail again on the next model, and leave the user re-choosing a model that was never the problem. The refusal
 * this sandbox never authored is an outage instead, and the turn comes back on the breaker. */
const codexFailureFrame = (event: Extract<AgentEvent, { kind: "error" }>): AgentEvent => {
    if (isUnsentParameterRefusalText(event.message)) {
        return unsentParameterFrame(event.message);
    }
    // Tag a rejected/unusable model so the client reloads the live catalog and drops the bad pinned model,
    // mirroring Grok's grok-model-invalid (OpenAI names no alternatives, so there's nothing to re-prompt with
    // here, the reloaded default serves the next turn).
    return CODEX_MODEL_INVALID.test(event.message) ? { ...event, code: "codex-model-invalid" as const } : event;
};

// What phase-1 of a plan turn holds back: the thread id (to resume for execution) and the trailing
// agent_message (the plan text the user approves).
interface TurnCapture {
    threadId?: string;
    heldMessage?: string;
    // Set when the plan phase hit a terminal error (turn.failed / error / item error), so runCodexPlanTurn
    // suppresses the plan frame, a failed turn must not surface a "plan" even if a message was held first.
    errored?: boolean;
}

interface ImageArtifactContext {
    readonly workspaceRoot: string;
    readonly codexHome: string;
}

interface CodexBrowserContext {
    readonly ports: Readonly<Record<string, number>>;
    readonly passkeys: Readonly<Record<string, string>>;
    // The routed browser server's account→owner map (browser-tools.ts). App-server's tool items carry no
    // arguments, so a routed call can only be attributed when every route lands on the same profile, the
    // single-owner turn, which is the common one (soleRoutedOwner below).
    readonly accounts: Readonly<Record<string, string>>;
    readonly owner?: string;
    // Present on a resumed invocation. A new thread learns its id from thread.started before it can call a tool.
    readonly sessionId?: string;
}

// The one profile a routed call can be pinned to without seeing its arguments, defined only when the turn's
// account map resolves everything to a single owner.
const soleRoutedOwner = (browser: CodexBrowserContext | undefined): string | undefined => {
    const owners = new Set(Object.values(browser?.accounts ?? {}));
    return owners.size === 1 ? [...owners][0] : undefined;
};

// A browser call, tied to the profile whose session it drives, so the pages this turn opens belong to that
// account. `web` names its own profile; the routed server's calls carry the account in arguments the item does
// not echo, so they attach only when the turn holds a single profile anyway. Anything that cannot be named down
// to a profile, a port and a session has nothing to attach and is left alone.
const attachBrowserSession = (
    item: Extract<CodexItem, { type: "mcp_tool_call" }>,
    threadId: string | undefined,
    browser: CodexBrowserContext | undefined,
): void => {
    if (browser === undefined || !item.tool.startsWith("browser_")) {
        return;
    }
    const profile = item.server === ROUTED_BROWSER_SERVER ? soleRoutedOwner(browser) : item.server;
    const port = profile === undefined ? undefined : browser.ports[profile];
    const sessionId = threadId ?? browser.sessionId;
    if (profile === undefined || port === undefined || sessionId === undefined) {
        return;
    }
    openBrowserSession({ sessionId, server: profile, port, passkeyStore: browser.passkeys[profile], owner: browser.owner });
};

// What one Codex turn's stream is normalized AGAINST: where the turn works, where its generated images land, and
// the two things a question card needs, the signal that settles the card if the turn dies first, and the
// conversation a dismissal ends. `holdMessages` is the plan phase's one behavioural difference (see streamTurn).
interface CodexStreamContext {
    readonly cwd: string;
    readonly imageArtifacts: ImageArtifactContext;
    readonly signal: AbortSignal;
    readonly conversationId?: string;
    readonly holdMessages?: boolean;
    readonly browser?: CodexBrowserContext;
    /* The owner's command rulebook for this turn (guard/turn-gate.ts). One gate for the whole turn, so an
     * "always" answered during the plan phase is not asked again while executing. Absent only where a caller
     * builds a context by hand (a bench run), and then Codex was never asked to raise approvals either. */
    readonly gate?: CommandGate;
}

/* A CODEX QUESTION, ON THE CARD THE `ask` TOOL RAISES, the same registry, the same frames, the same dismissal
 * behaviour, so a question reads identically whichever runtime asked it (agent-requests.ts).
 *
 * The stream is PARKED on the await, and that is the point: app-server is blocked on this reply too, so nothing
 * of the turn's can arrive out of order while a person reads the card. The `resolved` frame goes out before the
 * answer travels back, because it is what freezes the card in a replayed transcript.
 *
 * No mid-card rebase (the harness's syncOnAnswer): a Codex turn has no seam to run one from, which is what the
 * resync field's absence on every non-harness runtime already says (turn-plan.ts). */
async function* codexQuestionCard(
    request: Extract<CodexEvent, { type: "user_input.requested" }>,
    context: CodexStreamContext,
): AsyncGenerator<AgentEvent> {
    const asked = request.questions.filter((question) => !question.secret);
    if (asked.length === 0) {
        request.respond(Object.fromEntries(request.questions.map((question) => [question.id, [SECRET_REFUSED]])));
        return;
    }
    const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
    yield { kind: "question", requestId: id, questions: asked.map(askQuestion) };
    const { reply, resolved } = await wait(context.signal);
    yield resolved;
    request.respond(codexAnswers(request.questions, reply));
}

/* ONE COMMAND CODEX ASKED ABOUT, PUT THROUGH THE OWNER'S RULEBOOK, and the reason `commandRules` now means
 * something on this runtime instead of silently nothing.
 *
 * Shaped exactly like codexQuestionCard above, because it is the same trick and it is the only one available:
 * app-server is BLOCKED on this request, so parking here parks the turn, in order, with nothing of the turn's
 * able to arrive while a person reads the card. The gate's own frames (the card, then its resolution) are
 * `yield*`ed straight into this stream.
 *
 * A REFUSAL DECLINES rather than cancels. Codex offers both, and the difference matters: `cancel` interrupts the
 * whole turn, which is not what a refused command means. The agent should hear no and pick something else,
 * exactly as it does when the Claude path's hook denies one call. */
async function* codexCommandApproval(
    request: Extract<CodexEvent, { type: "command_approval.requested" }>,
    context: CodexStreamContext,
): AsyncGenerator<AgentEvent> {
    if (context.gate === undefined) {
        request.respond(true);
        return;
    }
    const outcome = yield* context.gate.consult(request.command, vendorSubject("Bash"));
    request.respond(outcome.allow);
}

// Normalize one Codex turn's provider event stream onto AgentEvents, RETURNING what the turn captured, the
// plan phase reads it off the `yield*` (as runPlanEmulation reads PlanPhaseResult off the phase), an ordinary
// turn discards it. `holdMessages` is the plan phase's one behavioural difference: agent messages are held back
// one-deep, intermediate narration still streams (flushed when the next message arrives), and whatever remains
// held at stream end is the plan text.
async function* streamTurn(events: AsyncIterable<CodexEvent>, context: CodexStreamContext): AsyncGenerator<AgentEvent, TurnCapture> {
    const { cwd, imageArtifacts, browser, holdMessages = false } = context;
    const capture: TurnCapture = {};
    for await (const event of events) {
        if (event.type === "thread.started") {
            capture.threadId = event.thread_id;
            yield { kind: "session", sessionId: event.thread_id };
        } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
            const item = event.item;
            if (item.type === "agent_message") {
                if (event.type !== "item.completed") {
                    continue;
                }
                // Only `item.completed` reaches here, so each delta below is a WHOLE message block, its
                // text_end follows immediately, which retires the client's prose bubble so the tool calls this
                // message introduced render under it instead of being hoisted above the turn's whole narration.
                if (!holdMessages) {
                    yield { kind: "delta", text: item.text };
                    yield { kind: "text_end" };
                    continue;
                }
                // Held one-deep: the message that was being held is flushed the moment a newer one arrives, so
                // narration still streams and only the last message is left held as the plan.
                if (capture.heldMessage !== undefined) {
                    yield { kind: "delta", text: capture.heldMessage };
                    yield { kind: "text_end" };
                }
                capture.heldMessage = item.text;
            } else if (item.type === "reasoning") {
                if (event.type === "item.completed") {
                    yield { kind: "thinking", text: item.text };
                }
            } else if (item.type === "command_execution") {
                if (event.type === "item.started") {
                    yield { kind: "tool_call", id: item.id, name: "Bash", category: "execute", status: "in_progress", target: item.command };
                } else if (event.type === "item.updated") {
                    // Live output: item.updated carries the aggregated output SO FAR as a snapshot, exactly the
                    // update frame's replace semantics, so a long command streams into its card.
                    yield { kind: "tool_call_update", id: item.id, content: [{ type: "text", text: item.aggregated_output }] };
                } else if (event.type === "item.completed") {
                    const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
                    yield {
                        kind: "tool_call_update",
                        id: item.id,
                        status: failed ? "failed" : "completed",
                        content: [{ type: "text", text: item.aggregated_output }],
                    };
                }
            } else if (item.type === "file_change") {
                // Emitted once, on success or failure; the app-server item carries paths but no diff text, so
                // the card shows locations + status only.
                if (event.type === "item.completed") {
                    const locations = item.changes
                        .map((change) => workspacePath(change.path, cwd))
                        .filter((path): path is string => path !== undefined)
                        .map((path): ToolCallLocation => ({ path }));
                    const allDeletes = item.changes.length > 0 && item.changes.every((change) => change.kind === "delete");
                    yield {
                        kind: "tool_call",
                        id: item.id,
                        name: "Edit",
                        category: allDeletes ? "delete" : "edit",
                        status: item.status === "failed" ? "failed" : "completed",
                        target: item.changes.map((change) => `${change.kind} ${change.path}`).join(", "),
                        ...(locations.length > 0 ? { locations } : {}),
                        ...(item.status === "failed" ? { content: [{ type: "text", text: "patch failed" }] } : {}),
                    };
                }
            } else if (item.type === "mcp_tool_call") {
                const name = `${item.server}.${item.tool}`;
                if (event.type === "item.started") {
                    attachBrowserSession(item, capture.threadId, browser);
                    yield { kind: "tool_call", id: item.id, name, category: toolCategoryOf(name), status: "in_progress" };
                } else if (event.type === "item.completed") {
                    yield {
                        kind: "tool_call_update",
                        id: item.id,
                        status: item.status === "failed" ? "failed" : "completed",
                        content: [{ type: "text", text: mcpResultText(item) }],
                    };
                }
            } else if (item.type === "web_search") {
                if (event.type === "item.completed") {
                    yield { kind: "tool_call", id: item.id, name: "WebSearch", category: "search", status: "completed", target: item.query };
                }
            } else if (item.type === "todo_list") {
                yield {
                    kind: "todos",
                    items: item.items.map((todo) => ({ content: todo.text, status: todo.completed ? ("completed" as const) : ("pending" as const) })),
                };
            } else if (item.type === "image_generation") {
                if (event.type === "item.started") {
                    yield {
                        kind: "tool_call",
                        id: item.id,
                        name: "Image generation",
                        category: "other",
                        status: "in_progress",
                        ...(item.revised_prompt !== undefined ? { target: item.revised_prompt } : {}),
                    };
                    continue;
                }
                // Nothing to say while it is running; the card is settled by the completion below.
                if (event.type !== "item.completed") {
                    continue;
                }
                if (item.status !== "completed") {
                    yield { kind: "tool_call_update", id: item.id, status: "failed", content: [{ type: "text", text: "Image generation failed" }] };
                    continue;
                }
                try {
                    const path = await persistCodexImageArtifact({ ...imageArtifacts, image: item });
                    yield { kind: "tool_call_update", id: item.id, status: "completed", content: [{ type: "image", path }] };
                } catch (error) {
                    yield {
                        kind: "tool_call_update",
                        id: item.id,
                        status: "failed",
                        content: [{ type: "text", text: error instanceof Error ? error.message : "Could not save generated image" }],
                    };
                }
            } else if (item.type === "context_compaction" && event.type === "item.completed") {
                yield { kind: "compact", trigger: "auto" };
            }
        } else if (event.type === "commands") {
            // The thread's skills, as the composer's `/` popover renders them. Republished every turn, like every
            // other provider's list, so a conversation that has not run one still has something to show.
            yield { kind: "commands", items: event.skills.map((skill) => ({ name: skill.name, description: skill.description })) };
        } else if (event.type === "user_input.requested") {
            yield* codexQuestionCard(event, context);
        } else if (event.type === "command_approval.requested") {
            yield* codexCommandApproval(event, context);
        } else if (event.type === "turn.completed") {
            if (event.usage !== undefined) {
                yield {
                    kind: "usage",
                    inputTokens: event.usage.input_tokens,
                    outputTokens: event.usage.output_tokens,
                    cacheReadTokens: event.usage.cached_input_tokens,
                    cacheCreationTokens: event.usage.cache_write_input_tokens,
                };
            }
        } else if (event.type === "turn.failed") {
            yield { kind: "error", message: event.error.message };
            capture.errored = true;
        } else if (event.type === "error") {
            const notice = codexNotice(event.message);
            if (notice !== undefined) {
                yield notice;
                continue;
            }
            yield { kind: "error", message: event.message };
            capture.errored = true;
        }
        // turn.started has no UI mapping, dropped, like the Claude path's unmapped SDK messages.
    }
    return capture;
}

// Codex's preamble adds the read-only truth of its planning phase to the shared skeleton's wording.
const CODEX_PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop: do not execute it yet. " +
    "You are in a read-only sandbox for this turn; end your reply with the plan itself.\n\n";

// Always-plan flow over the shared skeleton (this client does not wire app-server's collaboration modes): a
// read-only planning turn whose trailing message becomes the plan, then a full-access execution turn resumed on
// the same thread. Both phases can be steered and both can ask, each borrows its own steering channel from the
// run's relay, and closes it when its stream ends so the pause between them keeps the queue's messages.
async function* runCodexPlanTurn(
    request: AgentRequest,
    runner: CodexRunner,
    turnBase: CodexTurnBase,
    context: Omit<CodexStreamContext, "holdMessages" | "browser">,
    browser: Omit<CodexBrowserContext, "sessionId"> | undefined,
    channel: (() => SteeringChannel) | undefined,
): AsyncGenerator<AgentEvent> {
    const { images: firstTurnImages, others } = splitAttachments(request.attachments);
    // Images ride the first planning turn only, revision and execute turns resume the same thread, whose
    // context already holds them.
    let images = firstTurnImages;
    const phase = async function* (
        prompt: string,
        sessionId: string | undefined,
        sandboxMode: CodexSandboxMode,
        holdMessages: boolean,
    ): AsyncGenerator<AgentEvent, TurnCapture> {
        const steering = channel?.();
        try {
            return yield* streamTurn(
                runner({
                    prompt,
                    ...(images.length > 0 ? { images } : {}),
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    ...turnBase,
                    ...(steering !== undefined ? { steering: steering.steering } : {}),
                    options: threadOptions(request, sandboxMode, context.gate?.enforcing === true),
                    signal: request.signal,
                }),
                {
                    ...context,
                    holdMessages,
                    ...(browser === undefined ? {} : { browser: { ...browser, ...(sessionId === undefined ? {} : { sessionId }) } }),
                },
            );
        } finally {
            steering?.close();
        }
    };
    const planPhase: PlanPhase = async function* (prompt, sessionId) {
        const capture = yield* phase(prompt, sessionId, "read-only", true);
        images = [];
        return { sessionId: capture.threadId, planText: capture.heldMessage, errored: capture.errored === true };
    };
    const executePhase: ExecutePhase = (sessionId) => phase(EXECUTE_PROMPT, sessionId, "danger-full-access", false);
    yield* runPlanEmulation(request.signal, CODEX_PLAN_PREAMBLE + withFileNote(request.prompt, others), request.sessionId, planPhase, executePhase);
}

interface CodexAgentOptions {
    readonly codexHome: string;
    readonly runner?: CodexRunner;
}

// Build the Codex provider for the Services seam: AgentRequest in, AgentEvent frames out. Process-backed browser
// MCP runs inside app-server, which is also where mid-turn steering, question cards and the skill list come from;
// daemon-side SDK servers, plugins and server-initiated APPROVALS stay absent in the Codex capability row.
export const createCodexAgent = (options: CodexAgentOptions) => {
    const runner = options.runner ?? createCodexAppServerRunner();
    return async function* runCodexAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        // Per-account CODEX_HOME when the turn resolved one; the constructor's base dir is the OPENAI_API_KEY
        // fallback path only. A subscription-served turn (codexEndpoint) layers the translator provider block
        // on top: the bearer rides CODEX_API_KEY and the home holds only sessions, whatever auth.json it may
        // carry is ignored by the custom provider.
        const activeCodexHome = request.codexHome ?? options.codexHome;
        const env = codexEnv(activeCodexHome, request.cliEnv);
        /* The owner's system prompt and whatever the daemon adds to it, as the two config keys Codex reads them
         * from (codex-instructions.ts). Merged UNDER the translator provider block rather than over it: the two
         * touch different keys, and spelling the order out is what keeps a future key added to either from
         * silently winning. */
        const instructions = await codexInstructionConfig(request, activeCodexHome);
        const runtimeConfig = { ...instructions, ...questionToolConfig(request), ...codexMcpConfig(request.sdkServers, env) };
        const turnBase: CodexTurnBase = {
            ...(request.codexEndpoint !== undefined
                ? {
                      env: { ...env, CODEX_API_KEY: request.codexEndpoint.authToken },
                      ...withRuntimeConfig(translatorProvider(request.codexEndpoint.baseUrl), runtimeConfig),
                  }
                : { env, config: runtimeConfig }),
            /* WHERE APP-SERVER IS BORN. An isolated turn's anchor makes the conversation's worktree /work for the
             * app-server and everything it forks, which is what `isolation: "namespace"` in the Codex row claims,
             * before this the turn was merely cwd'd there and an absolute /work path reached the shared checkout.
             * Absent when the turn is not isolated, or when the container could not build a namespace (the plan
             * still stands, and the turn runs cwd'd as it always did). */
            ...(request.isolation?.anchor === undefined
                ? {}
                : { namespace: { pid: request.isolation.anchor.pid, cwd: request.isolation.anchor.cwd } }),
        };
        // request.cwd is the conversation's own checkout: the worktree for a cwd-isolated turn, and the workspace
        // root as the namespace sees it for an anchored one, inside which /work IS that worktree. Using the
        // daemon's shared root would put an isolated conversation's generated image in somebody else's tree.
        const imageArtifacts = { workspaceRoot: request.cwd, codexHome: activeCodexHome };
        const browser =
            request.browserPorts === undefined
                ? undefined
                : {
                      ports: request.browserPorts,
                      passkeys: request.browserPasskeys ?? {},
                      accounts: request.browserAccounts ?? {},
                      ...(request.conversationId === undefined ? {} : { owner: request.conversationId }),
                  };
        // The run's one consumer of the daemon's steering queue (see steeringRelay). Absent when the turn was
        // started with no queue, a bench or benchmark run rather than a chat.
        const channel = request.steering === undefined ? undefined : steeringRelay(request.steering);
        /* THE TURN'S SAFETY WIRING (guard/turn-gate.ts): the owner's command rulebook, reached through the
         * approval requests app-server raises, and this conversation's outside-content bit, published so the
         * wallet's payment gate can read it from outside this generator.
         *
         * Minted once for the whole run, so an "always" answered during the plan phase still holds while
         * executing, and so both phases ask Codex for the same approval posture. */
        const { gate, release } = createTurnGate(request);
        const context: Omit<CodexStreamContext, "holdMessages" | "browser"> = {
            cwd: request.cwd,
            imageArtifacts,
            signal: request.signal,
            gate,
            ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        };
        // If app-server reports a specific error and then its process also dies, keep the actionable frame and
        // suppress the generic process-exit wrapper.
        const { images, others } = splitAttachments(request.attachments);
        const steering = request.permissionMode === "plan" ? undefined : channel?.();
        const turn =
            request.permissionMode === "plan"
                ? runCodexPlanTurn(request, runner, turnBase, context, browser, channel)
                : streamTurn(
                      runner({
                          prompt: withFileNote(request.prompt, others),
                          ...(images.length > 0 ? { images } : {}),
                          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
                          ...turnBase,
                          ...(steering !== undefined ? { steering: steering.steering } : {}),
                          options: threadOptions(request, "danger-full-access", gate.enforcing),
                          signal: request.signal,
                      }),
                      {
                          ...context,
                          holdMessages: false,
                          ...(browser === undefined
                              ? {}
                              : { browser: { ...browser, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) } }),
                      },
                  );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                if (event.kind === "error") {
                    // An advisory is already tagged and is not a failure, so it must not count as the turn's
                    // surfaced error, letting it stand in for one would swallow the process-exit wrapper on a
                    // turn that then died for a real reason.
                    if (event.code === "codex-advisory") {
                        yield event;
                        continue;
                    }
                    surfacedError = true;
                    yield codexFailureFrame(event);
                    continue;
                }
                yield event;
            }
        } catch (error) {
            if (!surfacedError) {
                const message = error instanceof Error ? error.message : "codex agent failed";
                yield codexFailureFrame({ kind: "error", message });
            }
        } finally {
            // The app-server this channel fed is gone; a message still riding the queue has nowhere to land, and
            // leaving the channel open would park its pump on a promise nothing resolves.
            steering?.close();
            // This turn's outside-content bit dies with the turn (guard/turn-taint.ts): the next one starts clean
            // unless it too takes something in.
            release();
        }
        yield { kind: "done" };
    };
};
