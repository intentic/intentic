import { eventIterator, oc } from "@orpc/contract";
import { AgentEventSchema } from "../events.js";
import { AgentTurnSchema, AnswerSchema, DecisionSchema, OkSchema, SteerSchema, StopTurnSchema } from "../schemas.js";

// One agent turn streams typed AgentEvents (session/delta/tool/plan/question/error/done); decision/answer
// resolve a turn paused on an ExitPlanMode approval or an interactive question (the side channels).
// steer injects a user message into the running turn; stop hard-cancels it daemon-side.
export const agentContract = {
    run: oc.route({ method: "POST", path: "/agent" }).input(AgentTurnSchema).output(eventIterator(AgentEventSchema)),
    decision: oc.route({ method: "POST", path: "/agent/decision" }).input(DecisionSchema).output(OkSchema),
    answer: oc.route({ method: "POST", path: "/agent/answer" }).input(AnswerSchema).output(OkSchema),
    steer: oc.route({ method: "POST", path: "/agent/steer" }).input(SteerSchema).output(OkSchema),
    stop: oc.route({ method: "POST", path: "/agent/stop" }).input(StopTurnSchema).output(OkSchema),
};
