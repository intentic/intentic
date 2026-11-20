import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { isApplePlatform } from "@intentic/ui/keys";
import { pictureScale, viewportCoords } from "../viewportCoords";
import { wheelPixels } from "../wheelSteps";

// A PERSON'S HANDS IN CASTD'S VOCABULARY, straight from DOM events, for a live picture that does not run the browser
// view's whole input layer (liveInput.ts): the desktop (useDesktopView) and a connected account's sign-in window
// (BrowserProfileDialog). Pointer events in the picture's own pixels with the buttons held, scrolling in exact picture
// pixels (castd scrolls smoothly, no notches), keys by their DOM names with the layout already applied, which castd
// types on the display. Pure, so a caller only decides whether to send.

type MediaInput = Extract<BrowserMediaClientMessage, { type: `mouse` | `scroll` | `key` | `text` }>;

// Keys that only hold a modifier: castd puts a modifier down around the key it rides with (`ctrl`, `shift`, `alt`).
const MODIFIERS: ReadonlySet<string> = new Set([`Control`, `Shift`, `Alt`, `Meta`, `AltGraph`, `CapsLock`, `OS`]);

export const mediaPointer = (
    action: `move` | `down` | `up`,
    event: MouseEvent,
    picture: HTMLElement,
    width: number,
    height: number,
): MediaInput | undefined => {
    const at = viewportCoords(event, picture, width, height);
    if (at === undefined) {
        return undefined;
    }
    return action === `move`
        ? { type: `mouse`, action, ...at, buttons: event.buttons }
        : { type: `mouse`, action, ...at, button: event.button, buttons: event.buttons };
};

export const mediaScroll = (event: WheelEvent, picture: HTMLElement, width: number, height: number): MediaInput | undefined => {
    const at = viewportCoords(event, picture, width, height);
    const scale = pictureScale(picture, width, height);
    if (at === undefined || scale === undefined) {
        return undefined;
    }
    const { dx, dy } = wheelPixels(event, picture.getBoundingClientRect().height);
    return { type: `scroll`, ...at, dx: dx / scale, dy: dy / scale };
};

// No `meta`: the sandbox is Linux, so a Mac's Cmd travels as ctrl, as it does on the daemon's socket.
export const mediaKey = (event: KeyboardEvent, isMac: boolean = isApplePlatform()): MediaInput | undefined => {
    if (MODIFIERS.has(event.key) || event.isComposing) {
        return undefined;
    }
    const ctrl = event.ctrlKey || (isMac && event.metaKey);
    // Only flags that are held: castd reads a `false` as "let go of one left down", which no keystroke here means.
    return {
        type: `key`,
        key: event.key,
        code: event.code === `` ? undefined : event.code,
        ctrl: ctrl ? true : undefined,
        shift: event.shiftKey ? true : undefined,
        alt: event.altKey ? true : undefined,
    };
};
