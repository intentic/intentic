import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import { z } from "zod";
import { opt } from "../opt.js";
import type { ChildStop } from "./dialect.js";

// Grok Build's subagents, as its `spawn_subagent` tool runs them (read off recorded 1.0.46–1.0.70 traffic, transcribed
// from Orca's fixtures). The parent session hears `subagent_spawned`, `subagent_progress` and `subagent_finished` on
// `_x.ai/session_notification`; the subagent itself runs in a child session of its own (`child_session_id`, the same
// id as the subagent's), whose updates arrive as ordinary `session/update`s for that session. Nothing names the call
// that spawned it, so the spawn is paired with the open `spawn_subagent` call of its parent session that it describes.

const count = z.number().int().nonnegative();
const id = z.string().trim().min(1);
const text = z.string().nullish().catch(undefined);

export const SpawnedSchema = z.looseObject({
    sessionUpdate: z.literal("subagent_spawned"),
    subagent_id: id,
    parent_session_id: z.string().optional().catch(undefined),
    child_session_id: z.string().optional().catch(undefined),
    description: text,
    subagent_type: text,
    model: text,
});
export const ProgressSchema = z.looseObject({
    sessionUpdate: z.literal("subagent_progress"),
    subagent_id: id,
    tokens_used: count.optional().catch(undefined),
    tool_call_count: count.optional().catch(undefined),
    tools_used: z.array(z.string()).optional().catch(undefined),
});
export const FinishedSchema = z.looseObject({
    sessionUpdate: z.literal("subagent_finished"),
    subagent_id: id,
    status: z.string(),
    output: text,
    error: text,
    tokens_used: count.optional().catch(undefined),
    will_wake: z.boolean().optional().catch(undefined),
});

// What a spawn call's input says of the subagent: what it is for, and whether the parent waits for it.
export const SpawnInputSchema = z
    .looseObject({
        description: z.string().optional().catch(undefined),
        background: z.boolean().optional().catch(undefined),
        run_in_background: z.boolean().optional().catch(undefined),
    })
    .catch({});

// Grok's status words as the roster's.
const STATUSES: ReadonlyMap<string, SubagentStatus> = new Map([
    ["completed", "completed"],
    ["success", "completed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["cancelled", "killed"],
    ["killed", "killed"],
    ["stopped", "killed"],
    ["pending", "running"],
    ["running", "running"],
]);
export const subagentStatus = (status: string | undefined): SubagentStatus | undefined => (status === undefined ? undefined : STATUSES.get(status));

// The machine blocks Grok wraps a subagent's answer in for its own model; the words a person reads are the rest.
const MACHINE_BLOCKS = /<subagent_(meta|result)>[\s\S]*?<\/subagent_\1>/gu;
// Enough of a report to read it by without opening the subagent, as the OpenCode loop keeps.
const REPORT_KEPT = 4_000;
export const reportOf = (output: string | null | undefined): string | undefined => {
    const words = output?.replace(MACHINE_BLOCKS, "").trim().slice(0, REPORT_KEPT);
    return words === undefined || words === "" ? undefined : words;
};

export const bornFrame = (call: string, spawned: z.infer<typeof SpawnedSchema>, background: boolean): AgentEvent => ({
    kind: "subagent",
    id: call,
    subagentKind: "subagent",
    ...opt("agentType", spawned.subagent_type?.trim() || undefined),
    ...opt("description", spawned.description?.trim() || undefined),
    ...opt("model", spawned.model?.trim() || undefined),
    ...opt("background", background ? true : undefined),
});

export const progressFrame = (call: string, progress: z.infer<typeof ProgressSchema>): AgentEvent => ({
    kind: "subagent_update",
    id: call,
    status: "running",
    ...opt("tokens", progress.tokens_used === 0 ? undefined : progress.tokens_used),
    ...opt("toolUses", progress.tool_call_count),
    ...opt("lastTool", progress.tools_used?.at(-1)),
});

export const finishedFrame = (call: string, finished: z.infer<typeof FinishedSchema>): AgentEvent => {
    const status = subagentStatus(finished.status);
    return {
        kind: "subagent_update",
        id: call,
        ...opt("status", status),
        // A cancelled subagent reports zero: the running total it last stated stands.
        ...opt("tokens", finished.tokens_used === 0 ? undefined : finished.tokens_used),
        ...opt("summary", status === "completed" ? reportOf(finished.output) : undefined),
        ...opt("error", status === "failed" ? (finished.error?.trim() || undefined) : undefined),
    };
};

// JSON-RPC's "method not found": the one answer that says the agent has no such method. Any other answer to a probe
// that names no child (Grok's "missing field" refusal) says the method is there.
const METHOD_NOT_FOUND = -32_601;

export const GROK_SUBAGENT_STOP: ChildStop = {
    method: "_x.ai/subagent/cancel",
    probe: {},
    supported: (outcome) => outcome.error?.code !== METHOD_NOT_FOUND,
    params: (sessionId, subagentId) => ({ sessionId, subagentId }),
};
