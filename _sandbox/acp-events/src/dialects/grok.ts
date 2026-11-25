import type { ToolCall, ToolKind } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import { type AcpDialect, type DialectFrames, type DialectReader, vendorMethod } from "./dialect.js";
import { grokQuestion } from "./grok-questions.js";
import {
    backgrounded,
    finished,
    type GrokState,
    grokState,
    noteSpawnCall,
    noteTaskStarted,
    progressed,
    resultFrames,
    spawned,
    taskCompleted,
} from "./grok-state.js";
import { FinishedSchema, GROK_SUBAGENT_STOP, ProgressSchema, SpawnedSchema } from "./grok-subagents.js";
import { BackgroundedSchema, CompletedSchema, GROK_TASK_STOP } from "./grok-tasks.js";

// xAI's Grok Build CLI (`grok agent stdio`). Written against 1.0.52, the engine store's pin (runtimes/grok-build), and
// the 1.0.46–1.0.70 traffic Orca recorded (github.com/stablyai/orca at 5127e857010, src/main/acp/fixtures, MIT),
// transcribed into this folder's fixtures. What it says beyond ACP:
// - `_x.ai/session_notification` (and `_x.ai/session/update`): `{ sessionId, update }` with update kinds of its own:
//   subagent_spawned/progress/finished, turn_completed, response_completed, retry_state.
// - `_x.ai/task_backgrounded` / `_x.ai/task_completed`: a background task's life.
// - `_x.ai/queue/changed`, `_x.ai/models/update`, `_x.ai/session/prompt_complete` and others: nothing a chat draws here.
// - `_x.ai/ask_user_question`: its ask-user tool, a request (grok-questions.ts).
// - `_x.ai/subagent/cancel`, `_x.ai/task/kill`: stopping one child.
// - A finished background subagent or task with `will_wake` set makes it start a prompt of its own once its own has
//   ended (a reactive wake-up), which a turn_completed for that session ends.

const ToolMetaSchema = z
    .looseObject({ "x.ai/tool": z.looseObject({ name: z.string(), kind: z.string().optional().catch(undefined) }) })
    .catch({ "x.ai/tool": { name: "", kind: undefined } });
// Grok opens a call with no ACP `kind`, naming its own in `_meta` (`execute`, `list`, `task`, `ask_user`…); the ones
// that are ACP's, or plainly one of them, categorize the card from its first frame.
const ACP_KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
    ["execute", "execute"],
    ["read", "read"],
    ["edit", "edit"],
    ["delete", "delete"],
    ["move", "move"],
    ["search", "search"],
    ["fetch", "fetch"],
    ["think", "think"],
    ["list", "read"],
]);
const normalizeToolCall = (call: ToolCall): ToolCall => {
    const kind = ACP_KINDS.get(ToolMetaSchema.parse(call["_meta"])["x.ai/tool"].kind ?? "");
    return call.kind != null || kind === undefined ? call : { ...call, kind };
};
const EnvelopeSchema = z.object({ sessionId: z.string(), update: z.looseObject({ sessionUpdate: z.string() }) });

const SESSION_NOTIFICATIONS: ReadonlySet<string> = new Set(["x.ai/session_notification", "x.ai/session/update"]);
const TASK_NOTIFICATIONS: ReadonlySet<string> = new Set(["x.ai/task_backgrounded", "x.ai/task_completed"]);
const SPAWN_TOOL = "spawn_subagent";

// One `{ sessionId, update }` of Grok's own, by its update kind. A kind not read here is claimed and drawn as nothing.
const envelopeFrames = (state: GrokState, { sessionId, update }: z.infer<typeof EnvelopeSchema>): DialectFrames[] => {
    const spawn = SpawnedSchema.safeParse(update);
    if (spawn.success) {
        return [spawned(state, sessionId, spawn.data)];
    }
    const progress = ProgressSchema.safeParse(update);
    if (progress.success) {
        return progressed(state, progress.data);
    }
    const end = FinishedSchema.safeParse(update);
    if (end.success) {
        return finished(state, end.data);
    }
    const started = BackgroundedSchema.safeParse(update);
    if (started.success) {
        backgrounded(state, sessionId, started.data);
        return [];
    }
    const completed = CompletedSchema.safeParse(update);
    if (completed.success) {
        return taskCompleted(state, sessionId, completed.data);
    }
    const turn = z.looseObject({ sessionUpdate: z.literal("turn_completed") }).safeParse(update);
    if (turn.success) {
        state.wakes.delete(sessionId);
    }
    return [];
};

const grokReader = (): DialectReader => {
    const state = grokState();
    return {
        childOf: (session) => state.children.get(session),
        notification: (method, params) => {
            const canonical = vendorMethod(method);
            if (SESSION_NOTIFICATIONS.has(canonical) || TASK_NOTIFICATIONS.has(canonical)) {
                const envelope = EnvelopeSchema.safeParse(params);
                return envelope.success ? envelopeFrames(state, envelope.data) : [];
            }
            // Its queue, its model list, its own copy of a prompt's ending: nothing a chat draws from them here.
            return canonical.startsWith("x.ai/") ? [] : undefined;
        },
        toolUpdate: (session, update) => {
            const tool = ToolMetaSchema.parse(update["_meta"])["x.ai/tool"].name;
            if (tool === SPAWN_TOOL) {
                noteSpawnCall(state, session, update);
            }
            noteTaskStarted(state, session, update);
            return update.status === "completed" ? resultFrames(state, update, tool) : [];
        },
        holding: (session) => state.wakes.has(session) || [...state.subagents.values()].some((subagent) => subagent.session === session && !subagent.finished),
        live: (session) => ({
            subagents: [...state.subagents].flatMap(([id, subagent]) => (subagent.session === session && !subagent.finished ? [id] : [])),
            tasks: [...state.tasks].flatMap(([id, task]) => (task.session === session && !task.finished && !state.subagents.has(id) ? [id] : [])),
        }),
    };
};

export const GROK_DIALECT: AcpDialect = {
    id: "grok",
    writtenAgainst: "Grok Build 1.0.52 (engine pin), checked against Orca's recorded 1.0.46–1.0.70 traffic",
    reader: grokReader,
    normalizeToolCall,
    question: grokQuestion,
    subagentStop: GROK_SUBAGENT_STOP,
    taskStop: GROK_TASK_STOP,
};
