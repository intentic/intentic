// What Tip.astro's card needs a script for (DESIGN.md, "Detail on demand"). Everything else is the popover's own:
// a tap on the trigger opens it, Escape and a tap outside close it, and opening one closes whichever was open.
//
//   hover      opens after `--tip-intent` (80ms), so a pointer passing over a row of tiles does not open each one;
//   grace      the pointer may leave the trigger for `--tip-grace` (150ms) on its way into the card, so its link can be
//              pressed; leaving both closes it;
//   keyboard   focus that is keyboard focus opens it, and it stays while focus is on the trigger or inside the card;
//   touch      a finger never hovers: a tap toggles, on the (i), the term, or anywhere on a tile that is not a link;
//   placement  below the trigger (the whole tile, for an area Tip), above it when the viewport's foot is too close, and
//              8px clear of every edge. The lozenge keeps pointing at the trigger when the card is pushed sideways.

import { tokenMs } from "./motion";

/** Kept clear of the viewport's edges. */
const EDGE = 8;
/** Between the trigger and the card: room for the lozenge set into its edge. */
const GAP = 10;
/** The lozenge stays this far in from the card's ends, on its straight edge. */
const POINTER_INSET = 16;

let pointerType = "mouse";

const place = (card: HTMLElement, anchor: Element): void => {
    const box = anchor.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = window.innerHeight;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const below = viewHeight - box.bottom - GAP - EDGE;
    const above = box.top - GAP - EDGE;
    const side = below >= height || below >= above ? "bottom" : "top";
    const top = Math.max(EDGE, Math.min(side === "bottom" ? box.bottom + GAP : box.top - GAP - height, viewHeight - height - EDGE));
    const centre = box.left + box.width / 2;
    const left = Math.max(EDGE, Math.min(centre - width / 2, viewWidth - width - EDGE));
    card.dataset.side = side;
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
    card.style.setProperty("--tip-arrow", `${Math.round(Math.max(POINTER_INSET, Math.min(centre - left, width - POINTER_INSET)))}px`);
};

/** One Tip's parts and state, shared by the handlers below. */
interface Tip {
    root: HTMLElement;
    button: HTMLButtonElement;
    card: HTMLElement;
    /** The tile or node an area Tip hangs from; null for one that hangs from its own trigger. */
    area: HTMLElement | null;
    openTimer: number | undefined;
    closeTimer: number | undefined;
    /** Whether the card was up when the press that is now landing began: light dismiss may have closed it since. */
    wasOpen: boolean;
    lastHeight: number;
    /** Focus is being handed back to the trigger after an Escape: that focus must not reopen the card. */
    returning: boolean;
}

const anchorOf = (tip: Tip): Element => tip.area ?? (tip.root.dataset.trigger === "term" ? tip.root : tip.button);
const isOpen = (tip: Tip): boolean => tip.card.matches(":popover-open");
const clear = (tip: Tip): void => {
    window.clearTimeout(tip.openTimer);
    window.clearTimeout(tip.closeTimer);
};
const open = (tip: Tip): void => {
    clear(tip);
    if (isOpen(tip)) {
        return;
    }
    // Which way it will rise is decided before it shows, from its last height, so its entry runs the right way.
    const box = anchorOf(tip).getBoundingClientRect();
    tip.card.dataset.side = window.innerHeight - box.bottom - GAP - EDGE >= (tip.lastHeight || 160) ? "bottom" : "top";
    tip.card.showPopover();
};
const close = (tip: Tip): void => {
    clear(tip);
    if (isOpen(tip)) {
        tip.card.hidePopover();
    }
};
/** Whether anything still holds the card up: the pointer over a part of it, or keyboard focus on or inside it. */
const isHeld = (tip: Tip): boolean =>
    tip.root.matches(":hover") ||
    tip.card.matches(":hover") ||
    tip.area?.matches(":hover") === true ||
    tip.card.contains(document.activeElement) ||
    (document.activeElement === tip.button && tip.button.matches(":focus-visible"));

/** Hover, with intent on the way in and grace on the way out. A finger's pointer events are not a hover. */
const wireHover = (tip: Tip): void => {
    for (const zone of [tip.root, tip.card, tip.area]) {
        if (zone === null) {
            continue;
        }
        zone.addEventListener("pointerenter", (event) => {
            if (event.pointerType === "touch") {
                return;
            }
            window.clearTimeout(tip.closeTimer);
            if (!isOpen(tip)) {
                window.clearTimeout(tip.openTimer);
                tip.openTimer = window.setTimeout(() => open(tip), tokenMs("--tip-intent"));
            }
        });
        zone.addEventListener("pointerleave", (event) => {
            if (event.pointerType === "touch") {
                return;
            }
            clear(tip);
            tip.closeTimer = window.setTimeout(() => {
                if (!isHeld(tip)) {
                    close(tip);
                }
            }, tokenMs("--tip-grace"));
        });
    }
};

/** Press and tap. The native toggle is replaced, or a click on a trigger the pointer had already opened would close
 *  the card it was reaching for. */
const wirePress = (tip: Tip): void => {
    const remember = (): void => {
        tip.wasOpen = isOpen(tip);
    };
    tip.button.addEventListener("pointerdown", remember);
    tip.button.addEventListener("click", (event) => {
        event.preventDefault();
        // A mouse that clicks has already hovered: the card is up, and the click keeps it. A finger or a key toggles.
        const toggles = pointerType === "touch" || event.detail === 0;
        if (toggles && (tip.wasOpen || isOpen(tip))) {
            close(tip);
        } else {
            open(tip);
        }
        tip.wasOpen = isOpen(tip);
    });
    const area = tip.area;
    if (area === null) {
        return;
    }
    area.addEventListener("pointerdown", remember);
    area.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (pointerType !== "touch" || target === null || target.closest("a, button, .kit-tip-card") !== null) {
            return;
        }
        if (tip.wasOpen) {
            close(tip);
        } else {
            open(tip);
        }
    });
};

/** Keyboard focus opens it; it stays while focus is on the trigger or inside the card. */
const wireFocus = (tip: Tip): void => {
    tip.button.addEventListener("focus", () => {
        if (tip.returning) {
            tip.returning = false;
            return;
        }
        if (tip.button.matches(":focus-visible")) {
            open(tip);
        }
    });
    const leave = (): void => {
        window.setTimeout(() => {
            if (!isHeld(tip)) {
                close(tip);
            }
        }, 0);
    };
    tip.button.addEventListener("blur", leave);
    tip.card.addEventListener("focusout", leave);
};

/** While it is up: placed, kept with its trigger as the page scrolls, and closed once the trigger has gone. */
const wireToggle = (tip: Tip): void => {
    let frame = 0;
    const follow = (): void => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            // A card the pointer opened goes once its trigger has scrolled away. One that keyboard focus holds stays:
            // focusing scrolls the page (smoothly, on this site), and the trigger is on its way in, not out.
            const box = anchorOf(tip).getBoundingClientRect();
            const focused = document.activeElement === tip.button || tip.card.contains(document.activeElement);
            if (!focused && (box.bottom < 0 || box.top > window.innerHeight)) {
                close(tip);
                return;
            }
            place(tip.card, anchorOf(tip));
        });
    };
    // Whether focus was inside the card as it closed, read before it hides (after, focus has already fallen to the
    // body, which is also where it sits for every reader using a mouse).
    // The browser may hand focus back to the trigger itself while it hides the card, before `toggle` arrives; the
    // flag goes up here, synchronously, so that focus is not taken as a reader tabbing to the trigger.
    let focusInside = false;
    tip.card.addEventListener("beforetoggle", () => {
        focusInside = isOpen(tip) && tip.card.contains(document.activeElement);
        tip.returning = focusInside;
    });
    // `toggle` fires once the state has changed, so the card's own state is the new one.
    tip.card.addEventListener("toggle", () => {
        const opened = isOpen(tip);
        tip.button.setAttribute("aria-expanded", String(opened));
        if (opened) {
            place(tip.card, anchorOf(tip));
            tip.lastHeight = tip.card.offsetHeight;
            document.addEventListener("scroll", follow, { capture: true, passive: true });
            window.addEventListener("resize", follow, { passive: true });
            return;
        }
        clear(tip);
        document.removeEventListener("scroll", follow, { capture: true });
        window.removeEventListener("resize", follow);
        // Escape from inside the card would leave focus nowhere: hand it back to the trigger.
        if (focusInside && document.activeElement !== tip.button) {
            tip.button.focus({ preventScroll: true });
        }
        tip.returning = false;
    });
};

const enhance = (root: HTMLElement): void => {
    const button = root.querySelector<HTMLButtonElement>(":scope > .kit-tip-button");
    const card = root.querySelector<HTMLElement>(":scope > .kit-tip-card");
    if (button === null || card === null) {
        return;
    }
    const area = root.hasAttribute("data-area") ? root.closest<HTMLElement>("[data-tip-area]") : null;
    const tip: Tip = { root, button, card, area, openTimer: undefined, closeTimer: undefined, wasOpen: false, lastHeight: 0, returning: false };
    wireHover(tip);
    wirePress(tip);
    wireFocus(tip);
    wireToggle(tip);
    button.setAttribute("aria-expanded", "false");
};

let started = false;

/** Enhances every Tip on the page, once. A browser with no popovers keeps the cards in line, as text. */
export const startTips = (): void => {
    if (started || !("showPopover" in HTMLElement.prototype)) {
        return;
    }
    started = true;
    document.documentElement.dataset.kitTips = "";
    document.addEventListener(
        "pointerdown",
        (event) => {
            pointerType = event.pointerType;
        },
        { capture: true, passive: true },
    );
    for (const root of document.querySelectorAll<HTMLElement>("[data-kit-tip]")) {
        enhance(root);
    }
};
