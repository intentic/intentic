import type { MouseMessage } from "../../../../models/browsers/inputWire";
import { pictureScale, viewportCoords } from "../../../../models/browsers/viewportCoords";

// A MOUSE ON SOMEONE ELSE'S COMPUTER, in the picture's own pixels, the buttons held on every message so a drag is a
// drag, and the press count so a double click selects a word. With the pointer locked to the picture (a game, a 3D
// view, a drag that must not leave the window), this computer's cursor is hidden and only moves are reported: they move
// a cursor kept here, in picture pixels, held inside the picture, which is what the far end is told.

export type PointerAction = `move` | `down` | `up`;

interface Size {
    readonly width: number;
    readonly height: number;
}

export interface RemotePointer {
    // A mouse event over the picture, as the far end's mouse message; undefined while the picture has no box.
    readonly at: (action: PointerAction, event: MouseEvent, picture: HTMLElement, size: Size) => MouseMessage | undefined;
    // Locked: the cursor kept here, where a lock starts from the last place the pointer was.
    readonly locked: (on: boolean) => void;
    readonly cursor: () => { readonly x: number; readonly y: number } | undefined;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(0, max - 1), Math.max(0, Math.round(value)));

export const remotePointer = (): RemotePointer => {
    let lock = false;
    let cursor: { x: number; y: number } | undefined;

    const message = (action: PointerAction, event: MouseEvent, at: { readonly x: number; readonly y: number }): MouseMessage =>
        action === `move`
            ? { type: `mouse`, action, x: at.x, y: at.y, buttons: event.buttons }
            : { type: `mouse`, action, x: at.x, y: at.y, button: event.button, buttons: event.buttons, clickCount: Math.max(1, event.detail) };

    return {
        at: (action, event, picture, size) => {
            if (!lock) {
                const at = viewportCoords(event, picture, size.width, size.height);
                if (at !== undefined) {
                    cursor = at;
                }
                return at === undefined ? undefined : message(action, event, at);
            }
            const scale = pictureScale(picture, size.width, size.height);
            if (scale === undefined) {
                return undefined;
            }
            const from = cursor ?? { x: size.width / 2, y: size.height / 2 };
            cursor = { x: clamp(from.x + event.movementX / scale, size.width), y: clamp(from.y + event.movementY / scale, size.height) };
            return message(action, event, cursor);
        },
        locked: (on) => {
            lock = on;
        },
        cursor: () => cursor,
    };
};
