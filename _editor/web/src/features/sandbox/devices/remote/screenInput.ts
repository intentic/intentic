import { computed, type ComponentPublicInstance, onScopeDispose, ref, type Ref } from "vue";
import { mediaInput } from "../../../../models/browsers/inputWire";
import { type LiveInput, liveInput } from "../../../../models/browsers/liveInput";
import { mediaScroll } from "../../../../models/browsers/media/mediaHands";
import type { MediaPicture } from "../../../../models/browsers/media/mediaPicture";
import { type RemoteKey, type RemoteKeys, remoteKeys } from "./remoteKeys";
import { type PointerAction, remotePointer } from "./remotePointer";

// THE REMOTE SCREEN'S STAGE AS AN INPUT SURFACE (DeviceScreen.vue binds these). A mouse goes as the computer's mouse
// (remotePointer.ts), a key as its physical key (remoteKeys.ts); what only this browser can supply arrives through a
// hidden field that holds the keyboard while the stage has it: an input method's text, a phone's on-screen keyboard, and
// a paste, which carries this computer's clipboard to the far one first (inputSink.ts, through liveInput.ts, which also
// turns a finger into a mouse, a trackpad, a scroll or a pinch that magnifies the view here). Nothing is sent unless
// the person is driving; when the stage loses the keyboard, every key held over there is let go.

export interface ScreenInputOptions {
    readonly picture: MediaPicture;
    readonly driving: Ref<boolean>;
    readonly stage: Ref<HTMLElement | null>;
    // What pointer coordinates are measured against: the canvas painting the picture.
    readonly canvas: Ref<HTMLCanvasElement | null>;
    // The box a pinch magnifies.
    readonly zoomBox: Ref<HTMLElement | null>;
    readonly isMac: boolean;
}

interface Size {
    readonly width: number;
    readonly height: number;
}

// A control drawn over the picture keeps its own clicks, focus and fingers.
const pickedControl = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest(`button, input, select, a, [role="listbox"]`) !== null;

// The hidden field the keyboard lives in, where it sits (beside the last press, so an input method's candidates open
// there), and whether a phone's on-screen keyboard was asked for: a tap alone keeps it closed.
const screenSink = (stage: Ref<HTMLElement | null>) => {
    const sinkEl = ref<HTMLTextAreaElement | null>(null);
    const sinkAt = ref({ left: `0px`, top: `0px` });
    const touchSeen = ref(false);
    const softKeyboard = ref(false);
    const focus = (): void => sinkEl.value?.focus({ preventScroll: true });
    return {
        sinkEl,
        sinkAt,
        touchSeen,
        softKeyboard,
        focus,
        place: (event: { readonly clientX: number; readonly clientY: number }): void => {
            const rect = stage.value?.getBoundingClientRect();
            if (rect !== undefined) {
                sinkAt.value = { left: `${event.clientX - rect.left}px`, top: `${event.clientY - rect.top}px` };
            }
        },
        bindSink: (element: Element | ComponentPublicInstance | null): void => {
            sinkEl.value = element instanceof HTMLTextAreaElement ? element : null;
        },
        toggleKeyboard: (): void => {
            softKeyboard.value = !softKeyboard.value;
            if (softKeyboard.value) {
                focus();
            } else {
                sinkEl.value?.blur();
            }
        },
    };
};

// The hidden field's events: raw keys first, and what the browser types itself (an input method, a phone's keyboard, a
// paste) after them.
const sinkListeners = (keys: RemoteKeys, input: LiveInput, driving: Ref<boolean>) => ({
    keydown: (event: KeyboardEvent): void => {
        if (driving.value) {
            keys.keydown(event);
        }
    },
    keyup: (event: KeyboardEvent): void => {
        if (driving.value) {
            keys.keyup(event);
        }
    },
    beforeinput: input.onBeforeInput,
    input: input.onInput,
    compositionend: input.onCompositionEnd,
    paste: (event: ClipboardEvent): void => {
        keys.pasted();
        input.onPaste(event);
    },
});

// The stage's own events: a pointer, the wheel, a finger that must not become a click, and the keyboard leaving.
const stageListeners = (on: {
    readonly mouse: (action: PointerAction, event: PointerEvent) => void;
    readonly wheel: (event: WheelEvent) => void;
    readonly letGo: () => void;
    readonly stage: Ref<HTMLElement | null>;
}) => ({
    pointerdown: (event: PointerEvent): void => on.mouse(`down`, event),
    pointermove: (event: PointerEvent): void => on.mouse(`move`, event),
    pointerup: (event: PointerEvent): void => on.mouse(`up`, event),
    pointercancel: (event: PointerEvent): void => on.mouse(`up`, event),
    wheel: on.wheel,
    // A finger on the picture is a gesture and nothing else: no focus moving, no mouse made up from it.
    touchstart: (event: TouchEvent): void => {
        if (!pickedControl(event.target)) {
            event.preventDefault();
        }
    },
    contextmenu: (event: Event): void => event.preventDefault(),
    focusout: (event: FocusEvent): void => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && on.stage.value?.contains(next) === true)) {
            on.letGo();
        }
    },
});

export const useScreenInput = (options: ScreenInputOptions) => {
    const { picture, driving, stage, canvas } = options;
    const sink = screenSink(stage);
    // The picture's own pixels, which every point and distance sent is measured in: what the computer said it sends.
    const size = (): Size => ({ width: picture.hello.value?.width ?? 0, height: picture.hello.value?.height ?? 0 });
    const send = (message: Parameters<MediaPicture[`send`]>[0]): void => {
        if (driving.value) {
            picture.send(message);
        }
    };
    const keys = remoteKeys({ send, isMac: options.isMac });
    const pointer = remotePointer();
    // Where the kept cursor is while the pointer is locked, in picture pixels: drawn, since this computer's is hidden.
    const lockedCursor = ref<{ readonly x: number; readonly y: number } | undefined>();
    let locked = false;
    const input = liveInput({ port: mediaInput(send), driving, size, isMac: options.isMac, onPress: () => picture.gesture() });

    // A press is a gesture (a copy made over there is written here, and its sound may start) and puts the keyboard in
    // the field beside it; a finger goes to the gesture machine, a mouse straight to the computer.
    const mouse = (action: PointerAction, event: PointerEvent): void => {
        const element = canvas.value;
        if (element === null || pickedControl(event.target)) {
            return;
        }
        if (action === `down`) {
            picture.gesture();
            sink.place(event);
            sink.focus();
        }
        if (event.pointerType === `touch`) {
            sink.touchSeen.value ||= action === `down`;
            if (options.zoomBox.value !== null) {
                input.onTouch(action, event, element, options.zoomBox.value);
            }
            return;
        }
        if (action === `down`) {
            event.preventDefault();
            stage.value?.setPointerCapture(event.pointerId);
        }
        const message = pointer.at(action, event, element, size());
        if (message !== undefined) {
            lockedCursor.value = locked ? { x: message.x, y: message.y } : undefined;
            send(message);
        }
    };

    const wheel = (event: WheelEvent): void => {
        const message = canvas.value === null || !driving.value ? undefined : mediaScroll(event, canvas.value, size().width, size().height);
        if (message !== undefined) {
            event.preventDefault();
            send(message);
        }
    };

    // The keyboard left the picture for the toolbar or another window: nothing stays held down over there.
    const letGo = (): void => {
        if (driving.value) {
            keys.releaseAll();
        }
    };
    window.addEventListener(`blur`, letGo);
    onScopeDispose(() => window.removeEventListener(`blur`, letGo));

    return {
        ...sink,
        trackpad: input.trackpad,
        setTrackpad: input.setTrackpad,
        zoom: input.zoom,
        trackpadDot: computed(() => {
            const at = input.trackpadCursor.value;
            const rect = stage.value?.getBoundingClientRect();
            return at === undefined || rect === undefined ? undefined : { left: `${at.x - rect.left}px`, top: `${at.y - rect.top}px` };
        }),
        // The pointer locked to the picture (fullscreenLock.ts) or not, and its kept cursor, drawn while locked.
        lockPointer: (on: boolean): void => {
            locked = on;
            pointer.locked(on);
            lockedCursor.value = on ? pointer.cursor() : undefined;
        },
        lockedCursor,
        sendChord: (chord: readonly RemoteKey[]): void => {
            if (driving.value) {
                keys.press(chord);
            }
        },
        releaseAll: letGo,
        stageListeners: stageListeners({ mouse, wheel, letGo, stage }),
        sinkListeners: sinkListeners(keys, input, driving),
    };
};
