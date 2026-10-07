import { flashElement, lessMotion } from "@intentic/ui/motion";
import type { WaitKind } from "./pendingDecision";

// Where the waiting bar's press lands (ChatWaitingBar): the card for the ask the bar names, brought on screen, given the
// keyboard, and ringed for a moment. A press that only scrolled moved nothing when the card was already on screen, and
// a Polish reader pressed Answer eight times in thirty seconds; with more than one card waiting it scrolled to the
// newest, whichever ask that was.

// The live card a row holds for this ask (ChatMessageView's `data-card-request`), else the newest live one, for an ask
// whose row this window has not drawn under its id.
export const waitingCardIn = (pane: ParentNode, requestId: string): HTMLElement | undefined => {
    const row = [...pane.querySelectorAll<HTMLElement>(`[data-card-request]`)].find((candidate) => candidate.dataset[`cardRequest`] === requestId);
    const named = row?.querySelector<HTMLElement>(`[data-card-live]`);
    if (named !== null && named !== undefined) {
        return named;
    }
    // A NodeList has no `.at`: spread, so the newest drawn card is the last.
    return [...pane.querySelectorAll<HTMLElement>(`[data-card-live]`)].at(-1);
};

const usable = (el: HTMLElement): boolean => !el.matches(`:disabled, [aria-disabled="true"]`);

// What the press hands the keyboard to: the answer the reader already leans to, else the first one offered, else the
// card's own answers row. A plan's answers stand on the bar, not on its card, so a plan gives the card itself, to be
// read from its top.
export const answerIn = (card: HTMLElement, kind: WaitKind): HTMLElement => {
    if (kind === `plan`) {
        return card;
    }
    const asks = [`.chat-option[aria-checked="true"]`, `.chat-option`, `.chat-card-row :is(button, input, textarea, select)`];
    for (const ask of asks) {
        const found = [...card.querySelectorAll<HTMLElement>(ask)].find(usable);
        if (found !== undefined) {
            return found;
        }
    }
    return card;
};

export const showWaitingCard = (card: HTMLElement, kind: WaitKind): void => {
    card.scrollIntoView({ block: `center`, behavior: lessMotion() ? `auto` : `smooth` });
    const target = answerIn(card, kind);
    // The card itself takes focus from script only, never from Tab, which already stops on its answers.
    if (target === card && !card.hasAttribute(`tabindex`)) {
        card.setAttribute(`tabindex`, `-1`);
    }
    target.focus({ preventScroll: true });
    flashElement(card);
};
