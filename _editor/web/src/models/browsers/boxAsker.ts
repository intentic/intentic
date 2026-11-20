// THE BOX A LIVE PICTURE IS ASKED TO FILL: the stage's size in CSS px (and, on the media socket, the screen's pixels
// per CSS pixel), sent only when the far side does not have it already, at once for a one-step change and once a drag
// holds still. useScreencast asks the daemon on its socket; the media path asks castd on its own (media/mediaSize.ts).

// A box that changes after holding still this long is asked at once (a panel opened or closed, the window maximised);
// one changing again within it is a drag, asked once it holds still this long, since every step of a drag would
// otherwise restart the encoder.
export const RESIZE_DEBOUNCE_MS = 250;

export interface Box {
    readonly width: number;
    readonly height: number;
    // Device pixels per CSS pixel; 1 where the far side is not told.
    readonly scale: number;
}

const sameBox = (left: Box | undefined, right: Box | undefined): boolean =>
    left !== undefined && right !== undefined && left.width === right.width && left.height === right.height && left.scale === right.scale;

export interface BoxAsker {
    // The box was measured at this size, in CSS px, on a screen of `scale` device pixels per CSS pixel.
    readonly measured: (width: number, height: number, scale?: number) => void;
    // Asks for the box now, unless it is not to be asked or the far side was asked it already.
    readonly ask: () => void;
    // The far side has forgotten every box asked (a fresh socket, another picture, a phone let go of).
    readonly forget: () => void;
    readonly dispose: () => void;
}

// The box the far side is asked to size the picture to: the last one measured, sent when `canAsk` allows and only when
// it does not have it already, with RESIZE_DEBOUNCE_MS's rule for when.
export const boxAsker = (send: (box: Box) => void, canAsk: () => boolean): BoxAsker => {
    let box: Box | undefined;
    let asked: Box | undefined;
    let timer: number | undefined;
    // When the box last changed size: what tells a one-step change from a drag.
    let changedAt = 0;
    const ask = (): void => {
        if (box !== undefined && canAsk() && !sameBox(box, asked)) {
            asked = box;
            send(box);
        }
    };
    return {
        measured: (boxWidth, boxHeight, scale = 1) => {
            const size = { width: Math.round(boxWidth), height: Math.round(boxHeight), scale };
            if (size.width <= 0 || size.height <= 0 || sameBox(size, box)) {
                return;
            }
            box = size;
            const held = timer === undefined && Date.now() - changedAt >= RESIZE_DEBOUNCE_MS;
            changedAt = Date.now();
            window.clearTimeout(timer);
            timer = held
                ? undefined
                : window.setTimeout(() => {
                      timer = undefined;
                      ask();
                  }, RESIZE_DEBOUNCE_MS);
            if (held) {
                ask();
            }
        },
        ask,
        forget: () => {
            asked = undefined;
        },
        dispose: () => {
            window.clearTimeout(timer);
            timer = undefined;
        },
    };
};
