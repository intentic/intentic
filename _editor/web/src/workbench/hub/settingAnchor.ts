import { flashElement, lessMotion } from "@intentic/ui/motion";

// LANDING ON A CARD. A search answer (hubSearch.ts) is an address ending in `#setting-<id>`, and the card it names
// carries `data-setting="<id>"` in its page's template. The router's own scroll cannot do the landing: a hub page reads
// its settings before it draws its cards, and a page's category (`?section=`) swaps which cards are drawn at all, so the
// card is usually not there yet when the route settles. This waits for it, a bounded while, then brings it to the middle
// of the pane, lights it (the app's "here it is" glow, @intentic/ui/motion flash.ts) and gives it focus, so a screen
// reader lands where the eye does. That focus is QUIET (`data-quiet-focus`, base.css): the glow is what the eye is shown,
// and a focus ring left standing round a card that is not a control read as a stray box drawn over the page.

/** The attribute a card is marked with; a plain attribute, so it rides any element and any component's root. */
export const SETTING_ATTRIBUTE = `data-setting`;
// Focus given for assistive tech, drawn without a ring (base.css): only on a card this module made focusable, never on
// one that is a control of its own and keeps the ring a keyboard user steers by.
const QUIET_FOCUS = `data-quiet-focus`;

// Long enough for a page to read its settings over a slow link, short enough that a card this reader is not drawn
// (a stale link) does not leave a watcher behind for the rest of the visit.
const ARRIVAL_DEADLINE_MS = 4_000;

// Ids are lower-case words joined by `-` (hubSearch.ts), so one can sit in a selector unquoted-safe as it is.
const findSetting = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[${SETTING_ATTRIBUTE}="${id}"]`);

// A card's rounded surface rather than the card's whole box: a <RowGroup>'s root holds its label above the surface, and a
// glow round both reads as a box drawn round two things. A headline row, or a card with no surface, is lit as it stands.
const ringOf = (card: HTMLElement): HTMLElement => card.querySelector<HTMLElement>(`:scope > .rounded-xl`) ?? card;

// How long a landed card is kept in view while its page settles. A hub page draws its cards as each one's read answers,
// so the cards above the one landed on can still grow after the landing and push it off screen: the Agent page's Tools
// moved its Voice card twelve hundred pixels down after the scroll had already ended on it.
const SETTLE_MS = 2_000;
const READER_MOVES = [`wheel`, `touchstart`, `pointerdown`, `keydown`] as const;

const scrollerOf = (element: HTMLElement): Element => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        const { overflowY } = getComputedStyle(parent);
        if ((overflowY === `auto` || overflowY === `scroll`) && parent.scrollHeight > parent.clientHeight) {
            return parent;
        }
    }
    return document.scrollingElement ?? document.documentElement;
};

// The part of the screen a scroller shows. The document's own scroller is the window, whose box moves with what it
// scrolls; any other one stays where it is drawn.
const viewOf = (scroller: Element): { readonly top: number; readonly height: number } =>
    scroller === document.scrollingElement
        ? { top: 0, height: window.innerHeight }
        : { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight };

// Where the card sits in its scroller's content: what the cards above it move, and a scroll (smooth or the reader's)
// does not.
const placeIn = (card: HTMLElement, scroller: Element): number => card.getBoundingClientRect().top - viewOf(scroller).top + scroller.scrollTop;

// Room left above a card that is taller than the pane, so its heading is not flush with the edge.
const GAP_PX = 16;

// The card in the middle of the pane, or its heading at the top when the card is taller than the pane: a long card's
// middle is a row nobody asked for, with the name the reader picked scrolled away above it.
const bringIntoView = (card: HTMLElement, scroller: Element, behavior: ScrollBehavior): void => {
    const view = viewOf(scroller).height;
    const height = card.getBoundingClientRect().height;
    const above = height > view - 2 * GAP_PX ? GAP_PX : (view - height) / 2;
    scroller.scrollTo({ top: placeIn(card, scroller) - above, behavior });
};

// Brings the card back into view each frame its place moves, until the page has settled or the reader takes over:
// a reader who has started scrolling has said where they want to be. The glow starts again where the card comes back to,
// since the one it had played out where nobody could see it.
const holdInView = (card: HTMLElement, scroller: Element): void => {
    let place = placeIn(card, scroller);
    const until = performance.now() + SETTLE_MS;
    let frame = 0;
    const stop = (): void => {
        cancelAnimationFrame(frame);
        for (const move of READER_MOVES) {
            window.removeEventListener(move, stop, true);
        }
    };
    const tick = (): void => {
        if (performance.now() > until || !card.isConnected) {
            stop();
            return;
        }
        const now = placeIn(card, scroller);
        if (Math.abs(now - place) > 1) {
            bringIntoView(card, scroller, `auto`);
            flashElement(ringOf(card));
            place = now;
        }
        frame = requestAnimationFrame(tick);
    };
    for (const move of READER_MOVES) {
        window.addEventListener(move, stop, { capture: true, once: true, passive: true });
    }
    frame = requestAnimationFrame(tick);
};

const land = (card: HTMLElement): void => {
    // From script only, never from Tab: the card's own controls are already on the tab order. Focused before the scroll,
    // and without one of its own, so the scroll below is the only one.
    if (!card.hasAttribute(`tabindex`)) {
        card.setAttribute(`tabindex`, `-1`);
        card.setAttribute(QUIET_FOCUS, ``);
    }
    card.focus({ preventScroll: true });
    const scroller = scrollerOf(card);
    bringIntoView(card, scroller, lessMotion() ? `auto` : `smooth`);
    holdInView(card, scroller);
    flashElement(ringOf(card));
};

// The one wait in progress: a second answer picked before the first card arrived replaces it rather than landing twice.
// allow(module-state): the card a landing is still waiting for
let waiting: (() => void) | undefined;

/**
 * Brings the card marked `id` into view once its page has drawn it, and says whether it did. Gives up quietly at the
 * deadline: the page itself is still the right place, and an answer is never worse than the page it names.
 */
export const seekSetting = (id: string, deadlineMs = ARRIVAL_DEADLINE_MS): Promise<boolean> => {
    waiting?.();
    return new Promise((resolve) => {
        const present = findSetting(id);
        if (present !== null) {
            land(present);
            resolve(true);
            return;
        }
        const observer = new MutationObserver(() => {
            const found = findSetting(id);
            if (found !== null) {
                stop(true);
                land(found);
            }
        });
        const timer = setTimeout(() => stop(false), deadlineMs);
        const stop = (landed: boolean): void => {
            observer.disconnect();
            clearTimeout(timer);
            if (waiting === cancel) {
                waiting = undefined;
            }
            resolve(landed);
        };
        const cancel = (): void => stop(false);
        waiting = cancel;
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [SETTING_ATTRIBUTE] });
    });
};
