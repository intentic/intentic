import { viewportCoords } from "../browsers/viewportCoords";

// What the owner's hands become on /system/desktop-view (the daemon's desktop-view.ts reads these): pointer events in
// the picture's own pixels, keystrokes by their DOM names, and typed characters as text. Pure, so the view's socket
// code only decides WHETHER to send, never what.

export type DesktopPointerAction = `move` | `down` | `up`;

export interface DesktopMouse {
    readonly type: `mouse`;
    readonly action: DesktopPointerAction | `wheel`;
    readonly x: number;
    readonly y: number;
    // Which button changed, in DOM numbering (the daemon's xButton turns it into X's). Omitted on a move or a wheel.
    readonly button?: number;
    readonly deltaX?: number;
    readonly deltaY?: number;
}

// No `meta`: the desktop is Linux, so a Mac's Cmd travels as ctrl, as keyIntent does for the browser view. A flag is
// present only when held, so the common keystroke stays two fields; built field by field, hence the writable draft.
interface KeyDraft {
    type: `key`;
    key: string;
    ctrl?: true;
    alt?: true;
    shift?: true;
}
export type DesktopKey = Readonly<KeyDraft>;

export interface DesktopText {
    readonly type: `text`;
    readonly text: string;
}

// A press or a release carries its button; nothing carries a click count. X counts clicks by their timing, and the
// daemon replays `clickCount: n` as n presses, so passing on the DOM's running count would turn every double click
// into a triple.
export const pointerMessage = (
    action: DesktopPointerAction,
    event: MouseEvent,
    element: HTMLElement,
    width: number,
    height: number,
): DesktopMouse | undefined => {
    const at = viewportCoords(event, element, width, height);
    if (at === undefined) {
        return undefined;
    }
    return action === `move` ? { type: `mouse`, action, ...at } : { type: `mouse`, action, ...at, button: event.button };
};

// One wheel notch, in pixels, as the daemon divides a delta by it (xinput.ts WHEEL_STEP).
export const WHEEL_NOTCH = 53;
// A line is a third of a notch (Firefox scrolls three per notch); a page is the desktop's height.
const LINE_PX = WHEEL_NOTCH / 3;
const PAGE_PX = 800;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

// The daemon rounds each wheel event to whole notches and drops the rest, so a trackpad's stream of 2 px deltas would
// scroll nothing. This keeps the remainder here and hands back whole notches once there are any.
export const wheelGauge = (): ((event: WheelEvent) => { readonly deltaX: number; readonly deltaY: number } | undefined) => {
    let restX = 0;
    let restY = 0;
    return (event) => {
        const unit = event.deltaMode === DOM_DELTA_LINE ? LINE_PX : event.deltaMode === DOM_DELTA_PAGE ? PAGE_PX : 1;
        restX += event.deltaX * unit;
        restY += event.deltaY * unit;
        const notchesX = Math.trunc(restX / WHEEL_NOTCH);
        const notchesY = Math.trunc(restY / WHEEL_NOTCH);
        if (notchesX === 0 && notchesY === 0) {
            return undefined;
        }
        restX -= notchesX * WHEEL_NOTCH;
        restY -= notchesY * WHEEL_NOTCH;
        // `+ 0` turns the -0 a zero truncation of a negative rest leaves into 0.
        return { deltaX: notchesX * WHEEL_NOTCH + 0, deltaY: notchesY * WHEEL_NOTCH + 0 };
    };
};

// Pressed alone they say nothing; they travel as flags on the key they modify.
const MODIFIERS = new Set([`Shift`, `Control`, `Alt`, `Meta`, `AltGraph`, `CapsLock`, `NumLock`, `ScrollLock`, `Fn`, `FnLock`, `Hyper`, `Super`, `OS`]);
// Half of a character the keyboard is still composing; the finished character arrives as its own keydown.
const UNFINISHED = new Set([`Dead`, `Process`, `Unidentified`, `Compose`]);

// Which keystrokes go to the desktop, and as what. Undefined leaves the keystroke with the host: a bare modifier, a
// character mid-composition, and paste, whose host `paste` event carries the owner's own clipboard rather than the
// sandbox's. Everything else goes, since the desktop has no chrome of ours to steer: Escape, Tab, F-keys and every
// chord a desktop app answers (Ctrl+C in a terminal is an interrupt, not a copy).
export const keyMessage = (event: KeyboardEvent): DesktopKey | DesktopText | undefined => {
    if (event.isComposing || MODIFIERS.has(event.key) || UNFINISHED.has(event.key)) {
        return undefined;
    }
    const primary = event.ctrlKey || event.metaKey;
    const character = [...event.key].length === 1;
    // AltGr arrives as Ctrl+Alt on Windows, but the character it made is already the key: type it, never chord it.
    const altGraph = event.getModifierState(`AltGraph`);
    // Space is the one character sent as a key, so a focused button or checkbox answers it.
    if (character && event.key !== ` ` && (altGraph || (!primary && !event.altKey))) {
        return { type: `text`, text: event.key };
    }
    if (primary && !event.altKey && event.key.toLowerCase() === `v`) {
        return undefined;
    }
    // Lower case: Shift travels as a flag, so Ctrl+Shift+Z is the chord ctrl+shift+z rather than a capital Z.
    const chord: KeyDraft = { type: `key`, key: character ? event.key.toLowerCase() : event.key };
    if (primary) {
        chord.ctrl = true;
    }
    if (event.altKey) {
        chord.alt = true;
    }
    if (event.shiftKey) {
        chord.shift = true;
    }
    return chord;
};
