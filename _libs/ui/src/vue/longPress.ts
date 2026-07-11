import type { Directive } from "vue";

/* `v-longpress="handler"` — the touch replacement for right-click ContextMenus: pointerdown starts a 500ms
 * timer, movement beyond a 10px slop or pointerup cancels it, firing vibrates (Android; no-op on iOS) and
 * suppresses the click that follows the release so row-tap handlers don't also run. Mouse pointers are
 * ignored — desktop keeps its real context menus. */

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
    click: (event: MouseEvent) => void;
    contextmenu: (event: Event) => void;
}

const states = new WeakMap<HTMLElement, LongPressState>();

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
            click: (event) => {
                if (!state.fired) {
                    return;
                }
                event.stopPropagation();
                event.preventDefault();
                state.fired = false;
            },
            contextmenu: (event) => {
                // The browser's own long-press context menu / text selection would fight the handler.
                if (state.timer !== undefined || state.fired) {
                    event.preventDefault();
                }
            },
        };
        states.set(el, state);
        el.addEventListener(`pointerdown`, state.down);
        el.addEventListener(`pointermove`, state.move);
        el.addEventListener(`pointerup`, state.cancel);
        el.addEventListener(`pointercancel`, state.cancel);
        el.addEventListener(`click`, state.click, true);
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
        el.removeEventListener(`click`, state.click, true);
        el.removeEventListener(`contextmenu`, state.contextmenu);
        states.delete(el);
    },
};
