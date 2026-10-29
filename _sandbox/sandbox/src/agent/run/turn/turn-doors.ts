import type { StopResult, StopTurn } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { expectTurn, type LiveRun, liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { holdOf, waitingOf } from "../../../conversations/actor/conversation-queue.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { openingRows, openTurnTranscript, recordTurnTranscript, recordUnrecordedRuns, runLogFor } from "../../../sessions/turn-transcript.js";
import { createAdmission } from "./turn-admission.js";
import { applyReply, steerComposed } from "./turn-interactions.js";
import { fireHeldResume, startConversationTurn } from "./turn-resume.js";
import { onItsSession, routeTurn } from "./turn-routing.js";
import { startTurnRun } from "./turn-runs.js";
import { turnPulseOf } from "./turn-pulse.js";

// The turn engine behind the TurnStarter port: every door a subsystem starts or drives a turn through, over one turn
// body. Composition binds the body to streamAgent; a suite binds its own, and gets the real run, journal and card logic.

// Whether a stop that names its turn names the live one: by the run's id, or by a message the run carries.
const names = (target: Exclude<StopTurn, { readonly live: true }>, live: LiveRun | undefined): boolean => {
    if (live === undefined) {
        return false;
    }
    return "run" in target ? live.id === target.run : live.rows.some((row) => row.messageId === target.messageId);
};

// What a stop named: the run by id, a message the run carries, or whatever is live (a caller that cannot name one).
const namedBy = (target: StopTurn): Record<string, string> => {
    if ("live" in target) {
        return { named: "live" };
    }
    return "run" in target ? { named: "run", namedRun: target.run } : { named: "message", namedMessage: target.messageId };
};

// How far the live run had got when the stop came: no run at all, a run still setting up (worktree, preflight) whose
// runtime has not started, or a runtime running. A stop pressed before the turn was acknowledged left no line at all.
const phaseOf = (conversationId: string, live: LiveRun | undefined): string => {
    if (live === undefined) {
        return "no-run";
    }
    const pulse = turnPulseOf(conversationId);
    return pulse?.run === live.id && pulse.endedAt === undefined ? "running" : "setting-up";
};

// Hard-cancels the live turn, marks it stopped before the unwind, and joins the unwind, so a stop truly frees the lock.
// A stop naming a turn that is not the live one cancels nothing: it was pressed at one that has ended, or not begun.
// Each stop is one line, with what it named and how far the turn had got; the request id on the line says who pressed.
const stopTurn = async (
    daemon: Pick<Services, "conversations" | "logger">,
    target: StopTurn,
): Promise<StopResult> => {
    const { conversations } = daemon;
    const { conversationId } = target;
    const live = liveRunOf(conversations, conversationId);
    const said = { conversationId, ...namedBy(target), ...opt("run", live?.id), phase: phaseOf(conversationId, live) };
    if (!("live" in target) && !names(target, live)) {
        daemon.logger.info(said, "turn stop requested: it named no live turn, so nothing was stopped");
        return { stopped: false, ...opt("running", live?.id) };
    }
    const stopped = conversations.abort(conversationId);
    // A run can look gone while its pump still finishes cleanup; joining it avoids a race.
    if (!stopped && live === undefined) {
        daemon.logger.info(said, "turn stop requested: no turn was running, so nothing was stopped");
        return { stopped: false };
    }
    const askedAt = Date.now();
    conversations.send(conversationId, { kind: "stop", ending: "stopped" });
    await live?.waitUntilFinished();
    daemon.logger.info({ ...said, unwoundMs: Date.now() - askedAt }, "turn stop requested: the turn stopped");
    return { stopped: true };
};

// `services` is read per call, since the port is composed into the very object it reads. Every turn is routed as it comes
// in, by the one preamble (routeTurn): its persona or run role has the chance to name provider, model and knobs, then
// provider and loop are named once, never defaulted again downstream. A turn that names its model or provider keeps it, so
// one that walked its own ladder (an automation's fire, a runner's dispatched turn) is not re-pinned.
export const turnDoors = (services: () => Services, body: TurnStarter["stream"]): TurnStarter => {
    const start: TurnStarter["start"] = (turn, options) => startConversationTurn(services(), body, turn, options);
    return {
        start,
        resume: (conversationId, routing) => fireHeldResume(services(), conversationId, routing),
        run: (sent, options) => {
            const daemon = services();
            // Opened before the provider runs, matching the send path's own order.
            const opened = openTurnTranscript(daemon, sent);
            const run = startTurnRun(daemon, body, sent, {
                journalled: options?.journalled === true,
                before: opened,
                // The run is claimed at once, so its starter follows it from its first frame; the run routes the turn
                // before the provider is asked.
                route: async (claimed) => {
                    const routed = await routeTurn(daemon, claimed);
                    return options?.continuing === true ? onItsSession(daemon, routed) : routed;
                },
                opening: (startedAt) => openingRows(sent, daemon.workspace.root, startedAt),
                log: runLogFor(daemon, sent.conversationId),
                // Whatever an earlier run of this conversation could not write goes first, so the record keeps turns in order.
                transcript: async (rows, steerRows) =>
                    (await recordUnrecordedRuns(daemon, sent.conversationId)) && recordTurnTranscript(daemon, sent, rows, steerRows),
            });
            if (run === "archived") {
                daemon.logger.info({ conversationId: sent.conversationId }, "run not started: the conversation is archived, and only a person reopens it");
            }
            return run;
        },
        async *stream (turn, signal) {
            yield* body(await routeTurn(services(), turn), signal);
        },
        steer: (conversationId, steer) => steerComposed(services(), conversationId, steer),
        reply: (reply) => applyReply(services(), reply),
        stop: (target) => stopTurn(services(), target),
        // A person's message, one at a time per conversation.
        ...createAdmission(services, start),
    };
};

/**
 * A turn ending is when what waited behind it goes, whoever queued it: drained on `run.settled`, which the settle's own
 * broadcast goes out well ahead of, so words waiting in a queue nothing holds were drawn behind the ending they were
 * about to answer (Finished, or Attention after a failure) until their turn began. They are a turn on its way from the
 * settle (conversation-holdings.ts) until the drain has let them go or found them held.
 */
export const drainBehindTurns = (
    services: Pick<Services, "conversations" | "events"> & { readonly turns: Pick<Services["turns"], "drain"> },
): void => {
    const behind = new Map<string, () => void>();
    services.conversations.observe((conversationId, event, before, after) => {
        if (event.kind === "settle" && before.phase.kind === "running" && holdOf(after.queue) === undefined && waitingOf(after.queue).length > 0) {
            behind.get(conversationId)?.();
            behind.set(conversationId, expectTurn(services.conversations, conversationId, "queued"));
        }
    });
    services.events.subscribe("run.settled", ({ conversationId }) => {
        const waited = behind.get(conversationId);
        behind.delete(conversationId);
        void services.turns.drain(conversationId).finally(() => waited?.());
    });
};
