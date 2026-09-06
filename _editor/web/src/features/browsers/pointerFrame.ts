import { viewportCoords } from "./viewportCoords";

/* WHAT A POINTER EVENT HAS TO SAY TO BE ONE, the rule both screencast surfaces follow: the agent's browser view
 * (useBrowserView) and a connected account's own profile window (BrowserProfileDialog). One module for the same
 * reason viewportCoords and keyIntent are: each surface built its own and they drifted.
 *
 * A frame used to carry a position and, on a press, which button it was. That describes a CLICK and nothing else,
 * and it is why taking the wheel felt like operating the page through a letterbox:
 *
 *   - NO DRAG. Chromium decides a move is part of a drag from `buttons`, the bitmask of what is currently HELD,
 *     not from whatever the last press said. With it absent every move arrived as `buttons: 0`, which is a hover.
 *     Press-move-release therefore selected no text, moved no slider, dragged no file and drew on no canvas: the
 *     button may as well not have been down. Read off the DOM event rather than tracked across frames, because a
 *     lost `up` (the pointer leaving the picture, a socket blink) would stick a phantom button down forever.
 *   - NO DOUBLE-CLICK. `detail` is the browser's own count, and it is how double-click-to-select-a-word and
 *     triple-click-to-select-a-line reach a page. Sending 1 every time made them two and three single clicks.
 *   - NO MODIFIERS. Ctrl+click to open in a new tab, Shift+click to extend a selection, Ctrl+wheel to zoom.
 *
 * ⌘ TRAVELS AS CTRL, the same translation keyIntent makes and for the same reason: the Chromium at the far end is
 * a Linux one, where Meta means nothing, and ⌘+click is the gesture a Mac user makes for what Linux spells
 * Ctrl+click. A Mac's literal Ctrl+click (its context menu) therefore arrives as Ctrl too, which is the one
 * gesture this flattens; right-click is right there and does reach the page as a right-click. */

export type PointerAction = `move` | `down` | `up` | `wheel`;

export interface PointerFrame {
    readonly type: `mouse`;
    readonly action: PointerAction;
    readonly x: number;
    readonly y: number;
    // Which button changed, in DOM numbering. Omitted on a move, which changed none.
    readonly button?: number;
    // Which buttons are HELD. Always sent, including on a move: this is what makes a drag a drag.
    readonly buttons: number;
    readonly clickCount?: number;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
    readonly deltaX?: number;
    readonly deltaY?: number;
}

// Set only when true, so a frame stays as small as the common case deserves (no modifier is the common case).
const flag = (on: boolean): { readonly ctrl?: true } => (on ? { ctrl: true } : {});

export const pointerFrame = (
    action: PointerAction,
    event: MouseEvent,
    element: HTMLElement,
    viewWidth: number,
    viewHeight: number,
): PointerFrame => {
    const wheel = action === `wheel`;
    return {
        type: `mouse`,
        action,
        ...viewportCoords(event, element, viewWidth, viewHeight),
        buttons: event.buttons,
        // A move and a wheel change no button; naming one there makes Chromium read the event as a button event.
        ...(action === `move` || wheel ? {} : { button: event.button }),
        // `detail` is 0 on a move and on a wheel, and 1/2/3 on the presses that matter.
        ...(event.detail > 0 ? { clickCount: event.detail } : {}),
        ...flag(event.ctrlKey || event.metaKey),
        ...(event.shiftKey ? { shift: true } : {}),
        ...(event.altKey ? { alt: true } : {}),
        ...(wheel && event instanceof WheelEvent ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}),
    };
};
