import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ListenerPlanItem, ListenerStep } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import type { ToolCallStatus } from "@intentic/sandbox-contract/events/requests";
import { opt } from "../../opt.js";

// What a channel that started a turn sees of its work, read off the turn's own frames: each of its tool calls as a step
// (what kind of work, on what, and how it went, never the output), the subagents it starts as steps of their own, and
// its checklist. Only the turn's own calls: what a subagent does inside is that subagent's, as the chat shows it.

// The checklist's own tools, already shown as the checklist itself.
const CHECKLIST_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "update_plan"]);
// The calls that start a subagent, whose step is the subagent's.
const DELEGATING_TOOLS = new Set(["Task", "Agent"]);

// A call's status as its step's.
const TOOL_STEP = { pending: "running", in_progress: "running", completed: "done", failed: "failed" } as const satisfies Record<ToolCallStatus, ListenerStep["status"]>;

// A subagent's status as its step's; one still at work (or parked) leaves the step as it was.
const subagentStepStatus = (status: SubagentStatus | undefined): ListenerStep["status"] | undefined => {
    if (status === "completed") {
        return "done";
    }
    return status === "failed" || status === "killed" ? "failed" : undefined;
};

// One piece of progress a frame carried: a step that began or moved, or the checklist rewritten.
export type TurnProgressUpdate = { readonly step: ListenerStep } | { readonly plan: readonly ListenerPlanItem[] };

export interface TurnProgressReader {
    // The progress in one of the turn's frames, if it carried any a channel shows.
    readonly read: (event: AgentEvent) => TurnProgressUpdate | undefined;
}

type ToolCall = Extract<AgentEvent, { kind: "tool_call" }>;
type Subagent = Extract<AgentEvent, { kind: "subagent" }>;

// A call of the turn's own as its step, or undefined for one a channel does not show (a subagent's, the checklist's).
const callStep = (event: ToolCall): ListenerStep | undefined => {
    if (event.parentToolUseId !== undefined || CHECKLIST_TOOLS.has(event.name)) {
        return undefined;
    }
    const target = event.target === "" ? undefined : event.target;
    return {
        id: event.id,
        tool: event.name,
        kind: DELEGATING_TOOLS.has(event.name) ? "delegate" : event.category,
        status: TOOL_STEP[event.status],
        ...opt("target", target),
    };
};

// A subagent the turn started without a call this reader saw (a spawned child), as a step of its own.
const subagentStep = (event: Subagent): ListenerStep => ({ id: event.id, tool: "Agent", kind: "delegate", status: "running", ...opt("target", event.description) });

export const turnProgressReader = (): TurnProgressReader => {
    // Each of the turn's own steps by id, so an update (which names only the id) is told whole.
    const steps = new Map<string, ListenerStep>();
    const begin = (step: ListenerStep | undefined): TurnProgressUpdate | undefined => {
        if (step === undefined) {
            return undefined;
        }
        steps.set(step.id, step);
        return { step };
    };
    const move = (id: string, change: Partial<Pick<ListenerStep, "status" | "target">>): TurnProgressUpdate | undefined => {
        const known = steps.get(id);
        if (known === undefined || (change.status === undefined && change.target === undefined)) {
            return undefined;
        }
        return begin({ ...known, ...opt("status", change.status), ...opt("target", change.target) });
    };
    return {
        read: (event) => {
            switch (event.kind) {
                case "tool_call":
                    return begin(callStep(event));
                case "tool_call_update":
                    return move(event.id, { ...opt("status", event.status === undefined ? undefined : TOOL_STEP[event.status]) });
                case "subagent":
                    return steps.has(event.id) ? move(event.id, { ...opt("target", event.description) }) : begin(subagentStep(event));
                case "subagent_update":
                    return move(event.id, { ...opt("status", subagentStepStatus(event.status)) });
                case "todos":
                    return { plan: event.items.map((item) => ({ text: item.content, status: item.status })) };
                default:
                    return undefined;
            }
        },
    };
};
