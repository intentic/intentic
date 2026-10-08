import type { OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { displayNameOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { editDiffContent, toolLocations } from "../../agent/tools/tool-calls.js";
import { toolCallOpened, type TurnTokens } from "../decorators/vendor-events.js";

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
    "session.tool.input.started" | "session.tool.called" | "session.tool.progress" | "session.tool.success" | "session.tool.failed"
>;

const TOOL_EVENTS: ReadonlySet<string> = new Set([
    "session.tool.input.started",
    "session.tool.called",
    "session.tool.progress",
    "session.tool.success",
    "session.tool.failed",
]);
export const isToolEvent = (event: OpenCodeEvent): event is ToolEvent => TOOL_EVENTS.has(event.type);

// The session an event is about, where it names one; most of OpenCode's do.
export const sessionOf = (event: OpenCodeEvent): string | undefined => {
    const session = (event.data as { readonly sessionID?: unknown } | undefined)?.sessionID;
    return typeof session === "string" ? session : undefined;
};

// What a step cost, as the usage frame counts it; keyed per step, since OpenCode reports each model call on its own.
export const stepTokens = (event: EventOf<"session.step.ended">): TurnTokens => ({
    inputTokens: event.data.tokens.input,
    outputTokens: event.data.tokens.output,
    cacheReadTokens: event.data.tokens.cache.read,
    cacheCreationTokens: event.data.tokens.cache.write,
    costUsd: event.data.cost,
});

// A finished call's words: its text parts joined; a file it returned is named rather than inlined.
const contentText = (content: readonly { readonly type: string; readonly text?: string; readonly uri?: string }[]): string =>
    content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.uri ?? "file"}]`)).join("\n");

interface Call {
    // The tool's raw name, as the model called it.
    raw: string | undefined;
    input: Record<string, unknown> | undefined;
    opened: boolean;
}

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
        const fresh: Call = { raw: undefined, input: undefined, opened: false };
        calls.set(id, fresh);
        return fresh;
    };
    const nameOf = (call: Call): string => displayNameOf(view.toolName(call.raw ?? "tool"));

    const finished = (id: string, call: Call, failed: boolean, text: string, parent: string | undefined): AgentEvent => {
        const name = nameOf(call);
        const diff = failed ? undefined : editDiffContent(name, call.input, view.cwd);
        const content = [diff ?? { type: "text" as const, text }];
        const status = failed ? ("failed" as const) : ("completed" as const);
        if (call.opened) {
            return { kind: "tool_call_update", id, status, content };
        }
        call.opened = true;
        return toolCallOpened({
            id,
            name,
            status,
            target: toolTarget(call.input),
            locations: toolLocations(call.input, view.cwd),
            content,
            parentToolUseId: parent,
        });
    };

    return {
        call: (id) => {
            const known = calls.get(id);
            return { raw: known?.raw, input: known?.input };
        },
        frames: (event, parent) => {
            const call = callOf(event.data.id);
            switch (event.type) {
                case "session.tool.input.started":
                    call.raw = event.data.name;
                    return [];
                case "session.tool.called":
                    call.input = event.data.input;
                    if (call.opened) {
                        return [];
                    }
                    call.opened = true;
                    return [
                        toolCallOpened({
                            id: event.data.id,
                            name: nameOf(call),
                            target: toolTarget(call.input),
                            locations: toolLocations(call.input, view.cwd),
                            parentToolUseId: parent,
                        }),
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
