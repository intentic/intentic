import { eventIterator, oc } from "@orpc/contract";
import { AgentEventSchema } from "../events.js";
import { AgentTurnSchema, AnswerSchema, DecisionSchema, OkSchema } from "../schemas.js";

// One agent turn streams typed AgentEvents (session/delta/tool/plan/question/error/done); decision/answer
// resolve a turn paused on an ExitPlanMode approval or an interactive question (the side channels).
export const agentContract = {
    run: oc.route({ method: "POST", path: "/agent" }).input(AgentTurnSchema).output(eventIterator(AgentEventSchema)),
    decision: oc.route({ method: "POST", path: "/agent/decision" }).input(DecisionSchema).output(OkSchema),
    answer: oc.route({ method: "POST", path: "/agent/answer" }).input(AnswerSchema).output(OkSchema),
};
