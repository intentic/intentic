import { type ComponentPublicInstance, computed, type ComputedRef, ref, type Ref } from "vue";
import type { TouchPhase } from "../../models/browsers/liveInput";
import type { BrowserView } from "./useBrowserView";

// The live browser's stage as an input surface (LiveBrowser.vue binds `listeners` on it, LiveStageInput.vue draws the
// rest): the hidden field that holds the keyboard whenever the stage has focus, where that field sits, a finger on the
// picture, a phone's on-screen keyboard, and trackpad mode's cursor. What each event means for the page is the view's
// (useBrowserView, liveInput.ts); this is only where it happens.

export interface StageInputOptions {
    readonly view: BrowserView;
    readonly stage: Ref<HTMLElement | null>;
    // What pointer coordinates are measured against: the canvas or img painting the picture.
    readonly picture: ComputedRef<HTMLElement | undefined>;
    // Whether the person drives the window; a touch while only watching is a tap that says why nothing happened.
    readonly interactive: ComputedRef<boolean>;
    readonly onWatchTap: (event: MouseEvent) => void;
}

// A control drawn over the picture (a drop-down's menu, the touch buttons) keeps its own clicks, focus and fingers.
const pickedControl = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest(`button, input, select, a, [role="listbox"]`) !== null;

// What a template's function ref is handed.
type RefTarget = Element | ComponentPublicInstance | null;

// The stage's own events: focus passing on to the field, the keyboard leaving the picture, and a finger.
const stageListeners = (
    view: BrowserView,
    stage: Ref<HTMLElement | null>,
    focusSink: () => void,
    touch: (phase: TouchPhase, event: PointerEvent) => void,
) => ({
    // Focus reaching the stage itself (a click, Tab, the pane putting it there) goes on to the field.
    focus: (event: FocusEvent): void => {
        if (event.target === event.currentTarget) {
            focusSink();
        }
    },
    // The keyboard left the picture for the chrome or another window: nothing held stays down on the page.
    focusout: (event: FocusEvent): void => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && stage.value?.contains(next) === true)) {
            view.releaseInput();
        }
    },
    pointerdown: (event: PointerEvent): void => touch(`down`, event),
    pointermove: (event: PointerEvent): void => touch(`move`, event),
    pointerup: (event: PointerEvent): void => touch(`up`, event),
    pointercancel: (event: PointerEvent): void => touch(`cancel`, event),
    // A finger on the picture is a gesture and nothing else: no focus moving, no mouse events made up from it, no click.
    touchstart: (event: TouchEvent): void => {
        if (!pickedControl(event.target)) {
            event.preventDefault();
        }
    },
});

export const useStageInput = (options: StageInputOptions) => {
    const { view, stage } = options;
    const sinkEl = ref<HTMLTextAreaElement | null>(null);
    // The box a pinch magnifies (viewZoom.ts).
    const zoomEl = ref<HTMLElement | null>(null);
    // Where the field sits: at the last press, so an input method's candidate window opens beside what was clicked,
    // where the page's caret most likely is.
    const sinkAt = ref({ left: `0px`, top: `0px` });
    // Whether a finger has touched the picture (a phone or a tablet), and whether its on-screen keyboard was asked for:
    // a tap alone keeps it closed, so the picture is not half covered on every click.
    const touchSeen = ref(false);
    const softKeyboard = ref(false);

    const focusSink = (): void => sinkEl.value?.focus({ preventScroll: true });
    const placeSink = (event: { readonly clientX: number; readonly clientY: number }): void => {
        const rect = stage.value?.getBoundingClientRect();
        if (rect !== undefined) {
            sinkAt.value = { left: `${event.clientX - rect.left}px`, top: `${event.clientY - rect.top}px` };
        }
    };

    const touch = (phase: TouchPhase, event: PointerEvent): void => {
        const picture = options.picture.value;
        if (event.pointerType !== `touch` || picture === undefined || zoomEl.value === null || pickedControl(event.target)) {
            return;
        }
        if (phase === `down`) {
            touchSeen.value = true;
            placeSink(event);
            focusSink();
            if (!options.interactive.value) {
                options.onWatchTap(event);
            }
        }
        view.onTouch(phase, event, picture, zoomEl.value);
    };

    return {
        sinkEl,
        zoomEl,
        sinkAt,
        touchSeen,
        softKeyboard,
        // Template refs set from a function, since the field lives in another component.
        bindSink: (element: RefTarget): void => {
            sinkEl.value = element instanceof HTMLTextAreaElement ? element : null;
        },
        bindZoom: (element: RefTarget): void => {
            zoomEl.value = element instanceof HTMLElement ? element : null;
        },
        // A mouse press on the picture: the keyboard stays in the field rather than passing through the stage on every
        // click, which would end an input method's composition, and the field moves beside the click.
        press: (event: MouseEvent): void => {
            if (!pickedControl(event.target)) {
                event.preventDefault();
                placeSink(event);
                focusSink();
            }
        },
        toggleKeyboard: (): void => {
            softKeyboard.value = !softKeyboard.value;
            if (softKeyboard.value) {
                focusSink();
            } else {
                sinkEl.value?.blur();
            }
        },
        // Trackpad mode's cursor, where the stage draws it.
        trackpadDot: computed(() => {
            const at = view.trackpadCursor.value;
            const rect = stage.value?.getBoundingClientRect();
            return at === undefined || rect === undefined ? undefined : { left: `${at.x - rect.left}px`, top: `${at.y - rect.top}px` };
        }),
        listeners: stageListeners(view, stage, focusSink, touch),
    };
};

export type StageInput = ReturnType<typeof useStageInput>;
