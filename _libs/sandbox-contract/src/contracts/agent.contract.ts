import { eventIterator, oc } from "@orpc/contract";
import { AttachFrameSchema } from "../events.js";
import { AgentTurnSchema, AnswerSchema, AttachTurnSchema, DecisionSchema, OkSchema, StartedTurnSchema, SteerSchema, StopTurnSchema } from "../schemas.js";

// A turn EXECUTES as a detached daemon-side run: `run` starts it and acks with the run id; any number of
// clients render it via `attach` (replay from a seq cursor, then live) — the initiating window holds no
// special stream, so a reload, a second window, or another device attaches identically. decision/answer
// resolve a turn paused on an ExitPlanMode approval or an interactive question (the side channels);
// steer injects a user message into the running turn; stop hard-cancels it daemon-side.
export const agentContract = {
    run: oc.route({ method: "POST", path: "/agent" }).input(AgentTurnSchema).output(StartedTurnSchema),
    attach: oc.route({ method: "POST", path: "/agent/attach" }).input(AttachTurnSchema).output(eventIterator(AttachFrameSchema)),
    decision: oc.route({ method: "POST", path: "/agent/decision" }).input(DecisionSchema).output(OkSchema),
    answer: oc.route({ method: "POST", path: "/agent/answer" }).input(AnswerSchema).output(OkSchema),
    steer: oc.route({ method: "POST", path: "/agent/steer" }).input(SteerSchema).output(OkSchema),
    stop: oc.route({ method: "POST", path: "/agent/stop" }).input(StopTurnSchema).output(OkSchema),
};
