// The rule that sets a picture aside as plain, on synthetic frames shaped like what agents actually capture: a flat page,
// an empty page holding only a floating pill or a scrollbar, one line of text, and thin or tiny crops left unjudged.
import { lookOf, UNJUDGED } from "./shotLook";

type Rgba = readonly [number, number, number, number];

const WHITE: Rgba = [255, 255, 255, 255];
const INK: Rgba = [40, 40, 40, 255];

// A width×height frame of one colour, with rectangles painted on it.
const frame = (width: number, height: number, background: Rgba, ...boxes: { x: number; y: number; w: number; h: number; colour?: Rgba }[]) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let at = 0; at < data.length; at += 4) {
        data.set(background, at);
    }
    for (const box of boxes) {
        for (let y = box.y; y < box.y + box.h; y++) {
            for (let x = box.x; x < box.x + box.w; x++) {
                data.set(box.colour ?? INK, (y * width + x) * 4);
            }
        }
    }
    return { data, width, height };
};

const judge = (picture: ReturnType<typeof frame>) => lookOf(picture.data, picture.width, picture.height);

describe(`lookOf`, () => {
    it(`calls a flat frame plain, white, black or transparent`, () => {
        expect(judge(frame(256, 160, WHITE)).plain).toBe(true);
        expect(judge(frame(256, 160, [10, 10, 10, 255])).plain).toBe(true);
        expect(judge(frame(256, 160, [0, 0, 0, 0])).plain).toBe(true);
    });

    it(`calls an empty page with only a floating pill in a corner plain`, () => {
        expect(judge(frame(256, 160, WHITE, { x: 195, y: 146, w: 56, h: 8 })).plain).toBe(true);
    });

    it(`ignores a scrollbar down the edge`, () => {
        expect(judge(frame(256, 160, [10, 10, 10, 255], { x: 253, y: 0, w: 3, h: 160, colour: [120, 120, 120, 255] })).plain).toBe(true);
    });

    it(`keeps a line of text across a third of the page, and a dialog, as content`, () => {
        expect(judge(frame(256, 160, WHITE, { x: 10, y: 10, w: 90, h: 10 })).plain).toBe(false);
        expect(judge(frame(256, 160, WHITE, { x: 68, y: 30, w: 120, h: 70 })).plain).toBe(false);
    });

    it(`keeps two small things far apart as content, since what lies between them is the picture`, () => {
        expect(judge(frame(256, 160, WHITE, { x: 10, y: 10, w: 6, h: 6 }, { x: 230, y: 140, w: 6, h: 6 })).plain).toBe(false);
    });

    it(`does not judge a thin crop of one element, or a tiny one`, () => {
        expect(judge(frame(256, 40, [235, 235, 235, 255], { x: 120, y: 15, w: 8, h: 8 })).plain).toBe(false);
        expect(judge(frame(20, 20, [30, 30, 30, 255])).plain).toBe(false);
    });

    it(`prints identical pixels alike and any changed pixel apart`, () => {
        const one = judge(frame(256, 160, WHITE, { x: 20, y: 20, w: 100, h: 50 }));
        const same = judge(frame(256, 160, WHITE, { x: 20, y: 20, w: 100, h: 50 }));
        const ticked = judge(frame(256, 160, WHITE, { x: 20, y: 20, w: 100, h: 50 }, { x: 200, y: 100, w: 1, h: 1 }));
        expect(one.print).toMatch(/^256x160:/);
        expect(same.print).toBe(one.print);
        expect(ticked.print).not.toBe(one.print);
    });

    it(`judges nothing it cannot read`, () => {
        expect(lookOf(new Uint8ClampedArray(0), 0, 0)).toEqual(UNJUDGED);
        expect(lookOf(new Uint8ClampedArray(8), 10, 10)).toEqual(UNJUDGED);
    });
});
