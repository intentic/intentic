import { ref, type Ref } from "vue";
import { inputSink, pngOfImage, type PasteEvent } from "./inputSink";
import type { InputMessage, InputPort, MouseMessage } from "./inputWire";
import type { BrowserCommand } from "./keyIntent";
import { touchGestures, type Point } from "./touchGestures";
import { pictureScale, viewportCoords } from "./viewportCoords";
import { restingBox, viewZoom, zoomStyle } from "./viewZoom";
import { wheelCoalescer, wheelPixels, type ScrollStep } from "./wheelSteps";

// ONE LIVE BROWSER'S INPUT, END TO END: the keyboard's hidden field (inputSink.ts), the wheel and trackpad
// (wheelSteps.ts), a finger (touchGestures.ts) and a pinch (viewZoom.ts), all turned into the media vocabulary and
// handed to one port (inputWire.ts), which says it on whichever socket the picture rides. Nothing is sent unless the
// person is driving; a pinch, which only magnifies the view here, works while watching too.

export interface LiveInputOptions {
    readonly port: InputPort;
    readonly driving: Ref<boolean>;
    // The picture's size in its own pixels, which every point and distance sent is measured in.
    readonly size: () => { readonly width: number; readonly height: number };
    // A press of a pointer button or a finger, before it is sent: the page has the keyboard again after one.
    readonly onPress?: () => void;
    readonly isMac?: boolean | undefined;
}

// Which phase of a touch the stage saw.
export type TouchPhase = `down` | `move` | `up` | `cancel`;

export interface LiveInput {
    // A pointer event the screencast built (pointerFrame.ts); a wheel goes by `onWheel` instead.
    readonly pointer: (message: MouseMessage) => void;
    readonly onKeyDown: (event: KeyboardEvent, onCommand?: (command: BrowserCommand) => void) => void;
    readonly onBeforeInput: (event: InputEvent) => void;
    readonly onInput: (event: Event) => void;
    readonly onCompositionEnd: (event: CompositionEvent) => void;
    readonly onPaste: (event: PasteEvent) => void;
    readonly onWheel: (event: WheelEvent, picture: HTMLElement) => void;
    // A touch on the stage: `picture` is what points are measured against, `surface` the box a pinch transforms.
    readonly onTouch: (phase: TouchPhase, event: PointerEvent, picture: HTMLElement, surface: HTMLElement) => void;
    // The picture lost the keyboard (focus went to the chrome, or away from the window): nothing stays held down.
    readonly release: () => void;
    // The pinch's transform for the surface; undefined at rest.
    readonly zoom: Ref<{ transform: string; transformOrigin: string } | undefined>;
    readonly trackpad: Ref<boolean>;
    readonly setTrackpad: (on: boolean) => void;
    // Trackpad mode's cursor, in client pixels, for the stage to draw; undefined outside the mode.
    readonly trackpadCursor: Ref<Point | undefined>;
    // Another browser: no zoom, no scroll waiting to go, no gesture under way.
    readonly reset: () => void;
}

// The modifier keys a scroll can carry, as the keys that hold them down: Ctrl turns a wheel into zoom on the page and
// Shift turns it sideways, so they are put down around the scroll as a person's hand would.
const SCROLL_MODIFIERS = [
    { flag: `ctrl`, key: `Control`, code: `ControlLeft` },
    { flag: `shift`, key: `Shift`, code: `ShiftLeft` },
    { flag: `alt`, key: `Alt`, code: `AltLeft` },
] as const;

const scrollMessages = (step: ScrollStep): InputMessage[] => {
    const held = SCROLL_MODIFIERS.filter((modifier) => step[modifier.flag] === true);
    return [
        ...held.map((modifier): InputMessage => ({ type: `key`, key: modifier.key, code: modifier.code, action: `down` })),
        { type: `scroll`, x: step.x, y: step.y, dx: step.dx, dy: step.dy },
        ...held.map((modifier): InputMessage => ({ type: `key`, key: modifier.key, code: modifier.code, action: `up` })),
    ];
};

// The gesture machine over this view's picture: its points become pointer messages, its scrolls go through the wheel's
// frame, and its pinch drives the zoom.
const touchesOver = (
    options: LiveInputOptions,
    emit: (message: InputMessage) => void,
    scroll: (at: Point, dx: number, dy: number, picture: HTMLElement) => void,
    zoom: ReturnType<typeof viewZoom>,
    trackpadCursor: Ref<Point | undefined>,
) => {
    let target: { picture: HTMLElement; surface: HTMLElement } | undefined;
    const gestures = touchGestures({
        pointer: (action, at, button, buttons, clickCount) => {
            const picture = target?.picture;
            const point =
                picture === undefined
                    ? undefined
                    : viewportCoords({ clientX: at.x, clientY: at.y }, picture, options.size().width, options.size().height);
            if (point === undefined) {
                return;
            }
            const message: MouseMessage = { type: `mouse`, action, ...point, buttons };
            if (action !== `move`) {
                message.button = button;
                options.onPress?.();
            }
            if (clickCount > 0) {
                message.clickCount = clickCount;
            }
            emit(message);
        },
        scroll: (dx, dy, at) => {
            if (target !== undefined) {
                scroll(at, dx, dy, target.picture);
            }
        },
        zoom: {
            begin: (x, y, spread) => {
                if (target !== undefined) {
                    zoom.begin(x, y, spread, restingBox(target.surface.getBoundingClientRect(), zoom.state()));
                }
            },
            pinch: zoom.pinch,
            pan: zoom.pan,
        },
        // The picture as far as it is on screen: magnified, it runs past the box that clips it, and a cursor out there
        // would be one nobody can see.
        bounds: () => {
            const picture = target?.picture.getBoundingClientRect();
            const clip = target?.surface.parentElement?.getBoundingClientRect() ?? picture;
            return picture === undefined || clip === undefined
                ? undefined
                : {
                      left: Math.max(picture.left, clip.left),
                      top: Math.max(picture.top, clip.top),
                      right: Math.min(picture.right, clip.right),
                      bottom: Math.min(picture.bottom, clip.bottom),
                  };
        },
        cursor: (at) => (trackpadCursor.value = at),
        now: () => performance.now(),
        later: (run, ms) => {
            const timer = window.setTimeout(run, ms);
            return () => window.clearTimeout(timer);
        },
        buzz: () => navigator.vibrate?.(10),
    });
    return {
        gestures,
        on: (phase: TouchPhase, event: PointerEvent, picture: HTMLElement, surface: HTMLElement): void => {
            target = { picture, surface };
            gestures[phase](event);
        },
    };
};

export const liveInput = (options: LiveInputOptions): LiveInput => {
    const { port, driving } = options;
    const emit = (message: InputMessage): void => {
        if (driving.value) {
            port.send(message);
        }
    };
    const sink = inputSink({ send: emit, pngOf: pngOfImage, isMac: options.isMac });
    const wheel = wheelCoalescer((step) => scrollMessages(step).forEach(emit));
    // A distance on screen, at a point on screen, as the page's own: the picture's pixels.
    const scrollAt = (at: Point, dx: number, dy: number, picture: HTMLElement, modifiers: Partial<ScrollStep> = {}): void => {
        const { width, height } = options.size();
        const scale = pictureScale(picture, width, height);
        const point = viewportCoords({ clientX: at.x, clientY: at.y }, picture, width, height);
        if (scale !== undefined && point !== undefined) {
            wheel.add({ ...modifiers, ...point, dx: dx / scale, dy: dy / scale });
        }
    };
    const zoom = ref<{ transform: string; transformOrigin: string } | undefined>();
    const zoomer = viewZoom((state) => (zoom.value = zoomStyle(state)));
    const trackpad = ref(false);
    const trackpadCursor = ref<Point | undefined>();
    const touches = touchesOver(options, emit, scrollAt, zoomer, trackpadCursor);

    // Only while driving: the field's keys belong to the host otherwise.
    const whileDriving =
        <Event>(handle: (event: Event) => void) =>
        (event: Event): void => {
            if (driving.value) {
                handle(event);
            }
        };

    return {
        pointer: emit,
        onKeyDown: (event, onCommand) => {
            if (driving.value) {
                sink.keydown(event, onCommand);
            }
        },
        onBeforeInput: whileDriving(sink.beforeinput),
        // Always: the field is emptied whoever typed into it.
        onInput: sink.input,
        onCompositionEnd: whileDriving(sink.compositionend),
        onPaste: whileDriving(sink.paste),
        onWheel: (event, picture) => {
            if (!driving.value) {
                return;
            }
            event.preventDefault();
            const { dx, dy } = wheelPixels(event, picture.getBoundingClientRect().height);
            // allow(modifier-tiers): the page is Linux, where a Mac's ⌘-wheel and a PC's Ctrl-wheel are both its Ctrl-wheel.
            const ctrl = event.ctrlKey || event.metaKey;
            scrollAt({ x: event.clientX, y: event.clientY }, dx, dy, picture, { ctrl, shift: event.shiftKey, alt: event.altKey });
        },
        onTouch: (phase, event, picture, surface) => {
            if (event.pointerType !== `touch`) {
                return;
            }
            event.preventDefault();
            touches.on(phase, event, picture, surface);
        },
        release: () => {
            wheel.flush();
            emit({ type: `releaseAll` });
        },
        zoom,
        trackpad,
        setTrackpad: (on) => {
            trackpad.value = on;
            touches.gestures.setTrackpad(on);
        },
        trackpadCursor,
        reset: () => {
            wheel.cancel();
            zoomer.reset();
            touches.gestures.setTrackpad(trackpad.value);
        },
    };
};
