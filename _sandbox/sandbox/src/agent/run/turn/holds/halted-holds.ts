import type { Services } from "../../../../composition.js";
import { haltOf } from "../../../../conversations/actor/conversation-halt.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";

/**
 * A re-run the sandbox booked for a conversation a cancel has since stopped (conversations/actor/conversation-halt.ts) never fires: the
 * cancel drops the booking as it runs (halt-quiet.ts), and one booked after it is dropped here, by the resume pass, before
 * any rung reads it (turn-resume.ts runRung). Answers whether the conversation stands halted, so the pass leaves it.
 */
export const droppedForHalt = (services: Pick<Services, "conversations" | "logger">, conversationId: string, held: HeldRecord): boolean => {
    if (haltOf(services.conversations, conversationId) === undefined) {
        return false;
    }
    if (!held.fired && services.conversations.state(conversationId)?.resume.held === held) {
        services.conversations.send(conversationId, { kind: "resume-dropped" });
        services.logger.info({ conversationId, reason: held.reason }, "resume pass: the conversation was stopped by a cancel, its booked re-run is dropped");
    }
    return true;
};
