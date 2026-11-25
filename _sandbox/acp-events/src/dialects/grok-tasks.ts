import type { ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import type { ToolCallContent } from "@intentic/sandbox-contract/events/requests";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { z } from "zod";
import { opt } from "../opt.js";
import type { ChildStop } from "./dialect.js";

// Grok Build's background tasks (read off recorded 1.0.46–1.0.70 traffic, transcribed from Orca's fixtures). A command
// the model backgrounds answers its call at once ("Background task … started", rawOutput `BackgroundTaskStarted`), and
// the task's life is told on `_x.ai/task_backgrounded` (naming the call) and `_x.ai/task_completed` (its snapshot).
// Subagents share the vocabulary: a task whose command reads `[subagent:…]` is one, and its id is the subagent's.
// The chat has no row for a background task of its own, so its ending is put on the card of the call that started it.

const TaskSchema = z.looseObject({
    task_id: z.string().min(1),
    command: z.string().optional().catch(undefined),
    description: z.string().nullish().catch(undefined),
    output: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    exit_code: z.number().int().nullish().catch(undefined),
    signal: z.union([z.string(), z.number()]).nullish().catch(undefined),
    explicitly_killed: z.boolean().optional().catch(undefined),
    status: z.string().optional().catch(undefined),
    outcome: z.string().optional().catch(undefined),
});
export type GrokTask = z.infer<typeof TaskSchema>;

export const BackgroundedSchema = TaskSchema.extend({ sessionUpdate: z.literal("task_backgrounded"), tool_call_id: z.string().optional().catch(undefined) });
export const CompletedSchema = z.looseObject({
    sessionUpdate: z.literal("task_completed"),
    task_snapshot: TaskSchema,
    will_wake: z.boolean().optional().catch(undefined),
});

// A call's answer that is a background task starting, or that reads or kills tasks.
export const StartedOutputSchema = TaskSchema.extend({ type: z.literal("BackgroundTaskStarted") });
const ResultsSchema = z.looseObject({
    type: z.enum(["TaskOutput", "KillTask"]),
    Result: TaskSchema.optional().catch(undefined),
    MultiResult: z.looseObject({ results: z.array(TaskSchema) }).optional().catch(undefined),
});
export const taskResults = (update: Pick<ToolCallUpdate, "rawOutput">): { readonly type: "TaskOutput" | "KillTask"; readonly tasks: readonly GrokTask[] } | undefined => {
    const parsed = ResultsSchema.safeParse(update.rawOutput);
    return parsed.success ? { type: parsed.data.type, tasks: parsed.data.MultiResult?.results ?? (parsed.data.Result === undefined ? [] : [parsed.data.Result]) } : undefined;
};
// The ids a kill call names, read off its input.
export const KillInputSchema = z
    .looseObject({ task_id: z.string().trim().min(1).optional().catch(undefined), task_ids: z.array(z.string().trim().min(1)).optional().catch(undefined) })
    .catch({});

const SUBAGENT_COMMAND = /^\[subagent[:\]]/u;
export const isSubagentTask = (task: Pick<GrokTask, "command">): boolean => SUBAGENT_COMMAND.test(task.command ?? "");

// How much of a finished task's output its card keeps; the whole is in the task's output file.
const OUTPUT_KEPT = 4_000;

const failed = (task: GrokTask): boolean => task.signal != null || (task.error?.trim() ?? "") !== "" || (task.exit_code != null && task.exit_code !== 0);

// The card of the call that started a task, once the task has ended: its exit, what it was for, and its output's tail.
export const taskEndedFrame = (call: string, task: GrokTask): AgentEvent => {
    const what = task.description?.trim() || task.command?.trim() || task.task_id;
    const how = task.explicitly_killed === true ? "was stopped" : task.exit_code == null ? "ended" : `exited with code ${String(task.exit_code)}`;
    const lines = [`Background task ${how}: ${what}`];
    const output = (task.error?.trim() || task.output?.trim() || "").slice(-OUTPUT_KEPT);
    if (output !== "") {
        lines.push(output);
    }
    const content: ToolCallContent[] = [{ type: "text", text: lines.join("\n\n") }];
    return {
        kind: "tool_call_update",
        id: call,
        status: failed(task) && task.explicitly_killed !== true ? "failed" : "completed",
        content,
        ...opt("exitCode", task.exit_code ?? undefined),
    };
};

const METHOD_NOT_FOUND = -32_601;

// Grok's per-task kill, the one its own task list's Stop sends (no `source`, so the model is told the person stopped it).
export const GROK_TASK_STOP: ChildStop = {
    method: "_x.ai/task/kill",
    probe: {},
    supported: (outcome) => outcome.error?.code !== METHOD_NOT_FOUND,
    params: (sessionId, taskId) => ({ sessionId, taskId }),
};
