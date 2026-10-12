import { computed, getCurrentScope, nextTick, onScopeDispose, readonly, ref, type Ref, type WritableComputedRef } from "vue";
import { inCorridor, type Point } from "../lib/pointerCorridor.js";
import { type HoverIntentOptions, useHoverIntent } from "./useHoverIntent.js";

// A MENU THE POINTER CAN OPEN AND A PRESS CAN KEEP. Resting on the trigger raises it after the hover clock's dwell, and
// leaving lets it go after its grace. On the way to the panel the pointer crosses whatever lies between, so leaving
// toward it keeps it up for as long as the pointer stays in the corridor (lib/pointerCorridor.ts). A press raises it
// at once and pins it: it stays up until something dismisses it, as a menu that was asked for does. A press on a menu
// the pointer already raised pins it rather than closing it, because that press was meant to open it, and so does a
// press inside the panel, whose answer (a failure said under its row) must not leave with the pointer. A second press
// on the trigger closes it.
//
// The keyboard opens it with Enter, Space or ArrowDown and lands on the current row. Arrows, Home and End move between
// rows. The rows are what the panel marks `data-menu-row`, and the current one is marked `data-current`.

const ROW = `[data-menu-row]`;

export interface HoverMenu {
    /** The overlay's v-model: up or not, however it got there. */
    readonly open: WritableComputedRef<boolean>;
    /** Whether a press raised the panel now up (or the one last up): it stays until dismissed, and closing hands focus back. */
    readonly pressed: Readonly<Ref<boolean>>;
    /** Whether a mouse pointer is over the trigger now, so a caller can start a read before the panel asks for it. */
    readonly hovering: Readonly<Ref<boolean>>;
    /** Bound on the trigger with `v-on`. */
    readonly trigger: {
        readonly pointerenter: (event: PointerEvent) => void;
        readonly pointerleave: (event: PointerEvent) => void;
        readonly click: (event: MouseEvent) => void;
        readonly keydown: (event: KeyboardEvent) => void;
    };
    /** Bound on the panel's own content with `v-on`. */
    readonly panel: {
        readonly pointerenter: (event: PointerEvent) => void;
        readonly pointerleave: (event: PointerEvent) => void;
        readonly pointerdown: (event: PointerEvent) => void;
        readonly keydown: (event: KeyboardEvent) => void;
    };
}

// A mouse, and not one dragging something across: a drag carried over the trigger is on its way somewhere else.
const isHover = (event: PointerEvent): boolean => event.pointerType === `mouse` && event.buttons === 0;

const rowsIn = (panel: HTMLElement | null | undefined): HTMLElement[] =>
    panel === null || panel === undefined ? [] : [...panel.querySelectorAll<HTMLElement>(ROW)].filter((row) => !row.matches(`:disabled`));

export const useHoverMenu = (panel: Ref<HTMLElement | null | undefined>, timing: HoverIntentOptions = { open: 150, close: 200, warm: 400 }): HoverMenu => {
    const hover = useHoverIntent(timing);
    const pressed = ref(false);
    const hovering = ref(false);

    // Where the pointer left the trigger, while a pointer heading for the panel is being waited for.
    let corridor: { readonly exit: Point; readonly doc: Document } | undefined;

    const onMove = (event: PointerEvent): void => {
        const rect = panel.value?.getBoundingClientRect();
        if (corridor === undefined || rect === undefined) {
            return;
        }
        if (inCorridor({ x: event.clientX, y: event.clientY }, corridor.exit, rect)) {
            // Still on its way: the grace starts again from here, so a slow hand is never cut off mid-route.
            hover.leave();
            return;
        }
        // Gone somewhere else: the grace already running is all it gets.
        stopCorridor();
    };
    const stopCorridor = (): void => {
        corridor?.doc.removeEventListener(`pointermove`, onMove, true);
        corridor = undefined;
    };
    const startCorridor = (event: PointerEvent): void => {
        stopCorridor();
        const doc = event.currentTarget instanceof Node ? event.currentTarget.ownerDocument : null;
        if (doc === null) {
            return;
        }
        corridor = { exit: { x: event.clientX, y: event.clientY }, doc };
        doc.addEventListener(`pointermove`, onMove, true);
    };

    const pinned = (): boolean => hover.shown.value && pressed.value;

    const close = (): void => {
        stopCorridor();
        hover.hide();
    };

    // The keyboard's way in: the current row if the panel marks one, else the first. Waits for the panel to exist, which
    // is only after the render that opened it.
    const focusRow = async (): Promise<void> => {
        await nextTick();
        const rows = rowsIn(panel.value);
        (rows.find((row) => row.hasAttribute(`data-current`)) ?? rows[0])?.focus({ preventScroll: true });
    };

    const press = (): void => {
        stopCorridor();
        pressed.value = true;
        hover.show();
    };

    const open = computed({
        get: () => hover.shown.value,
        set: (value: boolean) => (value ? press() : close()),
    });

    if (getCurrentScope() !== undefined) {
        onScopeDispose(stopCorridor);
    }

    return {
        open,
        pressed: readonly(pressed),
        hovering: readonly(hovering),
        trigger: {
            pointerenter: (event) => {
                if (!isHover(event)) {
                    return;
                }
                hovering.value = true;
                stopCorridor();
                if (hover.shown.value) {
                    // Back over the trigger with the panel up: whatever close was pending is off.
                    hover.cancel();
                    return;
                }
                hover.enter(() => {
                    pressed.value = false;
                });
            },
            pointerleave: (event) => {
                if (event.pointerType !== `mouse`) {
                    return;
                }
                hovering.value = false;
                if (!hover.shown.value) {
                    // Left before the dwell ran out: a pointer crossing, which raises nothing.
                    hover.cancel();
                    return;
                }
                if (pinned()) {
                    return;
                }
                startCorridor(event);
                hover.leave();
            },
            click: (event) => {
                if (pinned()) {
                    close();
                    return;
                }
                press();
                // A click with no pointer behind it is Enter or Space on the trigger.
                if (event.detail === 0) {
                    void focusRow();
                }
            },
            keydown: (event) => {
                if (event.key !== `ArrowDown`) {
                    return;
                }
                event.preventDefault();
                press();
                void focusRow();
            },
        },
        panel: {
            pointerenter: () => {
                stopCorridor();
                hover.cancel();
            },
            pointerleave: (event) => {
                if (event.pointerType !== `mouse` || pinned()) {
                    return;
                }
                hover.leave();
            },
            pointerdown: () => {
                pressed.value = true;
            },
            keydown: (event) => {
                const rows = rowsIn(panel.value);
                if (rows.length === 0) {
                    return;
                }
                // -1 off any row (a nested control, the panel itself), so ArrowDown lands on the first and ArrowUp on the last.
                const at = event.target instanceof HTMLElement ? rows.indexOf(event.target) : -1;
                const next =
                    event.key === `ArrowDown`
                        ? rows[(at + 1) % rows.length]
                        : event.key === `ArrowUp`
                          ? rows[at <= 0 ? rows.length - 1 : at - 1]
                          : event.key === `Home`
                            ? rows[0]
                            : event.key === `End`
                              ? rows.at(-1)
                              : undefined;
                if (next === undefined) {
                    return;
                }
                event.preventDefault();
                // Whatever the pointer raised, the keyboard is using now: it stays until dismissed.
                pressed.value = true;
                next.focus();
            },
        },
    };
};
