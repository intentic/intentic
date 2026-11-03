import type { Ref } from "vue";
import { composerAnswer, planFeedback } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import type { SendHost } from "./composerSend";

// The composer's answers to the card a turn waits on: a plan's two (approve with notes, keep planning), and a question's
// or a page's one, the words in the box.

// Whether a press may go at all: the sandbox answers, and the reader may drive this chat.
export const pressable = (host: Pick<SendHost, "reachable" | "canDrive">): boolean => host.reachable.value && host.canDrive.value;

// Approval carries the composer's notes into execution. Restore the notes if the decision was refused.
// Keep planning sends the same notes as revision feedback.
export const planAnswers = (
    host: SendHost,
    planMessage: Readonly<Ref<ChatMessage | undefined>>,
    composer: { readonly settle: () => void; readonly sendDraft: () => void },
) => {
    const { view, history, editorContext } = host;
    const { draft, attachments, staged } = view;
    const approvePlan = async (): Promise<void> => {
        const plan = planMessage.value?.plan;
        if (plan === undefined || !pressable(host)) {
            return;
        }
        const text = draft.value.trim();
        const staging = attachments.value;
        const files = host.staging.snapshot();
        const notes = text.length > 0 || files.length > 0;
        if (notes) {
            attachments.value = [];
            editorContext.include.value = false;
            composer.settle();
        }
        const approved = await view.conversation.value.requests.reply(plan.requestId, {
            kind: `plan`,
            approve: true,
            feedback: notes ? planFeedback(text, files) : undefined,
        });
        if (!notes) {
            return;
        }
        if (!approved) {
            draft.value = text;
            attachments.value = staging;
            return;
        }
        if (text.length > 0) {
            history.value?.record(text);
        }
        host.pin();
    };
    const keepPlanning = (): void => {
        const plan = planMessage.value?.plan;
        if (plan === undefined || !pressable(host)) {
            return;
        }
        if (staged.value) {
            composer.sendDraft();
            return;
        }
        void view.conversation.value.requests.reply(plan.requestId, { kind: `plan`, approve: false });
    };
    return { approvePlan, keepPlanning };
};

// The composer's words as the answer to the question or page waiting above, in the reader's own words: the turn goes on
// with them at once. They used to wait behind the card as a message "for after" (2026-11-03), so a reader whose answer
// was none of the options had to pick one to be heard, and wrote what they meant into a note beside the pick.
export const useAskAnswer = (
    host: Pick<SendHost, "view" | "staging" | "editorContext" | "history" | "pin">,
    askMessage: Readonly<Ref<ChatMessage | undefined>>,
    settle: () => void,
) => {
    const { view, editorContext, history } = host;
    const { draft, attachments } = view;
    // Awaited, like a plan's approval with notes: an answer the daemon did not take puts the words and files back in the
    // box, and the card stays answerable (its error line says why).
    const answer = async (): Promise<void> => {
        const message = askMessage.value;
        const requestId = message?.question?.requestId ?? message?.pageAsk?.requestId;
        const text = draft.value.trim();
        const staging = attachments.value;
        const reply = composerAnswer(message, text, host.staging.snapshot());
        if (requestId === undefined || reply === undefined) {
            return;
        }
        attachments.value = [];
        editorContext.include.value = false;
        settle();
        if (!(await view.conversation.value.requests.reply(requestId, reply))) {
            draft.value = text;
            attachments.value = staging;
            return;
        }
        if (text.length > 0) {
            history.value?.record(text);
        }
        host.pin();
    };
    return { answer };
};
