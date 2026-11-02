import { computed, type Ref } from "vue";
import type { ReopenPress } from "../../composer/composerIntent";
import { bookingOf, type SendLater } from "../../../../models/conversations/drafts/sendLater";
import type { PickUp } from "../../../../models/conversations/endings/pickUp";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { track } from "../../../../app/analytics";
import type { SendHost } from "./composerSend";

// A stopped turn's Continue booked for a time the reader picks, or for another agent's land, from the send's caret on an
// empty box: it waits in the queue drawn as scheduled, as a reopen's does, and nothing joins the chat as the reader's
// words. Offered only where the bare press would continue (now, or at the reopen), and never for a flagged turn, which
// only its own card re-runs (a booked Continue would send it again with the stopped response still in the session).
export const useContinueLater = (
    host: Pick<SendHost, "view" | "reachable" | "canDrive" | "laterOffered" | "pin">,
    pickUp: Readonly<Ref<PickUp | undefined>>,
    continueOffer: Readonly<Ref<boolean>>,
    reopenPress: Readonly<Ref<ReopenPress | undefined>>,
) => {
    const continueLaterOffered = computed(
        () =>
            host.laterOffered.value &&
            supportsRoute(`agent.queueContinue`) &&
            pickUp.value?.reason !== `flagged` &&
            (continueOffer.value || reopenPress.value !== undefined),
    );
    const continueLater = (picked: SendLater): void => {
        if (!host.reachable.value || !host.canDrive.value || !continueLaterOffered.value) {
            return;
        }
        const chat = host.view.conversation.value;
        chat.sendLater.value = undefined;
        track(`message_sent`, { agent: chat.selection.provider.value, scheduled: true });
        void chat.turn.scheduleContinue(bookingOf(picked));
        host.pin();
    };
    return { continueLaterOffered, continueLater };
};
