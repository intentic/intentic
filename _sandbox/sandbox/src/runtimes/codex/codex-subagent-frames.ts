import type { AgentEvent, SubagentStatus } from "@intentic/sandbox-contract";
import { opt } from "../../opt.js";
import type { CodexEvent, CodexItem } from "./codex-app-server.js";

// Codex's own subagents as frames, from what codex-app-server.ts reads off its multi-agent calls and its subagents'
// threads. A spawn call's card carries the subagent it started, the subagent's own items nest under that card, and its
// standing moves with what Codex says of it: drawn the way the Claude loop's are, so the roster files them alike
// (agent/subagents/runtime-subagents.ts).

type ItemEvent = Extract<CodexEvent, { type: "item.started" | "item.updated" | "item.completed" }>;
type CollabItem = Extract<CodexItem, { type: "collab_agent_tool_call" }>;

// How one item of the turn's own thread reads as frames (codex-agent.ts), reused for a subagent's.
export type ItemFrames = (event: ItemEvent) => AsyncIterable<AgentEvent>;

export interface CodexSubagents {
    // Each subagent's thread, to the spawn call that started it.
    readonly spawnOf: Map<string, string>;
    // What each subagent said last, how many calls it has made, and what it has spent, by its spawn call.
    readonly said: Map<string, string>;
    readonly calls: Map<string, number>;
    readonly spent: Map<string, { readonly input: number; readonly output: number }>;
}

export const codexSubagents = (): CodexSubagents => ({ spawnOf: new Map(), said: new Map(), calls: new Map(), spent: new Map() });

/** What the turn's subagents have spent between them, which the account paid for as it paid for the turn. */
export const subagentSpend = (subagents: CodexSubagents): { readonly input: number; readonly output: number } =>
    [...subagents.spent.values()].reduce((sum, spent) => ({ input: sum.input + spent.input, output: sum.output + spent.output }), { input: 0, output: 0 });

// Codex's standing for a subagent, in the roster's words; a standing Codex adds later reads as still at work.
const COLLAB_STANDING = {
    pendingInit: "pending",
    running: "running",
    interrupted: "killed",
    completed: "completed",
    errored: "failed",
    shutdown: "killed",
    notFound: "failed",
} as const satisfies Record<string, SubagentStatus>;
const isCollabStanding = (standing: string): standing is keyof typeof COLLAB_STANDING => Object.hasOwn(COLLAB_STANDING, standing);
const standingOf = (standing: string): SubagentStatus => (isCollabStanding(standing) ? COLLAB_STANDING[standing] : "running");

// Codex's multi-agent tools, named for a reader; a tool Codex adds later is named as Codex names it.
const COLLAB_TOOLS = {
    spawnAgent: "Spawn agent",
    wait: "Wait for agents",
    sendInput: "Send to agent",
    resumeAgent: "Resume agent",
    closeAgent: "Close agent",
    sendMessage: "Message agent",
    followupTask: "Follow-up task",
    interruptAgent: "Interrupt agent",
    listAgents: "List agents",
} as const satisfies Record<string, string>;
const isCollabTool = (tool: string): tool is keyof typeof COLLAB_TOOLS => Object.hasOwn(COLLAB_TOOLS, tool);

// The first line of what a subagent was asked, as the line its card and record go by.
const DESCRIPTION_CHARS = 120;
const firstLine = (text: string | undefined): string | undefined => {
    const line = text?.trim().split("\n", 1)[0]?.trim();
    return line === undefined || line === "" ? undefined : line.slice(0, DESCRIPTION_CHARS);
};

/** Whether an event is about one of the turn's own subagents: its multi-agent calls, and its subagents' items and endings. */
export const aboutSubagent = (event: CodexEvent): boolean => {
    if (event.type === "subagent.ended" || event.type === "subagent.usage") {
        return true;
    }
    return (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && (event.parent !== undefined || event.item.type === "collab_agent_tool_call");
};

// A multi-agent call: its card, the subagent a spawn starts, and how each subagent it names now stands.
function* collabFrames(event: ItemEvent, item: CollabItem, subagents: CodexSubagents): Generator<AgentEvent> {
    const name = isCollabTool(item.tool) ? COLLAB_TOOLS[item.tool] : item.tool;
    const spawn = item.tool === "spawnAgent";
    if (event.type === "item.started") {
        yield { kind: "tool_call", id: item.id, name, category: "other", status: "in_progress", ...opt("target", firstLine(item.prompt)), ...opt("parentToolUseId", event.parent) };
        if (spawn) {
            yield { kind: "subagent", id: item.id, subagentKind: "subagent", ...opt("description", firstLine(item.prompt)), ...opt("model", item.model) };
        }
        return;
    }
    if (event.type !== "item.completed") {
        return;
    }
    yield { kind: "tool_call_update", id: item.id, status: item.status === "failed" ? "failed" : "completed" };
    if (spawn) {
        for (const thread of item.receivers) {
            subagents.spawnOf.set(thread, item.id);
        }
    }
    // A spawn that failed started nothing to wait on.
    if (spawn && item.status === "failed") {
        yield { kind: "subagent_update", id: item.id, status: "failed" };
    }
    for (const [thread, standing] of Object.entries(item.states)) {
        const started = subagents.spawnOf.get(thread);
        if (started !== undefined) {
            yield { kind: "subagent_update", id: started, status: standingOf(standing.status), ...opt("summary", standing.message) };
        }
    }
}

// One of a subagent's own items, nested under the spawn call that started it: its prose kept as what it last said, its
// calls counted as it makes them. Its checklist and compactions are its own business, not the turn's.
async function* subagentItemFrames(event: ItemEvent, parent: string, subagents: CodexSubagents, itemFrames: ItemFrames): AsyncGenerator<AgentEvent> {
    const item = event.item;
    if (item.type === "agent_message") {
        if (event.type === "item.completed") {
            subagents.said.set(parent, item.text);
            yield { kind: "delta", text: item.text, parentToolUseId: parent };
            yield { kind: "text_end", parentToolUseId: parent };
        }
        return;
    }
    if (item.type === "todo_list" || item.type === "context_compaction") {
        return;
    }
    for await (const frame of itemFrames(event)) {
        yield frame.kind === "tool_call" || frame.kind === "thinking" ? { ...frame, parentToolUseId: parent } : frame;
        if (frame.kind === "tool_call") {
            const calls = (subagents.calls.get(parent) ?? 0) + 1;
            subagents.calls.set(parent, calls);
            yield { kind: "subagent_update", id: parent, toolUses: calls, lastTool: frame.name };
        }
    }
}

/** The frames of an event aboutSubagent said yes to. */
export async function* codexSubagentFrames(event: CodexEvent, subagents: CodexSubagents, itemFrames: ItemFrames): AsyncGenerator<AgentEvent> {
    if (event.type === "subagent.ended") {
        yield { kind: "subagent_update", id: event.parent, status: event.status, ...opt("summary", subagents.said.get(event.parent)), ...opt("error", event.error) };
        return;
    }
    if (event.type === "subagent.usage") {
        subagents.spent.set(event.parent, { input: event.input, output: event.output });
        yield { kind: "subagent_update", id: event.parent, tokens: event.input + event.output };
        return;
    }
    if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
        return;
    }
    if (event.item.type === "collab_agent_tool_call") {
        yield* collabFrames(event, event.item, subagents);
        return;
    }
    if (event.parent !== undefined) {
        yield* subagentItemFrames(event, event.parent, subagents, itemFrames);
    }
}
