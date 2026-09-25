import { type StopResult, type StopTurn, withRuntimeDefaults } from "@intentic/sandbox-contract";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { type LiveRun, liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../../../sessions/turn-transcript.js";
import { steerTurn } from "../../checkpoints/agent-steering.js";
import { createAdmission } from "./turn-admission.js";
import { applyReply, composeSteerText } from "./turn-interactions.js";
import { fireHeldResume, startConversationTurn } from "./turn-resume.js";
import { startTurnRun } from "./turn-runs.js";

// The turn engine behind the TurnStarter port: every door a subsystem starts or drives a turn through, over one turn
// body. Composition binds the body to streamAgent; a suite binds its own, and gets the real run, journal and card logic.

// Whether a stop that names its turn names the live one: by the run's id, or by a message the run carries.
const names = (target: Exclude<StopTurn, { readonly live: true }>, live: LiveRun | undefined): boolean => {
    if (live === undefined) {
        return false;
    }
    return "run" in target ? live.id === target.run : live.rows.some((row) => row.messageId === target.messageId);
};

// Hard-cancels the live turn, marks it stopped before the unwind, and joins the unwind, so a stop truly frees the lock.
// A stop naming a turn that is not the live one cancels nothing: it was pressed at one that has ended, or not begun.
const stopTurn = async (conversations: Pick<ConversationActors, "holdings" | "abort" | "send">, target: StopTurn): Promise<StopResult> => {
    const { conversationId } = target;
    const live = liveRunOf(conversations, conversationId);
    if (!("live" in target) && !names(target, live)) {
        return { stopped: false, ...opt("running", live?.id) };
    }
    const stopped = conversations.abort(conversationId);
    // A run can look gone while its pump still finishes cleanup; joining it avoids a race.
    if (!stopped && live === undefined) {
        return { stopped: false };
    }
    conversations.send(conversationId, { kind: "stop", ending: "stopped" });
    await live?.waitUntilFinished();
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
        run: (sent) => {
            const daemon = services();
            const turn = withRuntimeDefaults(sent);
            // Opened before the provider runs, matching the send path's own order.
            const opened = openTurnTranscript(daemon, turn);
            const run = startTurnRun(daemon, body, turn, {
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
        steer: async (conversationId, steer) => {
            const daemon = services();
            const composed = await composeSteerText(daemon.workspace.root, steer);
            if (composed.invalid !== undefined) {
                return { invalid: composed.invalid };
            }
            return steerTurn(daemon.conversations, conversationId, { text: composed.text, voice: steer.voice, ...opt("outside", steer.outside) });
        },
        reply: (reply) => applyReply(services(), reply),
        stop: (target) => stopTurn(services().conversations, target),
        // A person's message, one at a time per conversation.
        ...createAdmission(services, start),
    };
};
