import { createPressLock, firePress, type PressLock, type PressState } from "./pressLock.js";
import type { Directive, DirectiveBinding } from "vue";

// `v-action="handler"`: components/Button.vue's press lock for hand-styled elements that can't become a <Button>.
// Replaces `@click` rather than composing with it, so the handler's return value can be awaited and locked. Busy
// state is drawn via the `data-press` attribute (styles/press.css), not a spinner, since a spinner would disturb a
// layout it doesn't own.

interface ActionState {
    handler: unknown;
    lock: PressLock;
    locked: boolean;
    click: (event: MouseEvent) => void;
}

const states = new WeakMap<HTMLElement, ActionState>();

const paint = (el: HTMLElement, state: PressState): void => {
    if (state.working) {
        el.dataset[`press`] = `working`;
    } else if (state.locked) {
        el.dataset[`press`] = `locked`;
    } else {
        delete el.dataset[`press`];
    }
    // aria-busy mirrors the dimmed state, so a screen reader gets the same signal.
    if (state.locked) {
        el.setAttribute(`aria-busy`, `true`);
    } else {
        el.removeAttribute(`aria-busy`);
    }
};

export const vAction: Directive<HTMLElement, unknown> = {
    mounted(el, binding: DirectiveBinding<unknown>) {
        const state: ActionState = {
            handler: binding.value,
            locked: false,
            lock: createPressLock((pressed) => {
                state.locked = pressed.locked;
                paint(el, pressed);
            }),
            click: (event) => {
                if (binding.modifiers[`stop`] === true) {
                    event.stopPropagation();
                }
                if (binding.modifiers[`prevent`] === true) {
                    event.preventDefault();
                }
                // The lock is the only guard: a hand-styled element has no `disabled`, and many of these are links.
                if (state.locked) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return;
                }
                const work = firePress(state.handler, event);
                if (work !== undefined) {
                    state.lock.hold(work);
                }
            },
        };
        states.set(el, state);
        el.addEventListener(`click`, state.click);
    },
    updated(el, binding: DirectiveBinding<unknown>) {
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
        el.removeEventListener(`click`, state.click);
        state.lock.dispose();
        states.delete(el);
    },
};
