import type { Directive, DirectiveBinding } from "vue";

/* `v-middleclick="handler"`, the tab-strip close gesture: a middle press on a pill closes it, as browsers and
   editors have always done. Two listeners, not one — `auxclick` is the press that closes, and the platform's own
   middle-press default (Chromium's autoscroll puck, X11's primary-selection paste) starts on `mousedown` and would
   outlive the element the close just removed. */

const MIDDLE = 1;

interface MiddleClickState {
    handler: (event: MouseEvent) => void;
    down: (event: MouseEvent) => void;
    aux: (event: MouseEvent) => void;
}

const states = new WeakMap<HTMLElement, MiddleClickState>();

export const vMiddleclick: Directive<HTMLElement, (event: MouseEvent) => void> = {
    mounted(el, binding: DirectiveBinding<(event: MouseEvent) => void>) {
        const state: MiddleClickState = {
            handler: binding.value,
            down: (event) => {
                if (event.button === MIDDLE) {
                    event.preventDefault();
                }
            },
            aux: (event) => {
                if (event.button !== MIDDLE) {
                    return;
                }
                // A card that is also a link would otherwise open itself in a background tab as it closes.
                event.preventDefault();
                // The strip under the pill has gestures of its own (selection, its context menu); this press is spent.
                event.stopPropagation();
                state.handler(event);
            },
        };
        states.set(el, state);
        el.addEventListener(`mousedown`, state.down);
        el.addEventListener(`auxclick`, state.aux);
    },
    // Re-bound in place: the handler closes over a row id that changes as the list re-renders.
    updated(el, binding: DirectiveBinding<(event: MouseEvent) => void>) {
        const state = states.get(el);
        if (state !== undefined) {
            state.handler = binding.value;
        }
    },
    unmounted(el) {
        const state = states.get(el);
        if (state === undefined) {
            return;
        }
        el.removeEventListener(`mousedown`, state.down);
        el.removeEventListener(`auxclick`, state.aux);
        states.delete(el);
    },
};
