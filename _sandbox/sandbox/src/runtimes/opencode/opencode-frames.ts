import type { OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import { editDiffContent } from "../../sessions/vocabulary/tool-calls.js";
import { toolCard, type TurnTokens } from "../decorators/vendor-events.js";
import { retryFrame } from "./opencode-failures.js";
import { opt } from "../../opt.js";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

// OpenCode 2's events as frames, the parts a turn's own session and its subagents' sessions share: tool cards, and what
// one model step spent. OpenCode announces a tool call in three steps: its name as the model starts writing it, its
// whole input once written (`called`), and its outcome; a card opens on the input, since a name alone has no target.

// What a turn's frames are read against: where it runs, and how its tool keys are spelled for a reader (a mounted MCP
// server's tool as `mcp__<server>__<tool>`, opencode-mcp.ts).
export interface TurnView {
    readonly cwd: string;
    readonly toolName: (raw: string) => string;
}

export type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>;

// The events a tool card is drawn from.
export type ToolEvent = EventOf<
    | "session.tool.input.started"
    | "session.tool.input.ended"
    | "session.tool.called"
    | "session.tool.progress"
    | "session.tool.success"
    | "session.tool.failed"
>;

const TOOL_EVENTS: ReadonlySet<string> = new Set([
    "session.tool.input.started",
    "session.tool.input.ended",
    "session.tool.called",
    "session.tool.progress",
    "session.tool.success",
    "session.tool.failed",
]);
export const isToolEvent = (event: OpenCodeEvent): event is ToolEvent => TOOL_EVENTS.has(event.type);

// The session an event is about, where it names one; most of OpenCode's do at `data.sessionID`, and a form it raises
// names its session on the form itself.
export const sessionOf = (event: OpenCodeEvent): string | undefined => {
    if (event.type === "form.created") {
        return event.data.form.sessionID;
    }
    const session = (event.data as { readonly sessionID?: unknown } | undefined)?.sessionID;
    return typeof session === "string" ? session : undefined;
};

// What one model call cost, as the usage frame counts it. OpenCode reports reasoning apart from the output it is billed
// as (2.0.26 takes it out of the provider's completion count), so it is added back: the usage frame has no reasoning
// bucket, and a thinking model's spend would otherwise read as a fraction of what it was.
// OpenCode prices a call from its own model catalog and says 0 where it holds no price (a subscription route, a model the
// catalog does not list), so a zero is an unknown price, not a free call: left out, the turn is filed as unpriced
// (turn-settlement.ts costOf) rather than as costing nothing. 2026-10-25: 142 OpenCode turns were filed at $0.
export const tokensOf = (tokens: EventOf<"session.step.ended">["data"]["tokens"], cost: number): TurnTokens => ({
    inputTokens: tokens.input,
    outputTokens: tokens.output + tokens.reasoning,
    cacheReadTokens: tokens.cache.read,
    cacheCreationTokens: tokens.cache.write,
    ...opt("costUsd", cost > 0 ? cost : undefined),
});

// One step's spend; keyed per step, since OpenCode reports each model call on its own.
export const stepTokens = (event: EventOf<"session.step.ended">): TurnTokens => tokensOf(event.data.tokens, event.data.cost);

// What a session spent between two of its running totals (`session.usage.updated`, the session's own record), less
// what its steps already reported: the model calls OpenCode makes for the session that no step reports (its title, a
// compaction). Never below nothing, so a total read late or a step reported twice cannot take spend away.
export const unreportedTokens = (before: TurnTokens, after: TurnTokens, reported: TurnTokens): TurnTokens => {
    const left = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"): number => Math.max(0, after[key] - before[key] - reported[key]);
    return {
        inputTokens: left("inputTokens"),
        outputTokens: left("outputTokens"),
        cacheReadTokens: left("cacheReadTokens"),
        cacheCreationTokens: left("cacheCreationTokens"),
        ...opt("costUsd", after.costUsd === undefined ? undefined : Math.max(0, after.costUsd - (before.costUsd ?? 0) - (reported.costUsd ?? 0))),
    };
};

// A finished call's words: its text parts joined; a file it returned is named rather than inlined.
const contentText = (content: readonly { readonly type: string; readonly text?: string; readonly uri?: string }[]): string =>
    content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.uri ?? "file"}]`)).join("\n");

// A call's arguments, as OpenCode's own event types them.
type CallInput = EventOf<"session.tool.called">["data"]["input"];

interface Call {
    // The tool's raw name, as the model called it.
    raw: string | undefined;
    input: CallInput | undefined;
    // The input as the model finished writing it (`input.ended`), for a call whose `called` came without it.
    written: CallInput | undefined;
    opened: boolean;
}

// `input.ended` carries the arguments as the text the model wrote; one JSON object is an input, anything else is none.
const WrittenInputSchema: z.ZodType<CallInput> = z.record(z.string(), z.unknown());

// A call's input for its card: what `called` said, or, where that came empty or not at all, what the model wrote. Until
// 2026-10-27 only `called` was read, and 39% of OpenCode's tool cards since 10-23 (Gemini's browser clicks, typing,
// snapshots, skills) were stored with no input at all, so a failing call could not be told from a mistyped one.
const inputOf = (call: Call): CallInput | undefined =>
    call.input !== undefined && Object.keys(call.input).length > 0 ? call.input : (call.written ?? call.input);

export interface ToolCards {
    // One tool event's frames; `parent` is the subagent call whose session made it. Undefined for a call whose input has
    // not arrived, so a caller can tell a card that opened from one still being written.
    readonly frames: (event: ToolEvent, parent?: string) => AgentEvent[];
    // The raw tool name and input a call was made with, once known.
    readonly call: (id: string) => { readonly raw: string | undefined; readonly input: Record<string, unknown> | undefined };
}

/** Tool cards for every session of one turn, keyed by call id, which OpenCode keeps unique across them. */
export const toolCards = (view: TurnView): ToolCards => {
    const calls = new Map<string, Call>();
    const callOf = (id: string): Call => {
        const known = calls.get(id);
        if (known !== undefined) {
            return known;
        }
        const fresh: Call = { raw: undefined, input: undefined, written: undefined, opened: false };
        calls.set(id, fresh);
        return fresh;
    };
    // The call's name in the canonical vocabulary, which its card is categorized by and shown from.
    const canonicalOf = (call: Call): string => view.toolName(call.raw ?? "tool");
    const nameOf = (call: Call): string => displayNameOf(canonicalOf(call));

    const finished = (id: string, call: Call, failed: boolean, text: string, parent: string | undefined): AgentEvent => {
        const name = nameOf(call);
        const diff = failed ? undefined : editDiffContent(name, inputOf(call), view.cwd);
        const content = [diff ?? { type: "text" as const, text }];
        const status = failed ? ("failed" as const) : ("completed" as const);
        if (call.opened) {
            return { kind: "tool_call_update", id, status, content };
        }
        call.opened = true;
        return toolCard({ id, name: canonicalOf(call), status, input: inputOf(call), cwd: view.cwd, content, parentToolUseId: parent });
    };

    return {
        call: (id) => {
            const known = calls.get(id);
            return { raw: known?.raw, input: known === undefined ? undefined : inputOf(known) };
        },
        frames: (event, parent) => {
            const call = callOf(event.data.id);
            switch (event.type) {
                case "session.tool.input.started":
                    call.raw = event.data.name;
                    return [];
                case "session.tool.input.ended":
                    call.written = parseJsonWith(event.data.text, WrittenInputSchema);
                    return [];
                case "session.tool.called":
                    call.input = event.data.input;
                    if (call.opened) {
                        return [];
                    }
                    call.opened = true;
                    return [
                        toolCard({ id: event.data.id, name: canonicalOf(call), input: inputOf(call), cwd: view.cwd, parentToolUseId: parent }),
                    ];
                case "session.tool.progress":
                    return [];
                case "session.tool.success":
                    return [finished(event.data.id, call, false, contentText(event.data.content), parent)];
                case "session.tool.failed":
                    return [finished(event.data.id, call, true, event.data.error.message, parent)];
            }
        },
    };
};

// What the session says of itself between its calls: a retry it scheduled, and a compaction, filed as every loop's is so
// the notes the summary dropped are said again (turn-premise.ts notesDue).
export const sessionNotice = (event: OpenCodeEvent): AgentEvent | undefined => {
    switch (event.type) {
        case "session.retry.scheduled":
            return retryFrame(event.data);
        case "session.compaction.ended":
            return { kind: "compact", trigger: event.data.reason };
        default:
            return undefined;
    }
};
