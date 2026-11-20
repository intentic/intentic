// WHERE A REMOTE SCREEN SITS ON THE STAGE, in three ways a person picks between:
// - `fit`: all of it, as large as the stage allows, letterboxed; the computer is asked for a picture of the stage's own
//   size, so where it obliges the picture is drawn 1:1 on the stage's device pixels and text stays sharp.
// - `actual`: one picture pixel on one device pixel of this screen (1:1), scrolled where it is larger than the stage;
//   the computer is asked for its own full size.
// - `fill`: the stage covered edge to edge, the overflow cropped evenly, never stretched out of shape.
// Every edge lands on a whole device pixel, so a picture drawn 1:1 is never resampled by a fraction.

export type ScreenScale = `fit` | `actual` | `fill`;

interface Size {
    readonly width: number;
    readonly height: number;
}

/** The picture's box on the stage in CSS px; `left`/`top` may be negative (fill), and the stage scrolls when `actual` overflows. */
export interface PictureBox {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

// A length in CSS px put on whole device pixels.
const snap = (css: number, ratio: number): number => Math.round(css * ratio) / ratio;

/** Where a picture of `picture` pixels goes on a stage of `stage` CSS px at `ratio` device pixels per CSS px. */
export const placePicture = (scale: ScreenScale, picture: Size, stage: Size, ratio: number): PictureBox | undefined => {
    if (picture.width <= 0 || picture.height <= 0 || stage.width <= 0 || stage.height <= 0 || ratio <= 0) {
        return undefined;
    }
    // CSS px per picture pixel.
    const unit = scale === `actual` ? 1 / ratio : (scale === `fit` ? Math.min : Math.max)(stage.width / picture.width, stage.height / picture.height);
    // Within half a device pixel of 1:1 is 1:1: the picture made for this stage, rounded by the far end.
    const exact = Math.abs(unit * ratio - 1) * Math.max(picture.width, picture.height) < 1 ? 1 / ratio : unit;
    const width = snap(picture.width * exact, ratio);
    const height = snap(picture.height * exact, ratio);
    // An overflowing 1:1 picture starts at the stage's corner and scrolls; everything else is centred.
    const centre = (room: number, size: number): number => (scale === `actual` && size > room ? 0 : snap((room - size) / 2, ratio));
    return { left: centre(stage.width, width), top: centre(stage.height, height), width, height };
};

/** The box the computer is asked to send, in CSS px at `ratio`: the stage to fit it, the whole screen otherwise. */
export const askedBox = (scale: ScreenScale, stage: Size, screen: Size | undefined, ratio: number): Size => {
    if (scale === `fit` || screen === undefined || ratio <= 0) {
        return { width: Math.floor(stage.width), height: Math.floor(stage.height) };
    }
    return { width: Math.floor(screen.width / ratio), height: Math.floor(screen.height / ratio) };
};
