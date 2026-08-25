/* The SDK's message stream, normalized onto AgentEvents: sdkTurns finds the turn boundary in streaming-input
 * mode, and TurnFold maps each message onto the typed frames the client renders. High-value block types get a
 * dedicated frame; any SDK message without a mapping is dropped. Does NOT emit the terminal `done` (runAgent
 * does that once the whole turn settles). */
import {
    type Options,
    query,
    type SDKAssistantMessage,
    type SDKMessage,
    type SDKUserMessage,
    type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, FastModeState, PermissionMode, UsageWindow } from "@intentic/sandbox-contract";
import { agentSessionName, browserSessionName } from "@intentic/sandbox-contract/session-names";
import { screenshotImage } from "../browser/browser-artifacts.js";
import { browserServerOfTool } from "../browser/browser-sessions.js";
import { localCommandText, unknownCommandName } from "./agent-commands.js";
import type { SteeringQueue } from "./agent-steering.js";
import { errorFrame, rateLimitFrame, retryStormFrame, trialRetryFrame } from "./error-frames.js";
import type { TurnAllowance } from "./harness-credentials.js";
import { opt } from "./opt.js";
import { noteSubagentSpawn, noteSubagentTask, type SubagentTaskMessage, type SubagentTurn } from "./subagents.js";
import { TaskChecklist } from "./task-checklist.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "./tool-calls.js";

// What a turn needs from the SDK: the message stream and the session's slash-command list. The real `query`
// returns a Query, which satisfies both; the method is optional because a fake stream legitimately has none
// (it resolves a control request, which no canned generator answers).
export type AgentQuery = AsyncIterable<SDKMessage> & {
    readonly supportedCommands?: () => Promise<readonly SlashCommand[]>;
};

// The SDK `query` is injected so tests drive a fake message stream, no API calls, no bundled binary.
export type QueryFn = (args: { readonly prompt: string | AsyncIterable<SDKUserMessage>; readonly options: Options }) => AgentQuery;
export const defaultQuery: QueryFn = (args) => query(args);

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
export const promptInput = (prompt: string, steering: SteeringQueue | undefined): string | AsyncIterable<SDKUserMessage> =>
    steering === undefined ? prompt : steeredInput(prompt, steering);

async function* steeredInput(first: string, steering: SteeringQueue): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null };
    for await (const text of steering) {
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
}

// In streaming-input mode the SDK emits one `result` per TURN and keeps the stream open for further input: a
// steered message the running turn could not absorb runs as its own follow-up turn AFTER the result (observed
// to announce itself within ~2ms), while a steer absorbed mid-turn (injected between tool calls) produces no
// extra result, so no message count can tell "more coming" from "settled". Instead, after a result on a
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
 * the turn's CLI process, so a stream ended while one is live kills it mid-flight, the failure the user meets
 * as "the session process exited and took all 14 agents with it", minutes after the model said it would come
 * back with their results. A backgrounded shell is deliberately absent: it runs in the turn's tmux session,
 * which the daemon owns and outlives the turn, and holding on one would keep a turn spinning for as long as a
 * dev server runs. `monitor` is ambient by design and lives exactly as long as the session, never waited on. */
const HELD_TASK_TYPES: ReadonlySet<string> = new Set(["subagent", "workflow", "local_workflow"]);

/* HOW DEEP AN IN-TURN RETRY STORM MAY GET BEFORE THE TURN STOPS CLAIMING TO BE WORKING.
 *
 * The harness's own budget is three hundred attempts with no ceiling on the wait it will honour
 * (CLAUDE_CODE_RETRY_WATCHDOG, harness-credentials.ts), and for a provider having a bad minute that is exactly
 * right: retrying inside the live turn keeps the session, the prompt cache and everything the agent has already
 * done, where dying costs a respawn. It is exactly wrong for a provider that refuses EVERY request, and from in
 * here the two are indistinguishable, so the only honest bound is how many refusals in a row a turn sits through
 * before handing itself to the layer built for waiting.
 *
 * THAT LAYER IS BETTER AT WAITING IN EVERY WAY THAT MATTERS. The breaker (provider-health.ts) escalates 30s →
 * 20m over six attempts, spends ONE probe per provider however many conversations are stranded, and the resume
 * continues from the session the dead turn reported (turn-resume.ts), so the work is kept rather than re-done.
 * What it also does, and the harness's budget cannot, is tell the truth while it waits: a turn spinning inside
 * that budget reads as `running` everywhere, which is a card sitting in the Active lane under a "Working…"
 * spinner for as long as the storm lasts. That is what this bound is really for. A local model whose
 * llama-server refused the harness's tool schema outright (500 on every request, packs/llamacpp.Dockerfile has
 * the story) held its card there indefinitely, saying work was in flight while nothing had happened at all.
 *
 * Eight is roughly two minutes of the SDK's own backoff: long enough that an ordinary capacity burst or a
 * rolling deploy is absorbed in place and nobody learns it happened, short enough that a provider which cannot
 * serve this turn at all becomes news inside the pause a person will stare at a spinner for. `attempt` is per
 * REQUEST and resets on every response the harness accepts, so a long turn losing the odd socket never
 * approaches it; only a run of consecutive refusals does. */
const MAX_IN_TURN_RETRIES = 8;

// Live in-process background work, off the SDK's own level signal (replace semantics, a missed edge cannot
// wedge a stale hold). Undefined on every other message, so the caller keeps its last count.
const heldTaskCount = (message: SDKMessage): number | undefined =>
    message.type === "system" && message.subtype === "background_tasks_changed"
        ? message.tasks.filter((task) => HELD_TASK_TYPES.has(task.task_type)).length
        : undefined;

// A main-thread model frame, a turn mid-stream always produces more messages, so only the idle gaps BETWEEN
// turns are raced against the grace window while held. Children's own frames (parented) keep arriving
// throughout the hold and must not read as a turn underway.
const isMainTurnFrame = (message: SDKMessage): boolean =>
    (message.type === "assistant" || message.type === "stream_event" || message.type === "user") && message.parent_tool_use_id === null;

// Whether the CLI produced anything at all, model output, a child's, or a local slash command's. What
// separates a turn that legitimately never called the model from one that swallowed its prompt.
const isWorkFrame = (message: SDKMessage): boolean =>
    message.type === "assistant" || message.type === "stream_event" || (message.type === "system" && message.subtype === "local_command_output");

// The SDK message stream, ended at the right turn boundary. Unsteered (or never-steered) streams end at the
// first result, as before. Once a steer was delivered, each result instead arms the grace race above; when it
// goes silent, closing the input queue ends the SDK's streaming input and the stream drains to its natural
// end (settling the subprocess), a turn that slipped in during the race still streams in full.
//
// A result with backgrounded CHILDREN still in flight is not the boundary either: they die with the
// subprocess, and the CLI wakes the model with a task notification when one settles, so the stream is held
// open and the wake turn (the "I'll come back with results") rides it like a steered follow-up. Once the last
// child settles, either a wake turn announces itself within the grace window or none is coming and closing
// the input drains the stream as above.
async function* sdkTurns(
    stream: AsyncIterable<SDKMessage>,
    steering: SteeringQueue | undefined,
    // Push the turn's prompt back through the streaming input, once, see the swallowed-prompt branch below.
    // Reports whether it did, so a stream that already redelivered ends at its result like any other.
    redeliver: (() => boolean) | undefined,
): AsyncGenerator<SDKMessage> {
    const iterator = stream[Symbol.asyncIterator]();
    // A result passed on a steered stream: the next idle gap decides follow-up turn vs. turn stream over.
    let awaitingNextTurn = false;
    // Live in-process background work, off the latest level signal. Counts only what the boundary waits for.
    let heldTasks = 0;
    // A result passed while children were live: the stream is being held open for the CLI's wake turn.
    let held = false;
    // A main-thread model frame since the last result, see isMainTurnFrame.
    let midTurn = false;
    // Anything produced since the last result, see isWorkFrame.
    let sawWork = false;
    // A pending next() that lost the grace race is re-awaited on the following pass, never abandoned.
    let pending: Promise<IteratorResult<SDKMessage, void>> | undefined;
    try {
        for (;;) {
            const nextPromise = pending ?? iterator.next();
            pending = undefined;
            let step: IteratorResult<SDKMessage, void>;
            /* The two parks that race the grace window, a result on a steered stream, and a hold whose last
             * child settled between turns, end the same way on silence: close the input and let the stream
             * drain. `held` is always false while awaitingNextTurn is set (every result path clears it before
             * arming the race), so clearing both on timeout is exact for either park. */
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
            /* A SWALLOWED PROMPT: an instant "success" with num_turns 0 and not one frame of work behind it,
             * before anything was even delivered. The CLI does this when a resume wakes up to its own stale
             * background-task notifications (a previous turn's subagents killed at its end): it classifies the
             * whole run as a notification wake needing no response and results in milliseconds, while the
             * prompt it was just sent is dequeued into the dying run, stamped "No response requested." at the
             * next resume, and never answered. To the user that is a sent message producing nothing at all: no
             * reply, no error, no stopped state.
             *
             * The subprocess is still alive waiting on the streaming input, so the recovery is the one the user
             * performs by hand, say it again: the prompt goes back through the steering queue and runs as a
             * follow-up turn in the same process, whose notification debt the dead run just paid. The empty
             * result is not yielded, nothing settled, and its zero-usage frame would end the client's turn.
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

// The modes the contract (and so the composer) models. The SDK also resolves 'dontAsk' and 'auto', from a
// settings default, say, which have no UI here, so a mode frame is only emitted for one of these four.
const PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions"]);

// Every input streamSdk folds, stated by name at the one call site (runAgent), each carries the reason it
// can be absent.
export interface StreamSdkArgs {
    readonly queryFn: QueryFn;
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
    readonly options: Options;
    readonly cwd: string;
    readonly tmuxEnabled: boolean;
    // Where this turn's browser artifacts land, how a screenshot's answer is turned back into a picture the
    // chat can show. Absent on a turn with no browser tools at all.
    readonly browserOutputDir: string | undefined;
    readonly steering: SteeringQueue | undefined;
    // The swallowed-prompt recovery sdkTurns fires, see its result branch. Absent on an unsteerable turn,
    // which has no road back into the streaming input.
    readonly redeliver: (() => boolean) | undefined;
    // Reads the credential's plan-limit pools at turn settle; absent when the turn ran on a credential with no
    // pools to read (an API endpoint, the container env), no read, no frame.
    readonly readUsage: (() => Promise<UsageWindow[]>) | undefined;
    // Whose allowance this turn spends and when it reopens; absent on a native Claude turn, whose harness
    // answers both by itself. See TurnAllowance.
    readonly allowance: TurnAllowance | undefined;
    // A platform-owned trial turn has already walked its whole key pool before a retry reaches this stream.
    readonly trial: boolean;
    // The turn handle children are filed under; absent ⇒ no conversation to file them against (the bench).
    readonly subagents: SubagentTurn | undefined;
}

type SdkOf<T extends SDKMessage["type"]> = Extract<SDKMessage, { type: T }>;

// A tool_use block that can be correlated to its result, real streams always carry an id and a name.
interface ToolUseBlock {
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
}

const toolUseOf = (block: { type: string; id?: string; name?: string; input?: unknown }): ToolUseBlock | undefined =>
    block.type === "tool_use" && typeof block.name === "string" && block.id !== undefined
        ? { id: block.id, name: block.name, input: block.input }
        : undefined;

/* The call that starts another AGENT, walked away from. Its input is the only place that says whether the
 * parent walked away from the child (subagents.ts), and background is the tool's own default, an explicit
 * `false` is the one shape that means the turn blocks on it. */
const isDetachedSpawn = (input: unknown): boolean => (input as { run_in_background?: unknown } | undefined)?.run_in_background !== false;

/* One turn's worth of fold state, everything the messages accumulate between the first frame and the last.
 * A class rather than a bag of closure variables so each message type's handler reads as its own unit. */
class TurnFold {
    private readonly args: StreamSdkArgs;
    // Bound rather than consumed as a bare AsyncIterable: the turn also reads the session's slash-command
    // list off this handle at `init` (see onSystem).
    private readonly session: AgentQuery;
    private sessionSent = false;
    // The agent's live tmux terminal is surfaced twice: once at the first Bash tool_use (so a long command is
    // watchable live) and once at that command's tool_result (by then tmux-run has definitely created the
    // session, so a first-command cold-start that outran the tool_use relist still gets a tab). surface() is
    // idempotent, so the double emit is harmless.
    private terminalSent = false;
    private terminalResurfaced = false;
    private agentSession: string | undefined;
    // Same idea for the agent's browser: named once, at the first browser tool call, so the client can offer
    // "watch this" from the card that asked the question. The PreToolUse hook is what actually registers the
    // session (browser/browser-sessions.ts); this frame only tells the client its name.
    private browserSent = false;
    private readonly bashToolIds = new Set<string>();
    // tool_use ids of browser screenshots, so the result can be turned into a picture the chat actually shows
    // instead of the literal "[image]" a non-text block collapses to (browser/browser-artifacts.ts).
    private readonly screenshotToolIds = new Set<string>();
    // tool_use ids whose tool_call already carried the authoritative diff (derived from the Edit/Write input),
    // so the success result's redundant "file updated" text must not REPLACE it (update content is a snapshot).
    private readonly diffToolIds = new Set<string>();
    // The agent's working checklist, reassembled from the Task tool family. Their tool_use ids are remembered
    // so the result path suppresses their cards too, the list IS their render.
    private readonly checklist = new TaskChecklist();
    private readonly checklistToolIds = new Set<string>();
    // Context-window fill for the turn: the latest message_start reports the request's input size (grows
    // monotonically within a turn); the result reports the model's contextWindow. Paired into one
    // context_usage frame at the result so the UI can warn as the chat nears auto-compaction.
    private contextTokens: number | undefined;
    private contextModel: string | undefined;
    // The text content block currently streaming, per agent, the main turn under "", each subagent under its
    // Task tool id, so a content_block_stop closes exactly the prose its own deltas were writing (see the
    // text_end frame). Keyed and index-matched rather than a bare flag so neither a stop belonging to some
    // other block (thinking, a tool's input JSON) nor a subagent's interleaved stream can retire the wrong one.
    // A block's stop always precedes its message's `assistant` frame, so the boundary lands BEFORE the tool
    // calls that block introduced, which is what puts them under it rather than above it in the transcript.
    private readonly textBlocks = new Map<string, number>();
    // The turn's live permission mode, so the composer can follow it. The SDK has no mode-change message,
    // `init` states the resolved starting mode, `status` piggybacks the current one, and the agent's own
    // EnterPlanMode is only visible as a tool call, so the three are folded here and de-duplicated.
    private mode: PermissionMode | undefined;
    /* What speed the harness is actually serving this turn at, folded and de-duplicated exactly like the mode
     * above: it is reported on `init` and again on the result, and restating an unchanged answer would put a
     * second identical row in front of the user for no new information.
     *
     * De-duplicated on the PAIR rather than on the state, because the reason moves on its own and the move is
     * the informative part: `init` can answer `off`/`pending`, the harness has not finished asking, and the
     * result then names why, which is the difference between "we're checking" and "your plan doesn't include
     * it". A state change alone is the other case worth a frame: a turn that exhausts the fast-mode pool
     * mid-flight (it has its own, separate from the model's) drops to `cooldown` and finishes at standard
     * speed, and the bill will say so whether or not the transcript does. */
    private fastReported: string | undefined;

    constructor(args: StreamSdkArgs, session: AgentQuery) {
        this.args = args;
        this.session = session;
    }

    // One SDK message onto its frames. Returns true when the message ends the whole stream (a terminal
    // rate_limit mid-retry). Any SDK message type without a mapping (hook / task / plugin / status / …) is
    // dropped, as before, new high-value types earn a dedicated frame here; the rest stay silent rather
    // than noisy.
    async *onMessage(message: SDKMessage): AsyncGenerator<AgentEvent, boolean> {
        const sessionId = (message as { session_id?: string }).session_id;
        if (!this.sessionSent && typeof sessionId === "string" && sessionId !== "") {
            this.sessionSent = true;
            yield { kind: "session", sessionId };
        }
        // The session a child's transcript is filed under, onto the handle the hooks close over, see SubagentTurn.
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

    // Token deltas, text and extended thinking both arrive here (partial messages are enabled). Each
    // request's message_start also reports its usage, which is the current context-window fill.
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
            yield { kind: "delta", text: event.delta.text, ...opt("parentToolUseId", parent) };
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
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

    // Text/thinking already streamed as deltas above; here we only surface tool calls (and the checklist
    // verbs, which are tool calls we render as their own live list).
    private async *onAssistant(message: SDKAssistantMessage, sessionId: unknown, parent: string | undefined): AsyncGenerator<AgentEvent> {
        if (message.error !== undefined) {
            yield await errorFrame(message, this.args.allowance, this.args.trial);
            return;
        }
        const content = message.message.content as ReadonlyArray<{ type: string; id?: string; name?: string; input?: unknown }>;
        for (const block of content) {
            const call = toolUseOf(block);
            if (call !== undefined) {
                yield* this.onToolUse(call, sessionId, parent);
            }
        }
    }

    private *onToolUse(block: ToolUseBlock, sessionId: unknown, parent: string | undefined): Generator<AgentEvent> {
        // The checklist, which renders as its own live list rather than as tool cards, one card per task
        // creation and per status flip would bury the transcript.
        if (block.name === "TaskCreate" || block.name === "TaskList" || block.name === "TaskUpdate") {
            yield* this.onChecklistCall(block);
            return;
        }
        // The agent moving itself into planning. Nothing else reports it, there is no mode-change SDK
        // message, so the tool call IS the signal. ExitPlanMode is NOT mirrored here: the user's approval
        // chooses the mode it lands in, and canUseTool pushes that frame.
        if (block.name === "EnterPlanMode") {
            const changed = this.modeChange("plan");
            if (changed !== undefined) {
                yield changed;
            }
        }
        // `Agent` is the Claude SDK's name for the tool, and the SDK task stream is the only thing that
        // files these children, so a spawn is only noted when there is a registry to file it in.
        if (block.name === "Agent" && this.args.subagents !== undefined && isDetachedSpawn(block.input)) {
            noteSubagentSpawn(block.id);
        }
        if (block.name === "Bash") {
            yield* this.onBashCall(block, sessionId);
        }
        // First browser tool of the turn: name the `browser-<id>` session so the card can offer to watch it.
        // Unlike Bash there is no resurface pass, the session is registered by the same call's PreToolUse
        // hook, which has already run by the time this block is streamed.
        if (browserServerOfTool(block.name) !== undefined) {
            yield* this.onBrowserCall(block, sessionId);
        }
        yield this.toolCallFrame(block, parent);
    }

    // A create can only render from its RESULT (that is where it learns its task id); an update names the id
    // in its input, so the list moves the instant the agent says so; a TaskList renders from its result alone.
    private *onChecklistCall(block: ToolUseBlock): Generator<AgentEvent> {
        this.checklistToolIds.add(block.id);
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

    private *onBashCall(block: ToolUseBlock, sessionId: unknown): Generator<AgentEvent> {
        // First Bash of the turn: name the live `agent-<id>` tmux session so the browser surfaces that
        // terminal. Same derivation the PreToolUse hook routes commands through, so they match. Remember
        // every Bash tool_use id so the tool_result can re-surface (the session may not exist yet at
        // tool_use, the SDK can lag before actually running the command).
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
            // Through the shared vocabulary like every other backend's: Claude's own tool names have no entry
            // and pass through untouched, and an MCP browser tool stops being `mcp__web__browser_navigate` on
            // the card.
            name: displayNameOf(block.name),
            category: toolCategoryOf(block.name),
            status: "in_progress",
            ...opt("target", toolTarget(block.input)),
            ...opt("locations", toolLocations(block.input, this.args.cwd)),
            ...(diff !== undefined ? { content: [diff] } : {}),
            ...opt("parentToolUseId", parent),
        };
    }

    // Tool results come back as tool_result blocks on a (usually synthetic) user message, this is where
    // edit diffs and bash output live. A result without a tool_use_id can't be correlated, real streams
    // always carry one.
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
        // Backstop: the first Bash tool_result guarantees tmux-run has created the session, so re-surface
        // the terminal in case the tool_use-time relist raced ahead of session creation.
        if (!this.terminalResurfaced && this.agentSession !== undefined && this.bashToolIds.has(toolUseId)) {
            this.terminalResurfaced = true;
            yield { kind: "terminal", session: this.agentSession };
        }
        // A checklist verb: no card was emitted for the call, so none is updated here. A create learns its
        // task id from this result ("Task #1 created successfully"), and a TaskList result is the
        // authoritative set, it adopts tasks made before this turn attached.
        if (this.checklistToolIds.has(toolUseId)) {
            const items = this.checklist.resolved(toolUseId, content) ?? this.checklist.listed(content);
            if (items !== undefined) {
                yield { kind: "todos", items };
            }
            return;
        }
        const text = resultText(content);
        // A screenshot's answer names the file it wrote; carry the picture alongside the text so the card
        // can show what the agent looked at, not just say that it looked.
        const image =
            !failed && this.screenshotToolIds.has(toolUseId) && this.args.browserOutputDir !== undefined
                ? screenshotImage(text, this.args.cwd, this.args.browserOutputDir)
                : undefined;
        // A successful Edit/Write result is only the redundant "file updated" snippet, status alone, so the
        // call-time diff stays the card's content. Errors DO replace it (the text is the reason).
        yield {
            kind: "tool_call_update",
            id: toolUseId,
            status: failed ? "failed" : "completed",
            ...(this.diffToolIds.has(toolUseId) && !failed
                ? {}
                : { content: [{ type: "text" as const, text }, ...(image !== undefined ? [image] : [])] }),
        };
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
                // The harness's answer to "am I serving this turn fast?", at the earliest point it can be
                // asked, before a single token has been spent, which is when it is still actionable.
                const speed = this.fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
                if (speed !== undefined) {
                    yield speed;
                }
                // The session's slash commands, built-ins plus the workspace's own .claude/commands and any
                // plugin/skill commands, all of which load because baseOptions sets settingSources. Read HERE
                // rather than before the stream on purpose: supportedCommands() awaits the SDK's initialize
                // response, and `init` is proof that response already landed, so it resolves immediately. Asked
                // any earlier, a CLI that dies during startup would hang the turn on a promise that never
                // settles instead of surfacing as the stream error it is.
                const commands = await this.session.supportedCommands?.().catch(() => undefined);
                if (commands !== undefined && commands.length > 0) {
                    yield commandFrame(commands);
                }
                return false;
            }
            case "status": {
                // `status` carries the CURRENT mode when it knows it, the backstop that catches any mode move
                // the two signals above miss (a hook, a settings default, a /mode-style slash command).
                const changed = this.modeChange(message.permissionMode as PermissionMode);
                if (changed !== undefined) {
                    yield changed;
                }
                return false;
            }
            case "commands_changed": {
                // A mid-session republish of the WHOLE list (skills discovered as the agent works in a
                // subdirectory, a reloaded plugin). The SDK's contract is replace-wholesale, which is exactly
                // what this frame means to the client, supportedCommands() is captured at initialize and
                // never reflects these, so re-asking it would return the stale init list.
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
                /* What a slash command the CLI answers ITSELF produced, no model request ran, so none of the
                 * frames above carry it. Dropping it (which this did) made every such command look broken: the
                 * turn ends with the composer's own echo and nothing else, whatever the command actually said.
                 *
                 * The unknown-command case is the one that costs the user their words: the CLI claims a leading
                 * `/`, finds no such command, and discards the REST of the message, the model never sees it.
                 * turn-plan.ts stops that before it happens whenever the command list is known; this is the
                 * backstop for when it isn't (a daemon that has run no turn yet), so it carries a code the
                 * client can act on rather than a line of red text the user has to read and re-type around. */
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
                // The platform has already exhausted its bounded key pool. Letting the harness begin another
                // backoff cycle turns a refunded failure into the indefinite "provider not responding" spinner.
                if (this.args.trial) {
                    yield trialRetryFrame(message.error);
                    return true;
                }
                /* A spent allowance is not an outage to ride out in a live process. The SDK names it directly
                 * and sets its retry delay to the closed window's remaining lifetime; turn that into the same
                 * terminal rate_limit frame as an assistant refusal, carrying the reset instant so the daemon's
                 * existing resume scheduler can park the turn and bring its session back after the reset. Aside
                 * from telling the truth, this frees the conversation's live-run lock instead of leaving a CLI
                 * spinner attached to it for minutes or hours. Ending the stream closes the SDK iterator in
                 * sdkTurns' finally; runAgent then supplies the ordinary terminal done frame. */
                if (message.error === "rate_limit") {
                    /* WHEN THE SPENT WINDOW REOPENS, from the only party that knows, and on this path only one
                     * of the two ever does. A NATIVE Claude turn's harness sets its retry delay to the closed
                     * window's remaining lifetime, so the delay IS the reset and arithmetic on it is exact. On a
                     * routed turn it is nothing of the sort: the delay is the SDK's own 620ms-and-doubling
                     * backoff, and turning that into an instant is what produced "Resets 5:32 PM" for a Google
                     * weekly quota five days out. So it is offered on the native path and withheld on the routed
                     * one, where the recorded quota answers instead, and may name no instant at all, which the
                     * client renders as a plain notice. That is the truth; an invented clock time is not. */
                    const allowance = this.args.allowance;
                    yield await rateLimitFrame(
                        allowance,
                        allowance === undefined ? Math.ceil((Date.now() + message.retry_delay_ms) / 1000) : undefined,
                    );
                    return true;
                }
                /* The storm is not clearing, so stop riding it out in here: the frame the harness would have
                 * ended on eventually goes out now, agent.routes files it as the outage it is, and the resume
                 * scheduler owns the waiting from this point (MAX_IN_TURN_RETRIES has the argument). */
                if (message.attempt >= MAX_IN_TURN_RETRIES) {
                    yield retryStormFrame(message.attempt, message.error_status ?? undefined);
                    return true;
                }
                /* Every other retry is still happening INSIDE this turn, so nothing has failed yet and there is
                 * nothing in the transcript to write. Forwarded because the retry budget is deliberately long
                 * (CLAUDE_CODE_RETRY_WATCHDOG in harness-credentials.ts): without this status a turn riding out
                 * an outage is indistinguishable from one that hung.
                 *
                 * The bound on the wire is whichever of the two will actually be honoured, and on this path that
                 * is almost always OURS: promising the harness's three hundred while the branch above ends the
                 * turn at eight is a countdown to a number nothing intends to reach. Read as a min rather than
                 * hard-coded so a harness release that lowers its own budget under ours still governs. */
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
                /* THE SDK'S SUBAGENT LIFECYCLE, the four messages that used to be dropped here for having "no UI
                 * mapping". They are the only account of a child between its tool_use and its result: what it is,
                 * what it is spending, what it is doing right now, whether it finished or failed. Which for a
                 * BACKGROUNDED child (the Agent tool's default) is the entire account, because its result may not
                 * land for minutes. The registry owns the fold; this only forwards what came back. */
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

    // Claude subscription usage for the turn: which window is active, how much of it is spent, and when it
    // resets. The SDK reports it on the stream at no token cost, we'd otherwise drop it. Only Claude turns
    // emit it (Codex/Grok have no equivalent).
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
        // Only surface accounting when the SDK actually reported it (real turns always do; the empty frame
        // would be noise).
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
        // Context-window fill: pair the latest message_start input size with the model's window (a static
        // per-model constant carried on the result). Key by the turn's model, fall back to the sole entry.
        if (this.contextTokens !== undefined) {
            const window =
                (this.contextModel !== undefined ? message.modelUsage[this.contextModel]?.contextWindow : undefined) ??
                Object.values(message.modelUsage)[0]?.contextWindow;
            if (window !== undefined && window > 0) {
                yield { kind: "context_usage", tokens: this.contextTokens, contextWindow: window };
            }
        }
        // The settled answer on speed. Usually a no-op, `init` already said it and nothing moved, but it
        // is the frame that catches a turn dropped into cooldown partway through, and the one that replaces
        // an init-time `pending` with the real reason.
        const speed = this.fastModeChange(message.fast_mode_state, message.fast_mode_disabled_reason);
        if (speed !== undefined) {
            yield speed;
        }
        if (message.subtype !== "success") {
            yield { kind: "error", message: `agent did not complete (${message.subtype})` };
        }
        // The account's headroom, re-read now that the turn has settled, the freshest this account's
        // limits get without spending anything to find out. After the result frames on purpose: the read
        // is a network round trip, and nothing about it should sit between the user and the answer they
        // were waiting for. An empty read (no pools reported, a failed request) yields no frame at all
        // rather than an empty window list, which would read as "measured, and you have no limits".
        const windows = this.args.readUsage === undefined ? [] : await this.args.readUsage();
        if (windows.length > 0) {
            yield { kind: "account_usage", windows };
        }
        // NOT the end of the stream: sdkTurns owns the turn boundary, a steered stream can carry a
        // follow-up turn after this result, whose frames keep flowing through the same cases above.
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
