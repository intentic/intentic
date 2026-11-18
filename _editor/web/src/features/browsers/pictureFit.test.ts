// Where the live picture sits while a new size is on its way: at its own size in the stage's corner, shrunk only to fit,
// never blown up, and kept 1:1 when it is only the rounding between the box asked and the picture made that is over.
import { fitPicture } from "./pictureFit";

test("a picture smaller than its stage stays at its own size rather than being blown up to fill it", () => {
    expect(fitPicture({ width: 1100, height: 800 }, 1, { width: 1800, height: 1100 })).toEqual({ width: 1100, height: 800 });
});

test("a picture larger than its stage shrinks to fit it, keeping its shape", () => {
    expect(fitPicture({ width: 1100, height: 800 }, 1, { width: 550, height: 724 })).toEqual({ width: 550, height: 400 });
    expect(fitPicture({ width: 1100, height: 800 }, 1, { width: 1100, height: 400 })).toEqual({ width: 550, height: 400 });
});

test("a picture under a pixel over its stage is kept 1:1, not resampled by a fraction of a percent", () => {
    expect(fitPicture({ width: 1234, height: 800 }, 1, { width: 1233.6, height: 800 })).toEqual({ width: 1234, height: 800 });
});

test("a display drawing two pixels per CSS pixel is shown at its CSS size", () => {
    expect(fitPicture({ width: 2200, height: 1600 }, 2, { width: 1800, height: 1100 })).toEqual({ width: 1100, height: 800 });
});
