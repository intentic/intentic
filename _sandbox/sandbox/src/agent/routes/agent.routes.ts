import { agentContract, type ConversationQueue } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { routeChat } from "../prompt/chat-router.js";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import { resolveWithin } from "../../workspace/files/workspace-files-paths.js";
import { type QueueChange, queueView } from "../../conversations/actor/conversation-queue.js";
import { rewindConversation } from "../checkpoints/rewind.js";
import { commandsOf } from "../providers/agent-commands.js";
import { switchAccount } from "../providers/accounts/switch-account.js";
import { actorOf, areasOf, ownerOf } from "../../auth/principal.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import { refuseUnlessReachable } from "../../personas/persona-reach.js";
import { opt } from "../../opt.js";
import { forgetRemoteRequest, remoteRequestOf } from "../../runners/runner-requests.js";
import { applyReply } from "../run/turn/turn-interactions.js";
import { notePlanAnswer } from "../run/stream-agent.js";

export const createAgentRoutes = (services: Services) => {
    const i = implement(agentContract).$context<OrpcContext>();
    // A guest drives only its own conversations (auth/fleet-scope.ts); one the registry has never seen is nobody's
    // yet, and becomes the caller's on its first turn.
    const own = (context: OrpcContext, conversationId: string | undefined): void => {
        const entry = conversationId === undefined ? undefined : services.agents.entry(conversationId);
        if (entry !== undefined) {
            refuseUnlessVisible(context.identity, provenanceOf(entry));
        }
    };
    // A change to a waiting message answered with the queue it left, or refused as the change found it.
    const queueAnswer = (conversationId: string, change: QueueChange): ConversationQueue => {
        if (change === "stale") {
            throw new ORPCError("PRECONDITION_FAILED", { message: "That message was changed since you read it: look again before changing it." });
        }
        if (change === "missing") {
            throw new ORPCError("NOT_FOUND", { message: "That message is no longer waiting: it has gone out, or somebody took it back." });
        }
        return queueView(services.conversations.queued(conversationId));
    };
    // The conversation a parked request belongs to: held here, or minted on a runner. Undefined when neither knows it,
    // which the reply below reports as NOT_FOUND on its own.
    const conversationOfRequest = (requestId: string): string | undefined =>
        services.cards.conversationOf(requestId) ?? remoteRequestOf(requestId)?.conversationId;
    return {
        // Starts the turn detached, says the words into the running one, or queues them for the next; the answer says
        // which, with the run the message is in, and the turn keeps running regardless of this request.
        run: i.run.handler(async ({ input, context }) => {
            if (input.conversationId === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "conversationId required" });
            }
            const conversationId = input.conversationId;
            // Refused before the turn exists, so the words stay in the composer: an error frame instead would strand
            // them in a transcript whose turn never ran. Mentions get no such veto; they are guesses, not choices.
            const escaping = (input.attachments ?? []).find((rel) => resolveWithin(services.workspace.root, rel) === undefined);
            if (escaping !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `invalid attachment path: ${escaping}` });
            }
            // The card has to work in the part of the workspace this caller holds, and a guest has to name one at all;
            // checked before anything is started. An unfenced caller pays no read for this.
            await refuseUnlessReachable(services, context.identity, input.actsAs);
            own(context, conversationId);
            // Who is asking, from what the middleware verified on this request, never from the body.
            const actor = actorOf(context.identity, context.principal);
            // Push rides the run's own lifecycle, not this request, since a tab may be asleep.
            const receipt = await services.turns.say({
                voice: "person",
                turn: {
                    ...input,
                    conversationId,
                    ...opt("actor", actor),
                    ...opt("owner", ownerOf(context.identity)),
                    ...opt("areas", areasOf(context.identity)),
                },
            });
            if ("invalid" in receipt) {
                throw new ORPCError("BAD_REQUEST", { message: receipt.invalid });
            }
            if ("why" in receipt) {
                throw new ORPCError("CONFLICT", { message: receipt.why });
            }
            return receipt;
        }),
        // Re-runs a turn a spent allowance refused or a dead runtime cut short, with everything but who serves it,
        // renamed by the press. NOT_FOUND when nothing is held; never CONFLICT, since a running turn already cleared
        // the entry.
        resume: i.resume.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            const run = await services.turns.resume(input.conversationId, true, input.routing);
            // A live turn already owns it (the resume pass's re-run, another window): the caller follows it, not re-sends.
            if (run === undefined && services.conversations.state(input.conversationId)?.phase.kind === "running") {
                throw new ORPCError("CONFLICT", { message: "a turn is already running in that conversation" });
            }
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no held turn to run again for that conversation" });
            }
            return { run: run.id };
        }),
        // The one command that moves who pays (agent/providers/accounts/switch-account.ts); a held turn re-runs there at once.
        switchAccount: i.switchAccount.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            const outcome = await switchAccount(services, input);
            if (outcome.kind === "unknown") {
                throw new ORPCError("NOT_FOUND", { message: "no conversation with that id" });
            }
            if (outcome.kind === "busy") {
                throw new ORPCError("CONFLICT", { message: "a turn is running in that conversation: move it once the turn ends" });
            }
            return outcome.run === undefined ? {} : { run: outcome.run };
        }),
        // Renders the run: its head, then every change as it lands, `end` when it settles.
        attach: i.attach.handler(async function* ({ input, context, signal }) {
            own(context, input.conversationId);
            const run = turnRunOf(services.conversations, input.conversationId);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no live or recent turn for that conversation" });
            }
            const { head, entries, cut } = run.attach(
                () => new ORPCError("TIMEOUT", { message: "fell behind the run; attach again for its rows as they stand" }),
                signal,
            );
            // Registered like /events: a member removed, re-graded or re-fenced stops reading the run now, not at their
            // next attach.
            const unregister =
                context.identity === undefined
                    ? undefined
                    : services.auth?.connections.register(context.identity, () => cut(new ORPCError("FORBIDDEN", { message: "authorization revoked" })));
            try {
                yield head;
                for await (const entry of entries) {
                    yield entry;
                }
                yield { kind: "end" as const };
            } finally {
                unregister?.();
            }
        }),
        // Un-parks a turn waiting on a card (plan/question/permission) by requestId; NOT_FOUND freezes it as stale. A
        // dismissed question ends the turn here, synchronously, so the board never shows it running again.
        reply: i.reply.handler(async ({ input, context }) => {
            // The decision's own line, written before the reply ends the turn.
            own(context, conversationOfRequest(input.requestId));
            const held = services.cards.conversationOf(input.requestId);
            const run = held === undefined ? undefined : turnRunOf(services.conversations, held);
            if (input.kind === "question" && input.cancelled === true) {
                run?.note({ role: "notice", text: "Question dismissed." });
            }
            // Who's answering, carried into settlement; the card itself decides who may answer.
            const applied = await applyReply(services, input, context.identity);
            if (typeof applied === "object") {
                // The card is still parked, waiting for somebody who can answer; 403, not 404.
                throw new ORPCError("FORBIDDEN", { message: applied.refused });
            }
            if (applied === "settled") {
                if (input.kind === "plan") {
                    notePlanAnswer(run, input);
                }
                // What waited behind the card goes into the turn it un-parked, for every window alike.
                void (held === undefined ? undefined : services.turns.drain(held));
                return { ok: true } as const;
            }
            // Remote: nothing held here is unusual, the question was minted on the runner instead.
            const remote = remoteRequestOf(input.requestId);
            const client = remote === undefined ? undefined : services.runnerHub.client(remote.runnerId);
            if (remote !== undefined && client !== undefined) {
                if (input.kind === "question" && input.cancelled === true) {
                    services.conversations.send(remote.conversationId, { kind: "stop", ending: "dismissed" });
                }
                const answered = await client.reply(input).catch((error: unknown) => {
                    services.logger.warn({ err: error, runner: remote.runnerId }, "runner: forwarding an answer failed");
                    return { applied: false };
                });
                if (answered.applied) {
                    forgetRemoteRequest(input.requestId);
                    return { ok: true } as const;
                }
            }
            throw new ORPCError("NOT_FOUND", { message: `no pending ${input.kind} for that request` });
        }),
        // Injects a message into a running turn, between tool calls; NOT_FOUND means nothing running takes words.
        // Composed exactly like a turn's own prompt, so a mid-turn attachment reads like one on a fresh message.
        steer: i.steer.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            const { conversationId, ...steer } = input;
            const steered = await services.turns.steerIn(conversationId, steer);
            if ("invalid" in steered) {
                throw new ORPCError("BAD_REQUEST", { message: steered.invalid });
            }
            if ("why" in steered) {
                throw new ORPCError("NOT_FOUND", { message: steered.why });
            }
            return steered;
        }),
        // Hard-cancels the conversation's running turn daemon-side; the browser's own fetch abort can't. Answers, rather
        // than refuses, a stop that found its run already over: the press raced the turn's own end.
        stop: i.stop.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            return services.turns.stop(input);
        }),
        queueEdit: i.queueEdit.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            // Taking words back is what removal is for; an edit to nothing would send a message with nothing in it.
            if (input.text.trim().length === 0) {
                throw new ORPCError("BAD_REQUEST", { message: "A waiting message needs words: take it back instead of emptying it." });
            }
            return queueAnswer(input.conversationId, await services.turns.reword(input));
        }),
        queueRemove: i.queueRemove.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            return queueAnswer(input.conversationId, await services.turns.unqueue(input));
        }),
        queueResume: i.queueResume.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            return services.turns.release(input);
        }),
        // Rewinds a message, its files, transcript and session together. CONFLICT rather than queuing behind a running
        // turn: by the time it finished, the workspace would have moved on from what the user is looking at.
        rewind: i.rewind.handler(async ({ input, context }) => {
            own(context, input.conversationId);
            const outcome = await rewindConversation(services, input.conversationId, input);
            if (outcome === "busy") {
                throw new ORPCError("CONFLICT", { message: "This agent is running a turn, stop it before going back." });
            }
            if (outcome === "no-checkpoint") {
                throw new ORPCError("NOT_FOUND", { message: "That message has no saved file state to go back to." });
            }
            if (outcome === "stale") {
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: "That message is no longer where you saw it: the conversation has moved since.",
                });
            }
            return outcome;
        }),
        // The provider's slash commands from its most recent turn; empty (not an error) if never run.
        commands: i.commands.handler(({ input }) => ({ commands: [...commandsOf(input.agent ?? "claude")] })),
        // What each provider last refused a turn with; empty is the common, healthy case.
        refusals: i.refusals.handler(async () => ({ refusals: await services.providerRefusals.read() })),
        // Never throws: no offer, no personas, no model, or a deadline are all "nothing chosen" with a reason; the
        // composer waits on this before the first turn goes out, so a failure here must cost that turn nothing but a
        // sentence. Read within the asker's own fence, so a persona it lands on is one they may actually send through.
        routeChat: i.routeChat.handler(({ input, context, signal }) => routeChat(services, input, context.identity?.areas, signal)),
    };
};
