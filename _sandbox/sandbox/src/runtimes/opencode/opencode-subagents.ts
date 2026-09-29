import type { Event, ToolPart } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { z } from "zod";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import type { UsageTotals } from "../decorators/vendor-events.js";
import { opt } from "../../opt.js";

// OpenCode's own subagents. Its `task` tool opens a child session naming the parent, runs a subagent there, and tells
// the parent's task part that session's id once it exists. The runner lets a subagent's events through
// (opencode-agent.ts); these frames put the subagent under its task's card the way the Claude loop's stream does: the
// subagent itself as `subagent` frames, its own calls, thinking and prose tagged with the task call's id.

// A task part's input and running metadata, read tolerantly: another shape reads as absent, never as a throw.
const TaskInputSchema = z.object({ description: z.string().optional().catch(undefined), subagent_type: z.string().optional().catch(undefined) }).catch({});
const TaskMetadataSchema = z.object({ sessionId: z.string().optional().catch(undefined) }).catch({});

// The task's answer wraps the subagent's closing words: `<task id="…" state="…"><task_result>…</task_result></task>`.
const TASK_RESULT = /<task_(?:result|error)>\n?([\s\S]*?)\n?<\/task_(?:result|error)>/u;
// Enough of a report to read it by without opening the subagent; the whole of it is the task's own card.
const REPORT_KEPT = 4_000;
const reportOf = (output: string): string => (TASK_RESULT.exec(output)?.[1] ?? output).trim().slice(0, REPORT_KEPT);

// Events a subagent's session sends before its task names that session are held, up to this many each.
const HELD_PER_SESSION = 500;

// The adapter's own mapping of one tool part, opening its card under `parent`.
export type ToolPartFrames = (part: ToolPart, parent: string) => AgentEvent[];

export interface OpenCodeSubagents {
    // What a parent `task` part says beyond its own card: the subagent's birth, the session it runs in, its ending.
    readonly task: (part: ToolPart) => AgentEvent[];
    // One event of a subagent's own session, as frames under its task; held until the task has named that session.
    readonly child: (event: Event, session: string) => AgentEvent[];
}

// What one subagent has done so far, as its record counts it.
interface Progress {
    toolUses: number;
    readonly tokens: Map<string, number>;
}

export const openCodeSubagents = (toolFrames: ToolPartFrames, usage: UsageTotals): OpenCodeSubagents => {
    const callOf = new Map<string, string>();
    const held = new Map<string, Event[]>();
    const born = new Set<string>();
    const progress = new Map<string, Progress>();
    // A subagent's messages by id, to tell its own prose from the prompt its task sent it.
    const roles = new Map<string, "user" | "assistant">();
    const emitted = new Map<string, number>();

    const progressOf = (call: string): Progress => {
        const known = progress.get(call);
        if (known !== undefined) {
            return known;
        }
        const fresh = { toolUses: 0, tokens: new Map<string, number>() };
        progress.set(call, fresh);
        return fresh;
    };

    // A text or reasoning part's new suffix; a snapshot no longer than what went out carries nothing new.
    const suffixOf = (id: string, text: string): string | undefined => {
        const before = emitted.get(id) ?? 0;
        if (text.length <= before) {
            return undefined;
        }
        emitted.set(id, text.length);
        return text.slice(before);
    };

    // The subagent's spend is the turn's spend too, filed under its own message; its record counts it as its own.
    const spent = (event: Extract<Event, { type: "message.updated" }>, call: string): AgentEvent[] => {
        const info = event.properties.info;
        roles.set(info.id, info.role);
        if (info.role !== "assistant") {
            return [];
        }
        usage.add(
            {
                inputTokens: info.tokens.input,
                outputTokens: info.tokens.output,
                cacheReadTokens: info.tokens.cache.read,
                cacheCreationTokens: info.tokens.cache.write,
                costUsd: info.cost,
            },
            info.id,
        );
        const tokens = progressOf(call).tokens;
        tokens.set(info.id, info.tokens.input + info.tokens.output);
        return [{ kind: "subagent_update", id: call, tokens: [...tokens.values()].reduce((sum, count) => sum + count, 0) }];
    };

    const partFrames = (part: Extract<Event, { type: "message.part.updated" }>["properties"]["part"], call: string): AgentEvent[] => {
        if (part.type === "text" && roles.get(part.messageID) !== "user") {
            const text = suffixOf(part.id, part.text);
            return text === undefined ? [] : [{ kind: "delta", text, parentToolUseId: call }];
        }
        if (part.type === "reasoning") {
            const text = suffixOf(part.id, part.text);
            return text === undefined ? [] : [{ kind: "thinking", text, parentToolUseId: call }];
        }
        if (part.type !== "tool" || part.tool === "todowrite") {
            return [];
        }
        const frames = toolFrames(part, call);
        if (!frames.some((frame) => frame.kind === "tool_call")) {
            return frames;
        }
        const count = progressOf(call);
        count.toolUses += 1;
        return [...frames, { kind: "subagent_update", id: call, toolUses: count.toolUses, lastTool: displayNameOf(part.tool) }];
    };

    // A subagent's own status, retries and idle say nothing its task's part does not say better.
    const childFrames = (event: Event, call: string): AgentEvent[] => {
        if (event.type === "message.updated") {
            return spent(event, call);
        }
        return event.type === "message.part.updated" ? partFrames(event.properties.part, call) : [];
    };

    return {
        task: (part) => {
            if (part.tool !== "task" || part.state.status === "pending") {
                return [];
            }
            const state = part.state;
            const frames: AgentEvent[] = [];
            if (!born.has(part.callID)) {
                born.add(part.callID);
                const input = TaskInputSchema.parse(state.input);
                frames.push({ kind: "subagent", id: part.callID, subagentKind: "subagent", ...opt("agentType", input.subagent_type), ...opt("description", input.description) });
            }
            const session = TaskMetadataSchema.parse(state.metadata).sessionId;
            if (session !== undefined && !callOf.has(session)) {
                callOf.set(session, part.callID);
                for (const event of held.get(session) ?? []) {
                    frames.push(...childFrames(event, part.callID));
                }
                held.delete(session);
            }
            if (state.status === "completed") {
                frames.push({ kind: "subagent_update", id: part.callID, status: "completed", summary: reportOf(state.output) });
            } else if (state.status === "error") {
                frames.push({ kind: "subagent_update", id: part.callID, status: "failed", error: state.error });
            }
            return frames;
        },
        child: (event, session) => {
            const call = callOf.get(session);
            if (call !== undefined) {
                return childFrames(event, call);
            }
            const waiting = held.get(session) ?? [];
            if (waiting.length < HELD_PER_SESSION) {
                waiting.push(event);
            }
            held.set(session, waiting);
            return [];
        },
    };
};
