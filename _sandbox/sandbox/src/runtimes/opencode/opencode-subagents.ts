import type { OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { z } from "zod";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import type { UsageTotals } from "../decorators/vendor-events.js";
import { opt } from "../../opt.js";
import { isToolEvent, stepTokens, type ToolCards, type ToolEvent } from "./opencode-frames.js";

// OpenCode's own subagents. Its `subagent` tool opens a child session naming the parent, runs a subagent there, and
// tells the parent's call that session's id once it exists (the call's progress metadata). The runner lets a subagent's
// events through (opencode-agent.ts); these frames put the subagent under its call's card the way the Claude loop's
// stream does: the subagent itself as `subagent` frames, its own calls, thinking and prose tagged with the call's id.

// OpenCode's name for the tool that starts a subagent.
export const SUBAGENT_TOOL = "subagent";

// A subagent call's input and progress metadata, read tolerantly: another shape reads as absent, never as a throw.
const SubagentInputSchema = z.object({ agent: z.string().optional().catch(undefined), description: z.string().optional().catch(undefined) }).catch({});
const SubagentMetadataSchema = z.object({ sessionID: z.string().optional().catch(undefined) }).catch({});

// The call's answer wraps the subagent's closing words: `<subagent sessionID="…" state="…">…</subagent>`.
const SUBAGENT_RESULT = /<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>/u;
// Enough of a report to read it by without opening the subagent; the whole of it is the call's own card.
const REPORT_KEPT = 4_000;
const reportOf = (output: string): string => (SUBAGENT_RESULT.exec(output)?.[1] ?? output).trim().slice(0, REPORT_KEPT);

// Events a subagent's session sends before its call names that session are held, up to this many each.
const HELD_PER_SESSION = 500;

export interface OpenCodeSubagents {
    // What a parent's tool event says beyond its own card, for a subagent call: the subagent's birth, the session it runs
    // in, its ending. Nothing for any other tool.
    readonly call: (event: ToolEvent) => AgentEvent[];
    // One event of a subagent's own session, as frames under its call; held until the call has named that session.
    readonly child: (event: OpenCodeEvent, session: string) => AgentEvent[];
}

// What one subagent has done so far, as its record counts it.
interface Progress {
    toolUses: number;
    tokens: number;
}

export const openCodeSubagents = (cards: ToolCards, usage: UsageTotals): OpenCodeSubagents => {
    const callOf = new Map<string, string>();
    const held = new Map<string, OpenCodeEvent[]>();
    const born = new Set<string>();
    const progress = new Map<string, Progress>();

    const progressOf = (call: string): Progress => {
        const known = progress.get(call);
        if (known !== undefined) {
            return known;
        }
        const fresh = { toolUses: 0, tokens: 0 };
        progress.set(call, fresh);
        return fresh;
    };

    // A subagent's own status, retries and endings say nothing its call's card does not say better.
    const childFrames = (event: OpenCodeEvent, call: string): AgentEvent[] => {
        if (event.type === "session.text.delta") {
            return [{ kind: "delta", text: event.data.delta, parentToolUseId: call }];
        }
        if (event.type === "session.reasoning.delta") {
            return [{ kind: "thinking", text: event.data.delta, parentToolUseId: call }];
        }
        if (event.type === "session.step.ended") {
            // The subagent's spend is the turn's spend too; its record counts it as its own.
            const tokens = stepTokens(event);
            usage.add(tokens, event.id);
            const count = progressOf(call);
            count.tokens += tokens.inputTokens + tokens.outputTokens;
            return [{ kind: "subagent_update", id: call, tokens: count.tokens }];
        }
        if (!isToolEvent(event)) {
            return [];
        }
        const frames = cards.frames(event, call);
        if (!frames.some((frame) => frame.kind === "tool_call")) {
            return frames;
        }
        const count = progressOf(call);
        count.toolUses += 1;
        return [...frames, { kind: "subagent_update", id: call, toolUses: count.toolUses, lastTool: displayNameOf(cards.call(event.data.id).raw ?? "tool") }];
    };

    return {
        call: (event) => {
            const id = event.data.id;
            const { raw, input } = cards.call(id);
            if (raw !== SUBAGENT_TOOL || event.type === "session.tool.input.started") {
                return [];
            }
            const frames: AgentEvent[] = [];
            if (!born.has(id) && input !== undefined) {
                born.add(id);
                const read = SubagentInputSchema.parse(input);
                frames.push({ kind: "subagent", id, subagentKind: "subagent", ...opt("agentType", read.agent), ...opt("description", read.description) });
            }
            const session = event.type === "session.tool.called" ? undefined : SubagentMetadataSchema.parse(event.data.metadata).sessionID;
            if (session !== undefined && !callOf.has(session)) {
                callOf.set(session, id);
                for (const waiting of held.get(session) ?? []) {
                    frames.push(...childFrames(waiting, id));
                }
                held.delete(session);
            }
            if (event.type === "session.tool.success") {
                frames.push({ kind: "subagent_update", id, status: "completed", summary: reportOf(event.data.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")) });
            } else if (event.type === "session.tool.failed") {
                frames.push({ kind: "subagent_update", id, status: "failed", error: event.data.error.message });
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
