// Normalizes the SDK's message stream onto AgentEvents: sdkTurns finds the turn boundary in streaming-input mode, and
// TurnFold maps each message onto typed frames. An SDK message with no mapping is dropped; the terminal `done` frame is
// emitted by runAgent, not here.
import type { Options, Query, SDKAssistantMessage, SDKMessage, SDKUserMessage, SlashCommand, TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import { within } from "@intentic/base/async";
import { sdk } from "../../engines/claude-sdk.js";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { FastModeState } from "@intentic/sandbox-contract/schemas/providers/fast-mode";
import { type PermissionMode, PermissionModeSchema } from "@intentic/sandbox-contract/schemas/agent";
import type { PromptFingerprint } from "@intentic/sandbox-contract/schemas/keep-warm";
import type { TodoItem } from "@intentic/sandbox-contract/events/requests";
import type { UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { agentSessionName, browserSessionName } from "@intentic/sandbox-contract/session-names";
import { browserServerOfTool } from "../../browser/sessions/browser-sessions.js";
import { localCommandText, unknownCommandName } from "../providers/agent-commands.js";
import type { SteeringQueue } from "../checkpoints/agent-steering.js";
import { contextOverflowFrame, errorFrame, modelUnavailableFrame, rateLimitFrame, retryStormFrame, safeguardFrame, trialRetryFrame } from "./error-frames.js";
import { isSafeguardRefusal, RefusalFork } from "./refusal-fork.js";
import { InformationalLines } from "./informational.js";
import { probeRoutedEndpoint, type RoutedEndpoint } from "../providers/routed-refusal.js";
import type { TurnAllowance } from "../providers/harness-credentials.js";
import { opt } from "../../opt.js";
import { type CacheCreationBuckets, ttlFromCacheCreation } from "./turn/prompt-cache.js";
import { noteRetryCause } from "./turn/turn-pulse.js";
import { promptFingerprint } from "./prompt-fingerprint.js";
import { noteSubagentSpawn, noteSubagentTask, type SubagentTaskMessage, type SubagentTurn } from "../subagents/subagents.js";
import { endJobTheCliStopped, noteJobNotice, noteJobShell, noteModelRequest } from "../tools/jobs/background-jobs.js";
import { TaskChecklist } from "../../sessions/vocabulary/task-checklist.js";
import { PageDrafts } from "../pages/page-draft.js";
import { PAGE_TOOL_NAMES } from "../pages/page-names.js";
import type { ChecklistSeed } from "./task-store.js";
import { displayNameOf, toolCategoryOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { type CalledTool, editDiffContent, mayShowPicture, resultContent, toolInput, toolLocations } from "../../sessions/vocabulary/tool-calls.js";

// What a turn needs from the SDK: the message stream and the session's slash-command list. `supportedCommands` is
// optional since a fake stream used in tests has none.
export type AgentQuery = AsyncIterable<SDKMessage> & {
    readonly supportedCommands?: () => Promise<readonly SlashCommand[]>;
    // Stops the running request loop where it stands; the stream still ends on its own result.
    readonly interrupt?: Query["interrupt"];
};

// The SDK `query` injected so tests can drive a fake message stream with no API calls and no bundled binary.
export type QueryFn = (args: { readonly prompt: string | AsyncIterable<SDKUserMessage>; readonly options: Options }) => AgentQuery;
export const defaultQuery: QueryFn = (args) => sdk().query(args);

// Maps the SDK's slash commands onto the composer's `/` popover shape. `argumentHint` is always a string on the SDK
// side; empty means no hint.
const commandFrame = (commands: readonly SlashCommand[]): AgentEvent => ({
    kind: "commands",
    items: commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint !== "" ? { hint: command.argumentHint } : {}),
    })),
});

// The turn's prompt input: a steerable turn streams user messages (the prompt, then whatever the steer route pushes
// until the queue closes); an unsteerable turn keeps single-message mode.
export const promptInput = (prompt: string, steering: SteeringQueue | undefined): string | AsyncIterable<SDKUserMessage> =>
    steering === undefined ? prompt : steeredInput(prompt, steering);

async function* steeredInput(first: string, steering: SteeringQueue): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null };
    for await (const text of steering) {
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
}

// Grace window after a steered result: a message means another turn is coming; silence means the stream ended.
const STEER_GRACE_MS = 1000;

// How long a CLI whose input closed gets to start the one turn it can still owe (a steer that raced the close, a child's
// notification) while only work that outlives the turn is live. Seconds against what it otherwise waits: print mode holds
// a CLI open for its background shells until each one's own time limit (thirty minutes by default), then wakes the model
// to say it stopped them, and the turn read as running all that time. On 2026-10-12 a finished turn sat nine minutes,
// and another twenty-eight, behind a demo server, for a stop that stopped nothing (tmux-run outlives that signal), and
// the server's watch then held the land. The shell is the daemon's job, judged when the turn ends (job-fates.ts).
const OUTLIVED_GRACE_MS = 10_000;

// How long an instant empty result waits for the CLI to start a run of its own before the prompt reads as swallowed
// and is redelivered. A resume that wakes to a stale background-task notice ends that wake's run empty, and the CLI
// almost always goes straight on to answer the prompt: of 48 redeliveries in the ten days to 2026-10-12, all 48 were
// answered twice, so the agent replied twice, and the copy made the turn read as steered, which (before
// OUTLIVED_GRACE_MS) held a finished turn open behind its demo server for nine minutes and for twenty. A run's first
// frame arrives within seconds of its request; a prompt the CLI did drop costs this wait before it goes again.
const SWALLOW_WAIT_MS = 10_000;

const nextWithinGrace = async (next: Promise<IteratorResult<SDKMessage, void>>): Promise<IteratorResult<SDKMessage, void> | undefined> =>
    within(next, STEER_GRACE_MS, undefined);

// Task types the turn need not wait for at stream end, since each outlives the process or never ends; anything else is
// waited on by default:
// local_bash a backgrounded shell in the daemon's own tmux session, independent of the turn
// monitor_ws ambient for the life of the session
// monitor_mcp the same
// remote_agent runs on the provider's side, not in this process
const UNHELD_TASK_TYPES: ReadonlySet<string> = new Set(["local_bash", "monitor_ws", "monitor_mcp", "remote_agent"]);

// The shell id the model was given for a background job, that its completion notice is queued, and that the CLI stopped
// it by itself (its time limit, memory running short), which only the sandbox can make true (endJobTheCliStopped). Not
// once the turn's input has ended (`steering`, closed): a CLI that stops its shells then is ending, and what its turn left
// running is the turn's ending to judge (job-fates.ts), not this stop's.
const noteBashTask = (turn: SubagentTurn, message: SubagentTaskMessage, steering: SteeringQueue | undefined): void => {
    if (message.subtype === "task_started" && message.task_type === "local_bash" && message.tool_use_id !== undefined && message.task_id !== undefined) {
        noteJobShell(turn.conversations, message.tool_use_id, message.task_id);
    }
    if (message.subtype === "task_notification" && message.task_id !== undefined) {
        noteJobNotice(turn.conversations, message.task_id);
        if (message.status === "stopped" && steering?.ended !== true) {
            // Not awaited: the fold must not stall on a process group's grace. The stop marks the job stopped before
            // its first await, so the turn's ending already reads it as stopped, and a stop that failed after that
            // leaves a job no wake waits on and no land is held by, which a person can still stop from its row.
            // allow(silent-catch): no logger reaches the fold, and what a failed stop leaves is said above.
            void endJobTheCliStopped(turn.conversations, message.task_id)?.catch(() => undefined);
        }
    }
};

// Consecutive refusals before ending the turn for the breaker (provider-health.ts) instead of spinning.
const MAX_IN_TURN_RETRIES = 8;

// The CLI's endings for a session its window can no longer hold, compaction included; resuming it ends there again.
const OVERFLOW_ENDINGS: ReadonlySet<TerminalReason> = new Set<TerminalReason>(["prompt_too_long", "blocking_limit", "rapid_refill_breaker"]);

// Live background work off the SDK's own level signal (replace semantics; a missed edge can't wedge a stale hold): the
// in-process work the boundary waits for, and the work that outlives the turn (UNHELD_TASK_TYPES). Undefined on every
// other message, so the caller keeps its last counts.
const taskCounts = (message: SDKMessage): { readonly held: number; readonly outliving: number } | undefined => {
    if (message.type !== "system" || message.subtype !== "background_tasks_changed") {
        return undefined;
    }
    const outliving = message.tasks.filter((task) => UNHELD_TASK_TYPES.has(task.task_type)).length;
    return { held: message.tasks.length - outliving, outliving };
};

// A main-thread turn frame; only the idle gaps between turns race the grace window. A child's own frames (parented)
// keep arriving throughout a hold and must not read as a turn underway.
// `init` opens a wake turn before its model answers; an input closed in that wait refuses the turn's first tool call.
const isMainTurnFrame = (message: SDKMessage): boolean =>
    (message.type === "system" && message.subtype === "init") ||
    ((message.type === "assistant" || message.type === "stream_event" || message.type === "user") && message.parent_tool_use_id === null);

// Whether the CLI produced anything at all, model output, a child's, or a local slash command's; separates a turn that
// legitimately called nothing from one that swallowed its prompt.
const isWorkFrame = (message: SDKMessage): boolean =>
    message.type === "assistant" || message.type === "stream_event" || (message.type === "system" && message.subtype === "local_command_output");

// Where a stream stands between its frames, as the turn boundary reads it.
interface Boundary {
    // A result passed on a steered stream: the next idle gap decides follow-up turn vs. turn-stream-over.
    awaitingNextTurn: boolean;
    // Live in-process background work off the latest level signal; counts only what the boundary waits for.
    heldTasks: number;
    // Live work that outlives the turn, off the same signal: what a CLI whose input closed holds itself open for.
    outlivingTasks: number;
    // The input was closed by a grace that passed in silence; the CLI owes at most a turn that raced the close.
    inputClosed: boolean;
    // A result passed while children were live: the stream is held open for the CLI's wake turn.
    held: boolean;
    // A main-thread model frame seen since the last result (see isMainTurnFrame).
    midTurn: boolean;
    // Anything produced since the last result (see isWorkFrame).
    sawWork: boolean;
    // An instant empty result held back until the CLI shows whether it goes on to answer the prompt (emptyWake), and
    // the Date.now() past which its silence reads as the prompt swallowed.
    suspect: { readonly result: SdkOf<"result">; readonly until: number } | undefined;
}

// How the boundary waits for the next frame once no empty result is held (sdkTurns waits that one out first): a grace
// window, whose silence closes the input (both parks end alike; `held` is always false while awaitingNextTurn is set); a
// closed input's last window, whose silence ends the stream; or as long as it takes.
const waitOf = (at: Boundary): "grace" | "outlived" | "plain" => {
    const quiet = !at.midTurn && at.heldTasks === 0;
    if (at.awaitingNextTurn || (at.held && quiet)) {
        return "grace";
    }
    // Silence here is the CLI holding itself open for work that outlives the turn, not a turn to come.
    return at.inputClosed && quiet && at.outlivingTasks > 0 ? "outlived" : "plain";
};

// Folds one frame into where the stream stands.
const noteFrame = (at: Boundary, message: SDKMessage): void => {
    const counts = taskCounts(message);
    at.heldTasks = counts?.held ?? at.heldTasks;
    at.outlivingTasks = counts?.outliving ?? at.outlivingTasks;
    at.midTurn ||= isMainTurnFrame(message);
    at.sawWork ||= isWorkFrame(message);
};

// A prompt that may have been swallowed, given a result with no work behind it: an instant empty success. The CLI woke
// on a stale notice and ended that run empty; whether it then dropped the queued prompt or goes on to answer it, only
// what follows says (SWALLOW_WAIT_MS). The caller skips it while held for a wake turn.
const emptyWake = (message: SdkOf<"result">, steering: SteeringQueue | undefined, redeliver: (() => boolean) | undefined): boolean =>
    message.subtype === "success" && message.num_turns === 0 && steering?.delivered === 0 && redeliver !== undefined;

// The CLI at work after a held empty result: a run of its own under way, or another result. Ambient frames (a
// background task's progress, a settings echo) say nothing about the prompt and leave the wait running.
const runUnderway = (message: SDKMessage): boolean => message.type === "result" || isMainTurnFrame(message) || isWorkFrame(message);

// What a yielded result leaves the boundary waiting on: children still live hold the stream for the CLI's wake turn, a
// steered stream races the grace window for a follow-up turn, and anything else ends the stream (true).
const afterResult = (at: Boundary, steering: SteeringQueue | undefined): boolean => {
    at.held = at.heldTasks > 0;
    if (at.held) {
        return false;
    }
    if (steering === undefined || steering.delivered === 0) {
        // Closed before returning so a steer racing this result reports undelivered rather than queuing forever.
        steering?.close();
        return true;
    }
    at.awaitingNextTurn = true;
    return false;
};

// One wait for the next frame, as the boundary stands: a frame to fold; silence that moved the boundary, after which
// the same pending frame is waited on again; a held empty result that is the turn's answer after all (`last` when the
// stream ended behind it); or the stream's end.
type NextFrame =
    | { readonly kind: "frame"; readonly message: SDKMessage }
    | { readonly kind: "again" }
    | { readonly kind: "answer"; readonly result: SdkOf<"result">; readonly last: boolean }
    | { readonly kind: "end" };

// A held empty result's window: the CLI starting a run of its own clears it (the prompt was taken, and the result was
// the stale wake's), silence redelivers the prompt once, and a prompt that cannot go again leaves the empty answer.
const waitOutSuspect = async (
    at: Boundary,
    suspect: NonNullable<Boundary["suspect"]>,
    next: Promise<IteratorResult<SDKMessage, void>>,
    redeliver: (() => boolean) | undefined,
): Promise<NextFrame> => {
    const step = await within(next, Math.max(0, suspect.until - Date.now()), undefined);
    if (step !== undefined && step.done !== true) {
        if (runUnderway(step.value)) {
            at.suspect = undefined;
        }
        return { kind: "frame", message: step.value };
    }
    at.suspect = undefined;
    if (step === undefined && redeliver?.() === true) {
        at.awaitingNextTurn = true;
        return { kind: "again" };
    }
    return { kind: "answer", result: suspect.result, last: step !== undefined };
};

const nextFrame = async (
    at: Boundary,
    next: Promise<IteratorResult<SDKMessage, void>>,
    steering: SteeringQueue | undefined,
    redeliver: (() => boolean) | undefined,
): Promise<NextFrame> => {
    if (at.suspect !== undefined) {
        return waitOutSuspect(at, at.suspect, next, redeliver);
    }
    const wait = waitOf(at);
    let step: IteratorResult<SDKMessage, void> | undefined;
    if (wait === "grace") {
        at.awaitingNextTurn = false;
        step = await nextWithinGrace(next);
        if (step === undefined) {
            at.held = false;
            steering?.close();
            at.inputClosed = true;
            return { kind: "again" };
        }
    } else if (wait === "outlived") {
        // Its close (iterator.return, in sdkTurns) ends the CLI, which nothing outliving the turn goes with.
        step = await within(next, OUTLIVED_GRACE_MS, undefined);
    } else {
        step = await next;
    }
    return step === undefined || step.done === true ? { kind: "end" } : { kind: "frame", message: step.value };
};

// Ends the SDK stream at the right turn boundary: unsteered streams end at the first result; once steered, a result
// arms the grace race, and one with children still live holds the stream for the CLI's wake turn. A CLI whose input
// closed and that holds itself open only for work outliving the turn is let go after a last window. An instant empty
// result is held until the CLI shows whether it took the prompt (emptyWake).
async function* sdkTurns(
    stream: AsyncIterable<SDKMessage>,
    steering: SteeringQueue | undefined,
    // Push the turn's prompt back through streaming input once; true means the stream ends normally at its result.
    redeliver: (() => boolean) | undefined,
): AsyncGenerator<SDKMessage> {
    const iterator = stream[Symbol.asyncIterator]();
    const at: Boundary = {
        awaitingNextTurn: false,
        heldTasks: 0,
        outlivingTasks: 0,
        inputClosed: false,
        held: false,
        midTurn: false,
        sawWork: false,
        suspect: undefined,
    };
    // A pending next() that lost a window's race is re-awaited on the following pass, never abandoned.
    let pending: Promise<IteratorResult<SDKMessage, void>> | undefined;
    try {
        for (;;) {
            const next = pending ?? iterator.next();
            pending = undefined;
            const got = await nextFrame(at, next, steering, redeliver);
            if (got.kind === "end") {
                return;
            }
            if (got.kind === "again") {
                pending = next;
                continue;
            }
            if (got.kind === "answer") {
                yield got.result;
                if (got.last || afterResult(at, steering)) {
                    return;
                }
                pending = next;
                continue;
            }
            const message = got.message;
            noteFrame(at, message);
            if (message.type !== "result") {
                yield message;
                continue;
            }
            at.midTurn = false;
            const idle = !at.sawWork;
            at.sawWork = false;
            if (!at.held && idle && emptyWake(message, steering, redeliver)) {
                at.suspect = { result: message, until: Date.now() + SWALLOW_WAIT_MS };
                continue;
            }
            yield message;
            if (afterResult(at, steering)) {
                return;
            }
        }
    } finally {
        await iterator.return?.();
    }
}

// Modes the contract models; the SDK also resolves 'dontAsk'/'auto' from settings, which have no UI here.
const PERMISSION_MODES = new Set<PermissionMode>(PermissionModeSchema.options);

/* THE POSTURE THE SESSION IS ACTUALLY IN, shared with the permission gate. The CLI moves a session itself
 * (EnterPlanMode, `init`, `status`), so a gate reading only the mode the turn was launched in decides on a mode the
 * session left. Written here, at the frame that announces the move, and read in agent.ts's canUseTool. */
export interface TurnPosture {
    mode: PermissionMode;
}

// Every input streamSdk folds, named at its one call site (runAgent); each field's comment says why it can be absent.
export interface StreamSdkArgs {
    readonly queryFn: QueryFn;
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
    readonly options: Options;
    readonly cwd: string;
    readonly tmuxEnabled: boolean;
    // Where this turn's browser artifacts land; absent on a turn with no browser tools at all.
    readonly browserOutputDir: string | undefined;
    readonly steering: SteeringQueue | undefined;
    // The swallowed-prompt recovery sdkTurns fires (see its result branch); absent on an unsteerable turn.
    readonly redeliver: (() => boolean) | undefined;
    // Reads the credential's plan-limit pools at turn settle; absent when the credential has no pools to read.
    readonly readUsage: (() => Promise<UsageWindow[]>) | undefined;
    // Whose allowance this turn spends and when it reopens; absent on a native Claude turn (see TurnAllowance).
    readonly allowance: TurnAllowance | undefined;
    // The translator endpoint on a routed turn only, so a retry storm can ask what it is (routed-refusal.ts).
    readonly routed: RoutedEndpoint | undefined;
    // A platform-owned trial turn has already walked its whole key pool before a retry reaches this stream.
    readonly trial: boolean;
    // The turn handle children are filed under; absent ⇒ no conversation to file them against (the bench).
    readonly subagents: SubagentTurn | undefined;
    // The checklist the resumed session already holds (task-store.ts); adopted once the fold sees the session id.
    readonly checklistSeed: ChecklistSeed | undefined;
    // What the resumed session already spent (carried-cost.ts), which its first result counts again; 0 when fresh.
    readonly carriedCostUsd: number;
    // The live permission posture, seeded with the turn's own mode; mutated here and read by the gate.
    readonly posture: TurnPosture;
}

type SdkOf<T extends SDKMessage["type"]> = Extract<SDKMessage, { type: T }>;

// A tool_use block that can be correlated to its result; real streams always carry an id and a name.
interface ToolUseBlock {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
}

// One request's accounting, as `message_start` reports it: the Messages API usage object, of which the SDK's own types
// name only the totals. `cache_creation` is the per-TTL split of `cache_creation_input_tokens`.
interface RequestUsage {
    readonly input_tokens?: number;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
    readonly cache_creation?: CacheCreationBuckets | null;
}

const toolUseOf = (block: { type: string; id?: string; name?: string; input?: unknown }): ToolUseBlock | undefined =>
    block.type === "tool_use" && typeof block.name === "string" && block.id !== undefined
        ? { id: block.id, name: block.name, input: block.input }
        : undefined;

// An explicit `run_in_background: false` is the only shape that blocks the turn on the call.
// A tier is never resolved to a version here; the harness decides which build it names.
const spawnedAgent = (input: unknown): { readonly background: boolean; readonly model?: string } => {
    const spec = input as { run_in_background?: unknown; model?: unknown } | undefined;
    return {
        background: spec?.run_in_background !== false,
        ...(typeof spec?.model === "string" ? { model: spec.model } : {}),
    };
};

// One turn's worth of fold state, everything the messages accumulate between the first frame and the last. A class
// rather than closure variables so each message type's handler reads as its own unit.
class TurnFold {
    private readonly args: StreamSdkArgs;
    // Bound rather than consumed as a bare AsyncIterable: also reads the slash-command list at `init` (onSystem).
    private readonly session: AgentQuery;
    private sessionSent = false;
    // Whether this turn already probed its routed endpoint; asked once per turn (endRetrying).
    private routedProbed = false;
    // The terminal surfaces at the first Bash tool_use and again at its result, in case tmux-run lagged behind.
    private terminalSent = false;
    private terminalResurfaced = false;
    private agentSession: string | undefined;
    // Named once at the first browser call so the client can offer to watch; PreToolUse registers the session.
    private browserSent = false;
    private readonly bashToolIds = new Set<string>();
    // Calls whose answer can be a picture (mayShowPicture), by tool_use id, read against their result.
    private readonly pictureCalls = new Map<string, CalledTool>();
    // tool_use ids whose call already carried the diff; a redundant 'file updated' result must not replace it.
    private readonly diffToolIds = new Set<string>();
    // The agent's working checklist, rebuilt from the Task tool family; the list itself is their render.
    private readonly checklist = new TaskChecklist();
    private inheritedChecklist: TodoItem[] | undefined;
    private readonly checklistToolIds = new Set<string>();
    // Task ids made by a subagent (onChecklistCall), kept off this conversation's list like any checklist verb.
    private readonly foreignChecklistToolIds = new Set<string>();
    // Context fill: message_start reports input size, the result reports the model's window; paired at result.
    private contextTokens: number | undefined;
    private contextModel: string | undefined;
    // The prompt cache's clock: when the last main-thread request touched it, and the TTL that request's write went in
    // under. The TTL outlives a read-only request, which refreshes the entry without saying how long it now lives.
    private cachedAt: number | undefined;
    private cacheTtlMs: number | undefined;
    // The stream's first main-thread request against the cache: what a resume found there.
    private opening: { readonly read: number; readonly written: number } | undefined;
    private fingerprint: PromptFingerprint | undefined;
    // A block's stop always precedes its assistant frame, so introduced tool calls render after it, not before.
    private readonly textBlocks = new Map<string, number>();
    // Fast-mode speed, de-duplicated on the (state, reason) pair, since a changing reason alone is informative.
    private fastReported: string | undefined;
    // The query's running total as of the last result, in USD: the SDK reports that total, a frame only its growth.
    private spentUsd: number;
    // Whether this turn already said its session outgrew the window; the result's ending repeats the assistant's error.
    private overflowed = false;
    // Where a turn the safety classifier stops can resume from, and whether it has stopped: said once, and the interrupted
    // result after it is that same ending, not another.
    private readonly fork = new RefusalFork();
    // The loop's informational lines this turn, onto the agent UI lane (informational.ts).
    private readonly informational = new InformationalLines();
    // Pages the main thread is writing, drawn in the chat as their markup streams in.
    private readonly pageDrafts = new PageDrafts((name) => PAGE_TOOL_NAMES.has(name));
    private flagged = false;

    constructor(args: StreamSdkArgs, session: AgentQuery) {
        this.args = args;
        this.session = session;
        this.spentUsd = args.carriedCostUsd;
    }

    // One SDK message onto its frames; returns true when the message ends the whole stream (a terminal rate_limit
    // mid-retry). Any message type with no mapping is dropped silently.
    async *onMessage(message: SDKMessage): AsyncGenerator<AgentEvent, boolean> {
        const sessionId = (message as { session_id?: string }).session_id;
        if (!this.sessionSent && typeof sessionId === "string" && sessionId !== "") {
            this.sessionSent = true;
            yield { kind: "session", sessionId };
            this.adoptChecklist(sessionId);
        }
        this.fork.note(message);
        // Frames produced inside a subagent (Task tool) carry its id so the UI can group them.
        const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
        switch (message.type) {
            case "stream_event":
                yield* this.onStreamEvent(message, parent);
                return false;
            case "assistant":
                yield* this.onAssistant(message, sessionId, parent);
                return false;
            case "user":
                yield* this.onToolResults(message);
                return false;
            case "system":
                return yield* this.onSystem(message, parent);
            case "rate_limit_event":
                yield* this.onRateLimitInfo(message);
                return false;
            case "result":
                yield* this.onResult(message);
                return false;
            default:
                return false;
        }
    }

    /* Folds `init`, `status` and the tool-call-only EnterPlanMode onto one posture, and announces each move. The
     * posture is shared with the permission gate, so it must be written before the frame is handed on: the CLI can ask
     * about the next tool while the consumer is still draining this one. */
    private modeChange(next: PermissionMode | undefined): AgentEvent | undefined {
        if (next === undefined || next === this.args.posture.mode || !PERMISSION_MODES.has(next)) {
            return undefined;
        }
        this.args.posture.mode = next;
        return { kind: "mode", mode: next };
    }

    private fastModeChange(state: FastModeState | undefined, reason: string | undefined): AgentEvent | undefined {
        if (state === undefined) {
            return undefined;
        }
        const reported = `${state}:${reason ?? ""}`;
        if (reported === this.fastReported) {
            return undefined;
        }
        this.fastReported = reported;
        return { kind: "fast_mode", state, ...opt("reason", reason) };
    }

    // Token deltas, text and extended thinking both arrive here since partial messages are enabled. Each request's
    // message_start also reports usage, the current context-window fill.
    private *onStreamEvent(message: SdkOf<"stream_event">, parent: string | undefined): Generator<AgentEvent> {
        const event = message.event as {
            type: string;
            index?: number;
            content_block?: { type?: string; id?: string; name?: string };
            delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
            message?: {
                model?: string;
                usage?: RequestUsage;
            };
        };
        // A page the main thread is writing streams to the chat as it is written (agent/pages/page-draft.ts).
        if (parent === undefined) {
            yield* this.pageDraftFrames(event);
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
            yield* this.showInheritedChecklist();
            yield { kind: "delta", text: event.delta.text, ...opt("parentToolUseId", parent) };
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
            yield* this.showInheritedChecklist();
            yield { kind: "thinking", text: event.delta.thinking, ...opt("parentToolUseId", parent) };
        } else if (event.type === "content_block_start" && event.content_block?.type === "text" && event.index !== undefined) {
            this.textBlocks.set(parent ?? "", event.index);
        } else if (event.type === "content_block_stop" && event.index !== undefined && this.textBlocks.get(parent ?? "") === event.index) {
            this.textBlocks.delete(parent ?? "");
            yield { kind: "text_end", ...opt("parentToolUseId", parent) };
        } else if (event.type === "message_start" && event.message?.usage !== undefined) {
            this.noteRequest(parent);
            // Full input sent for this request = the context fill right now (input + both cache buckets).
            const usage = event.message.usage;
            this.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            this.contextModel = event.message.model;
            this.notePromptCache(usage, parent);
            if (parent === undefined && this.opening === undefined) {
                this.opening = { read: usage.cache_read_input_tokens ?? 0, written: usage.cache_creation_input_tokens ?? 0 };
                yield { kind: "prompt_cache", readTokens: this.opening.read, writtenTokens: this.opening.written };
            }
        }
    }

    private *pageDraftFrames(event: {
        readonly type: string;
        readonly index?: number;
        readonly content_block?: { type?: string; id?: string; name?: string };
        readonly delta?: { type: string; partial_json?: string };
    }): Generator<AgentEvent> {
        if (event.type === "message_start") {
            this.pageDrafts.reset();
        } else if (event.type === "content_block_start" && event.index !== undefined && event.content_block !== undefined) {
            this.pageDrafts.start(event.index, event.content_block);
        } else if (event.type === "content_block_delta" && event.index !== undefined && event.delta?.type === "input_json_delta") {
            yield* this.pageDrafts.delta(event.index, event.delta.partial_json ?? "");
        } else if (event.type === "content_block_stop" && event.index !== undefined) {
            yield* this.pageDrafts.stop(event.index);
        }
    }

    // Only a main-thread request reads this conversation's queued completion notices.
    private noteRequest(parent: string | undefined): void {
        if (parent === undefined && this.args.subagents !== undefined) {
            noteModelRequest(this.args.subagents.conversations, this.args.subagents.conversationId);
        }
    }

    // The main thread's cache only: a subagent works a prefix of its own, whose entry expiring costs this conversation
    // nothing. A request that neither read nor wrote cache moves no clock, so a turn running with caching switched off
    // publishes no deadline rather than one nothing is keeping.
    private notePromptCache(usage: RequestUsage, parent: string | undefined): void {
        if (parent !== undefined || ((usage.cache_read_input_tokens ?? 0) === 0 && (usage.cache_creation_input_tokens ?? 0) === 0)) {
            return;
        }
        this.cachedAt = Date.now();
        this.cacheTtlMs = ttlFromCacheCreation(usage.cache_creation ?? undefined) ?? this.cacheTtlMs;
    }

    // Text and thinking already streamed as deltas above; here only tool calls surface (including checklist verbs,
    // rendered as their own live list).
    private async *onAssistant(message: SDKAssistantMessage, sessionId: unknown, parent: string | undefined): AsyncGenerator<AgentEvent> {
        if (message.error !== undefined && parent === undefined && isSafeguardRefusal(message)) {
            yield* this.onFlagged(message);
            return;
        }
        if (message.error !== undefined) {
            const failure = await errorFrame(message, this.args.allowance, this.args.trial);
            this.overflowed ||= failure.code === "context-overflow";
            yield failure;
            return;
        }
        yield* this.showInheritedChecklist();
        const content = message.message.content as ReadonlyArray<{ type: string; id?: string; name?: string; input?: unknown }>;
        for (const block of content) {
            const call = toolUseOf(block);
            if (call !== undefined) {
                yield* this.onToolUse(call, sessionId, parent);
            }
        }
    }

    // The safety classifier stopped the turn: said once, held for a person (classify-failure.ts), and the CLI interrupted,
    // since left alone it answers the stopped response's tool call and asks again into the same refusal, over and over
    // (a real CLI sent 18 more requests in half a second). The stream then ends on the interrupted run's own result.
    private async *onFlagged(message: SDKAssistantMessage): AsyncGenerator<AgentEvent> {
        if (this.flagged) {
            return;
        }
        this.flagged = true;
        yield safeguardFrame(message, this.fork.point());
        // allow(silent-catch): a CLI that cannot take the interrupt still ends the turn on its result, only later.
        await this.session.interrupt?.().catch(() => undefined);
    }

    private *onToolUse(block: ToolUseBlock, sessionId: unknown, parent: string | undefined): Generator<AgentEvent> {
        // The checklist renders as one live list, not tool cards, so status flips don't bury the transcript.
        if (block.name === "TaskCreate" || block.name === "TaskList" || block.name === "TaskUpdate") {
            yield* this.onChecklistCall(block, parent);
            return;
        }
        // The only signal for entering plan mode; ExitPlanMode isn't mirrored, since approval picks the landing mode.
        if (block.name === "EnterPlanMode") {
            const changed = this.modeChange("plan");
            if (changed !== undefined) {
                yield changed;
            }
        }
        // `Agent` is the SDK's own tool name; a spawn is noted only when there is a registry to file it in.
        // Foreground calls are noted too, since a call can name a model without backgrounding.
        if (block.name === "Agent" && this.args.subagents !== undefined) {
            noteSubagentSpawn(this.args.subagents.conversations, block.id, spawnedAgent(block.input));
        }
        if (block.name === "Bash") {
            yield* this.onBashCall(block, sessionId);
        }
        // First browser tool of the turn names the session so the card can offer to watch it.
        if (browserServerOfTool(block.name) !== undefined) {
            yield* this.onBrowserCall(block, sessionId);
        }
        yield this.toolCallFrame(block, parent);
    }

    /* A turn inherits a checklist only when its seed belongs to the same session. */
    private adoptChecklist(sessionId: string): void {
        const seed = this.args.checklistSeed;
        if (seed === undefined || seed.sessionId !== sessionId) {
            return;
        }
        this.inheritedChecklist = this.checklist.seed(seed.tasks);
    }

    private *showInheritedChecklist(): Generator<AgentEvent> {
        const items = this.inheritedChecklist;
        this.inheritedChecklist = undefined;
        if (items !== undefined) {
            yield { kind: "todos", items };
        }
    }

    // A create renders from its result (the id arrives there); an update names its id in the input.
    private *onChecklistCall(block: ToolUseBlock, parent: string | undefined): Generator<AgentEvent> {
        // Remembered so the result path doesn't route this id to a tool card that was never created.
        this.checklistToolIds.add(block.id);
        // A subagent's checklist is not its parent's: adopting it could overwrite the parent's own list.
        if (parent !== undefined) {
            this.foreignChecklistToolIds.add(block.id);
            return;
        }
        if (block.name === "TaskCreate") {
            this.checklist.created(block.id, block.input);
            return;
        }
        if (block.name === "TaskUpdate") {
            const items = this.checklist.updated(block.input);
            if (items !== undefined) {
                yield { kind: "todos", items };
            }
        }
    }

    // What a checklist verb's result does to the list: a create learns its id here; a TaskList result is authoritative.
    // A child's verb contributes nothing, since its TaskList would replace this list wholesale.
    private checklistFrom(toolUseId: string, content: unknown): TodoItem[] | undefined {
        if (this.foreignChecklistToolIds.has(toolUseId)) {
            return undefined;
        }
        return this.checklist.resolved(toolUseId, content) ?? this.checklist.listed(content);
    }

    private *onBashCall(block: ToolUseBlock, sessionId: unknown): Generator<AgentEvent> {
        // First Bash of the turn names the tmux session so the browser surfaces it; ids are kept for resurfacing.
        if (this.args.tmuxEnabled && typeof sessionId === "string") {
            this.agentSession ??= agentSessionName(sessionId);
            if (this.agentSession !== undefined) {
                this.bashToolIds.add(block.id);
                if (!this.terminalSent) {
                    this.terminalSent = true;
                    yield { kind: "terminal", session: this.agentSession };
                }
            }
        }
    }

    private *onBrowserCall(block: ToolUseBlock, sessionId: unknown): Generator<AgentEvent> {
        if (this.browserSent || typeof sessionId !== "string") {
            return;
        }
        const browser = browserSessionName(sessionId);
        if (browser === undefined) {
            return;
        }
        this.browserSent = true;
        yield { kind: "browser", session: browser };
    }

    private toolCallFrame(block: ToolUseBlock, parent: string | undefined): AgentEvent {
        const diff = editDiffContent(block.name, block.input, this.args.cwd);
        if (diff !== undefined) {
            this.diffToolIds.add(block.id);
        }
        if (mayShowPicture(block.name)) {
            this.pictureCalls.set(block.id, { name: block.name, input: block.input });
        }
        return {
            kind: "tool_call",
            id: block.id,
            // Through the shared tool-name vocabulary; an MCP browser tool no longer shows its raw `mcp__web__` name
            // here.
            name: displayNameOf(block.name),
            category: toolCategoryOf(block.name),
            status: "in_progress",
            ...opt("target", toolTarget(block.input)),
            // An MCP or Agent call has no target; its input is what the record would otherwise lose.
            ...opt("input", toolInput(block.input, toolTarget(block.input))),
            ...opt("locations", toolLocations(block.input, this.args.cwd)),
            ...(diff !== undefined ? { content: [diff] } : {}),
            ...opt("parentToolUseId", parent),
        };
    }

    // Tool results arrive as tool_result blocks on a (usually synthetic) user message; this is where edit diffs and
    // bash output live. A result with no tool_use_id can't be correlated.
    private *onToolResults(message: SdkOf<"user">): Generator<AgentEvent> {
        const content = message.message.content;
        if (!Array.isArray(content)) {
            return;
        }
        for (const block of content as ReadonlyArray<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (block.type === "tool_result" && block.tool_use_id !== undefined) {
                yield* this.onToolResult(block.tool_use_id, block.content, block.is_error === true);
            }
        }
    }

    private *onToolResult(toolUseId: string, content: unknown, failed: boolean): Generator<AgentEvent> {
        yield* this.informational.settled(toolUseId);
        // A page's own frame (or its failure) has landed; the draft that stood for it goes.
        yield* this.pageDrafts.settled(toolUseId);
        // Backstop: the first Bash result guarantees tmux-run created the session, in case tool_use raced ahead of it.
        if (!this.terminalResurfaced && this.agentSession !== undefined && this.bashToolIds.has(toolUseId)) {
            this.terminalResurfaced = true;
            yield { kind: "terminal", session: this.agentSession };
        }
        // A checklist verb has no card here; a create learns its id from this result, and TaskList is authoritative.
        if (this.checklistToolIds.has(toolUseId)) {
            const items = this.checklistFrom(toolUseId, content);
            if (items !== undefined) {
                yield { kind: "todos", items };
            }
            return;
        }
        // A screenshot's answer names the file it wrote and a Read of an image answers with it; either carries the picture.
        const call = failed ? undefined : this.pictureCalls.get(toolUseId);
        // A successful Edit/Write result is just 'file updated', so the call-time diff stays; errors do replace it.
        yield {
            kind: "tool_call_update",
            id: toolUseId,
            status: failed ? "failed" : "completed",
            ...(this.diffToolIds.has(toolUseId) && !failed ? {} : { content: resultContent(content, this.args.cwd, this.args.browserOutputDir, call) }),
        };
    }

    // Whether a retry is worth waiting out. Probes the routed endpoint once per turn to catch a refused model early;
    // past MAX_IN_TURN_RETRIES, ends the turn for the resume scheduler to wait instead.
    private async endRetrying(attempt: number, status: number | undefined): Promise<AgentEvent | undefined> {
        const routed = this.args.routed;
        if (routed !== undefined && !this.routedProbed) {
            this.routedProbed = true;
            const refusal = await probeRoutedEndpoint(routed);
            if (refusal !== undefined) {
                return modelUnavailableFrame(routed.model, refusal);
            }
        }
        return attempt >= MAX_IN_TURN_RETRIES ? retryStormFrame(attempt, status) : undefined;
    }

    // A retry the loop is waiting out: a terminal frame when it should not be waited out live (returns true, ending the
    // stream), else the provider_retry status.
    private async *onApiRetry(message: Extract<SdkOf<"system">, { subtype: "api_retry" }>): AsyncGenerator<AgentEvent, boolean> {
        // The platform already exhausted its key pool; another backoff cycle reads as an indefinite spinner.
        if (this.args.trial) {
            yield trialRetryFrame(message.error);
            return true;
        }
        // A spent allowance is not an outage to ride out live: the SDK's own retry delay is the window's
        // remaining lifetime, so end the stream as a terminal rate_limit frame and free the conversation's run
        // lock for the resume scheduler.
        if (message.error === "rate_limit") {
            // The reset instant is offered only on a native turn, whose retry delay IS the window's remaining
            // lifetime; a routed turn's delay is just SDK backoff, and turning it into an instant invents a
            // false reset.
            const allowance = this.args.allowance;
            yield await rateLimitFrame(
                allowance,
                allowance === undefined ? Math.ceil((Date.now() + message.retry_delay_ms) / 1000) : undefined,
            );
            return true;
        }
        // The vendor's own word for it rides the turn's retry line (turn-pulse.ts): a status-less retry says nothing else.
        noteRetryCause(this.args.subagents?.conversationId, message.no_response === undefined ? message.error : `${message.error}: no response headers`);
        // The two ways a retry stops: an outright model refusal, or a storm long enough to hand off
        // (endRetrying).
        const terminal = await this.endRetrying(message.attempt, message.error_status ?? undefined);
        if (terminal !== undefined) {
            yield terminal;
            return true;
        }
        // Forwarded so a long retry doesn't read as a hang; maxAttempts reports the smaller of the two budgets.
        yield {
            kind: "provider_retry",
            attempt: message.attempt,
            maxAttempts: Math.min(message.max_retries, MAX_IN_TURN_RETRIES),
            nextAttemptAt: Date.now() + message.retry_delay_ms,
            ...opt("status", message.error_status ?? undefined),
        };
        return false;
    }

    // Returns true when the message ends the whole stream, see the api_retry rate_limit path.
    private async *onSystem(message: SdkOf<"system">, parent: string | undefined): AsyncGenerator<AgentEvent, boolean> {
        switch (message.subtype) {
            case "init": {
                this.fingerprint ??= promptFingerprint(message, this.args.options);
                // Guard the model: the frame's schema requires a string, so never forward an empty init.
                if (message.model) {
                    yield { kind: "init", model: message.model, prompt: this.fingerprint };
                }
                const changed = this.modeChange(message.permissionMode as PermissionMode);
                if (changed !== undefined) {
                    yield changed;
                }
                // The harness's answer to "am I serving this fast?", asked before a token is spent, while still
                // actionable.
                const speed = this.fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
                if (speed !== undefined) {
                    yield speed;
                }
                // Read supported commands after init so dead CLIs cannot hang startup.
                const commands = await this.session.supportedCommands?.().catch(() => undefined);
                if (commands !== undefined && commands.length > 0) {
                    yield commandFrame(commands);
                }
                return false;
            }
            case "status": {
                // `status` carries the current mode when known; the backstop for a mode move the other two signals
                // miss.
                const changed = this.modeChange(message.permissionMode as PermissionMode);
                if (changed !== undefined) {
                    yield changed;
                }
                return false;
            }
            case "commands_changed": {
                // Republish changed commands when the session announces them.
                yield commandFrame(message.commands);
                return false;
            }
            case "compact_boundary": {
                const meta = message.compact_metadata;
                yield {
                    kind: "compact",
                    trigger: meta.trigger,
                    preTokens: meta.pre_tokens,
                    ...opt("postTokens", meta.post_tokens),
                };
                return false;
            }
            case "local_command_output": {
                // A slash command the CLI answers itself; no model request ran, so no other frame carries it. An
                // unknown leading `/` makes the CLI discard the rest of the message; coded so the client can act on it
                // instead of showing red text.
                const output = localCommandText(message.content);
                const unknown = unknownCommandName(output);
                if (unknown !== undefined) {
                    yield {
                        kind: "error",
                        code: "unknown-command",
                        message: `\`/${unknown}\` isn't a command this agent has, so it read your message as one and dropped the rest.`,
                    };
                    return false;
                }
                yield { kind: "delta", text: output, ...opt("parentToolUseId", parent) };
                yield { kind: "text_end", ...opt("parentToolUseId", parent) };
                return false;
            }
            case "informational": {
                // Hook feedback, status lines, a plugin's words: a notice, or a call's progress entry.
                yield* this.informational.frames(message);
                return false;
            }
            case "api_retry":
                return yield* this.onApiRetry(message);
            default: {
                // The SDK's subagent lifecycle messages, the only account of a backgrounded child between its tool_use
                // and its result. The registry owns the fold; this only forwards what came back.
                if (this.args.subagents !== undefined && message.subtype.startsWith("task_")) {
                    noteBashTask(this.args.subagents, message as SubagentTaskMessage, this.args.steering);
                    const frame = noteSubagentTask(this.args.subagents, message as SubagentTaskMessage);
                    if (frame !== undefined) {
                        yield frame;
                    }
                }
                return false;
            }
        }
    }

    // Claude subscription usage for the turn: which window is active, how much is spent, and when it resets. The SDK
    // reports it at no token cost; only Claude turns emit it.
    private *onRateLimitInfo(message: SdkOf<"rate_limit_event">): Generator<AgentEvent> {
        const info = message.rate_limit_info;
        yield {
            kind: "rate_limit_info",
            status: info.status,
            ...opt("resetsAt", info.resetsAt),
            ...opt("rateLimitType", info.rateLimitType),
            ...opt("utilization", info.utilization),
        };
    }

    // This result's own spend, off the running total the SDK reports: carried in from a resumed transcript, cumulative
    // across results. A total below the last means the count started over (a /clear, a zeroed crash result).
    private spentSince(total: number | undefined): number | undefined {
        if (total === undefined) {
            return undefined;
        }
        const previous = total < this.spentUsd ? 0 : this.spentUsd;
        this.spentUsd = total;
        return total - previous;
    }

    // How the turn ended when it didn't succeed. A session past its window outranks the subtype and is said once, since
    // the assistant's error usually said it first; otherwise the subtype decides the code and rides the sentence.
    private endingFrame(message: SdkOf<"result">): AgentEvent | undefined {
        if (message.terminal_reason !== undefined && OVERFLOW_ENDINGS.has(message.terminal_reason)) {
            const repeated = this.overflowed;
            this.overflowed = true;
            return repeated ? undefined : contextOverflowFrame(`agent stopped: the session no longer fits the model's context window (${message.terminal_reason})`);
        }
        // A turn the classifier stopped was interrupted on purpose: its ending is the flag already said.
        if (this.overflowed || this.flagged || message.subtype === "success") {
            return undefined;
        }
        return {
            kind: "error",
            code: message.subtype === "error_max_turns" ? "turn-cap" : "harness-incomplete",
            message: `agent did not complete (${message.subtype})`,
        };
    }

    private async *onResult(message: SdkOf<"result">): AsyncGenerator<AgentEvent> {
        // Only surface accounting when the SDK actually reported it; an empty frame on every turn would be noise.
        if (message.usage !== undefined || message.total_cost_usd !== undefined) {
            yield {
                kind: "usage",
                ...opt("costUsd", this.spentSince(message.total_cost_usd)),
                ...opt("inputTokens", message.usage?.input_tokens),
                ...opt("outputTokens", message.usage?.output_tokens),
                ...opt("cacheReadTokens", message.usage?.cache_read_input_tokens),
                ...opt("cacheCreationTokens", message.usage?.cache_creation_input_tokens),
                ...opt("durationMs", message.duration_ms),
                ...opt("numTurns", message.num_turns),
                ...opt("openingCacheReadTokens", this.opening?.read),
                ...opt("openingCacheCreationTokens", this.opening?.written),
                ...opt("promptFingerprint", this.fingerprint?.hash),
            };
        }
        // Context-window fill: pairs the latest message_start size with the model's window, keyed by the turn's model.
        if (this.contextTokens !== undefined) {
            const window =
                (this.contextModel !== undefined ? message.modelUsage[this.contextModel]?.contextWindow : undefined) ??
                Object.values(message.modelUsage)[0]?.contextWindow;
            if (window !== undefined && window > 0) {
                // The cache instant rides this frame rather than one of its own: both answer "what would the next
                // request cost", and a turn that reported one reported the other. A `cachedAt` with no TTL beside it is
                // for the route to finish from the credential, which is where the harness's own rule is known.
                yield {
                    kind: "context_usage",
                    tokens: this.contextTokens,
                    contextWindow: window,
                    ...opt("cachedAt", this.cachedAt),
                    ...opt("cacheTtlMs", this.cacheTtlMs),
                };
            }
        }
        // The settled answer on speed: usually a no-op, but catches cooldown mid-turn or an init `pending`.
        const speed = this.fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
        if (speed !== undefined) {
            yield speed;
        }
        const ending = this.endingFrame(message);
        if (ending !== undefined) {
            yield ending;
        }
        // The account's headroom, re-read now the turn has settled; an empty read yields no frame, not an empty list.
        const windows = this.args.readUsage === undefined ? [] : await this.args.readUsage();
        if (windows.length > 0) {
            yield { kind: "account_usage", windows };
        }
        // Not the end of the stream; sdkTurns owns the boundary, and a steered stream may carry a follow-up turn next.
    }
}

// Normalize the SDK's SDKMessage stream onto AgentEvents.
export async function* streamSdk(args: StreamSdkArgs): AsyncGenerator<AgentEvent> {
    const session = args.queryFn({ prompt: args.prompt, options: args.options });
    const fold = new TurnFold(args, session);
    for await (const message of sdkTurns(session, args.steering, args.redeliver)) {
        const ended = yield* fold.onMessage(message);
        if (ended) {
            return;
        }
    }
}
