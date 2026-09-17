import type { Directive } from "vue";

/* `v-longpress="handler"`, the touch replacement for right-click ContextMenus: pointerdown starts a 500ms timer. */

const DURATION_MS = 500;
const SLOP_PX = 10;

interface LongPressState {
    handler: (event: PointerEvent) => void;
    timer?: ReturnType<typeof setTimeout>;
    startX: number;
    startY: number;
    fired: boolean;
    down: (event: PointerEvent) => void;
    move: (event: PointerEvent) => void;
    cancel: () => void;
    contextmenu: (event: Event) => void;
}

const states = new WeakMap<HTMLElement, LongPressState>();

// The finger lifting after a long press is not a tap. By then the handler's sheet sits under it, so the release's
// click would land on the sheet's mask and dismiss what the press just opened; the first click within the window
// is dropped wherever it lands, not only on the pressed element.
const RELEASE_WINDOW_MS = 1000;
const swallowRelease = (): void => {
    const swallow = (event: MouseEvent): void => {
        event.stopImmediatePropagation();
        event.preventDefault();
        stop();
    };
    const timer = setTimeout(() => stop(), RELEASE_WINDOW_MS);
    const stop = (): void => {
        clearTimeout(timer);
        document.removeEventListener(`click`, swallow, true);
    };
    document.addEventListener(`click`, swallow, true);
};

export const vLongpress: Directive<HTMLElement, (event: PointerEvent) => void> = {
    mounted(el, binding) {
        const state: LongPressState = {
            handler: binding.value,
            startX: 0,
            startY: 0,
            fired: false,
            down: (event) => {
                if (event.pointerType === `mouse`) {
                    return;
                }
                state.startX = event.clientX;
                state.startY = event.clientY;
                state.fired = false;
                state.timer = setTimeout(() => {
                    state.timer = undefined;
                    state.fired = true;
                    navigator.vibrate?.(10);
                    swallowRelease();
                    state.handler(event);
                }, DURATION_MS);
            },
            move: (event) => {
                if (state.timer === undefined) {
                    return;
                }
                if (Math.abs(event.clientX - state.startX) > SLOP_PX || Math.abs(event.clientY - state.startY) > SLOP_PX) {
                    state.cancel();
                }
            },
            cancel: () => {
                if (state.timer !== undefined) {
                    clearTimeout(state.timer);
                    state.timer = undefined;
                }
            },
            contextmenu: (event) => {
                // The browser's own long-press context menu / text selection would fight the handler.
                if (state.timer !== undefined || state.fired) {
                    event.preventDefault();
                }
                state.fired = false;
            },
        };
        states.set(el, state);
        el.addEventListener(`pointerdown`, state.down);
        el.addEventListener(`pointermove`, state.move);
        el.addEventListener(`pointerup`, state.cancel);
        el.addEventListener(`pointercancel`, state.cancel);
        el.addEventListener(`contextmenu`, state.contextmenu);
        el.style.webkitUserSelect = `none`;
        el.style.userSelect = `none`;
    },
    updated(el, binding) {
        const state = states.get(el);
        if (state === undefined) {
            return;
        }
        state.handler = binding.value;
    },
    unmounted(el) {
        const state = states.get(el);
        if (state === undefined) {
            return;
        }
        state.cancel();
        el.removeEventListener(`pointerdown`, state.down);
        el.removeEventListener(`pointermove`, state.move);
        el.removeEventListener(`pointerup`, state.cancel);
        el.removeEventListener(`pointercancel`, state.cancel);
        el.removeEventListener(`contextmenu`, state.contextmenu);
        states.delete(el);
    },
};
