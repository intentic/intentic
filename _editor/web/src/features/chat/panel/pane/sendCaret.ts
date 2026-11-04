import { type Ref, watch } from "vue";
import type { SendLater } from "../../../../models/conversations/drafts/sendLater";
import type { Conversation } from "../../../../models/conversations/session/conversation";

// The send's caret menu at work (ChatPane's split send): a pick in it is the send itself, booked for when it says, and its
// Send now clears the booking and sends. On an empty box over a paused chat the pick books the Continue instead.

export interface SendCaretHost {
    readonly conversation: () => Conversation;
    // The caret's menu, and whether the caret stands at all.
    readonly open: Ref<boolean>;
    readonly shown: Readonly<Ref<boolean>>;
    readonly staged: Readonly<Ref<boolean>>;
    readonly continueLaterOffered: Readonly<Ref<boolean>>;
    readonly continueLater: (later: SendLater) => void;
    readonly submit: () => void;
}

export const useSendCaret = (host: SendCaretHost) => {
    // A caret that leaves takes its menu with it, so nothing floats over a composer gone back to a plain Send.
    watch(host.shown, (shown) => {
        if (!shown) {
            host.open.value = false;
        }
    });
    return {
        sendAt: (later: SendLater): void => {
            host.open.value = false;
            if (!host.staged.value && host.continueLaterOffered.value) {
                host.continueLater(later);
                return;
            }
            host.conversation().sendLater.value = later;
            host.submit();
        },
        sendNow: (): void => {
            host.conversation().sendLater.value = undefined;
            host.open.value = false;
            host.submit();
        },
    };
};
