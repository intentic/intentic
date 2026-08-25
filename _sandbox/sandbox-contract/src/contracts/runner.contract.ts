import { eventIterator, oc } from "@orpc/contract";
import { AgentEventSchema } from "../events.js";
import { RunnerFactsSchema, RunnerSyncLineSchema, RunnerSyncSchema, RunnerTurnSchema } from "../runner-protocol.js";
import { OkSchema } from "../schemas.js";

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
    // Stop the running turn; the parent's stop button reaching through.
    interrupt: oc.input(RunnerTurnSchema.pick({ conversationId: true })).output(OkSchema),
    // Liveness, driven by the parent: keepalive and gone-detection in one, the host hub's heartbeat verbatim.
    ping: oc.output(OkSchema),
};
