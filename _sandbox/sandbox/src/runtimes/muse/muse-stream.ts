import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@intentic/sandbox-contract/events/requests";
import { toolCategoryOf } from "@intentic/agent-context/tool-calls";
import { isContextOverflowText } from "../../engines/failure-sentences.js";
import { workspacePath } from "../../sessions/vocabulary/tool-calls.js";
import { opt } from "../../opt.js";
import { isRateLimited } from "../decorators/vendor-errors.js";
import { type MuseEvent, type MuseItem, type MuseToolArgs, type MuseTurnError, shellResultOf, toolArgsOf } from "./muse-wire.js";

// One Muse turn's notifications as the daemon's frames: prose and reasoning as they stream, each tool call as a card
// with the category, files and diff the verification ledger reads, usage and context fill, the retries Muse schedules
// itself, and its typed failure coded the way auto-resume keys off. Pure: no process, no cards. Approvals and questions
// are the loop's (muse-agent.ts), since answering them is a round trip.

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// How often a running command's output goes out, in ms: each frame carries the whole output so far, so one per delta
// would send a long log once per line.
const OUTPUT_EVERY_MS = 250;

// How much of one side of an edit a card carries.
const DIFF_CHARS = 32_000;

export interface MuseStreamState {
    // Text each running message has streamed so far, so its completion adds only what the deltas missed.
    readonly streamed: Map<string, string>;
    // The summary part each reasoning item streamed last, so a new part starts a new paragraph.
    readonly parts: Map<string, string>;
    // Tool cards already opened, by item id.
    readonly opened: Set<string>;
    // Each running command's output so far, and when it last went out.
    readonly output: Map<string, { text: string; at: number }>;
    // What the turn's model calls spent, summed from each completion's own report.
    readonly spent: { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number };
    // A planning phase holds its prose one message deep: the last one held is the plan.
    readonly holdMessages: boolean;
    planText: string | undefined;
    // The turn this stream is about; another turn's notifications (a queued follow-up) are not this one's.
    turnId: string | undefined;
    // Whether Muse scheduled a retry of a failing model call in this turn: a failure after that is one it outlasted.
    retried: boolean;
}

export const museStreamState = (options: { readonly holdMessages?: boolean } = {}): MuseStreamState => ({
    streamed: new Map(),
    parts: new Map(),
    opened: new Set(),
    output: new Map(),
    spent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
    holdMessages: options.holdMessages === true,
    planText: undefined,
    turnId: undefined,
    retried: false,
});

export interface MuseStreamContext {
    // The workspace root as the turn sees it, which every card's paths are made relative to.
    readonly cwd: string;
    // The clock, a parameter so a suite can step it.
    readonly now?: () => number;
}

const clipped = (text: string): { readonly text: string; readonly truncated: boolean } =>
    text.length > DIFF_CHARS ? { text: text.slice(0, DIFF_CHARS), truncated: true } : { text, truncated: false };

// What a call's card opens with: its name in the transcript's vocabulary, what it does, and what it touches.
interface ToolOpening {
    readonly name: string;
    readonly category: ToolKind;
    readonly target?: string;
    readonly path?: string;
    readonly content?: ToolCallContent[];
}

const editDiff = (path: string | undefined, args: MuseToolArgs, tool: string): ToolCallContent[] | undefined => {
    if (path === undefined) {
        return undefined;
    }
    if (tool === "write_file" && args.content !== undefined) {
        const next = clipped(args.content);
        return [{ type: "diff", path, newText: next.text, ...opt("truncated", next.truncated ? true : undefined) }];
    }
    if (tool === "edit_file" && args.find !== undefined && args.replace !== undefined) {
        const before = clipped(args.find);
        const after = clipped(args.replace);
        const truncated = before.truncated || after.truncated;
        return [{ type: "diff", path, oldText: before.text, newText: after.text, ...opt("truncated", truncated ? true : undefined) }];
    }
    return undefined;
};

// Muse's own tools by name (its `muse` namespace); anything else, an MCP server's tool included, is named as Muse names it
// and categorized by its verb.
const openingOf = (item: MuseItem, args: MuseToolArgs, cwd: string): ToolOpening => {
    const tool = item.tool ?? "tool";
    const path = args.path === undefined ? undefined : workspacePath(args.path, cwd);
    switch (tool) {
        case "bash":
            return { name: "Bash", category: "execute", ...opt("target", args.command) };
        case "bash_input":
            return { name: "Bash", category: "execute", ...opt("target", args.chars) };
        case "read_file":
            return { name: "Read", category: "read", ...opt("target", path ?? args.path), ...opt("path", path) };
        case "write_file":
            return { name: "Write", category: "edit", ...opt("target", path ?? args.path), ...opt("path", path), ...opt("content", editDiff(path, args, tool)) };
        case "edit_file":
            return { name: "Edit", category: "edit", ...opt("target", path ?? args.path), ...opt("path", path), ...opt("content", editDiff(path, args, tool)) };
        case "search":
            return { name: "Grep", category: "search", ...opt("target", args.pattern) };
        case "web_fetch":
            return { name: "WebFetch", category: "fetch", ...opt("target", args.url) };
        case "web_search":
            return { name: "WebSearch", category: "search", ...opt("target", args.query) };
        default:
            // A tool with a patch is an edit whatever it is called (a preset's apply_patch, a later edit tool).
            return { name: tool, category: item.patchSummary === undefined ? toolCategoryOf(tool) : "edit", ...opt("target", args.command ?? args.path ?? args.url) };
    }
};

const locationsOf = (opening: ToolOpening): ToolCallLocation[] | undefined => (opening.path === undefined ? undefined : [{ path: opening.path }]);

// The card opening, for a call seen starting or seen only once it was done.
const toolCallFrame = (item: MuseItem, opening: ToolOpening, status: "in_progress" | "completed" | "failed"): AgentEvent => ({
    kind: "tool_call",
    id: item.itemId,
    name: opening.name,
    category: opening.category,
    status,
    ...opt("target", opening.target),
    ...opt("locations", locationsOf(opening)),
    ...opt("content", opening.content),
    ...opt("input", opening.target === undefined ? item.args?.slice(0, 2_000) : undefined),
});

// What a finished call's card settles with: its output, and the command's exit code where it ran one.
interface SettledCall {
    readonly content: ToolCallContent[] | undefined;
    readonly exitCode: number | undefined;
}

// A shell call's result: Muse wraps the command's own output and exit code in an envelope, which the card unwraps.
const settledContent = (item: MuseItem, opening: ToolOpening): SettledCall => {
    if (opening.name === "Bash") {
        const shell = shellResultOf(item.visibleOutput);
        if (shell !== undefined) {
            return { content: [{ type: "text", text: shell.output }], exitCode: shell.exit_code };
        }
    }
    const said = [item.visibleOutput, item.failureReason].filter((text): text is string => text !== undefined && text !== "").join("\n");
    // An edit's diff went out when it opened; its completion adds the tool's words only where it failed.
    if (opening.category === "edit" && opening.content !== undefined && item.status === "completed") {
        return { content: undefined, exitCode: undefined };
    }
    return { content: said === "" ? undefined : [{ type: "text", text: said }], exitCode: undefined };
};

// A finished call settles completed or failed; a call refused at its approval reads as failed with its reason.
const settledStatus = (item: MuseItem, exitCode: number | undefined): "completed" | "failed" =>
    item.status === "completed" && (exitCode === undefined || exitCode === 0) ? "completed" : "failed";

function* toolFrames(method: "item/started" | "item/updated" | "item/completed", item: MuseItem, context: MuseStreamContext, state: MuseStreamState): Generator<AgentEvent> {
    const args = toolArgsOf(item.args);
    if (item.tool === "update_plan") {
        if (method === "item/started" && args.plan !== undefined) {
            yield { kind: "todos", items: args.plan.map((entry) => ({ content: entry.step, status: entry.status })) };
        }
        return;
    }
    const opening = openingOf(item, args, context.cwd);
    if (method !== "item/completed") {
        if (!state.opened.has(item.itemId)) {
            state.opened.add(item.itemId);
            yield toolCallFrame(item, opening, "in_progress");
        }
        return;
    }
    state.output.delete(item.itemId);
    const { content, exitCode } = settledContent(item, opening);
    const status = settledStatus(item, exitCode);
    if (!state.opened.delete(item.itemId)) {
        // Seen only once done (after a gap, or a single-shot call): opened and settled in one frame.
        yield toolCallFrame(item, { ...opening, ...opt("content", content ?? opening.content) }, status);
        return;
    }
    yield { kind: "tool_call_update", id: item.itemId, status, ...opt("content", content), ...opt("exitCode", exitCode) };
}

// What a message's whole text adds to what its deltas already showed; should the two disagree, the deltas stand.
const unsaid = (state: MuseStreamState, id: string, whole: string): string => {
    const said = state.streamed.get(id);
    state.streamed.delete(id);
    if (said === undefined) {
        return whole;
    }
    return whole.startsWith(said) ? whole.slice(said.length) : "";
};

function* messageFrames(item: MuseItem, state: MuseStreamState): Generator<AgentEvent> {
    const whole = item.text ?? "";
    if (state.holdMessages) {
        // Held one deep: a newer message flushes the one before it, so the last one held is the plan.
        state.streamed.delete(item.itemId);
        if (state.planText !== undefined) {
            yield { kind: "delta", text: state.planText };
            yield { kind: "text_end" };
        }
        state.planText = whole;
        return;
    }
    const rest = unsaid(state, item.itemId, whole);
    if (rest !== "") {
        yield { kind: "delta", text: rest };
    }
    yield { kind: "text_end" };
}

// A subagent Muse started: a card under its objective, settled with what it reported back.
function* subagentFrames(method: "item/started" | "item/updated" | "item/completed", item: MuseItem, state: MuseStreamState): Generator<AgentEvent> {
    if (method !== "item/completed") {
        if (!state.opened.has(item.itemId)) {
            state.opened.add(item.itemId);
            yield { kind: "tool_call", id: item.itemId, name: "Agent", category: "other", status: "in_progress", ...opt("target", item.objective) };
        }
        return;
    }
    state.opened.delete(item.itemId);
    const report = item.result?.summary ?? item.result?.text ?? item.failureReason;
    yield {
        kind: "tool_call_update",
        id: item.itemId,
        status: item.status === "completed" ? "completed" : "failed",
        ...opt("content", report === undefined ? undefined : [{ type: "text" as const, text: report }]),
    };
    // A child's model calls are the account's spend too, and Muse never folds them into the session's own counters.
    if (item.usage !== undefined) {
        spend(state, item.usage.inputTokens, item.usage);
    }
}

function* itemFrames(method: "item/started" | "item/updated" | "item/completed", item: MuseItem, context: MuseStreamContext, state: MuseStreamState): Generator<AgentEvent> {
    switch (item.kind) {
        case "agentMessage":
            if (method === "item/completed") {
                yield* messageFrames(item, state);
            }
            return;
        case "toolCall":
            yield* toolFrames(method, item, context, state);
            return;
        case "subagent":
            yield* subagentFrames(method, item, state);
            return;
        case "webSearch":
            if (method === "item/completed") {
                yield { kind: "tool_call", id: item.itemId, name: "WebSearch", category: "search", status: "completed", ...opt("target", item.fallbackText) };
            }
            return;
        case "compaction":
            if (method === "item/completed") {
                yield { kind: "compact", trigger: item.trigger ?? "auto", ...opt("preTokens", item.tokensBefore), ...opt("postTokens", item.tokensAfter) };
            }
            return;
        default:
            // The turn's own prompt echoed back, Muse's background reminder observers, its hook runs, reasoning that is
            // whole only at the end (its summary streamed as deltas already): nothing the transcript shows twice.
            return;
    }
}

// Live text of a running item: a message's prose, a reasoning summary part, a command's output.
function* deltaFrames(event: Extract<MuseEvent, { method: "item/delta" }>, context: MuseStreamContext, state: MuseStreamState): Generator<AgentEvent> {
    const { itemId, field, delta } = event.params;
    if (field === "output") {
        const running = state.output.get(itemId) ?? { text: "", at: 0 };
        running.text += delta;
        state.output.set(itemId, running);
        const now = (context.now ?? Date.now)();
        if (now - running.at >= OUTPUT_EVERY_MS) {
            running.at = now;
            yield { kind: "tool_call_update", id: itemId, content: [{ type: "text", text: running.text }] };
        }
        return;
    }
    if (field.startsWith("summary.")) {
        // A reasoning summary streams part by part (`summary.0`, `summary.1`); a new part starts a new paragraph.
        const part = state.parts.get(itemId);
        state.parts.set(itemId, field);
        yield { kind: "thinking", text: part !== undefined && part !== field ? `\n${delta}` : delta };
        return;
    }
    if (field !== "text" || state.holdMessages) {
        return;
    }
    state.streamed.set(itemId, (state.streamed.get(itemId) ?? "") + delta);
    yield { kind: "delta", text: delta };
}

const spend = (state: MuseStreamState, prompt: number, usage: { readonly outputTokens: number; readonly cachedTokens: number; readonly cacheReadTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined }): void => {
    // Muse's counted-once prompt total, split the way every other runtime reports it: cache reads and writes apart
    // from the fresh input they are part of. A provider that names no read/write split reports its cached tokens whole.
    const cacheRead = usage.cacheReadTokens ?? usage.cachedTokens;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    state.spent.input += Math.max(0, prompt - cacheRead - cacheWrite);
    state.spent.output += usage.outputTokens;
    state.spent.cacheRead += cacheRead;
    state.spent.cacheWrite += cacheWrite;
    state.spent.calls += 1;
};

// What the turn spent, once, as it ends; nothing when no model call reported any.
export const museUsageFrame = (state: MuseStreamState, durationMs: number | undefined): AgentEvent | undefined =>
    state.spent.calls === 0
        ? undefined
        : {
              kind: "usage",
              inputTokens: state.spent.input,
              outputTokens: state.spent.output,
              cacheReadTokens: state.spent.cacheRead,
              cacheCreationTokens: state.spent.cacheWrite,
              ...opt("durationMs", durationMs),
          };

// How Muse's typed failure is coded, ahead of any sentence: a spent quota (Muse types it), then a window the session
// outgrew, then a model call Muse retried and could not get through (an outage the daemon re-runs once the provider is
// back), then the sentence rules every runtime shares. Undefined leaves the frame plain.
export const museFailureCode = (error: MuseTurnError, retried: boolean): ErrorFrame["code"] => {
    if (error.quota !== undefined || isRateLimited(error.message)) {
        return "rate_limit";
    }
    if (isContextOverflowText(error.message)) {
        return "context-overflow";
    }
    if (error.kind === "modelError" && (error.retryable || retried)) {
        return "provider-outage";
    }
    return undefined;
};

// Muse's own word for a key it no longer accepts, said the way the person can act on it.
const AUTH_REFUSED = "Muse Code's provider refused this turn's key. Connect the account again in Sandbox ▸ Agent, then send again.";

export const museFailureFrame = (error: MuseTurnError, retried: boolean): ErrorFrame => ({
    kind: "error",
    message: error.kind === "authRequired" ? `${AUTH_REFUSED} (${error.message})` : error.message,
    ...opt("code", museFailureCode(error, retried)),
});

/** One notification's frames; turn-level bookkeeping (usage, the terminal) is read here but emitted by the loop. */
export function* museFrames(event: MuseEvent, context: MuseStreamContext, state: MuseStreamState): Generator<AgentEvent> {
    switch (event.method) {
        case "item/started":
        case "item/updated":
        case "item/completed":
            if (state.turnId === undefined || event.params.item.turnId === undefined || event.params.item.turnId === null || event.params.item.turnId === state.turnId) {
                yield* itemFrames(event.method, event.params.item, context, state);
            }
            return;
        case "item/delta":
            yield* deltaFrames(event, context, state);
            return;
        case "turn/retryScheduled":
            state.retried = true;
            yield {
                kind: "provider_retry",
                attempt: event.params.nextAttempt,
                maxAttempts: event.params.maxAttempts,
                nextAttemptAt: (context.now ?? Date.now)() + event.params.retryDelayMs,
                ...opt("status", event.params.httpStatus),
            };
            return;
        case "session/tokenUsage":
            if (state.turnId === undefined || event.params.turnId === state.turnId) {
                spend(state, event.params.promptTokens, event.params.usage);
            }
            return;
        case "session/contextUsage":
            // Without the window there is no fill to show, only a count.
            if (event.params.windowTokens !== undefined && event.params.windowTokens > 0) {
                yield { kind: "context_usage", tokens: event.params.usedTokens, contextWindow: event.params.windowTokens };
            }
            return;
        case "session/modelChanged":
            yield { kind: "init", model: event.params.modelId };
            return;
        default:
            return;
    }
}
