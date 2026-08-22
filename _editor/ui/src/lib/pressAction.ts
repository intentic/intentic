import { createPressLock, firePress, type PressLock, type PressState } from "./pressLock.js";
import type { Directive, DirectiveBinding } from "vue";

/* `v-action="handler"`, THE RAW ELEMENT'S HALF OF components/Button.vue.
 *
 * Same state machine, same thresholds, same promise (see lib/pressLock.ts): a press that starts async work
 * locks its control in the same tick and shows it working once the wait is worth drawing. This spelling
 * exists because roughly a third of the app's actions are NOT the design system's button. They are
 * hand-styled `<button class="…">` rows: a menu item, a chip, a link inside a notice, an inline "Retry".
 * Turning those into components would rewrite their appearance; this changes one attribute:
 *
 *     <button @click="logout">    ->    <button v-action="logout">
 *
 * IT REPLACES @click RATHER THAN JOINING IT, and that is the whole trick. Vue hands a directive its binding
 * value, so the handler is ours to call and its return value ours to read, which is the one thing an
 * `@click` listener can never tell us: whether the press started something that has not finished.
 *
 * WHAT BUSY LOOKS LIKE HERE IS DELIBERATELY QUIETER than on the kit's button, and the reason is layout. The
 * button owns its own markup and can hang a spinner over the middle of itself. This directive is handed
 * somebody else's element with somebody else's classes on it, and a spinner needs either a positioning
 * context it may not have or a box of its own that would shove the row sideways at the 200ms mark. So the
 * press is drawn in the two ways that cost no layout at all: it dims the moment it is pressed, and it
 * breathes once the wait is long enough to be worth saying so. Styles live in styles/press.css, keyed on
 * the `data-press` attribute this sets.
 *
 * Modifiers mirror the ones the `@click` it replaces would have carried: `.stop`, `.prevent`. */

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
    // Read out as busy rather than merely dimmed: a screen reader gets the same news the dimming gives.
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
                // The lock is the guard. A hand-styled element has no `disabled` to lean on, and half of
                // these are links, where the browser would happily navigate a second time.
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
