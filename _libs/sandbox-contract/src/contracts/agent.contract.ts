import { eventIterator, oc } from "@orpc/contract";
import { AgentCommandsQuerySchema, AgentCommandsSchema, AttachFrameSchema } from "../events.js";
import { AgentReplySchema, AgentTurnSchema, AttachTurnSchema, OkSchema, StartedTurnSchema, SteerSchema, StopTurnSchema } from "../schemas.js";

// A turn EXECUTES as a detached daemon-side run: `run` starts it and acks with the run id; any number of
// clients render it via `attach` (replay from a seq cursor, then live) — the initiating window holds no
// special stream, so a reload, a second window, or another device attaches identically. `reply` un-parks a
// turn waiting on any interactive card (plan approval, clarifying questions, a per-tool permission prompt);
// steer injects a user message into the running turn; stop hard-cancels it daemon-side.
export const agentContract = {
    run: oc.route({ method: "POST", path: "/agent" }).input(AgentTurnSchema).output(StartedTurnSchema),
    attach: oc.route({ method: "POST", path: "/agent/attach" }).input(AttachTurnSchema).output(eventIterator(AttachFrameSchema)),
    reply: oc.route({ method: "POST", path: "/agent/reply" }).input(AgentReplySchema).output(OkSchema),
    steer: oc.route({ method: "POST", path: "/agent/steer" }).input(SteerSchema).output(OkSchema),
    stop: oc.route({ method: "POST", path: "/agent/stop" }).input(StopTurnSchema).output(OkSchema),
    // The provider's slash commands as last published by one of its turns, so a conversation's `/` popover is
    // populated before it has run one. The live `commands` frame stays authoritative for a running turn.
    commands: oc.route({ method: "GET", path: "/agent/commands" }).input(AgentCommandsQuerySchema).output(AgentCommandsSchema),
};
