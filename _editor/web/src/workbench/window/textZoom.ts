import { isApplePlatform, primaryHeld } from "@intentic/ui/keys";
import { useTextSize } from "@intentic/ui/text-size";
import { desktopApp } from "../../app/environments/desktop";
import { localFace, sandboxFace } from "../../app/environments/local";

// CTRL+PLUS, CTRL+MINUS, CTRL+0 AND CTRL+WHEEL IN THE DESKTOP APP'S WINDOWS step the reader's text size (useTextSize.ts),
// the way a browser's zoom keys do in a tab. Not the webview's own zoom: the app leaves Tauri's `zoomHotkeysEnabled` off,
// so WebView2 answers none of these keys and WebKitGTK has none, and the page takes them. A page zoom would scale the
// chrome the app holds steady (railFrame.ts), shift every CSS pixel the window measures for its native size
// (fitWindow.ts), the pointer maths of the live views and uiScale.ts, and be kept per webview rather than as the reader's
// preference across the frame's faces, its floating panels and the account. A browser tab is left alone: its own zoom
// already answers these keys there.

/** Which way a keystroke zooms: a rung up, a rung down, back to the default, or not a zoom key at all. */
export type ZoomStep = -1 | 0 | 1;

// The primary modifier alone (Ctrl, ⌘ on a Mac), Shift allowed since "+" is a shifted "=" on many layouts. Alt is
// refused, which also keeps AltGr (Ctrl+Alt on Windows) typing its characters.
const zoomHeld = (event: KeyboardEvent | WheelEvent, isMac: boolean): boolean => !event.altKey && primaryHeld(event, isMac);

const BY_KEY: ReadonlyMap<string, ZoomStep> = new Map([
    [`+`, 1],
    [`=`, 1],
    [`-`, -1],
    [`_`, -1],
    [`0`, 0],
]);
// A key that typed no character (a dead key, an IME's "Process", "Unidentified") is read by the US key under the finger.
// One that typed another character is that character's: a German "ß" sits where US has "-" and zooms nothing.
const BY_CODE: ReadonlyMap<string, ZoomStep> = new Map([
    [`Equal`, 1],
    [`NumpadAdd`, 1],
    [`Minus`, -1],
    [`NumpadSubtract`, -1],
    [`Digit0`, 0],
    [`Numpad0`, 0],
]);

/** The zoom a keydown asks for, by the character it types (the "+" key of a German layout too), else by its place. */
export const zoomStepOf = (event: KeyboardEvent, isMac: boolean): ZoomStep | undefined => {
    if (!zoomHeld(event, isMac)) {
        return undefined;
    }
    const typed = BY_KEY.get(event.key);
    if (typed !== undefined) {
        return typed;
    }
    return [...event.key].length === 1 ? undefined : BY_CODE.get(event.code);
};

// One rung per mouse notch (Chromium reports 100 px, WebKitGTK about half), and per that much of a touchpad's scroll;
// a pause or a turn of direction starts the count again, so a fling does not run the ladder to its end.
const WHEEL_STEP_PX = 50;
const WHEEL_PAUSE_MS = 250;
const LINE_PX = 16;

const wheelPixels = (event: WheelEvent): number =>
    event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * LINE_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * window.innerHeight : event.deltaY;

/** Counts wheel movement into rungs: hands back the step a movement completes, if any. Wheel down zooms out. */
export const wheelCounter = (): ((pixels: number, at: number) => ZoomStep | undefined) => {
    let total = 0;
    let last = Number.NEGATIVE_INFINITY;
    return (pixels, at) => {
        if (at - last > WHEEL_PAUSE_MS || Math.sign(pixels) !== Math.sign(total)) {
            total = 0;
        }
        last = at;
        total += pixels;
        if (Math.abs(total) < WHEEL_STEP_PX) {
            return undefined;
        }
        const step: ZoomStep = total > 0 ? -1 : 1;
        total = 0;
        return step;
    };
};

/** Whether this window is one of the desktop app's: the workspace face and its floating panels, a folder's, the sandbox face. */
export const inDesktopWindow = (): boolean => desktopApp() !== undefined || localFace() !== undefined || sandboxFace();

/** Installs the zoom keys and Ctrl+wheel in this window, if it is the desktop app's. Once per window, from main.ts. */
export const installTextZoom = (): void => {
    if (!inDesktopWindow()) {
        return;
    }
    const isMac = isApplePlatform();
    const { stepTextSize } = useTextSize();
    const modifier = isMac ? `Meta` : `Control`;

    // Capture, ahead of whatever holds focus: the terminal would otherwise send Ctrl+- to its shell as ^_, as a browser
    // tab's zoom also takes it from there.
    window.addEventListener(
        `keydown`,
        (event) => {
            const step = zoomStepOf(event, isMac);
            if (step === undefined) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            stepTextSize(step);
        },
        { capture: true },
    );

    // A wheel listener that may cancel makes the compositor wait on this thread before every scroll starts, so it is
    // held only while the modifier is down. On the bubble, after the page: a surface that zooms its own content on
    // Ctrl+wheel (ImageView) cancels the event and keeps it.
    const count = wheelCounter();
    let armed = false;
    const onWheel = (event: WheelEvent): void => {
        if (!zoomHeld(event, isMac)) {
            disarm();
            return;
        }
        if (event.defaultPrevented) {
            return;
        }
        event.preventDefault();
        const step = count(wheelPixels(event), event.timeStamp);
        if (step !== undefined) {
            stepTextSize(step);
        }
    };
    const arm = (): void => {
        if (!armed) {
            armed = true;
            window.addEventListener(`wheel`, onWheel, { passive: false });
        }
    };
    function disarm(): void {
        if (armed) {
            armed = false;
            window.removeEventListener(`wheel`, onWheel);
        }
    }
    window.addEventListener(`keydown`, (event) => event.key === modifier && arm(), { capture: true });
    window.addEventListener(`keyup`, (event) => event.key === modifier && disarm(), { capture: true });
    window.addEventListener(`blur`, disarm);
};
