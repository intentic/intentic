import { boxAsker } from "../boxAsker";
import { watchPixelRatio, type RatioWindow } from "./pixelRatio";

// THE BOX CASTD SIZES ITS SCREEN TO: the stage in CSS px and the screen's device pixels per CSS pixel, so the picture
// comes back at exactly the stage's device pixels and is drawn 1:1. Whole CSS px, rounded down, so the picture is never
// wider than the stage (castd makes the screen round(width × scale), even). Asked like the daemon's box
// (boxAsker.ts), only on a socket that may resize (castd ignores a read-only viewer's box, and the driving viewer's
// wins), again on every fresh socket and whenever the box or the ratio changes, never again for a hello alone. The
// ratio is the stage's own window's: a pane popped out onto another screen has that screen's, watched there.

export interface MediaSize {
    readonly measured: (width: number, height: number) => void;
    // A fresh socket: castd has no box from it yet.
    readonly opened: () => void;
    // A hello: the socket may resize now, and is asked the box unless it was asked this box already. castd answers a
    // box with a hello of the size it made, which may not be the box (fitted to the screen's limits); asking again
    // for every hello would loop.
    readonly fresh: () => void;
    // The stage may be in another window now (popped out, or back): its ratio is read and watched there.
    readonly moved: () => void;
    readonly dispose: () => void;
}

export const mediaSize = (
    send: (box: { readonly width: number; readonly height: number; readonly scale: number }) => void,
    canAsk: () => boolean,
    view: () => RatioWindow = () => window,
): MediaSize => {
    let stage: { readonly width: number; readonly height: number } | undefined;
    const asker = boxAsker(send, canAsk);
    const measure = (): void => {
        if (stage !== undefined) {
            asker.measured(Math.floor(stage.width), Math.floor(stage.height), view().devicePixelRatio);
        }
    };
    let watched = view();
    let stop = watchPixelRatio(measure, watched);
    return {
        measured: (width, height) => {
            stage = { width, height };
            measure();
        },
        opened: asker.forget,
        fresh: asker.ask,
        moved: () => {
            if (view() !== watched) {
                stop();
                watched = view();
                stop = watchPixelRatio(measure, watched);
                measure();
            }
        },
        dispose: () => {
            stop();
            asker.dispose();
        },
    };
};
