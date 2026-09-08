// Normalizes the SDK's message stream onto AgentEvents: sdkTurns finds the turn boundary in streaming-input mode, and
// TurnFold maps each message onto typed frames. An SDK message with no mapping is dropped; the terminal `done` frame is
// emitted by runAgent, not here.
import type { Options, SDKAssistantMessage, SDKMessage, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../runtimes/claude/claude-sdk.js";
import type { AgentEvent, FastModeState, PermissionMode, TodoItem, UsageWindow } from "@intentic/sandbox-contract";
import { agentSessionName, browserSessionName } from "@intentic/sandbox-contract/session-names";
import { screenshotImage } from "../../browser/cast/browser-artifacts.js";
import { browserServerOfTool } from "../../browser/sessions/browser-sessions.js";
import { localCommandText, unknownCommandName } from "../providers/agent-commands.js";
import type { SteeringQueue } from "../anchors/agent-steering.js";
import { errorFrame, modelUnavailableFrame, rateLimitFrame, retryStormFrame, trialRetryFrame } from "./error-frames.js";
import { probeRoutedEndpoint, type RoutedEndpoint } from "../providers/routed-refusal.js";
import type { TurnAllowance } from "../providers/harness-credentials.js";
import { opt } from "./opt.js";
import { noteSubagentSpawn, noteSubagentTask, type SubagentTaskMessage, type SubagentTurn } from "../subagents/subagents.js";
import { TaskChecklist } from "./task-checklist.js";
import type { ChecklistSeed } from "./task-store.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "../tools/tool-calls.js";

// What a turn needs from the SDK: the message stream and the session's slash-command list. `supportedCommands` is
// optional since a fake stream used in tests has none.
export type AgentQuery = AsyncIterable<SDKMessage> & {
    readonly supportedCommands?: () => Promise<readonly SlashCommand[]>;
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

// Task types the turn need not wait for at stream end, since each outlives the process or never ends; anything else is
// waited on by default:
// local_bash a backgrounded shell in the daemon's own tmux session, independent of the turn
// monitor_ws ambient for the life of the session
// monitor_mcp the same
// remote_agent runs on the provider's side, not in this process
const UNHELD_TASK_TYPES: ReadonlySet<string> = new Set(["local_bash", "monitor_ws", "monitor_mcp", "remote_agent"]);

// Consecutive refusals before ending the turn for the breaker (provider-health.ts) instead of spinning.
const MAX_IN_TURN_RETRIES = 8;

// Live in-process background work off the SDK's own level signal (replace semantics; a missed edge can't wedge a stale
// hold). Undefined on every other message, so the caller keeps its last count.
const heldTaskCount = (message: SDKMessage): number | undefined =>
    message.type === "system" && message.subtype === "background_tasks_changed"
        ? message.tasks.filter((task) => !UNHELD_TASK_TYPES.has(task.task_type)).length
        : undefined;

// A main-thread model frame; only the idle gaps between turns race the grace window. A child's own frames (parented)
// keep arriving throughout a hold and must not read as a turn underway.
const isMainTurnFrame = (message: SDKMessage): boolean =>
    (message.type === "assistant" || message.type === "stream_event" || message.type === "user") && message.parent_tool_use_id === null;

// Whether the CLI produced anything at all, model output, a child's, or a local slash command's; separates a turn that
// legitimately called nothing from one that swallowed its prompt.
const isWorkFrame = (message: SDKMessage): boolean =>
    message.type === "assistant" || message.type === "stream_event" || (message.type === "system" && message.subtype === "local_command_output");

// Ends the SDK stream at the right turn boundary: unsteered streams end at the first result; once steered, a result
// arms the grace race, and one with children still live holds the stream for the CLI's wake turn.
async function* sdkTurns(
    stream: AsyncIterable<SDKMessage>,
    steering: SteeringQueue | undefined,
    // Push the turn's prompt back through streaming input once; true means the stream ends normally at its result.
    redeliver: (() => boolean) | undefined,
): AsyncGenerator<SDKMessage> {
    const iterator = stream[Symbol.asyncIterator]();
    // A result passed on a steered stream: the next idle gap decides follow-up turn vs. turn-stream-over.
    let awaitingNextTurn = false;
    // Live in-process background work off the latest level signal; counts only what the boundary waits for.
    let heldTasks = 0;
    // A result passed while children were live: the stream is held open for the CLI's wake turn.
    let held = false;
    // A main-thread model frame seen since the last result (see isMainTurnFrame).
    let midTurn = false;
    // Anything produced since the last result (see isWorkFrame).
    let sawWork = false;
    // A pending next() that lost the grace race is re-awaited on the following pass, never abandoned.
    let pending: Promise<IteratorResult<SDKMessage, void>> | undefined;
    try {
        for (;;) {
            const nextPromise = pending ?? iterator.next();
            pending = undefined;
            let step: IteratorResult<SDKMessage, void>;
            // Both parks end alike on silence: close input and drain; `held` is always false while awaitingNextTurn is
            // set.
            if (awaitingNextTurn || (held && !midTurn && heldTasks === 0)) {
                awaitingNextTurn = false;
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
            heldTasks = heldTaskCount(message) ?? heldTasks;
            midTurn = midTurn || isMainTurnFrame(message);
            sawWork = sawWork || isWorkFrame(message);
            if (message.type !== "result") {
                yield message;
                continue;
            }
            midTurn = false;
            // A swallowed prompt: an instant empty success with no work behind it (the CLI notification-wakes on a dead
            // run and drops the queued message). Redelivered once through the steering queue instead of yielded;
            // skipped while held for a wake turn.
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
                // Closed before returning so a steer racing this result reports undelivered rather than queuing
                // forever.
                steering?.close();
                return;
            }
            awaitingNextTurn = true;
        }
    } finally {
        await iterator.return?.();
    }
}

// Modes the contract models; the SDK also resolves 'dontAsk'/'auto' from settings, which have no UI here.
const PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions"]);

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
}

type SdkOf<T extends SDKMessage["type"]> = Extract<SDKMessage, { type: T }>;

// A tool_use block that can be correlated to its result; real streams always carry an id and a name.
interface ToolUseBlock {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
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
    // tool_use ids of browser screenshots, turned into a picture instead of the literal '[image]' text.
    private readonly screenshotToolIds = new Set<string>();
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
    // A block's stop always precedes its assistant frame, so introduced tool calls render after it, not before.
    private readonly textBlocks = new Map<string, number>();
    // Live permission mode, folded and de-duplicated across `init`, `status`, and the tool-call-only EnterPlanMode.
    private mode: PermissionMode | undefined;
    // Fast-mode speed, de-duplicated on the (state, reason) pair, since a changing reason alone is informative.
    private fastReported: string | undefined;

    constructor(args: StreamSdkArgs, session: AgentQuery) {
        this.args = args;
        this.session = session;
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
        // The session id a child's transcript files under, onto the handle the hooks close over (SubagentTurn).
        const subagents = this.args.subagents;
        if (subagents !== undefined && subagents.sessionId === undefined && typeof sessionId === "string" && sessionId !== "") {
            subagents.sessionId = sessionId;
        }
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

    private modeChange(next: PermissionMode | undefined): AgentEvent | undefined {
        if (next === undefined || next === this.mode || !PERMISSION_MODES.has(next)) {
            return undefined;
        }
        this.mode = next;
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
            content_block?: { type?: string };
            delta?: { type: string; text?: string; thinking?: string };
            message?: {
                model?: string;
                usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
            };
        };
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
            // Full input sent for this request = the context fill right now (input + both cache buckets).
            const usage = event.message.usage;
            this.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            this.contextModel = event.message.model;
        }
    }

    // Text and thinking already streamed as deltas above; here only tool calls surface (including checklist verbs,
    // rendered as their own live list).
    private async *onAssistant(message: SDKAssistantMessage, sessionId: unknown, parent: string | undefined): AsyncGenerator<AgentEvent> {
        if (message.error !== undefined) {
            yield await errorFrame(message, this.args.allowance, this.args.trial);
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
            noteSubagentSpawn(block.id, spawnedAgent(block.input));
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

    /* THE LIST THIS TURN INHERITS, and when it is safe to say so. The seed was read for the session the turn
     * asked to resume; the CLI's first frame says which session it is actually running, and a CLI that could
     * not resume starts a fresh one whose ids begin again at 1. Adopted under that session the seed would
     * render last session's rows and let this session's first create overwrite one of them, so a seed for any
     * other session is dropped unread, and the fold stays as empty as a first turn's.
     *
     * Seed the reducer immediately so updates can resolve old task ids, but publish only once the provider
     * answers. An init followed by a usage refusal did no work: publishing here created another checklist
     * bubble on every failed retry. The registry already carries unfinished work across refused turns. */
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
        if (block.name.endsWith("__browser_take_screenshot")) {
            this.screenshotToolIds.add(block.id);
        }
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
        return {
            kind: "tool_call",
            id: block.id,
            // Through the shared tool-name vocabulary; an MCP browser tool no longer shows its raw `mcp__web__` name
            // here.
            name: displayNameOf(block.name),
            category: toolCategoryOf(block.name),
            status: "in_progress",
            ...opt("target", toolTarget(block.input)),
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
        const text = resultText(content);
        // A screenshot's answer names the file it wrote; carry the picture too, not just the text that it looked.
        const image =
            !failed && this.screenshotToolIds.has(toolUseId) && this.args.browserOutputDir !== undefined
                ? screenshotImage(text, this.args.cwd, this.args.browserOutputDir)
                : undefined;
        // A successful Edit/Write result is just 'file updated', so the call-time diff stays; errors do replace it.
        yield {
            kind: "tool_call_update",
            id: toolUseId,
            status: failed ? "failed" : "completed",
            ...(this.diffToolIds.has(toolUseId) && !failed
                ? {}
                : { content: [{ type: "text" as const, text }, ...(image !== undefined ? [image] : [])] }),
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

    // Returns true when the message ends the whole stream, see the api_retry rate_limit path.
    private async *onSystem(message: SdkOf<"system">, parent: string | undefined): AsyncGenerator<AgentEvent, boolean> {
        switch (message.subtype) {
            case "init": {
                // Guard the model: the frame's schema requires a string, so never forward an empty init.
                if (message.model) {
                    yield { kind: "init", model: message.model };
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
                // Read here, not pre-stream: supportedCommands() resolves only after `init`, else a dead CLI could hang
                // it.
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
                // A mid-session republish of the whole list; supportedCommands() is captured at init and won't reflect
                // it.
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
            case "api_retry": {
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
            default: {
                // The SDK's subagent lifecycle messages, the only account of a backgrounded child between its tool_use
                // and its result. The registry owns the fold; this only forwards what came back.
                if (this.args.subagents !== undefined && message.subtype.startsWith("task_")) {
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

    private async *onResult(message: SdkOf<"result">): AsyncGenerator<AgentEvent> {
        // Only surface accounting when the SDK actually reported it; an empty frame on every turn would be noise.
        if (message.usage !== undefined || message.total_cost_usd !== undefined) {
            yield {
                kind: "usage",
                ...opt("costUsd", message.total_cost_usd),
                ...opt("inputTokens", message.usage?.input_tokens),
                ...opt("outputTokens", message.usage?.output_tokens),
                ...opt("cacheReadTokens", message.usage?.cache_read_input_tokens),
                ...opt("cacheCreationTokens", message.usage?.cache_creation_input_tokens),
                ...opt("durationMs", message.duration_ms),
                ...opt("numTurns", message.num_turns),
            };
        }
        // Context-window fill: pairs the latest message_start size with the model's window, keyed by the turn's model.
        if (this.contextTokens !== undefined) {
            const window =
                (this.contextModel !== undefined ? message.modelUsage[this.contextModel]?.contextWindow : undefined) ??
                Object.values(message.modelUsage)[0]?.contextWindow;
            if (window !== undefined && window > 0) {
                yield { kind: "context_usage", tokens: this.contextTokens, contextWindow: window };
            }
        }
        // The settled answer on speed: usually a no-op, but catches cooldown mid-turn or an init `pending`.
        const speed = this.fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
        if (speed !== undefined) {
            yield speed;
        }
        // How the turn ended when it didn't succeed: the subtype decides the code (turn-cap vs. harness-incomplete),
        // and the raw subtype still rides the sentence since it's the only thing telling several endings apart.
        if (message.subtype !== "success") {
            yield {
                kind: "error",
                code: message.subtype === "error_max_turns" ? "turn-cap" : "harness-incomplete",
                message: `agent did not complete (${message.subtype})`,
            };
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
