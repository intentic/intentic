import { type StopResult, type StopTurn, withRuntimeDefaults } from "@intentic/sandbox-contract";
import { type LiveRun, liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../../../sessions/turn-transcript.js";
import { createAdmission } from "./turn-admission.js";
import { applyReply, steerComposed } from "./turn-interactions.js";
import { fireHeldResume, startConversationTurn } from "./turn-resume.js";
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
// in (withRuntimeDefaults): provider and loop named once, never defaulted again downstream. A started turn is routed by
// startConversationTurn, after its run role or persona has had the chance to name them.
export const turnDoors = (services: () => Services, body: TurnStarter["stream"]): TurnStarter => {
    const start: TurnStarter["start"] = (turn, options) => startConversationTurn(services(), body, turn, options);
    return {
        start,
        resume: (conversationId, routing) => fireHeldResume(services(), conversationId, routing),
        run: (sent, options) => {
            const daemon = services();
            const turn = withRuntimeDefaults(sent);
            // Opened before the provider runs, matching the send path's own order.
            const opened = openTurnTranscript(daemon, turn);
            const run = startTurnRun(daemon, body, turn, {
                journalled: options?.journalled === true,
                before: opened,
                opening: (startedAt) => openingRows(turn, daemon.workspace.root, startedAt),
                transcript: (rows, steerRows) => recordTurnTranscript(daemon, turn, rows, steerRows),
            });
            if (run === "archived") {
                daemon.logger.info({ conversationId: turn.conversationId }, "run not started: the conversation is archived, and only a person reopens it");
            }
            return run;
        },
        stream: (turn, signal) => body(withRuntimeDefaults(turn), signal),
        steer: (conversationId, steer) => steerComposed(services(), conversationId, steer),
        reply: (reply) => applyReply(services(), reply),
        stop: (target) => stopTurn(services(), target),
        // A person's message, one at a time per conversation.
        ...createAdmission(services, start),
    };
};
