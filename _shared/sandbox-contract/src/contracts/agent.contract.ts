import { procedure } from "../protocol/route-meta.js";
import { streamOf } from "../protocol/routes.js";
import { AgentCommandsQuerySchema, AgentCommandsSchema } from "../events/requests.js";
import { AttachFrameSchema } from "../events/agent-events.js";
import { AgentTurnSchema, AttachTurnSchema, ConversationQueueSchema, MessageReceiptSchema, QueueResumedSchema, StartedTurnSchema } from "../schemas/agent.js";
import { ChatRouteAskSchema, ChatRouteSchema } from "../schemas/chat-route.js";
import { RewindResultSchema, RewindTurnSchema } from "../schemas/history.js";
import {
    AgentReplySchema,
    ProviderRefusalsSchema,
    QueuedMessageRefSchema,
    QueueEditSchema,
    QueueResumeSchema,
    ResumeTurnSchema,
    AccountSwitchedSchema,
    SteerSchema,
    SwitchAccountSchema,
    StopResultSchema,
    StopTurnSchema,
} from "../schemas/providers/plan-limits.js";
import { OkSchema } from "../schemas/shared.js";

// A turn executes as a detached daemon-side run. `run` starts it, or says the message into the running turn, or queues it
// for the next; `attach` streams it to any number of clients (replay then live, no special stream for the initiator),
// `reply` un-parks it, `steer` injects a message, `stop` hard-cancels it, and the queue's three doors change what waits.
export const agentContract = {
    run: procedure
        .route({
            method: "POST",
            path: "/agent",
            summary: "Say something to an agent",
            description:
                "Answers at once with what became of the message: it starts a turn when the conversation is free, is said into the running turn where that turn takes words mid-way, and otherwise waits in the conversation's queue for the next turn, where every window sees it. The work runs inside the sandbox whether or not anybody stays connected; watch it by attaching. Naming a conversation that does not exist yet opens it. Give the message an id, and sending it again after a lost answer is met with what became of it the first time rather than a second delivery.",
        })
        // Driving agents is the collaborator grant; what leaves the sandbox stays at the maintainer default.
        .meta({ floor: "collaborator", guest: true, control: "editor" })
        .input(AgentTurnSchema)
        .output(MessageReceiptSchema),
    attach: procedure
        .route({
            method: "POST",
            path: "/agent/attach",
            summary: "Watch a turn happen",
            description:
                "Streams everything the agent does: its words, the tools it reaches for, and the answers it gets. It opens with the turn's transcript whole as it stands, then sends every change as it lands, so a reload or a dropped connection loses nothing: attaching again hands over the whole transcript again. The window that started the turn holds no special claim, and any number of watchers on any number of devices see the same thing.",
        })
        // Watching a live turn is reading, POST or not, so the read rung reaches it too.
        .meta({ floor: "viewer", guest: true, stream: true, control: "read" })
        .input(AttachTurnSchema)
        .output(streamOf(AttachFrameSchema)),
    reply: procedure
        .route({
            method: "POST",
            path: "/agent/reply",
            summary: "Answer a question the agent asked",
            description:
                "Un-parks a turn that is waiting on you: approving a plan, choosing between options, or permitting a tool. The turn picks up where it stopped.",
        })
        .meta({ floor: "collaborator", guest: true, control: "editor" })
        .input(AgentReplySchema)
        .output(OkSchema),
    steer: procedure
        .route({
            method: "POST",
            path: "/agent/steer",
            summary: "Interrupt a running turn",
            description:
                "Slips a message into a turn already under way, without stopping it. This is how you redirect an agent mid-thought rather than waiting for it to finish being wrong. Give the message an id, and sending it again after a lost answer is met with what became of it the first time rather than saying it twice.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(SteerSchema)
        .output(MessageReceiptSchema),
    stop: procedure
        .route({
            method: "POST",
            path: "/agent/stop",
            summary: "Stop a turn now",
            description:
                "Cancels the running turn inside the sandbox. Whatever it had already written to disk stays written, and whatever waits in the conversation's queue is held there, for everyone, until somebody resumes it. Name the run you mean: a stop that arrives after that run has ended cancels nothing, rather than whatever turn started next.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(StopTurnSchema)
        .output(StopResultSchema),
    // PRECONDITION_FAILED when the message changed since it was read; NOT_FOUND when it is no longer waiting.
    queueEdit: procedure
        .route({
            method: "POST",
            path: "/agent/queue/edit",
            summary: "Reword a waiting message",
            description:
                "Changes what a message waiting in the conversation's queue says, keeping its place. Name the revision you read it at: if somebody changed it since, on this device or another, nothing is changed and you are told so.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(QueueEditSchema)
        .output(ConversationQueueSchema),
    // PRECONDITION_FAILED when the message changed since it was read; NOT_FOUND when it is no longer waiting.
    queueRemove: procedure
        .route({
            method: "POST",
            path: "/agent/queue/remove",
            summary: "Take back a waiting message",
            description:
                "Removes a message from the conversation's queue before the agent gets it. Name the revision you read it at: a message somebody reworded since is left alone, so you never take back words you have not seen.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(QueuedMessageRefSchema)
        .output(ConversationQueueSchema),
    queueResume: procedure
        .route({
            method: "POST",
            path: "/agent/queue/resume",
            summary: "Let waiting messages go",
            description:
                "Releases a queue held after a stop or a refusal: what waits goes out now as one turn when nothing is running, or after the running turn otherwise. Name who serves that turn when the conversation has been re-pointed since the messages were queued.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(QueueResumeSchema)
        .output(QueueResumedSchema),
    // CONFLICT while a turn already runs (the client follows it); NOT_FOUND when nothing is held (it falls back to `run`).
    resume: procedure
        .route({
            method: "POST",
            path: "/agent/resume",
            summary: "Run a refused turn again",
            description:
                "Sends the same turn again when the model provider's allowance refused it, with everything it originally carried except who serves it: the caller may name a different provider, harness or account, which is the usual answer to a spent allowance. It repeats the request rather than adding a new message to the conversation, so pressing it twice costs nothing and the agent is never told to continue work it has not started.",
        })
        // The same turn again with all it carried; refused, a collaborator's automation sticks at its first refusal.
        .meta({ floor: "collaborator", guest: true })
        .input(ResumeTurnSchema)
        .output(StartedTurnSchema),
    // CONFLICT while the model is generating (a turn parked on a card may move); NOT_FOUND for an unknown conversation.
    switchAccount: procedure
        .route({
            method: "POST",
            path: "/agent/account",
            summary: "Move a conversation to another account",
            description:
                "Points the conversation at another connected account of the provider it runs on, for every turn from now on. A turn held by a spent allowance or a stop runs again at once on that account, which is how a refused turn continues elsewhere. Without `carry` the next turn opens a fresh session seeded from the record.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(SwitchAccountSchema)
        .output(AccountSwitchedSchema),
    // CONFLICT while a turn is running; NOT_FOUND when the message has no checkpoint; PRECONDITION_FAILED when the
    // position no longer holds the message named.
    rewind: procedure
        .route({
            method: "POST",
            path: "/agent/rewind",
            summary: "Go back to an earlier message",
            description:
                "Puts the files back as they stood at that point, drops every message after it, and forgets what the model remembered, so the next thing you say starts from there cleanly. Refused while a turn is running, because a restore cannot overwrite files an agent is editing; refused for a message with no saved state to return to; and refused when that position no longer holds the message you named, because the conversation moved since you read it.",
        })
        .meta({ floor: "collaborator", guest: true })
        .input(RewindTurnSchema)
        .output(RewindResultSchema),
    commands: procedure
        .route({
            method: "GET",
            path: "/agent/commands",
            summary: "Shortcut commands the agent knows",
            description:
                "The commands a provider published the last time one of its turns ran, so a composer can offer them before this conversation has run anything. A running turn's own list wins over this one.",
        })
        .meta({ guest: true })
        .input(AgentCommandsQuerySchema)
        .output(AgentCommandsSchema),
    // Never throws: no offer, no personas, no model, or a deadline are all "nothing chosen" with a reason; the composer
    // is waiting.
    routeChat: procedure
        .route({
            method: "POST",
            path: "/agent/route-chat",
            summary: "Choose what a new chat opens on",
            description:
                "Reads a new chat's opening message once and answers whichever of two questions it still has: the model, effort and account that conversation should run on, from what is connected and still has allowance left, and which of this sandbox's personas should handle it. `model` and `persona` on the ask say which halves to answer, and only those are put to the model. Asked once per chat, on the message actually sent, and never again: every turn after it runs on what the chat is wearing, which you are free to change. Answers with nothing, and a reason, whenever it cannot choose — a chat is never held up by this.",
        })
        // A read shaped as a POST, costing one model call the tier about to spend a whole turn may spend.
        .meta({ floor: "collaborator" })
        .input(ChatRouteAskSchema)
        .output(ChatRouteSchema),
    refusals: procedure
        .route({
            method: "GET",
            path: "/agent/refusals",
            summary: "The last time each provider said no",
            description:
                "What each model provider most recently refused and why. Read this alongside an account's usage: the usage says how full it was when last checked, this says whether it has since started turning work away.",
        })
        .meta({ guest: true })
        .output(ProviderRefusalsSchema),
};
