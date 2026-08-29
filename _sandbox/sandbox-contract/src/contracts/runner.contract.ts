import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { AgentEventSchema } from "../events.js";
import { RunnerFactsSchema, RunnerSyncLineSchema, RunnerSyncSchema, RunnerTurnSchema } from "../runner-protocol.js";
import { EditorContextSchema } from "../schemas/agent.js";
import { AgentReplySchema } from "../schemas/plan-limits.js";
import { OkSchema } from "../schemas/shared.js";

/* What a RUNNER can be asked, over the socket it opened to its parent sandbox. Phase-1 skeleton: the shape is
 * decided (docs/remote-runners-plan.md §5, workspace root), the implementations land with runner mode.
 *
 * Same inversion as hostContract: the runner dialled, but the runner is the oRPC SERVER and the parent holds
 * the client, because a runner sits behind NAT or inside a Fly private network and can only ever be the side
 * that connects. No `.route()` on these, the link never touches HTTP; the procedure path IS the address.
 *
 * TYPED THROUGHOUT, where hostContract keeps its deliberate `mcp` hole, and the difference is who releases
 * what. A machine's tools must outlive the daemon's release cycle, so their schemas stay on the machine. A
 * runner IS this daemon, the same image the parent runs, released together by construction, so an untyped
 * channel would buy independence nobody has while costing the parent's persistence layer its guarantee that
 * every frame is exactly what a local turn would have produced. */
export const runnerContract = {
    // What this runner is, hardware-wise: pulled after the socket authenticates and again whenever the
    // placement picker wants it fresh. Parity facts (image, overlay hash) ride the hello instead, they change
    // only with a rebuild, which drops the socket anyway.
    describe: oc.output(RunnerFactsSchema),
    // Bring the runner's checkout of one conversation's branch up to date (`pull`), or return the result
    // after a turn (`push`). Streamed: a first sync clones repositories, and a person may be watching.
    syncWorkspace: oc.input(RunnerSyncSchema).output(eventIterator(RunnerSyncLineSchema)),
    // The dispatch: one turn in, the frames a local turn would have produced out. The parent republishes them
    // into the same pipeline local frames enter, which is the whole "feels local" mechanism.
    runTurn: oc.input(RunnerTurnSchema).output(eventIterator(AgentEventSchema)),
    /* THE USER, REACHING THE TURN THEY ARE WATCHING. A remote turn's question, permission prompt and plan
     * approval are minted in the RUNNER's request registry, and the answer arrives at the PARENT (that is
     * where the browser is). So it travels back down the same socket and is applied there by the same code a
     * local answer takes (agent/turn-interactions.ts).
     *
     * `applied` rather than a throw: "nothing holds that id any more" is an ordinary race (the card was
     * answered in another window, or the turn ended while the user was reading), and the parent turns it
     * into the same NOT_FOUND its local path gives. */
    reply: oc.input(AgentReplySchema).output(z.object({ applied: z.boolean() })),
    /* Speaking into a running remote turn. The parent sends the user's words, the attachment paths and the
     * editor context UNCOMPOSED: the note over those paths has to be built against the runner's own
     * workspace root, since that is the machine whose files the agent will open. */
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
    /* The parent pushing its declared shape onto this runner: a settings-only definition (sandbox.toml text,
     * runner-protocol.ts's hello says why settings are all a runner declares). REPLACE semantics, not the
     * owner-facing apply's merge-beside: a key the definition omits returns to its default, because the parent
     * is a runner's whole authority and "make this runner match" must also unset what the parent unset. The
     * answer names the keys now holding non-default values, which is what the parent adopts as the runner's
     * new declared shape without waiting for a reconnect. */
    applyDefinition: oc.input(z.object({ toml: z.string() })).output(z.object({ settings: z.array(z.string()) })),
    // Stop the running turn; the parent's stop button reaching through.
    interrupt: oc.input(RunnerTurnSchema.pick({ conversationId: true })).output(OkSchema),
    // Liveness, driven by the parent: keepalive and gone-detection in one, the host hub's heartbeat verbatim.
    ping: oc.output(OkSchema),
};
