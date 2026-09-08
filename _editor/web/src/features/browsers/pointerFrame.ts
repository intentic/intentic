import { viewportCoords } from "./viewportCoords";

// What a pointer event needs to drive a real page (useBrowserView, BrowserProfileDialog), not just register a click.
// - buttons (bitmask of what's held, from the DOM event): without it, drag/select/slider gestures don't work,
//   since Chromium reads a drag off `buttons`, not the last press.
// - detail as clickCount: double/triple-click-to-select need the real count, not always 1.
// - modifiers: Ctrl+click, Shift+click, Ctrl+wheel.
// Cmd travels as ctrl, like keyIntent, since the far end is Linux; a Mac's literal Ctrl+click (context menu) also
// arrives as ctrl.

export type PointerAction = `move` | `down` | `up` | `wheel`;

export interface PointerFrame {
    readonly type: `mouse`;
    readonly action: PointerAction;
    readonly x: number;
    readonly y: number;
    // Which button changed, in DOM numbering. Omitted on a move, which changed none.
    readonly button?: number;
    // Which buttons are held; sent on every action, including a move, since that's what makes a drag a drag.
    readonly buttons: number;
    readonly clickCount?: number;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
    readonly deltaX?: number;
    readonly deltaY?: number;
}

// Set only when true, so the common case (no modifier) keeps the frame small.
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
        // A move or wheel names no button, or Chromium would read the event as a button event.
        ...(action === `move` || wheel ? {} : { button: event.button }),
        // `detail` is 0 on a move and on a wheel, and 1/2/3 on the presses that matter.
        ...(event.detail > 0 ? { clickCount: event.detail } : {}),
        ...flag(event.ctrlKey || event.metaKey),
        ...(event.shiftKey ? { shift: true } : {}),
        ...(event.altKey ? { alt: true } : {}),
        ...(wheel && event instanceof WheelEvent ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}),
    };
};
