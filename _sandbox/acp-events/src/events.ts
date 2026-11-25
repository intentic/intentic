import type {
    ContentBlock,
    SessionUpdate,
    ToolCall,
    ToolCallContent as AcpToolCallContent,
    ToolCallLocation as AcpToolCallLocation,
    ToolKind as AcpToolKind,
    ToolCallUpdate,
} from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { type ToolCallContent, type ToolCallLocation, type ToolKind, ToolKindSchema } from "@intentic/sandbox-contract/events/requests";
import { toolCategoryOf } from "@intentic/agent-context/tool-calls";
import { opt } from "./opt.js";
import { diffContent, type PathReading, pathUnder, toolCard, toolInput } from "./tool-cards.js";

// Maps ACP session/update notifications onto AgentEvent frames; an update with no UI mapping returns undefined. ACP's
// `plan` is a TodoWrite-style checklist, not intentic's approval plan frame, and maps to `todos`.

// How a finished command exited, by the terminal a tool call embeds, where the caller ran that terminal itself.
export type TerminalExit = (terminalId: string) => number | undefined;

// What a caller knows that the update does not say: how its own terminals exited, and how a path the agent names reads
// against the turn's folder (`pathUnder` unless the caller has places of its own).
export interface UpdateReading {
    readonly terminalExit?: TerminalExit;
    readonly pathOf?: PathReading;
    // The agent's dialect's rewrite of a tool update before its card is read (dialects/, `normalizeToolUpdate`).
    readonly normalizeToolUpdate?: (update: ToolCallUpdate) => ToolCallUpdate;
    // The same for a call as it opens (`normalizeToolCall`).
    readonly normalizeToolCall?: (call: ToolCall) => ToolCall;
}

// ToolKind mirrors ACP's kind vocabulary verbatim; an unrecognized kind falls back to the shared name→kind table over
// the title.
const categoryOf = (kind: AcpToolKind | null | undefined, title: string): ToolKind => ToolKindSchema.safeParse(kind).data ?? toolCategoryOf(title);

const textOf = (content: ContentBlock): string => (content.type === "text" ? content.text : `[${content.type}]`);

const mapContent = (entries: AcpToolCallContent[] | null | undefined, cwd: string, pathOf: PathReading): ToolCallContent[] | undefined => {
    if (entries === null || entries === undefined || entries.length === 0) {
        return undefined;
    }
    const mapped: ToolCallContent[] = [];
    for (const entry of entries) {
        if (entry.type === "content") {
            mapped.push({ type: "text", text: textOf(entry.content) });
        } else if (entry.type === "diff") {
            // Diff paths keep a value outside the turn's folder as-is; only locations enforce the route space.
            mapped.push(diffContent(pathOf(entry.path, cwd) ?? entry.path, entry.oldText ?? undefined, entry.newText));
        } else {
            // Terminal-embed entry: where the caller runs the terminal itself it shows in its own panel (the daemon's
            // tmux session, through its adapter's terminal frame); this is a pointer to it.
            mapped.push({ type: "text", text: "[running in the live terminal panel]" });
        }
    }
    return mapped.length > 0 ? mapped : undefined;
};

const mapLocations = (locations: AcpToolCallLocation[] | null | undefined, cwd: string, pathOf: PathReading): ToolCallLocation[] | undefined => {
    if (locations === null || locations === undefined || locations.length === 0) {
        return undefined;
    }
    const mapped = locations.flatMap((location): ToolCallLocation[] => {
        const path = pathOf(location.path, cwd);
        if (path === undefined) {
            return [];
        }
        const line = location.line ?? 0;
        return [{ path, ...opt("line", line > 0 ? line : undefined) }];
    });
    return mapped.length > 0 ? mapped : undefined;
};

// A finished command's exit code, where the update carries one as a number: in `rawOutput` (`exitCode`, `exit_code`,
// or a terminal-style `exitStatus.exitCode`), else from the terminal it embeds, which the caller ran itself. Without
// it a completed call reads as a pass whatever its command did.
const RawExitSchema = z.looseObject({
    exitCode: z.number().int().optional().catch(undefined),
    exit_code: z.number().int().optional().catch(undefined),
    exitStatus: z
        .looseObject({ exitCode: z.number().int().optional().catch(undefined) })
        .optional()
        .catch(undefined),
});

const exitCodeOf = (update: ToolCallUpdate, terminalExit: TerminalExit): number | undefined => {
    if (update.status !== "completed" && update.status !== "failed") {
        return undefined;
    }
    const raw = RawExitSchema.safeParse(update.rawOutput);
    const reported = raw.success ? (raw.data.exitCode ?? raw.data.exit_code ?? raw.data.exitStatus?.exitCode) : undefined;
    if (reported !== undefined) {
        return reported;
    }
    const terminal = (update.content ?? []).findLast((entry) => entry.type === "terminal");
    return terminal?.type === "terminal" ? terminalExit(terminal.terminalId) : undefined;
};

const noTerminals: TerminalExit = () => undefined;

const toolCallUpdated = (update: ToolCallUpdate, cwd: string, terminalExit: TerminalExit, pathOf: PathReading): AgentEvent => ({
    kind: "tool_call_update",
    id: update.toolCallId,
    ...opt("status", update.status ?? undefined),
    ...opt("content", mapContent(update.content, cwd, pathOf)),
    ...opt("locations", mapLocations(update.locations, cwd, pathOf)),
    ...opt("exitCode", exitCodeOf(update, terminalExit)),
    // An agent that sends the arguments only once the call runs (Devin) leaves its card empty otherwise.
    ...opt("input", toolInput(update.rawInput, undefined)),
});

// One session/update → at most one AgentEvent. `undefined` = no UI mapping, dropped.
export const sessionUpdateEvent = (update: SessionUpdate, cwd: string, reading: UpdateReading = {}): AgentEvent | undefined => {
    const pathOf = reading.pathOf ?? pathUnder;
    switch (update.sessionUpdate) {
        case "agent_message_chunk": {
            const text = textOf(update.content);
            return text === "" ? undefined : { kind: "delta", text };
        }
        case "agent_thought_chunk": {
            const text = textOf(update.content);
            return text === "" ? undefined : { kind: "thinking", text };
        }
        case "tool_call": {
            const call = reading.normalizeToolCall?.(update) ?? update;
            return toolCard({
                id: call.toolCallId,
                name: call.title,
                category: categoryOf(call.kind, call.title),
                status: call.status ?? "in_progress",
                input: call.rawInput,
                locations: mapLocations(call.locations, cwd, pathOf),
                content: mapContent(call.content, cwd, pathOf),
            });
        }
        case "tool_call_update":
            return toolCallUpdated(reading.normalizeToolUpdate?.(update) ?? update, cwd, reading.terminalExit ?? noTerminals, pathOf);
        case "plan":
            // ACP's plan is a progress checklist (entries with status), the TodoWrite shape.
            return { kind: "todos", items: update.entries.map((entry) => ({ content: entry.content, status: entry.status })) };
        case "usage_update":
            return update.size > 0 ? { kind: "context_usage", tokens: update.used, contextWindow: update.size } : undefined;
        case "available_commands_update":
            // Agent's own slash commands, shown in the composer's `/` popover; invoking one is plain `/name …` prompt
            // text.
            return {
                kind: "commands",
                items: update.availableCommands.map((command) => ({
                    name: command.name,
                    description: command.description,
                    ...opt("hint", command.input?.hint ?? undefined),
                })),
            };
        // user_message_chunk, current_mode/config_option/session_info, plan_update/plan_removed: no UI mapping.
        default:
            return undefined;
    }
};
