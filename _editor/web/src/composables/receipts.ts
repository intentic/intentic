import { ref } from "vue";

/* THE APP SAYING "DONE" WITHOUT ASKING FOR ANYTHING BACK.
 *
 * Until this, the app had exactly one channel: a red box that stays until dismissed. So success was SILENCE
 * and the only feedback the product owned was alarm — which is why every confirmation worth having had to
 * become a permanent element (a counter, a badge, a strip) or not exist at all. Several did not exist: a file
 * deleted from the tree, a path copied, a token revoked all completed in total quiet, and the only way to
 * learn whether they worked was to go and look.
 *
 * A receipt is the other channel. It retires itself, because a completion is not something the user has to
 * acknowledge and one more thing to dismiss is exactly what makes an app feel like a toll. It carries at most
 * one way back — an Undo, when the action has one — and nothing else: a receipt with choices on it is a
 * dialog that forgot to block.
 *
 * The vocabulary and the rules are the fleet board's (useAgents.ts), which had reasoned all of this out for
 * archiving and could not share a line of it. What is generalised here is the STORE; the timing stays with
 * the host component (ReceiptBar.vue), for the reason the board found: a receipt must not vanish under the
 * cursor that came for its Undo, so its expiry depends on hover, which is a view's business. That also keeps
 * this module timer-free and its tests free of fake clocks.
 *
 * ONE AT A TIME, newest wins. Two receipts stacked is a notification centre, and the second one is always the
 * one the user is looking for — a queue would make them wait for the first to expire before being told what
 * just happened.
 *
 * AND THE THIRD THING THAT CAN HAPPEN: not done, not alarming. A background helper that could not answer — a
 * quick-model job with every connected model spent — belongs in neither of the two channels the app had. It is
 * not a completion, and the red box is for a failure the user has to act on: nothing is broken, no work was
 * lost, and there is nothing to fix but wait. Left with only those two, it went in the silent one, so the
 * gesture did nothing at all and looked like a dead control.
 *
 * So a receipt carries a TONE. Same pill, same dwell, same self-retiring contract — one glyph and one colour
 * apart, because "it didn't work" said calmly is still the same KIND of message as "it worked": something
 * happened, here it is, carry on. */

export type ReceiptTone = "done" | "problem";

export interface Receipt {
    // What happened, in the past tense, from the user's side: "3 files deleted", not "Delete succeeded". For a
    // `problem`, what could not happen and why in one sentence — this is the whole message, not a headline.
    readonly message: string;
    readonly tone: ReceiptTone;
    // The way back, when there is one. A receipt whose action needs more than one word does not belong here.
    readonly undo?: () => void | Promise<void>;
}

const current = ref<Receipt | undefined>(undefined);

export const useReceipts = () => {
    /* Raising one REPLACES whatever is showing, which is also how the timer restarts: the host watches this
     * ref, so a second archive re-arms the full dwell rather than inheriting the tail of the first. */
    const say = (message: string, undo?: Receipt[`undo`]): void => {
        current.value = { message, tone: `done`, undo };
    };
    /* The same channel for the thing that did not work — no Undo, because there is nothing to take back. Use it
     * where the alternative is silence: a click that produced no result and no explanation. A failure the user
     * must ACT on is still a notice (ui/notice.ts), and putting one here would retire it before they read it. */
    const warn = (message: string): void => {
        current.value = { message, tone: `problem` };
    };
    const dismissReceipt = (): void => {
        current.value = undefined;
    };
    return { receipt: current, say, warn, dismissReceipt };
};
