import { sleep } from "@intentic/base/async";
import { escapeRegExp } from "@intentic/base/escape";
import { vendorShellEnv } from "../../agent/run/vendor-shell-env.js";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AskQuestion, ToolCallContent, ToolCallLocation } from "@intentic/sandbox-contract/events/requests";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import type { AgentRequest, CodexCredential, CodexHostedProvider, TurnTools } from "../../agent/providers/agent-request.js";
import { splitAttachments, withFileNote } from "../../sessions/vocabulary/attachment-note.js";
import { opt } from "../../opt.js";
import { type EmulatedPlan, EXECUTE_PROMPT, planMode } from "../decorators/plan-mode.js";
import { POST_PLAN_MODE } from "../../agent/run/agent.js";
import { codedFailure, type FailureRule } from "../../agent/run/frames/error-frames.js";
import { LIMIT_WAIT_HANDED_OVER, type LimitWait, limitWait, limitWaitOptions } from "./turn/limit-wait.js";
import { isRateLimited } from "../../engines/failure-sentences.js";
import { transientUpstream } from "../../agent/providers/routed-refusal.js";
import { toolCategoryOf } from "@intentic/agent-context/tool-calls";
import { resultContent, workspacePath } from "../../sessions/vocabulary/tool-calls.js";
import { openBrowserSession } from "../../browser/sessions/browser-sessions.js";
import { workloadStamp } from "../../seams/workload-stamp.js";
import { ROUTED_BROWSER_SERVER } from "../../browser/tools/browser-tools.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { planPhaseOf, type TurnCapture } from "../decorators/vendor-events.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { codexUsageFromRateLimits } from "../../usage/translator-usage.js";
import {
    type CodexEvent,
    type CodexFailureInfo,
    type CodexFileChange,
    type CodexFrameInbox,
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
import { aboutSubagent, codexSubagentFrames, codexSubagents, subagentSpend } from "./codex-subagent-frames.js";
import { codexInstructions, PROJECT_DOC_CONFIG } from "./codex-instructions.js";
import { answerCommand, answerFileChange, answerPermissions, codexPosture, type CodexPosture, type OwnerApprovals } from "./codex-approvals.js";
import { codexAllowlistConfig, codexHooksConfig, type CodexHookSession, createCodexHookSession, HOOK_TRUST_WARNING } from "./codex-hooks.js";
import { GATE_SERVER } from "../daemon-tools/policy-gate-server.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import { CODEX_FAST_TIER } from "./codex-model-list.js";
import { CODEX_ADVISORY, CODEX_COMPACTION_NOTICE, CODEX_MODEL_RESUMED_ELSEWHERE, CODEX_RECONNECTING, isCodexModelInvalid } from "./codex-models.js";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import { containerKeyEnv } from "../../seams/sealed-env.js";

// Codex provider adapter: same seam as agent.ts's runAgent (AgentRequest in, AgentEvent frames out), backed by the
// Codex CLI's app-server instead of the Claude Agent SDK. App-server publishes item lifecycles with their live text
// (prose, reasoning summaries, command output), patches with their diffs, usage and context fill, image-generation and
// compaction events, and the approvals each turn's posture answers (codex-approvals.ts).

// Codex names every rung of the shared scale, so a pick travels as picked; a level this build doesn't know is dropped
// rather than guessed at, leaving the model's own default to answer.
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const reasoningEffort = (effort: string): CodexReasoningEffort | undefined =>
    EFFORT_LEVELS.has(effort) ? (effort as CodexReasoningEffort) : undefined;

// Explicit environment app-server inherits: undefined entries dropped, cli-kind credentials merged, CODEX_HOME pinned,
// and the owner stamp every turn workload carries. CODEX_API_KEY is dropped: only a turn that resolves a codexEndpoint
// sets it, or a daemon-side bearer would leak to native account turns too.
const codexEnv = (codexHome: string, cliEnv: Record<string, string> | undefined, conversationId: string | undefined): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEX_API_KEY") {
            env[key] = value;
        }
    }
    return { ...env, ...cliEnv, CODEX_HOME: codexHome, ...(conversationId === undefined ? {} : workloadStamp(conversationId)) };
};

// The translator provider block speaks Responses wire format with a fixed local bearer (env_key) and
// supports_websockets=false, since the translator's inbound is plain POST SSE. Merges a turn's instructions and MCP
// keys under the provider block, an order chosen once since the two sets never share a key.
const withRuntimeConfig = (
    provider: Pick<CodexTurn, "modelProvider" | "config">,
    instructions: Record<string, JsonValue>,
): Pick<CodexTurn, "modelProvider" | "config"> => ({ ...provider, config: { ...instructions, ...provider.config } });

// What every turn of one run shares: environment, provider block, and namespace. Only the prompt, sandbox mode and
// session id differ between turns.
type CodexTurnBase = Pick<CodexTurn, "env" | "modelProvider" | "config" | "namespace" | "spawnDepth" | "instructions">;

// Projects the turn's MCP servers into Codex's per-thread config: every remote mount (the daemon's MCP door's browsers,
// machines and extension tools, and the mcp-kind cards) as a Streamable HTTP server, the one list every runtime reads.
const codexMcpConfig = (tools: Pick<TurnTools, "remote">): Record<string, JsonValue> => {
    const config: Record<string, JsonValue> = {};
    for (const tool of tools.remote ?? []) {
        config[`mcp_servers.${tool.name}`] = {
            url: tool.url,
            ...(tool.token === undefined ? {} : { http_headers: { Authorization: `Bearer ${tool.token}` } }),
            ...(tool.timeoutMs === undefined ? {} : { tool_timeout_sec: Math.ceil(tool.timeoutMs / 1_000) }),
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
            // Non-secret marker Codex's image extension expects; the translator drops it and authenticates itself.
            http_headers: { "x-openai-actor-authorization": "intentic" },
            supports_websockets: false,
        },
    },
});

// Another provider's route as its own provider block (codex-endpoint `hosted`): the same Responses wire and bearer seam as
// the translator's, with what Codex can't know of a model outside OpenAI's catalog said per thread. Its window, where
// the route's catalog publishes one (else Codex assumes 272k, and compacts by that); hosted web search and image
// generation off, since only OpenAI serves those tools and every other provider refuses a request naming them. A custom
// provider is never OpenAI's own, so Codex compacts a long thread locally rather than through OpenAI's endpoint.
const hostedProvider = (baseUrl: string, hosted: CodexHostedProvider): Pick<CodexTurn, "modelProvider" | "config"> => ({
    modelProvider: hosted.id,
    config: {
        [`model_providers.${hosted.id}`]: {
            name: hosted.id,
            base_url: `${baseUrl.replace(/\/$/, "")}${hosted.path}`,
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            ...opt("http_headers", hosted.headers === undefined ? undefined : { ...hosted.headers }),
            supports_websockets: false,
        },
        web_search: "disabled",
        "features.image_generation": false,
        ...opt("model_context_window", hosted.contextWindow),
    },
});

// The provider block a turn on a URL the daemon names rides: the translator's for the ChatGPT plan, else the route's own.
const endpointProvider = (credential: Extract<CodexCredential, { kind: "codex-endpoint" }>): Pick<CodexTurn, "modelProvider" | "config"> =>
    credential.hosted === undefined ? translatorProvider(credential.baseUrl) : hostedProvider(credential.baseUrl, credential.hosted);

const hostedTurn = (credential: CodexCredential): true | undefined => (credential.kind === "codex-endpoint" && credential.hosted !== undefined ? true : undefined);

// Codex registers this tool whenever the config table is absent, so it's set explicitly every turn: on for every turn,
// the adapter answering the resulting card. An unattended turn's question waits for the owner like any other card.
const QUESTION_TOOL_CONFIG = { "tools.experimental_request_user_input.enabled": true } as const satisfies Readonly<Record<string, JsonValue>>;

// Every question of a request rides one card. Always single-pick: Codex's request (0.162) carries no multi-select flag,
// and the card's free-text answer already covers `isOther`. A secret is never put on a card, since a card's answers are
// recorded in the frame log and journal; the refusal points to the credential already in the turn's environment instead.
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

// One answer per question id, in the shape app-server is waiting for. A secret question is always refused; a dismissal
// answers every question the same way, since Codex is blocked on the reply.
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

const threadOptions = (request: Pick<AgentRequest, "spec">, phase: Pick<CodexPhase, "sandboxMode" | "collaborationMode">, gated: boolean): CodexThreadOptions => {
    const effort = request.spec.effort !== undefined ? reasoningEffort(request.spec.effort) : undefined;
    return {
        workingDirectory: request.spec.cwd,
        sandboxMode: phase.sandboxMode,
        // `gated` is always true today (the command gate always enforces), so Codex asks about every command off its
        // known-safe list and every patch; `never` remains for a gate that could refuse nothing.
        approvalPolicy: gated ? "untrusted" : "never",
        ...(request.spec.model !== undefined ? { model: request.spec.model } : {}),
        ...(effort !== undefined ? { modelReasoningEffort: effort } : {}),
        // Only a turn that asked for it, and only where the route let it through (honoured.ts drops it otherwise).
        ...opt("serviceTier", request.spec.fast === true ? CODEX_FAST_TIER : undefined),
        ...opt("collaborationMode", phase.collaborationMode),
    };
};

// An MCP result read by the Claude stream's own rule (resultContent), so a Codex screenshot carries its picture too.
const mcpResultContent = (item: Extract<CodexItem, { type: "mcp_tool_call" }>, name: string, context: CodexStreamContext): ToolCallContent[] =>
    item.error === undefined
        ? resultContent(item.result?.content, context.cwd, context.browserOutputDir, item.status === "failed" ? undefined : { name, input: undefined })
        : [{ type: "text", text: item.error.message }];

// Codex's in-turn retry notice when it counts ("Reconnecting... 2/5 (...)"); 0.162 also says "Reconnecting... waiting
// for network", with no counters at all. Read only for its counters once willRetry has said the error is a retry: the
// sentence decides nothing.
const CODEX_RETRY_COUNTERS = new RegExp(String.raw`^${escapeRegExp(CODEX_RECONNECTING)}\s*(\d+)\s*\/\s*(\d+)`);

// Codex's heads-up after every auto-compaction. The context_compaction item already carries the lifecycle frame, so
// repeating it here would show the reader two compaction notices for one compaction.
const CODEX_COMPACTED = new RegExp(escapeRegExp(CODEX_COMPACTION_NOTICE), "i");

// Codex messages this chat swallows on any channel: each reports something already framed elsewhere, so neither an
// error nor a muted line may come of them.
// The hook-trust notice is about the daemon's own per-thread hooks (codex-hooks.ts), which nobody reading can act on.
const codexDropped = (message: string): boolean =>
    CODEX_COMPACTED.test(message) || CODEX_MODEL_RESUMED_ELSEWHERE.test(message) || HOOK_TRUST_WARNING.test(message);

// Codex's warning channel, which by construction carries advisories rather than failures: whatever it says, the turn
// runs on. So nothing here may redden the turn or offer to pick it back up; the worst case is a muted line. Undefined
// drops the warning entirely.
const codexWarning = (message: string): AgentEvent | undefined => (codexDropped(message) ? undefined : { kind: "error", code: "codex-advisory", message });

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// The typed failures that are the provider's transport or capacity giving way: what the outage breaker counts and
// auto-resume re-runs once the provider is back (stream-agent.ts).
const OUTAGE_KINDS = new Set([
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
    "serverOverloaded",
    "internalServerError",
]);
const RATE_LIMIT_KINDS = new Set(["usageLimitExceeded", "rateLimitExceeded"]);
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

// How Codex's typed failure is coded, ahead of any sentence: a spent allowance or a 429 first, so the client shows a
// muted reset countdown and holds the turn; a thread past the window, which the daemon re-runs in a fresh one; then a
// transport or capacity failure, an outage only when no status says otherwise (a 4xx from a broken connection is a
// refusal, not the provider being down). Undefined leaves the sentence rules to speak.
const codexFailureCode = (info: CodexFailureInfo | undefined): ErrorFrame["code"] => {
    if (info === undefined) {
        return undefined;
    }
    if (RATE_LIMIT_KINDS.has(info.kind) || info.httpStatus === HTTP_TOO_MANY_REQUESTS) {
        return "rate_limit";
    }
    if (info.kind === "contextWindowExceeded") {
        return "context-overflow";
    }
    return OUTAGE_KINDS.has(info.kind) && (info.httpStatus === undefined || info.httpStatus >= HTTP_SERVER_ERROR) ? "provider-outage" : undefined;
};

// A failure as its frame, coded by type where Codex typed it.
const failureFrame = (message: string, info: CodexFailureInfo | undefined): ErrorFrame => ({ kind: "error", message, ...opt("code", codexFailureCode(info)) });

// Codex retrying inside the turn: the counters its sentence carries where it carries them, else this turn's own count.
const retryFrame = (event: Extract<CodexEvent, { type: "error" }>, retries: { count: number }): AgentEvent => {
    retries.count += 1;
    // allow(dependency-text): the Codex CLI's retry notice (codex-models.ts); without its counters, this turn's own count.
    const counters = CODEX_RETRY_COUNTERS.exec(event.message);
    return {
        kind: "provider_retry",
        attempt: counters === null ? retries.count : Number(counters[1]),
        ...opt("maxAttempts", counters === null ? undefined : Number(counters[2])),
        ...opt("status", event.info?.httpStatus),
    };
};

// Codex's error channel, classified whole: the frames to emit, and whether the turn really died. willRetry is Codex
// saying it is retrying in the turn, a wait; a dropped message yields nothing at all; an advisory is a muted line. Only
// what is none of those counts as a failure.
interface CodexErrorReading {
    readonly frames: AgentEvent[];
    readonly errored: boolean;
    // A retry of a rate limit: Codex is waiting out a refusal, which the turn gives only so long (LimitWait).
    readonly limited?: true;
}

// Whether a retry Codex announced is it waiting out a rate limit: typed so, a 429 behind it, or said so.
const limitRetry = (event: Extract<CodexEvent, { type: "error" }>): boolean => codexFailureCode(event.info) === "rate_limit" || isRateLimited(event.message);

// `hosted`: another provider's model, whose fallback-metadata advisory is expected and says nothing (CodexStreamContext).
const codexError = (event: Extract<CodexEvent, { type: "error" }>, retries: { count: number }, hosted = false): CodexErrorReading => {
    // allow(dependency-text): the Codex CLI's notices (codex-models.ts); an unmatched one shows as the failure it came as.
    if (codexDropped(event.message) || (hosted && CODEX_ADVISORY.test(event.message))) {
        return { frames: [], errored: false };
    }
    if (event.willRetry === true) {
        const retry: CodexErrorReading = { frames: [retryFrame(event, retries)], errored: false };
        return limitRetry(event) ? { ...retry, limited: true } : retry;
    }
    // An advisory isn't a failure: the turn still answers normally, so it must not mark the phase errored.
    // allow(dependency-text): the Codex CLI's fallback-metadata advisory; an unmatched one shows as a failure.
    if (CODEX_ADVISORY.test(event.message)) {
        return { frames: [{ kind: "error", code: "codex-advisory", message: event.message }], errored: false };
    }
    return { frames: [failureFrame(event.message, event.info)], errored: true };
};

// Codex's own words for a model it cannot use, read before the sentences every runtime shares (codedFailure), so the
// client reloads the catalog and drops the bad pin.
const CODEX_FAILURES: readonly FailureRule[] = [[isCodexModelInvalid, "codex-model-invalid"]];

// Waits before re-running a turn the translator never got to the model, in ms: long enough for a stalled resolver or a
// refused dial to pass, short enough that the user is still watching. One entry per retry, so the list is the cap.
const UPSTREAM_WAITS_MS = [3_000, 8_000] as const;
const UPSTREAM_ATTEMPTS = UPSTREAM_WAITS_MS.length + 1;

// The wait before re-running, or undefined when this failure is the turn's answer. Only a transport or capacity failure
// earns a re-run: the proxy files its credential away for one of those and then refuses in the words of a plan that
// excludes the model, so the sentence alone would end a turn the next call would serve. A spent allowance is ruled out
// first, since it belongs in a countdown the user waits out, not in a ladder that spends attempts on the same refusal.
const upstreamWaitMs = (attempt: number, event: ErrorFrame): number | undefined =>
    event.code !== "rate_limit" && !isRateLimited(event.message) && transientUpstream(event.message) ? UPSTREAM_WAITS_MS[attempt - 1] : undefined;

// Frames a turn emits before it does any work: its thread id, its skill list, its usage and limit snapshots. Anything
// else means a re-run would repeat work the user has already seen.
const TURN_BOOKKEEPING = new Set<AgentEvent["kind"]>([
    "session",
    "commands",
    "usage",
    "rate_limit_info",
    "account_usage",
    "context_usage",
    "init",
    "mode",
    "provider_retry",
]);

// One attempt's frames, plus what to do after it: the failure it surfaced, or the wait before re-running when the
// translator never reached the model. `surfaced` carries in what earlier attempts already showed.
interface AttemptOutcome {
    readonly surfaced?: string;
    readonly waitMs?: number;
}

const attemptOutcome = (surfaced: string | undefined, waitMs?: number): AttemptOutcome => ({
    ...(surfaced === undefined ? {} : { surfaced }),
    ...(waitMs === undefined ? {} : { waitMs }),
});

// An advisory rides the same channel as a failure without being one: it must never count as the surfaced error, or the
// real failure that follows arrives silent.
const isCodexFailure = (event: AgentEvent): event is ErrorFrame =>
    event.kind === "error" && event.code !== "codex-advisory";

const thrownMessage = (error: unknown): string => (error instanceof Error ? error.message : "codex agent failed");

async function* consumeAttempt(
    turn: AsyncGenerator<AgentEvent>,
    attempt: number,
    surfaced: string | undefined,
): AsyncGenerator<AgentEvent, AttemptOutcome> {
    let shown = surfaced;
    // A re-run re-sends the prompt, so only an attempt that produced nothing may be retried.
    let produced = false;
    try {
        for await (const event of turn) {
            if (!isCodexFailure(event)) {
                produced ||= !TURN_BOOKKEEPING.has(event.kind);
                yield event;
                continue;
            }
            // The ladder first: a turn the translator never got to the model is re-run whatever its type says.
            const waitMs = produced ? undefined : upstreamWaitMs(attempt, event);
            if (waitMs !== undefined) {
                return attemptOutcome(shown, waitMs);
            }
            if (shown === undefined) {
                shown = event.message;
                // A failure Codex typed is already coded; only an untyped one is read by its sentence.
                yield codedFailure(event, CODEX_FAILURES);
            }
        }
    } catch (error) {
        // The app-server died: its own message stands only when the turn hasn't already said what went wrong.
        if (shown === undefined) {
            shown = thrownMessage(error);
            yield codedFailure({ kind: "error", message: shown }, CODEX_FAILURES);
        }
    }
    return attemptOutcome(shown);
}

interface ImageArtifactContext {
    readonly workspaceRoot: string;
    readonly codexHome: string;
}

interface CodexBrowserContext {
    readonly ports: Readonly<Record<string, number>>;
    readonly passkeys: Readonly<Record<string, string>>;
    // Routed browser server's account→owner map; a routed call attributes only when every route shares one owner.
    readonly accounts: Readonly<Record<string, string>>;
    readonly owner?: string;
    // Present only on a resumed invocation; a new thread learns its id from thread.started first.
    readonly sessionId?: string;
}

// The one profile a routed call can be pinned to without seeing its arguments; defined only if every account maps to
// the same owner.
const soleRoutedOwner = (browser: CodexBrowserContext | undefined): string | undefined => {
    const owners = new Set(Object.values(browser?.accounts ?? {}));
    return owners.size === 1 ? [...owners][0] : undefined;
};

// Ties a browser call to the profile whose session drives it, so opened pages belong to that account. A routed server's
// calls carry no account in the item, so they attach only when the turn resolves to a single profile.
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

// Context one Codex turn's stream normalizes against: cwd, where generated images land, the question-card signal and
// dismissal target. `holdMessages` is the plan phase's one behavioral difference in what it shows; `posture` is how it
// answers approvals.
interface CodexStreamContext {
    readonly cwd: string;
    // Where a question card is parked, so the reply finds it.
    readonly cards: Pick<ParkedCards, "create">;
    readonly imageArtifacts: ImageArtifactContext;
    // Where this turn's screenshots land; absent on a turn with no browser tools.
    readonly browserOutputDir?: string;
    readonly signal: AbortSignal;
    readonly conversationId?: string;
    readonly holdMessages?: boolean;
    readonly browser?: CodexBrowserContext;
    // One gate for the whole turn, so an "always" from planning still holds while executing.
    readonly gate?: CommandGuard;
    // How this phase answers Codex's approval requests, and the run's per-tool cards they may raise.
    readonly posture: CodexPosture;
    readonly owner: OwnerApprovals;
    // The run's side of its per-thread hooks (codex-hooks.ts): what the gate answered each call. Absent where the turn
    // has no gate mounted (a bench run, a test), which leaves the approval channel judging as it always did.
    readonly hooks?: CodexHookSession;
    // The turn's outside-content bit, marked by results no hook sees (Codex's hosted web search).
    readonly taint?: TurnTaint;
    // Stops the running phase: a call ran that the gate never answered.
    readonly halt?: () => void;
    // How long a rate limit Codex waits out in the turn is let run (LimitWait); absent leaves Codex to wait (a test).
    readonly limitWait?: LimitWait;
    // The turn runs another provider's model on its route (codex-endpoint `hosted`), whose window the route already
    // gave Codex: Codex's every-turn notice that it fell back to default metadata for an id outside OpenAI's catalog
    // tells the reader nothing, so it is dropped.
    readonly hosted?: true;
}

// Same card, registry and dismissal the `ask` tool uses, so a question reads the same across runtimes. The stream parks
// on the await (app-server is blocked on it too), and the resolved frame goes out before the answer, to freeze the card
// in a replayed transcript.
async function* codexQuestionCard(
    request: Extract<CodexEvent, { type: "user_input.requested" }>,
    context: CodexStreamContext,
): AsyncGenerator<AgentEvent> {
    const asked = request.questions.filter((question) => !question.secret);
    if (asked.length === 0) {
        request.respond(Object.fromEntries(request.questions.map((question) => [question.id, [SECRET_REFUSED]])));
        return;
    }
    const { id, wait } = context.cards.create("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
    yield { kind: "question", requestId: id, questions: asked.map(askQuestion) };
    const { reply, resolved } = await wait(context.signal);
    yield resolved;
    request.respond(codexAnswers(request.questions, reply));
}

type CodexItemEvent = Extract<CodexEvent, { type: "item.started" | "item.updated" | "item.completed" }>;
type ItemOf<T extends CodexItem["type"]> = Extract<CodexItem, { type: T }>;

// What one stream has shown of the items still running, so each item's completion adds only what was not yet said.
interface StreamState {
    // Text each running message or reasoning item has streamed so far.
    readonly streamed: Map<string, string>;
    // The summary part each reasoning item streamed last, so a new part starts a new paragraph.
    readonly parts: Map<string, number>;
    // Each running command's output so far, and when it last went out.
    readonly output: Map<string, { text: string; at: number }>;
    // Each patch Codex opened, by item id: the files it touches, for its approval card.
    readonly patches: Map<string, readonly CodexFileChange[]>;
    // Retries Codex has reported in this turn, for a notice that carries no counters of its own.
    readonly retries: { count: number };
    // Whether a planning phase has proposed its plan, after which its messages are prose again.
    planned: boolean;
}

const streamState = (): StreamState => ({ streamed: new Map(), parts: new Map(), output: new Map(), patches: new Map(), retries: { count: 0 }, planned: false });

// What an item's whole text adds to what its deltas already showed. Should the two disagree, the deltas stand, since
// the reader has them already and a second copy would read as the agent repeating itself.
const unsaid = (state: StreamState, id: string, whole: string): string => {
    const said = state.streamed.get(id);
    state.streamed.delete(id);
    state.parts.delete(id);
    if (said === undefined) {
        return whole;
    }
    return whole.startsWith(said) ? whole.slice(said.length) : "";
};

// How often a running command's output goes out, in ms: each frame carries the whole output so far (the update frame
// replaces), so one per delta would send a long log once per line.
const OUTPUT_EVERY_MS = 250;

// Live text of a running item: a message's prose, a reasoning summary, a command's output. A planning phase holds its
// prose back (it may be the plan), so only its reasoning and output stream.
function* deltaFrames(event: Extract<CodexEvent, { type: "item.delta" }>, context: CodexStreamContext, state: StreamState): Generator<AgentEvent> {
    if (event.channel === "output") {
        const running = state.output.get(event.item_id) ?? { text: "", at: 0 };
        running.text += event.text;
        state.output.set(event.item_id, running);
        const now = Date.now();
        if (now - running.at >= OUTPUT_EVERY_MS) {
            running.at = now;
            yield { kind: "tool_call_update", id: event.item_id, content: [{ type: "text", text: running.text }] };
        }
        return;
    }
    if (event.channel === "message" && context.holdMessages === true && !state.planned) {
        return;
    }
    const said = state.streamed.get(event.item_id) ?? "";
    const part = state.parts.get(event.item_id);
    const text = event.part !== undefined && part !== undefined && event.part !== part && said !== "" ? `\n${event.text}` : event.text;
    if (event.part !== undefined) {
        state.parts.set(event.item_id, event.part);
    }
    state.streamed.set(event.item_id, said + text);
    yield event.channel === "message" ? { kind: "delta", text } : { kind: "thinking", text };
}

// An agent message: its deltas already streamed, so its completion adds what they missed, then text_end, so later tool
// calls render under this bubble. A plan phase holds messages one deep, flushing each the instant a newer one arrives,
// so only the last stays held as the plan, unless Codex proposed the plan as an item of its own, after which prose is
// prose again.
function* messageFrames(event: CodexItemEvent, item: ItemOf<"agent_message">, context: CodexStreamContext, capture: TurnCapture, state: StreamState): Generator<AgentEvent> {
    if (event.type !== "item.completed") {
        return;
    }
    if (context.holdMessages !== true || state.planned) {
        const rest = unsaid(state, item.id, item.text);
        if (rest !== "") {
            yield { kind: "delta", text: rest };
        }
        yield { kind: "text_end" };
        return;
    }
    if (capture.planText !== undefined) {
        yield { kind: "delta", text: capture.planText };
        yield { kind: "text_end" };
    }
    capture.planText = item.text;
}

// The plan Codex's plan mode proposed: the plan card's text, whatever prose came around it. Outside a planning phase it
// is just more of the answer.
function* planFrames(event: CodexItemEvent, item: ItemOf<"plan">, context: CodexStreamContext, capture: TurnCapture, state: StreamState): Generator<AgentEvent> {
    if (event.type !== "item.completed") {
        return;
    }
    if (context.holdMessages !== true) {
        yield { kind: "delta", text: item.text };
        yield { kind: "text_end" };
        return;
    }
    // Whatever was held is the lead-in to the plan, not the plan.
    if (capture.planText !== undefined && !state.planned) {
        yield { kind: "delta", text: capture.planText };
        yield { kind: "text_end" };
    }
    capture.planText = item.text;
    state.planned = true;
}

// A command, its card opening as it starts; its output streams through deltaFrames and its completion settles it whole.
function* commandFrames(event: CodexItemEvent, item: ItemOf<"command_execution">, state: StreamState, context: CodexStreamContext): Generator<AgentEvent> {
    if (event.type === "item.started") {
        // The command as the model wrote it, where the one Codex runs is the hooks' wrapper around it.
        const said = context.hooks?.record(item.id)?.said ?? item.command;
        yield { kind: "tool_call", id: item.id, name: "Bash", category: "execute", status: "in_progress", target: said };
        return;
    }
    if (event.type !== "item.completed") {
        return;
    }
    state.output.delete(item.id);
    const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
    yield { kind: "tool_call_update", id: item.id, status: failed ? "failed" : "completed", content: [{ type: "text", text: item.aggregated_output }] };
}

// How much of one file's change a card carries; past it the card says it was clipped.
const DIFF_CHARS = 32_000;

// One file's change as card content, from the text app-server sends for it: an added file's content is the new side
// whole, a deleted file's the old side whole, and an update's unified diff is shown as Codex rendered it, since
// rebuilding both sides from hunks would claim a whole file it does not have.
const changeContent = (change: CodexFileChange, cwd: string): ToolCallContent | undefined => {
    if (change.diff === undefined || change.diff === "") {
        return undefined;
    }
    const path = workspacePath(change.path, cwd);
    const clipped = change.diff.length > DIFF_CHARS;
    const text = change.diff.slice(0, DIFF_CHARS);
    if (path !== undefined && change.kind === "add") {
        return { type: "diff", path, newText: text, ...opt("truncated", clipped ? true : undefined) };
    }
    if (path !== undefined && change.kind === "delete") {
        return { type: "diff", path, oldText: text, newText: "", ...opt("truncated", clipped ? true : undefined) };
    }
    return { type: "text", text: `${path ?? change.path}\n${text}${clipped ? "\n[… diff clipped …]" : ""}` };
};

const patchContent = (item: ItemOf<"file_change">, cwd: string): ToolCallContent[] =>
    item.changes.map((change) => changeContent(change, cwd)).filter((content): content is ToolCallContent => content !== undefined);

// A patch: its card opens as Codex proposes it (before any approval it waits on), carrying the files and each one's
// change, and settles as it lands or fails. A patch only ever seen complete opens and settles in one frame.
function* fileChangeFrames(event: CodexItemEvent, item: ItemOf<"file_change">, cwd: string, state: StreamState): Generator<AgentEvent> {
    const locations = item.changes
        .map((change) => workspacePath(change.path, cwd))
        .filter((path): path is string => path !== undefined)
        .map((path): ToolCallLocation => ({ path }));
    const diffs = patchContent(item, cwd);
    const opening = {
        kind: "tool_call" as const,
        id: item.id,
        name: "Edit",
        category: item.changes.length > 0 && item.changes.every((change) => change.kind === "delete") ? ("delete" as const) : ("edit" as const),
        target: item.changes.map((change) => `${change.kind} ${change.path}`).join(", "),
        ...opt("locations", locations.length > 0 ? locations : undefined),
    };
    if (event.type === "item.started") {
        state.patches.set(item.id, item.changes);
        yield { ...opening, status: "in_progress", ...opt("content", diffs.length > 0 ? diffs : undefined) };
        return;
    }
    if (event.type !== "item.completed") {
        return;
    }
    const opened = state.patches.delete(item.id);
    const failed = item.status === "failed";
    const content = failed ? [{ type: "text" as const, text: "patch failed" }] : diffs;
    const settled = { status: failed ? ("failed" as const) : ("completed" as const), ...opt("content", content.length > 0 ? content : undefined) };
    yield opened ? { kind: "tool_call_update", id: item.id, ...settled } : { ...opening, ...settled };
}

function* mcpFrames(event: CodexItemEvent, item: ItemOf<"mcp_tool_call">, context: CodexStreamContext, capture: TurnCapture): Generator<AgentEvent> {
    const name = `${item.server}.${item.tool}`;
    if (event.type === "item.started") {
        attachBrowserSession(item, capture.sessionId, context.browser);
        yield { kind: "tool_call", id: item.id, name, category: toolCategoryOf(name), status: "in_progress" };
    } else if (event.type === "item.completed") {
        yield { kind: "tool_call_update", id: item.id, status: item.status === "failed" ? "failed" : "completed", content: mcpResultContent(item, name, context) };
    }
}

// A generated picture, saved into the workspace once done; nothing to say while it runs.
async function* imageFrames(event: CodexItemEvent, item: ItemOf<"image_generation">, context: CodexStreamContext): AsyncGenerator<AgentEvent> {
    if (event.type === "item.started") {
        yield { kind: "tool_call", id: item.id, name: "Image generation", category: "other", status: "in_progress", ...opt("target", item.revised_prompt) };
        return;
    }
    if (event.type !== "item.completed") {
        return;
    }
    if (item.status !== "completed") {
        yield { kind: "tool_call_update", id: item.id, status: "failed", content: [{ type: "text", text: "Image generation failed" }] };
        return;
    }
    try {
        const path = await persistCodexImageArtifact({ ...context.imageArtifacts, image: item });
        yield { kind: "tool_call_update", id: item.id, status: "completed", content: [{ type: "image", path }] };
    } catch (error) {
        yield {
            kind: "tool_call_update",
            id: item.id,
            status: "failed",
            content: [{ type: "text", text: error instanceof Error ? error.message : "Could not save generated image" }],
        };
    }
}

// Items that settle in one frame, emitted as they complete: the rest of a reasoning summary, a web search, a compaction;
// a checklist on every report of it.
function* settledFrames(
    event: CodexItemEvent,
    item: ItemOf<"reasoning" | "web_search" | "todo_list" | "context_compaction">,
    state: StreamState,
    taint: TurnTaint | undefined,
): Generator<AgentEvent> {
    if (item.type === "todo_list") {
        yield { kind: "todos", items: item.items.map((todo) => ({ content: todo.text, status: todo.completed ? ("completed" as const) : ("pending" as const) })) };
        return;
    }
    if (event.type !== "item.completed") {
        return;
    }
    if (item.type === "reasoning") {
        const streamed = state.streamed.has(item.id);
        const rest = unsaid(state, item.id, item.text);
        if (!streamed || rest !== "") {
            yield { kind: "thinking", text: rest };
        }
    } else if (item.type === "web_search") {
        // Hosted: no hook sees its results, so the item itself marks the turn as having read the outside.
        taint?.mark("WebSearch");
        yield { kind: "tool_call", id: item.id, name: "WebSearch", category: "search", status: "completed", target: item.query };
    } else {
        yield { kind: "compact", trigger: "auto" };
    }
}

// One item of a thread, as frames: its prose, reasoning, commands, edits, tool calls, checklist, pictures, plan and
// compactions. A subagent's items come through here too (codex-subagent-frames.ts), tagged with its spawn call after;
// its multi-agent calls are that module's alone.
async function* itemFrames(event: CodexItemEvent, context: CodexStreamContext, capture: TurnCapture, state: StreamState): AsyncGenerator<AgentEvent> {
    const item = event.item;
    switch (item.type) {
        case "agent_message":
            yield* messageFrames(event, item, context, capture, state);
            return;
        case "plan":
            yield* planFrames(event, item, context, capture, state);
            return;
        case "command_execution":
            yield* commandFrames(event, item, state, context);
            return;
        case "file_change":
            yield* fileChangeFrames(event, item, context.cwd, state);
            return;
        case "mcp_tool_call":
            yield* mcpFrames(event, item, context, capture);
            return;
        case "image_generation":
            yield* imageFrames(event, item, context);
            return;
        case "collab_agent_tool_call":
            return;
        default:
            yield* settledFrames(event, item, state, context.taint);
    }
}

type CodexSpend = ReturnType<typeof subagentSpend>;

// What the turn's own thread spent and what its subagents' threads did since the last report: the account paid for
// both, and a refused steer can start another turn whose subagent reports stay cumulative across it.
const usageFrame = (usage: CodexUsageOf, delegated: CodexSpend, charged: CodexSpend): AgentEvent => ({
    kind: "usage",
    inputTokens: Math.max(0, usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens) + delegated.input - charged.input,
    outputTokens: usage.output_tokens + delegated.output - charged.output,
    cacheReadTokens: usage.cached_input_tokens + delegated.cacheRead - charged.cacheRead,
    cacheCreationTokens: usage.cache_write_input_tokens + delegated.cacheCreation - charged.cacheCreation,
});
type CodexUsageOf = NonNullable<Extract<CodexEvent, { type: "turn.completed" }>["usage"]>;

// Why Codex moved a turn to another model, in a reader's words; a reason it adds later is shown as it names it.
const REROUTE_REASONS = { highRiskCyberActivity: "it read as high-risk security work" } as const satisfies Readonly<Record<string, string>>;

const isRerouteReason = (reason: string): reason is keyof typeof REROUTE_REASONS => Object.hasOwn(REROUTE_REASONS, reason);

// Codex served the turn on another model: the init frame names the one that actually ran, and a muted line says so.
const reroutedFrames = (event: Extract<CodexEvent, { type: "model.rerouted" }>): AgentEvent[] => {
    const reason = isRerouteReason(event.reason) ? REROUTE_REASONS[event.reason] : event.reason;
    return [
        { kind: "init", model: event.to },
        { kind: "error", code: "codex-advisory", message: `Codex moved this turn from ${event.from} to ${event.to}${reason === "" ? "" : ` because ${reason}`}.` },
    ];
};

// An approval request, answered by this phase's posture; app-server stays parked until it is.
async function* approvalFrames(
    event: Extract<CodexEvent, { type: "command_approval.requested" | "file_change_approval.requested" | "permissions_approval.requested" }>,
    context: CodexStreamContext,
    state: StreamState,
): AsyncGenerator<AgentEvent> {
    const records = context.hooks?.record;
    if (event.type === "command_approval.requested") {
        yield* answerCommand(event, context.posture, context.gate, context.owner, records);
    } else if (event.type === "file_change_approval.requested") {
        yield* answerFileChange(event, context.posture, state.patches.get(event.item_id), context.owner, records);
    } else {
        yield* answerPermissions(event, context.posture, context.owner);
    }
}

// Events that only report, settling nothing the turn holds: its skills, its context fill, a reroute, its headroom, a
// warning. turn.started has no UI mapping and is dropped, like the Claude path's unmapped SDK messages.
function* reportFrames(event: CodexEvent): Generator<AgentEvent> {
    if (event.type === "commands") {
        // Thread's skills for the `/` popover; republished every turn so an unused conversation still shows them.
        yield { kind: "commands", items: event.skills.map((skill) => ({ name: skill.name, description: skill.description })) };
    } else if (event.type === "context") {
        yield { kind: "context_usage", tokens: event.tokens, contextWindow: event.window };
    } else if (event.type === "model.rerouted") {
        yield* reroutedFrames(event);
    } else if (event.type === "rate_limits") {
        // Headroom pushed as the turn spends it; a snapshot with no window yields no frame, not a false "no limits".
        const usage = codexUsageFromRateLimits(event.snapshot);
        if (usage !== undefined) {
            yield { kind: "account_usage", windows: usage.windows };
        }
    } else if (event.type === "warning") {
        // Never sets `errored`: a warned turn still answers, and a plan phase that holds its message must still hand
        // it over.
        const notice = codexWarning(event.message);
        if (notice !== undefined) {
            yield notice;
        }
    }
}

// The items a PreToolUse hook stands in front of: a call of one of these on the turn's own thread with no answer from the
// gate ran past a hook that failed, or past hooks Codex never loaded.
const HOOKED_ITEMS = new Set<CodexItem["type"]>(["command_execution", "file_change", "mcp_tool_call"]);

export const UNGATED_CALL =
    "A Codex tool call started without the sandbox's safety policy having answered for it (its hook did not reach the policy gate), so the turn was stopped there. Send the message again; if it keeps happening, the daemon's log says why.";

// Whether this event shows the gate was bypassed: a failed PreToolUse hook of the turn's own, or an own call that started
// with no answer recorded. A failed PostToolUse costs the turn its taint reading, so it marks the bit instead.
const bypassed = (event: CodexEvent, context: CodexStreamContext): boolean => {
    const hooks = context.hooks;
    if (hooks === undefined) {
        return false;
    }
    if (event.type === "hook.failed") {
        if (event.event === "postToolUse") {
            context.taint?.mark("a PostToolUse hook that failed");
        }
        return event.event === "preToolUse";
    }
    return event.type === "item.started" && event.parent === undefined && HOOKED_ITEMS.has(event.item.type) && hooks.record(event.item.id) === undefined;
};

const handedOverFrame = (): ErrorFrame => ({ kind: "error", code: "rate_limit", message: LIMIT_WAIT_HANDED_OVER, own: true });

// Codex events that mean the provider answered: what it streamed, or a turn that went on to finish.
const ANSWERING: ReadonlySet<CodexEvent["type"]> = new Set(["item.started", "item.updated", "item.completed", "item.delta", "turn.completed"]);

// Normalizes one Codex turn onto AgentEvents and returns what it captured (read via `yield*` by the plan phase,
// discarded by an ordinary turn). `holdMessages` holds agent messages one-deep, flushing each as the next arrives, so
// whatever remains at the end is the plan text.
async function* streamTurn(events: AsyncIterable<CodexEvent>, context: CodexStreamContext): AsyncGenerator<AgentEvent, TurnCapture> {
    const capture: TurnCapture = {};
    const state = streamState();
    // The subagents this turn's multi-agent calls start; their items read as the turn's own do, under their spawn call.
    const subagents = codexSubagents();
    let charged = subagentSpend(subagents);
    const spent = (usage: CodexUsageOf | undefined): AgentEvent[] => {
        if (usage === undefined) {
            return [];
        }
        const delegated = subagentSpend(subagents);
        const frame = usageFrame(usage, delegated, charged);
        charged = delegated;
        return [frame];
    };
    // Once a handed-over wait has been said, the interrupt it caused must not be said again as a failure of its own.
    let handOverSaid = false;
    const handOver = (): AgentEvent[] => {
        if (handOverSaid || context.limitWait?.handedOver() !== true) {
            return [];
        }
        handOverSaid = true;
        capture.errored = true;
        return [handedOverFrame()];
    };
    try {
        yield* streamEvents(events, context, capture, state, subagents, spent, handOver);
    } catch (error) {
        // The interrupt patience sent may end in the app-server being killed: that is the hand-over, not a crash.
        if (context.limitWait?.handedOver() !== true) {
            throw error;
        }
    }
    yield* handOver();
    return capture;
}

// How a failed turn is said: as the hand-over a patience-sent interrupt ended it on, else as its own failure.
const turnFailure = (event: Extract<CodexEvent, { type: "turn.failed" }>, handed: readonly AgentEvent[]): readonly AgentEvent[] =>
    handed.length > 0 ? handed : [failureFrame(event.error.message, event.error.info)];

// Codex's error channel: its frames, whether the turn died, and a rate-limited retry's patience clock started.
function* errorChannel(event: Extract<CodexEvent, { type: "error" }>, context: CodexStreamContext, capture: TurnCapture, state: StreamState): Generator<AgentEvent> {
    const failure = codexError(event, state.retries, context.hosted === true);
    if (failure.limited === true) {
        context.limitWait?.retrying();
    }
    yield* failure.frames;
    capture.errored ||= failure.errored;
}

// The body of streamTurn: every Codex event onto its frames. `handOver` answers the frame a handed-over wait ends on, once.
async function* streamEvents(
    events: AsyncIterable<CodexEvent>,
    context: CodexStreamContext,
    capture: TurnCapture,
    state: StreamState,
    subagents: ReturnType<typeof codexSubagents>,
    spent: (usage: CodexUsageOf | undefined) => AgentEvent[],
    handOver: () => AgentEvent[],
): AsyncGenerator<AgentEvent> {
    const subagentItems = (event: CodexItemEvent): AsyncIterable<AgentEvent> => itemFrames(event, { ...context, holdMessages: false }, {}, state);
    for await (const event of events) {
        if (ANSWERING.has(event.type)) {
            context.limitWait?.answered();
        }
        if (bypassed(event, context)) {
            context.halt?.();
            capture.errored = true;
            yield { kind: "error", message: UNGATED_CALL, own: true };
            continue;
        }
        if (aboutSubagent(event)) {
            yield* codexSubagentFrames(event, subagents, subagentItems);
            continue;
        }
        switch (event.type) {
            case "frame":
                yield event.frame;
                break;
            case "thread.started":
                capture.sessionId = event.thread_id;
                yield { kind: "session", sessionId: event.thread_id };
                break;
            case "item.started":
            case "item.updated":
            case "item.completed":
                yield* itemFrames(event, context, capture, state);
                break;
            case "item.delta":
                yield* deltaFrames(event, context, state);
                break;
            case "user_input.requested":
                yield* codexQuestionCard(event, context);
                break;
            case "command_approval.requested":
            case "file_change_approval.requested":
            case "permissions_approval.requested":
                yield* approvalFrames(event, context, state);
                break;
            case "turn.completed":
                yield* spent(event.usage);
                break;
            case "turn.failed":
                // A failed or interrupted turn still spent what it spent.
                yield* spent(event.usage);
                yield* turnFailure(event, handOver());
                capture.errored = true;
                break;
            case "error":
                yield* errorChannel(event, context, capture, state);
                break;
            default:
                yield* reportFrames(event);
        }
    }
}

// The request a Codex loop runs: the subscription through the translator, or the container's own OPENAI_API_KEY.
type CodexRequest = AgentRequest<CodexCredential>;

// One app-server run of a phase: its prompt and pictures, the thread it resumes, the sandbox it runs in, Codex's own
// collaboration mode, and how it answers approvals. It borrows its own steering channel and closes it on end, so a pause
// between phases keeps queued messages.
interface CodexPhase {
    readonly prompt: string;
    readonly images: readonly string[];
    readonly sessionId: string | undefined;
    readonly sandboxMode: CodexSandboxMode;
    readonly holdMessages: boolean;
    readonly collaborationMode?: "plan" | "default";
    readonly posture: CodexPosture;
}

// What a run's phases share of its gate: the hook configuration each phase writes (no Stop hook while planning), the
// inbox the door's frames arrive in, and the switch that stops a phase whose call ran past the gate.
interface CodexPhaseGate {
    readonly config: (planning: boolean) => Readonly<Record<string, JsonValue>>;
    readonly frames: CodexFrameInbox;
    readonly halted: AbortSignal;
}

const codexPhase = (
    request: CodexRequest,
    runner: CodexRunner,
    turnBase: CodexTurnBase,
    context: Omit<CodexStreamContext, "holdMessages" | "browser" | "posture">,
    browser: Omit<CodexBrowserContext, "sessionId"> | undefined,
    channel: (() => SteeringChannel) | undefined,
    gated: CodexPhaseGate | undefined,
) =>
    async function* (phase: CodexPhase): AsyncGenerator<AgentEvent, TurnCapture> {
        const steering = channel?.();
        // Stops this phase alone when a rate limit is waited out past patience: the turn goes on to say so and is held.
        const handover = new AbortController();
        const waiting = limitWait(() => handover.abort(), limitWaitOptions(request.credential));
        const stops = [request.signal, handover.signal, ...(gated === undefined ? [] : [gated.halted])];
        try {
            return yield* streamTurn(
                runner({
                    prompt: phase.prompt,
                    ...opt("reviewScope", request.spec.reviewScope),
                    ...(phase.images.length > 0 ? { images: phase.images } : {}),
                    ...(phase.sessionId !== undefined ? { sessionId: phase.sessionId } : {}),
                    ...turnBase,
                    ...(gated === undefined
                        ? {}
                        : { config: { ...turnBase.config, ...gated.config(phase.holdMessages) }, requiredMcp: [GATE_SERVER], frames: gated.frames }),
                    ...(steering !== undefined
                        ? {
                              steering: steering.steering,
                              closeSteering: () => {
                                  // Planning lends the queue onward; execution closes admission before terminal yields.
                                  if (phase.holdMessages) {
                                      steering.close();
                                  } else {
                                      request.spec.steering?.close();
                                  }
                              },
                          }
                        : {}),
                    options: threadOptions(request, phase, context.gate?.enforcing === true),
                    signal: AbortSignal.any(stops),
                }),
                {
                    ...context,
                    limitWait: waiting,
                    holdMessages: phase.holdMessages,
                    posture: phase.posture,
                    ...(browser === undefined
                        ? {}
                        : { browser: { ...browser, ...(phase.sessionId === undefined ? {} : { sessionId: phase.sessionId }) } }),
                },
            );
        } finally {
            waiting.dispose();
            // Leaving the channel open would park the steering pump on a promise nothing resolves.
            steering?.close();
        }
    };

// The planning preamble for a turn Codex's own plan mode cannot take (no model to name in its settings): the shared
// wording plus Codex's read-only truth.
const CODEX_PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop: do not execute it yet. " +
    "You are in a read-only sandbox for this turn; end your reply with the plan itself.\n\n";

// Codex honours every permission mode itself (codex-approvals.ts) except the approval card between a plan and its
// execution, which the shared plan loop owns: this is that loop's view of Codex, not its capability row.
const PLAN_LOOP = { permissions: "plan" } as const;

// Plan flow over the shared skeleton: a read-only planning turn in Codex's own plan mode, whose proposed plan becomes the
// plan card, then a full-access execution turn back in its default mode, resumed on the same thread in the mode an
// approved plan moves the conversation to. Without a model to name, plan mode cannot be set, so the planning turn falls
// back to the preamble and its trailing message. Pictures ride only the first planning turn; later turns resume the
// thread that already holds them.
const codexPlan = (request: CodexRequest, phase: ReturnType<typeof codexPhase>): EmulatedPlan => {
    const { images: firstImages, others } = splitAttachments(request.spec.attachments);
    const native = request.spec.model !== undefined && request.spec.model !== "";
    let images: readonly string[] = firstImages;
    return {
        prompt: (native ? "" : CODEX_PLAN_PREAMBLE) + withFileNote(request.spec.prompt, others),
        async *plan(prompt, sessionId) {
            const capture = yield* phase({
                prompt,
                images,
                sessionId,
                sandboxMode: "read-only",
                holdMessages: true,
                ...opt("collaborationMode", native ? ("plan" as const) : undefined),
                posture: "plan",
            });
            images = [];
            return planPhaseOf(capture);
        },
        async *execute(sessionId) {
            // Moves the mode as the Claude loop's approval does, so the composer's chip follows the turn out of planning.
            yield { kind: "mode", mode: POST_PLAN_MODE };
            return yield* phase({
                prompt: EXECUTE_PROMPT,
                images,
                sessionId,
                sandboxMode: "danger-full-access",
                holdMessages: false,
                ...opt("collaborationMode", native ? ("default" as const) : undefined),
                posture: codexPosture(POST_PLAN_MODE, false),
            });
        },
    };
};

// Frames the door's daemon tools push while the turn runs, held until the running phase's app-server loop reads them.
const frameInbox = (): CodexFrameInbox & { readonly push: (event: AgentEvent) => void } => {
    const frames: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    return {
        push: (event) => {
            frames.push(event);
            wake?.();
        },
        take: () => frames.splice(0),
        watch: (next) => {
            wake = next;
            return () => {
                if (wake === next) {
                    wake = undefined;
                }
            };
        },
    };
};

// The run's per-thread hooks and what its phases share of them, where the turn mounted the door's gate.
interface CodexRunGate {
    readonly session: CodexHookSession;
    readonly phase: CodexPhaseGate;
    readonly halt: () => void;
    readonly close: () => Promise<void>;
}

// Attaches the loop to the door's daemon tools (turn-relay.ts): their frames into the stream, the command gate and taint
// bit their consults read, and this run's side of the gate's hooks. No watchdog hold: a Codex turn has none, so a card
// or a child's wait is bounded by the per-server tool timeout and the hook timeout instead (codex-hooks.ts).
const codexRunGate = (request: CodexRequest, guard: { readonly gate: CommandGuard; readonly taint: TurnTaint }): CodexRunGate | undefined => {
    const relay = request.hooks.relay;
    const remote = request.tools.remote ?? [];
    if (relay === undefined || !remote.some((tool) => tool.name === GATE_SERVER)) {
        return undefined;
    }
    const inbox = frameInbox();
    const session = createCodexHookSession({
        cwd: request.spec.cwd,
        isolation: request.spec.isolation,
        conversationId: request.spec.conversationId,
        tools: request.tools,
        editReviewers: request.hooks.editReviewers,
        push: inbox.push,
    });
    const detach = relay.attach({ push: inbox.push, guard, gateHooks: session.gateHooks });
    const halted = new AbortController();
    const allowlist = codexAllowlistConfig(
        request.policy.allowedTools,
        remote.map((tool) => tool.name),
    );
    return {
        session,
        phase: { config: (planning) => ({ ...allowlist, ...codexHooksConfig(session.key, planning) }), frames: inbox, halted: halted.signal },
        halt: () => halted.abort(),
        close: async () => {
            detach();
            await session.dispose();
        },
    };
};

// A turn held to a tool list with no gate to hold it there (a request built without the door's servers) does not run.
export const UNGATED_LIST =
    "This turn carries a tool list, and nothing could hold Codex to it here (the sandbox's policy gate was not mounted), so it was not run.";

interface CodexAgentOptions {
    readonly codexHome: string;
    readonly runner?: CodexRunner;
}

// Codex provider for the Services seam: AgentRequest in, AgentEvent frames out. Browser MCP, steering, question cards,
// approvals and the skill list all come from app-server; daemon-side SDK servers and plugins stay absent.
export const createCodexAgent = (options: CodexAgentOptions) => {
    const runner = options.runner ?? createCodexAppServerRunner();
    return async function* runCodexAgent(request: CodexRequest): AsyncGenerator<AgentEvent> {
        // The sandbox-wide CODEX_HOME; a subscription turn's bearer rides CODEX_API_KEY instead.
        const activeCodexHome = options.codexHome;
        const inherited = codexEnv(activeCodexHome, request.tools.cliEnv, request.spec.conversationId);
        // Its shell's programs judged by the heavy table, as a Claude Code turn's are, installs in the install lane.
        const env = { ...inherited, ...(await vendorShellEnv(request.tools, inherited)) };
        // The question tool, Codex's own AGENTS.md loader switched off, and the turn's MCP servers, merged under the
        // translator provider block, not over, so a future key added to either side can't silently win.
        const runtimeConfig = { ...QUESTION_TOOL_CONFIG, ...PROJECT_DOC_CONFIG, ...codexMcpConfig(request.tools) };
        const credential = request.credential;
        const anchor = request.spec.isolation?.anchor;
        const turnBase: CodexTurnBase = {
            ...(credential.kind === "codex-endpoint"
                ? {
                      env: { ...env, CODEX_API_KEY: credential.authToken },
                      ...withRuntimeConfig(endpointProvider(credential), runtimeConfig),
                  }
                : // The container's own key, handed over by name: the daemon's environment no longer holds it (sealed-env.ts).
                  { env: { ...env, ...containerKeyEnv("codex") }, config: runtimeConfig }),
            // Anchors an isolated turn's worktree at /work for app-server and its forks; absent, the turn just runs
            // cwd'd.
            ...(anchor === undefined ? {} : { namespace: { pid: anchor.pid, cwd: anchor.cwd, ...opt("namespace", anchor.namespace) } }),
            ...opt("spawnDepth", request.spec.spawnDepth),
            // Owner's system prompt and the daemon's additions, as thread/start's own two fields.
            instructions: codexInstructions(request.spec),
        };
        // request.spec.cwd is this conversation's own checkout; the shared root would misplace an isolated turn's image.
        const imageArtifacts = { workspaceRoot: request.spec.cwd, codexHome: activeCodexHome };
        const browser =
            request.tools.browserPorts === undefined
                ? undefined
                : {
                      ports: request.tools.browserPorts,
                      passkeys: request.tools.browserPasskeys ?? {},
                      accounts: request.tools.browserAccounts ?? {},
                      ...(request.spec.conversationId === undefined ? {} : { owner: request.spec.conversationId }),
                  };
        // This run's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const channel = request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering);
        // One gate for the whole run, so an "always" from planning still holds while executing.
        const { gate, taint, release } = vendorTurnGate(request);
        const runGate = codexRunGate(request, { gate, taint });
        if (runGate === undefined && request.policy.allowedTools !== undefined) {
            release();
            yield { kind: "error", message: UNGATED_LIST, own: true };
            yield { kind: "done" };
            return;
        }
        // The run's per-tool cards: one set of "don't ask again" answers for every phase of it.
        const owner: OwnerApprovals = {
            cards: request.hooks.cards,
            ...opt("conversationId", request.spec.conversationId),
            signal: request.signal,
            ...opt("restoredGrant", request.hooks.restoredGrant),
            always: new Set(),
        };
        const context: Omit<CodexStreamContext, "holdMessages" | "browser" | "posture"> = {
            cwd: request.spec.cwd,
            cards: request.hooks.cards,
            imageArtifacts,
            ...opt("browserOutputDir", request.tools.browserOutputDir),
            signal: request.signal,
            gate,
            owner,
            taint,
            ...opt("hooks", runGate?.session),
            ...opt("halt", runGate?.halt),
            ...opt("conversationId", request.spec.conversationId),
            ...opt("hosted", hostedTurn(credential)),
        };
        const { images, others } = splitAttachments(request.spec.attachments);
        const phase = codexPhase(request, runner, turnBase, context, browser, channel, runGate?.phase);
        // One whole attempt at the turn: a retry runs a new app-server, and the steering channel each phase borrows dies
        // with the process it was borrowed for.
        const runAttempt = (): AsyncGenerator<AgentEvent> =>
            planMode(
                PLAN_LOOP,
                request,
                () => codexPlan(request, phase),
                () =>
                    phase({
                        prompt: withFileNote(request.spec.prompt, others),
                        images,
                        sessionId: request.spec.sessionId,
                        sandboxMode: "danger-full-access",
                        holdMessages: false,
                        posture: codexPosture(request.policy.permissionMode, false),
                    }),
            );
        // The failure this run has already put in front of the user, carried across attempts: Codex reports one failure
        // on both of its channels and then dies, and no repeat of it may redden the turn again.
        let surfaced: string | undefined;
        try {
            for (let attempt = 1; ; attempt += 1) {
                const outcome = yield* consumeAttempt(runAttempt(), attempt, surfaced);
                surfaced = outcome.surfaced;
                if (outcome.waitMs === undefined) {
                    break;
                }
                yield { kind: "provider_retry", attempt, maxAttempts: UPSTREAM_ATTEMPTS, nextAttemptAt: Date.now() + outcome.waitMs };
                // Waits out the backoff, and stops waiting the moment the turn is cancelled: a turn nobody is waiting
                // for must not hold the run open for the rest of its wait.
                await sleep(outcome.waitMs, { signal: request.signal });
                // A turn cancelled while it waited has no second attempt to run.
                if (request.signal?.aborted === true) {
                    break;
                }
            }
        } finally {
            // This turn's outside-content bit dies with it, so the next turn starts clean unless it takes something in
            // too, and a card an approval request left open (the app-server died, or moved on) is settled.
            await runGate?.close();
            release();
        }
        yield { kind: "done" };
    };
};
