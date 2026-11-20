import { boxAsker } from "../boxAsker";
import { displayRate, type FrameWindow } from "./displayRate";
import { watchPixelRatio, type RatioWindow } from "./pixelRatio";

// THE BOX CASTD SIZES ITS SCREEN TO: the stage in CSS px and the screen's device pixels per CSS pixel, so the picture
// comes back at exactly the stage's device pixels and is drawn 1:1. Whole CSS px, rounded down, so the picture is never
// wider than the stage (castd makes the screen round(width × scale), even). Asked like the daemon's box
// (boxAsker.ts), only on a socket that may resize (castd ignores a read-only viewer's box, and the driving viewer's
// wins), again on every fresh socket and whenever the box or the ratio changes, never again for a hello alone. The
// ratio is the stage's own window's: a pane popped out onto another screen has that screen's, watched there. So is the
// display's refresh rate (`hz`, displayRate.ts), measured once the stage has a size and said with the box: a box asked
// before it was known is asked again with it.

/** The box as castd is asked it: browser-wire's `resize`, without its type. */
export interface MediaBox {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly hz?: number;
}

/** The window the stage is in: its ratio, and its frames, which its display's rate is read off. */
export type StageWindow = RatioWindow & FrameWindow;

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
    send: (box: MediaBox) => void,
    canAsk: () => boolean,
    view: () => StageWindow = () => window,
    rate: (view: FrameWindow) => Promise<number | undefined> = displayRate,
): MediaSize => {
    let stage: { readonly width: number; readonly height: number } | undefined;
    let hz: number | undefined;
    // The window whose rate is known or being measured.
    let rated: StageWindow | undefined;
    const asker = boxAsker((box) => send(hz === undefined ? box : { ...box, hz }), canAsk);
    const learnRate = (): void => {
        const of = view();
        if (rated === of) {
            return;
        }
        rated = of;
        void rate(of).then((measured) => {
            if (rated === of && measured !== hz) {
                hz = measured;
                // The box castd has is the same box at another rate: asked again whatever was asked.
                asker.forget();
                asker.ask();
            }
        });
    };
    const measure = (): void => {
        if (stage !== undefined) {
            learnRate();
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
            rated = undefined;
        },
    };
};
