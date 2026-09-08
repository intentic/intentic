import { eventIterator, oc } from "@orpc/contract";
import { AgentCommandsQuerySchema, AgentCommandsSchema } from "../events/cards.js";
import { AttachFrameSchema } from "../events/agent-events.js";
import { AgentTurnSchema, AttachTurnSchema, StartedTurnSchema } from "../schemas/agent.js";
import { RewindResultSchema, RewindTurnSchema } from "../schemas/history.js";
import { AgentReplySchema, ProviderRefusalsSchema, ResumeTurnSchema, SteerSchema, StopTurnSchema } from "../schemas/plan-limits.js";
import { OkSchema } from "../schemas/shared.js";

// A turn executes as a detached daemon-side run. `run` starts it, `attach` streams it to any number of clients
// (replay then live, no special stream for the initiator), `reply` un-parks it, `steer` injects a message, `stop`
// hard-cancels it.
export const agentContract = {
    run: oc
        .route({
            method: "POST",
            path: "/agent",
            summary: "Say something to an agent",
            description:
                "Starts a turn and answers immediately with its id; the work runs inside the sandbox whether or not anybody stays connected. Watch it by attaching. Naming a conversation that does not exist yet opens it.",
        })
        .input(AgentTurnSchema)
        .output(StartedTurnSchema),
    attach: oc
        .route({
            method: "POST",
            path: "/agent/attach",
            summary: "Watch a turn happen",
            description:
                "Streams everything the agent does: its words, the tools it reaches for, and the answers it gets. Give it the point you have already seen and it replays from there before going live, so a reload loses nothing. The window that started the turn holds no special claim, and any number of watchers on any number of devices see the same thing.",
        })
        .input(AttachTurnSchema)
        .output(eventIterator(AttachFrameSchema)),
    reply: oc
        .route({
            method: "POST",
            path: "/agent/reply",
            summary: "Answer a question the agent asked",
            description:
                "Un-parks a turn that is waiting on you: approving a plan, choosing between options, or permitting a tool. The turn picks up where it stopped.",
        })
        .input(AgentReplySchema)
        .output(OkSchema),
    steer: oc
        .route({
            method: "POST",
            path: "/agent/steer",
            summary: "Interrupt a running turn",
            description:
                "Slips a message into a turn already under way, without stopping it. This is how you redirect an agent mid-thought rather than waiting for it to finish being wrong.",
        })
        .input(SteerSchema)
        .output(OkSchema),
    stop: oc
        .route({
            method: "POST",
            path: "/agent/stop",
            summary: "Stop a turn now",
            description: "Cancels the running turn inside the sandbox. Whatever it had already written to disk stays written.",
        })
        .input(StopTurnSchema)
        .output(OkSchema),
    // NOT_FOUND when nothing is held (superseded, or the daemon restarted): the client should fall back to `run`.
    resume: oc
        .route({
            method: "POST",
            path: "/agent/resume",
            summary: "Run a refused turn again",
            description:
                "Sends the same turn again when the model provider's allowance refused it, with everything it originally carried except who serves it: the caller may name a different provider, harness or account, which is the usual answer to a spent allowance. It repeats the request rather than adding a new message to the conversation, so pressing it twice costs nothing and the agent is never told to continue work it has not started.",
        })
        .input(ResumeTurnSchema)
        .output(StartedTurnSchema),
    // CONFLICT while a turn is running; NOT_FOUND when the message has no checkpoint.
    rewind: oc
        .route({
            method: "POST",
            path: "/agent/rewind",
            summary: "Go back to an earlier message",
            description:
                "Puts the files back as they stood at that point, drops every message after it, and forgets what the model remembered, so the next thing you say starts from there cleanly. Refused while a turn is running, because a restore cannot overwrite files an agent is editing, and refused for a message with no saved state to return to.",
        })
        .input(RewindTurnSchema)
        .output(RewindResultSchema),
    commands: oc
        .route({
            method: "GET",
            path: "/agent/commands",
            summary: "Shortcut commands the agent knows",
            description:
                "The commands a provider published the last time one of its turns ran, so a composer can offer them before this conversation has run anything. A running turn's own list wins over this one.",
        })
        .input(AgentCommandsQuerySchema)
        .output(AgentCommandsSchema),
    refusals: oc
        .route({
            method: "GET",
            path: "/agent/refusals",
            summary: "The last time each provider said no",
            description:
                "What each model provider most recently refused and why. Read this alongside an account's usage: the usage says how full it was when last checked, this says whether it has since started turning work away.",
        })
        .output(ProviderRefusalsSchema),
};
