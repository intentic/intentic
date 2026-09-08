import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { AgentEventSchema } from "../events/agent-events.js";
import { RunnerFactsSchema, RunnerSyncLineSchema, RunnerSyncSchema, RunnerTurnSchema } from "../protocol/runner-protocol.js";
import { EditorContextSchema } from "../schemas/agent.js";
import { AgentReplySchema } from "../schemas/plan-limits.js";
import { OkSchema } from "../schemas/shared.js";

// What a runner can be asked, over the socket it opened; same inversion as hostContract, the runner is the oRPC server,
// the parent the client. No `.route()`: the procedure path is the address. Typed throughout, unlike hostContract's
// `mcp` hole, since a runner is the same daemon image as the parent, released together.
export const runnerContract = {
    // Hardware facts, refreshed on demand; parity facts (image, overlay hash) ride the hello, not this call.
    describe: oc.output(RunnerFactsSchema),
    // `pull` updates the checkout, `push` returns a turn's result; streamed since a first sync clones repos.
    syncWorkspace: oc.input(RunnerSyncSchema).output(eventIterator(RunnerSyncLineSchema)),
    // One turn in, the frames a local turn would produce out; the parent republishes them into the local pipeline.
    runTurn: oc.input(RunnerTurnSchema).output(eventIterator(AgentEventSchema)),
    // Returns `applied` rather than throwing: a missing id is an ordinary race, same as local NOT_FOUND.
    reply: oc.input(AgentReplySchema).output(z.object({ applied: z.boolean() })),
    // Attachments/editor context travel uncomposed: the note must build against the runner's own workspace root.
    steer: oc
        .input(
            z.object({
                conversationId: z.string().min(1),
                text: z.string(),
                attachments: z.array(z.string()).optional(),
                editorContext: EditorContextSchema.optional(),
            }),
        )
        .output(z.object({ applied: z.boolean(), invalid: z.string().optional() })),
    // REPLACE semantics: a key the definition omits returns to its default, unlike the owner apply's merge-beside.
    applyDefinition: oc.input(z.object({ toml: z.string() })).output(z.object({ settings: z.array(z.string()) })),
    // Stop the running turn; the parent's stop button reaching through.
    interrupt: oc.input(RunnerTurnSchema.pick({ conversationId: true })).output(OkSchema),
    // Liveness driven by the parent: keepalive and gone-detection in one.
    ping: oc.output(OkSchema),
};
