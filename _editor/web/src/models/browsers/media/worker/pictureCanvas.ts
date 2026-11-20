import type { DecodeSeams, Painter, Surface } from "./decodeSeams";
import { paintExact, stripePainter } from "./exactPicture";
import type { ExactCopy } from "../mediaHeader";
import type { DecodedStripe } from "./stripeVideo";
import { tabSwitch, type TabSwitch } from "./tabSwitch";

// THE PICTURE ON ITS CANVAS, IN THE DECODE WORKER: the OffscreenCanvas the page transferred, backed at the picture's
// own pixels (hello's width × height), which the page shows at width/scale CSS px, so a DPR-2 screen gets the picture
// 1:1. Each stripe is drawn at its top row the moment it decodes, only inside its frame's clip where castd clipped it,
// and castd's exact copies where they belong (exactPicture.ts). The canvas is resized on the first frame of a new
// size, never ahead of it, since resizing clears it. What the page needs to place the picture (its painted size, its
// edge colour, that a picture is up) is posted as it changes.

export interface PictureCanvas {
    readonly attach: (surface: Surface | undefined) => void;
    // A `hello`: the stream's size, applied by its first frame.
    readonly start: (width: number, height: number) => void;
    // Draws a decoded stripe and closes it; `drawnAt` hears when it landed, with its capture time.
    readonly draw: (decoded: DecodedStripe) => void;
    // Draws castd's exact copy of a rectangle, on a canvas already at the stream's size.
    readonly exact: (copy: ExactCopy) => void;
    readonly edge: () => string | undefined;
    readonly tabs: TabSwitch;
    readonly reset: () => void;
}

export const pictureCanvas = (
    seams: Pick<DecodeSeams, `post` | `edge` | `surface` | `snapshot` | `now` | `bgrxFrame` | `imageData`>,
    drawnAt: (captureMs: number) => void,
): PictureCanvas => {
    let surface: Surface | undefined;
    let painter: Painter | undefined;
    let size: { readonly width: number; readonly height: number } | undefined;
    // Whether anything is on this canvas, and whether the page was told a picture is up since the last hello.
    let drawn = false;
    let said = false;

    // Sizes the canvas; true when it changed (or had nothing on it), which the page is told once the frame is on it.
    const resize = (width: number, height: number): boolean => {
        if (surface === undefined || (surface.width === width && surface.height === height && drawn)) {
            return false;
        }
        surface.width = width;
        surface.height = height;
        return true;
    };

    const tabs = tabSwitch(
        seams,
        () => (surface === undefined || painter === undefined ? undefined : { surface, painter, drawn }),
        (width, height) => {
            if (resize(width, height)) {
                seams.post({ type: `painted`, width, height });
            }
        },
    );

    const draw = (decoded: DecodedStripe): void => {
        // Undefined for a stripe its frame's clip misses, which changes nothing on the canvas.
        const paint = stripePainter(decoded);
        try {
            if (paint === undefined) {
                return;
            }
            const first = !drawn || surface?.width !== size?.width || surface?.height !== size?.height;
            const resized = size !== undefined && resize(size.width, size.height);
            const target = tabs.painter() ?? painter;
            if (target === undefined || surface === undefined) {
                return;
            }
            paint(target);
            drawn = true;
            tabs.drew(decoded.captureMs);
            drawnAt(decoded.captureMs);
            if (!said) {
                said = true;
                seams.post({ type: `picture` });
            }
            // The edge before the size: the page samples the edge colour as the new size lands.
            if (first) {
                seams.post({ type: `edge`, colour: seams.edge(surface) });
            }
            if (resized) {
                seams.post({ type: `painted`, width: surface.width, height: surface.height });
            }
        } finally {
            // A VideoFrame holds a decoder buffer until closed; leaking one stalls the decoder within a second.
            decoded.frame.close();
        }
    };

    // A canvas not yet at the stream's size is cleared by the frame that sizes it: a copy drawn there is lost anyway.
    const exact = (copy: ExactCopy): void => {
        const target = tabs.painter() ?? painter;
        const sized = size !== undefined && surface?.width === size.width && surface.height === size.height;
        return target === undefined || !sized ? undefined : paintExact(target, copy, seams);
    };

    return {
        attach: (next) => {
            tabs.release();
            surface = next;
            // Opaque, and drawn without waiting on the page's compositor: the lowest-latency 2D surface there is.
            painter = next?.getContext(`2d`, { alpha: false, desynchronized: true }) ?? undefined;
            drawn = false;
            said = false;
            if (tabs.paintBlank()) {
                drawn = true;
            }
        },
        start: (width, height) => {
            size = { width, height };
            said = false;
        },
        draw,
        exact,
        edge: () => (surface === undefined || !drawn ? undefined : seams.edge(surface)),
        tabs,
        reset: () => {
            tabs.leave();
            size = undefined;
            drawn = false;
            said = false;
        },
    };
};
