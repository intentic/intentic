import { flashElement, lessMotion } from "@intentic/ui/motion";
import type { WaitKind } from "../../../../models/conversations/panel/pendingAsks";

// Moving between an ask in the dock above the composer (ChatAskDock) and the row in the transcript where it was asked.
// The dock's answer is handed the keyboard and ringed, so a press that opens it always shows where to answer (a Polish
// reader once pressed a bar's Answer eight times in thirty seconds when the press only scrolled). A row is brought into
// the part of the column the footer does not cover: centred in the whole scroller it sat behind the composer on a phone,
// where the footer is half the screen, and one option of a question showed with its Submit underneath.

// The transcript row an ask was made in, by the key the dock lists it under (ChatMessageView's `data-ask-row`).
export const askRowIn = (pane: ParentNode, key: string): HTMLElement | undefined =>
    [...pane.querySelectorAll<HTMLElement>(`[data-ask-row]`)].find((row) => row.dataset[`askRow`] === key);

const usable = (el: HTMLElement): boolean => !el.matches(`:disabled, [aria-disabled="true"]`);

// What an ask's body hands the keyboard to: the answer the reader already leans to, else the first one offered, else the
// card's own answers row. A plan is read in the transcript, so its body itself takes it.
export const answerIn = (body: HTMLElement, kind: WaitKind): HTMLElement => {
    if (kind === `plan`) {
        return body;
    }
    const asks = [`.chat-option[aria-checked="true"]`, `.chat-option`, `.chat-card-row :is(button, input, textarea, select)`, `button`];
    for (const ask of asks) {
        const found = [...body.querySelectorAll<HTMLElement>(ask)].find(usable);
        if (found !== undefined) {
            return found;
        }
    }
    return body;
};

/** Gives an ask's body in the dock the keyboard at its first answer, and rings it. */
export const focusAsk = (body: HTMLElement, kind: WaitKind): void => {
    const target = answerIn(body, kind);
    // The body itself takes focus from script only, never from Tab, which already stops on its answers.
    if (target === body && !body.hasAttribute(`tabindex`)) {
        body.setAttribute(`tabindex`, `-1`);
    }
    target.focus({ preventScroll: true });
    flashElement(body);
};

const MARGIN = 12;

// How far to scroll for `box` to stand wholly in the room above the footer: none when it already does, else centred in
// that room, or its head at the top when it is taller than the room.
export const scrollToShow = (box: { top: number; bottom: number }, room: { top: number; bottom: number }): number => {
    if (box.top >= room.top + MARGIN && box.bottom <= room.bottom - MARGIN) {
        return 0;
    }
    const height = box.bottom - box.top;
    const space = room.bottom - room.top;
    if (height + MARGIN * 2 > space) {
        return box.top - (room.top + MARGIN);
    }
    return box.top + height / 2 - (room.top + space / 2);
};

/** How tall the part of the scroller the sticky footer leaves uncovered is. */
export const roomAbove = (scroller: HTMLElement, footer: HTMLElement | null): number => {
    const view = scroller.getBoundingClientRect();
    return view.height - (footer === null ? 0 : Math.max(0, view.bottom - footer.getBoundingClientRect().top));
};

/** Brings a transcript row into the room the sticky footer leaves, and rings it. */
export const revealRow = (row: HTMLElement, scroller: HTMLElement, footer: HTMLElement | null): void => {
    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const delta = scrollToShow(box, { top: view.top, bottom: view.top + roomAbove(scroller, footer) });
    if (delta !== 0) {
        scroller.scrollBy({ top: delta, behavior: lessMotion() ? `auto` : `smooth` });
    }
    flashElement(row.querySelector(`.chat-card`) ?? row);
};
