import "@intentic/testing/dom";
import { keyboardOcclusion } from "../../../ui/src/composables/useDevice";

it(`detects a keyboard when interactive-widget shrinks both viewports`, () => {
    expect(keyboardOcclusion(430, 430, 0, 780, true)).toBe(350);
    expect(keyboardOcclusion(430, 430, 0, 780, false)).toBe(0);
});

it(`keeps the ordinary visual viewport inset for browsers that overlay the keyboard`, () => {
    expect(keyboardOcclusion(780, 430, 0, 780, true)).toBe(350);
});
