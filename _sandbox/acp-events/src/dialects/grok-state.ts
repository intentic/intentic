import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import type { z } from "zod";
import type { ChildSession, DialectFrames } from "./dialect.js";
import { bornFrame, type FinishedSchema, finishedFrame, type ProgressSchema, progressFrame, reportOf, type SpawnedSchema, SpawnInputSchema, subagentStatus } from "./grok-subagents.js";
import { type BackgroundedSchema, type CompletedSchema, type GrokTask, isSubagentTask, KillInputSchema, StartedOutputSchema, taskEndedFrame, taskResults } from "./grok-tasks.js";

// What one connection to Grok Build remembers between messages (grok.ts reads each message into these steps).

interface Subagent {
    readonly session: string;
    readonly call: string;
    finished: boolean;
}

interface Task {
    readonly session: string;
    readonly call: string | undefined;
    finished: boolean;
}

// A call that spawns a subagent, not yet paired with the subagent it started.
interface OpenSpawn {
    readonly session: string;
    readonly call: string;
    description: string | undefined;
    background: boolean;
}

export interface GrokState {
    readonly spawns: OpenSpawn[];
    readonly subagents: Map<string, Subagent>;
    readonly children: Map<string, ChildSession>;
    readonly tasks: Map<string, Task>;
    // Sessions owed a wake: a child ended saying it will wake the agent, and no turn has completed there since.
    readonly wakes: Set<string>;
}

export const grokState = (): GrokState => ({ spawns: [], subagents: new Map(), children: new Map(), tasks: new Map(), wakes: new Set() });

const KILL_TOOL = "kill_command_or_subagent";

// Where a session's frames land, and one of its calls as that turn knows it: a child session's are its parent's.
const home = (state: GrokState, session: string, call: string): { readonly session: string; readonly call: string } => {
    const child = state.children.get(session);
    return child === undefined ? { session, call } : { session: child.parentSessionId, call: `${session}/${call}` };
};

// The spawn call a subagent came from: the open one of its parent session that it describes, else that session's oldest.
const takeSpawn = (state: GrokState, parent: string, description: string | undefined): OpenSpawn | undefined => {
    const described = state.spawns.findIndex((spawn) => spawn.session === parent && spawn.description === description);
    const index = described === -1 ? state.spawns.findIndex((spawn) => spawn.session === parent) : described;
    return index === -1 ? undefined : state.spawns.splice(index, 1)[0];
};

export const noteSpawnCall = (state: GrokState, session: string, update: ToolCall | ToolCallUpdate): void => {
    const input = SpawnInputSchema.parse(update.rawInput);
    const description = input.description?.trim();
    const background = input.background === true || input.run_in_background === true;
    const open = state.spawns.find((spawn) => spawn.session === session && spawn.call === update.toolCallId);
    if (open !== undefined) {
        open.description = description ?? open.description;
        open.background ||= background;
    } else if ("title" in update && update.status !== "completed") {
        state.spawns.push({ session, call: update.toolCallId, description, background });
    }
};

export const spawned = (state: GrokState, envelopeSession: string, update: z.infer<typeof SpawnedSchema>): DialectFrames => {
    const parent = update.parent_session_id ?? envelopeSession;
    const spawn = takeSpawn(state, parent, update.description?.trim());
    const at = home(state, parent, spawn?.call ?? update.subagent_id);
    state.subagents.set(update.subagent_id, { session: parent, call: at.call, finished: false });
    state.children.set(update.child_session_id ?? update.subagent_id, { parentSessionId: at.session, callId: at.call });
    return { sessionId: at.session, events: [bornFrame(at.call, update, spawn?.background ?? false)] };
};

export const progressed = (state: GrokState, update: z.infer<typeof ProgressSchema>): DialectFrames[] => {
    const known = state.subagents.get(update.subagent_id);
    return known === undefined ? [] : [{ sessionId: home(state, known.session, "").session, events: [progressFrame(known.call, update)] }];
};

export const finished = (state: GrokState, update: z.infer<typeof FinishedSchema>): DialectFrames[] => {
    const known = state.subagents.get(update.subagent_id);
    if (known === undefined) {
        return [];
    }
    known.finished = true;
    if (update.will_wake === true) {
        state.wakes.add(known.session);
    }
    return [{ sessionId: home(state, known.session, "").session, events: [finishedFrame(known.call, update)] }];
};

export const backgrounded = (state: GrokState, session: string, update: z.infer<typeof BackgroundedSchema>): void => {
    if (!state.tasks.has(update.task_id)) {
        state.tasks.set(update.task_id, { session, call: update.tool_call_id, finished: false });
    }
};

export const taskCompleted = (state: GrokState, session: string, update: z.infer<typeof CompletedSchema>): DialectFrames[] => {
    const task = update.task_snapshot;
    const known = state.tasks.get(task.task_id);
    if (known !== undefined) {
        known.finished = true;
    }
    if (update.will_wake === true) {
        state.wakes.add(session);
    }
    if (known?.call === undefined) {
        return [];
    }
    const at = home(state, session, known.call);
    return [{ sessionId: at.session, events: [taskEndedFrame(at.call, task)] }];
};

export const noteTaskStarted = (state: GrokState, session: string, update: ToolCall | ToolCallUpdate): void => {
    const started = StartedOutputSchema.safeParse(update.rawOutput);
    if (started.success && !state.tasks.has(started.data.task_id)) {
        state.tasks.set(started.data.task_id, { session, call: update.toolCallId, finished: false });
    }
};

// One child known to have ended by a call that read or killed it: its subagent's frame, where it is a running subagent.
const ended = (state: GrokState, id: string, status: SubagentStatus, summary: string | undefined): AgentEvent[] => {
    const task = state.tasks.get(id);
    if (task !== undefined) {
        task.finished = true;
    }
    const subagent = state.subagents.get(id);
    if (subagent === undefined || subagent.finished) {
        return [];
    }
    subagent.finished = true;
    return [summary === undefined ? { kind: "subagent_update", id: subagent.call, status } : { kind: "subagent_update", id: subagent.call, status, summary }];
};

const resultStatus = (type: "TaskOutput" | "KillTask", task: GrokTask): SubagentStatus | undefined =>
    type === "KillTask" ? (task.outcome === "killed" ? "killed" : undefined) : subagentStatus(task.status);

// What a finished call that reads or kills tasks says of the children it names.
export const resultFrames = (state: GrokState, update: ToolCall | ToolCallUpdate, tool: string): AgentEvent[] => {
    const results = taskResults(update);
    if (results !== undefined) {
        return results.tasks.flatMap((task) => {
            const status = resultStatus(results.type, task);
            if (status === undefined || status === "running") {
                return [];
            }
            return ended(state, task.task_id, status, status === "completed" && isSubagentTask(task) ? reportOf(task.output) : undefined);
        });
    }
    if (tool !== KILL_TOOL) {
        return [];
    }
    const kill = KillInputSchema.parse(update.rawInput);
    const ids = new Set([...(kill.task_ids ?? []), ...(kill.task_id === undefined ? [] : [kill.task_id])]);
    return [...ids].flatMap((id) => ended(state, id, "killed", undefined));
};
