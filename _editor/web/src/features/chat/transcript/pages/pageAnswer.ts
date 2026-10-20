import type { TranscriptPageAsk } from "@intentic/sandbox-contract/events/transcript";
import { t } from "@intentic/ui/i18n";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";

/**
 * What an asked page's answer (`intentic.submit`) does, wherever the page is drawn (the chat's card, ChatPageAskCard,
 * or the page full screen, ChatPageScreen): it goes through the chat's one reply like every card's, and the page is told
 * why not when it is not taken. `card` is read again after the reply, since an answer the daemon refused leaves it
 * pending.
 */
export const answerOnPage =
    (card: () => TranscriptPageAsk | undefined, settling: () => boolean, reply: (answer: CardAnswer) => Promise<void>) =>
    async (value: string): Promise<string | undefined> => {
        if (card()?.status !== `pending`) {
            return t(`chat.chatPages.alreadyAnswered`);
        }
        if (settling()) {
            return t(`chat.chatPages.answering`);
        }
        await reply({ kind: `page_ask`, value });
        return card()?.status === `pending` ? t(`chat.cardReplies.answersNotSubmitted`) : undefined;
    };
