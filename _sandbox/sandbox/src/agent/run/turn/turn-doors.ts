import type { ConversationActors } from "../../../agents/actor/conversation-actors.js";
import { turnRunOf } from "../../../agents/actor/conversation-holdings.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../../../sessions/turn-transcript.js";
import { steerTurn } from "../../checkpoints/agent-steering.js";
import { applyReply, composeSteerText } from "./turn-interactions.js";
import { fireHeldResume, startConversationTurn } from "./turn-resume.js";
import { startTurnRun } from "./turn-runs.js";

// The turn engine behind the TurnStarter port: every door a subsystem starts or drives a turn through, over one turn
// body. Composition binds the body to streamAgent; a suite binds its own, and gets the real run, journal and card logic.

// Hard-cancels the live turn, marks it stopped before the unwind, and joins the unwind, so a stop truly frees the lock.
const stopTurn = async (conversations: Pick<ConversationActors, "holdings" | "abort" | "send">, conversationId: string): Promise<boolean> => {
    const run = turnRunOf(conversations, conversationId);
    const stopped = conversations.abort(conversationId);
    // A run can look gone while its pump still finishes cleanup; joining it avoids a race.
    if (!stopped && (run === undefined || run.done)) {
        return false;
    }
    conversations.send(conversationId, { kind: "stop", ending: "stopped" });
    await run?.waitUntilFinished();
    return true;
};

// `services` is read per call, since the port is composed into the very object it reads.
export const turnDoors = (services: () => Services, body: TurnStarter["stream"]): TurnStarter => ({
    start: (turn, options) => startConversationTurn(services(), body, turn, options),
    resume: (conversationId, routing) => fireHeldResume(services(), conversationId, routing),
    run: (turn) => {
        const daemon = services();
        // Opened before the provider runs, matching the send path's own order.
        const opened = openTurnTranscript(daemon, turn);
        return startTurnRun(daemon, body, turn, {
            before: opened,
            opening: (startedAt) => openingRows(turn, daemon.workspace.root, startedAt),
            transcript: (rows, steerRows) => recordTurnTranscript(daemon, turn, rows, steerRows),
        });
    },
    stream: body,
    steer: async (conversationId, steer) => {
        const daemon = services();
        const composed = await composeSteerText(daemon.workspace.root, steer);
        if (composed.invalid !== undefined) {
            return { invalid: composed.invalid };
        }
        return steerTurn(daemon.conversations, conversationId, { text: composed.text, voice: steer.voice, ...opt("outside", steer.outside) });
    },
    reply: (reply) => applyReply(services(), reply),
    stop: (conversationId) => stopTurn(services().conversations, conversationId),
});
