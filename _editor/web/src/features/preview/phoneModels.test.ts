import { describe, expect, it } from "vitest";
import { DEFAULT_PHONE_ID, PHONE_MODELS, phoneById, phoneOuterSize, phonePickerGroups, phoneScale } from "./phoneModels";

// The phone catalogue: what the stage is asked to draw, and how big it draws it. Pure, so the arithmetic is pinned
// without a DOM.

describe(`the catalogue`, () => {
    it(`names every phone once and ships the default it points at`, () => {
        const ids = PHONE_MODELS.map((phone) => phone.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain(DEFAULT_PHONE_ID);
    });

    it(`describes portrait CSS viewports, not physical pixels`, () => {
        for (const phone of PHONE_MODELS) {
            expect(phone.height).toBeGreaterThan(phone.width);
            // A physical-pixel row would be 2-3x this; anything outside the range is a transcription slip.
            expect(phone.width).toBeGreaterThanOrEqual(320);
            expect(phone.width).toBeLessThanOrEqual(500);
        }
    });

    it(`offers every phone through the picker, grouped by make`, () => {
        const offered = phonePickerGroups().flatMap((group) => group.options.map((option) => option.value));
        expect(offered.toSorted()).toEqual(PHONE_MODELS.map((phone) => phone.id).toSorted());
        expect(phonePickerGroups().every((group) => group.label !== undefined)).toBe(true);
    });

    it(`resolves an unknown id to the default rather than an empty stage`, () => {
        expect(phoneById(`nokia-3310`).id).toBe(DEFAULT_PHONE_ID);
        expect(phoneById(undefined).id).toBe(DEFAULT_PHONE_ID);
        expect(phoneById(`pixel-7`).label).toBe(`Pixel 7`);
    });
});

describe(`the drawn size`, () => {
    const gestures = phoneById(`iphone-15`);
    const homeButton = phoneById(`iphone-se`);

    it(`wraps the viewport in a bezel, and in a chin where the model has one`, () => {
        expect(gestures.chin).toBeUndefined();
        expect(phoneOuterSize(gestures)).toEqual({
            width: gestures.width + gestures.bezel * 2,
            height: gestures.height + gestures.bezel * 2,
        });
        // The home-button phone spends far more height on hardware than it spends width, and the chin says so.
        expect(phoneOuterSize(homeButton)).toEqual({
            width: homeButton.width + homeButton.bezel * 2,
            height: homeButton.height + homeButton.chin! * 2,
        });
        expect(homeButton.chin!).toBeGreaterThan(homeButton.bezel);
    });

    it(`shrinks to the tighter axis and never magnifies past 1:1`, () => {
        const outer = phoneOuterSize(gestures);
        expect(phoneScale(gestures, { width: outer.width * 4, height: outer.height * 4 })).toBe(1);
        expect(phoneScale(gestures, { width: outer.width, height: outer.height / 2 })).toBeCloseTo(0.5);
        expect(phoneScale(gestures, { width: outer.width / 4, height: outer.height })).toBeCloseTo(0.25);
    });

    it(`reads an unmeasured pane as 1:1, since a zero scale would paint nothing`, () => {
        expect(phoneScale(gestures, { width: 0, height: 0 })).toBe(1);
        expect(phoneScale(gestures, { width: Number.NaN, height: 600 })).toBe(1);
    });
});
