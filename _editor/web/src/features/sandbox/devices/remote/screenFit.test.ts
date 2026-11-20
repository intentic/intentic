// Where a remote screen sits on the stage: fitted whole and letterboxed, one picture pixel per device pixel, or covering
// the stage, every edge on a whole device pixel, and the box the computer is asked to send for each.
import { askedBox, placePicture } from "./screenFit";

const STAGE = { width: 1200, height: 700 };

it("fits a 4K screen whole into the stage, centred, its edges on device pixels", () => {
    // 1200 / 3840 = 0.3125 and 700 / 2160 ≈ 0.324: the width decides, and the 12.5 px left over above is rounded to 13.
    expect(placePicture(`fit`, { width: 3840, height: 2160 }, STAGE, 1)).toEqual({ left: 0, top: 13, width: 1200, height: 675 });
    // At 1.5 device pixels per CSS px, the offset lands on a third of a CSS px rather than a blur.
    const box = placePicture(`fit`, { width: 3840, height: 2160 }, { width: 1001, height: 700 }, 1.5)!;
    expect([box.left * 1.5, box.top * 1.5, box.width * 1.5, box.height * 1.5].every(Number.isInteger)).toBe(true);
});

it("draws a picture made for the stage 1:1 rather than resampling it by a pixel of rounding", () => {
    // Asked for 1200×700 CSS px at 2×, the computer sent 2400×1398 (an even height): 1:1, not stretched by 2 px.
    expect(placePicture(`fit`, { width: 2400, height: 1398 }, STAGE, 2)).toEqual({ left: 0, top: 0.5, width: 1200, height: 699 });
});

it("puts one picture pixel on one device pixel at actual size, scrolling from the corner when larger than the stage", () => {
    expect(placePicture(`actual`, { width: 3840, height: 2160 }, STAGE, 2)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(placePicture(`actual`, { width: 800, height: 600 }, STAGE, 1)).toEqual({ left: 200, top: 50, width: 800, height: 600 });
});

it("covers the stage without stretching, cropping evenly", () => {
    expect(placePicture(`fill`, { width: 1920, height: 1080 }, STAGE, 1)).toEqual({ left: -22, top: 0, width: 1244, height: 700 });
});

it("places nothing before there is a picture or a stage", () => {
    expect(placePicture(`fit`, { width: 0, height: 0 }, STAGE, 1)).toBeUndefined();
    expect(placePicture(`fit`, { width: 1920, height: 1080 }, { width: 0, height: 700 }, 1)).toBeUndefined();
});

it("asks for the stage to fit, and for the whole screen at actual size or to fill", () => {
    const screen = { width: 3840, height: 2160 };
    expect(askedBox(`fit`, { width: 1200.6, height: 700.2 }, screen, 2)).toEqual({ width: 1200, height: 700 });
    expect(askedBox(`actual`, STAGE, screen, 2)).toEqual({ width: 1920, height: 1080 });
    expect(askedBox(`fill`, STAGE, undefined, 2)).toEqual({ width: 1200, height: 700 });
});
