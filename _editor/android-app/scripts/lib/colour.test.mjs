import assert from "node:assert/strict";
import { test } from "node:test";
import { argb, fromOklch, fromSrgb, mix, TRANSPARENT } from "./colour.mjs";

// The categorical series in primitive-colors.css carry the hex a browser renders each at, written beside them; with
// the ends of the scale and CSS Color 4's own pure red they pin oklch → OKLab → linear sRGB → gamma end to end.
const KNOWN = [
    [[1, 0, 0], `#FFFFFFFF`],
    [[0, 0, 0], `#FF000000`],
    [[0.62796, 0.25768, 29.2339], `#FFFF0000`],
    [[0.7, 0.17, 55], `#FFEC7C0E`],
    [[0.521, 0.169, 254.8], `#FF0367C7`],
    [[0.669, 0.116, 189.6], `#FF00ABA4`],
    [[0.45, 0.169, 294.8], `#FF5F38A7`],
    [[0.621, 0.191, 345.1], `#FFD14BA0`],
    [[0.67, 0.161, 54.6], `#FFDE7514`],
    [[0.55, 0.18, 255], `#FF026FD7`],
    [[0.654, 0.113, 189.5], `#FF01A69F`],
    [[0.519, 0.18, 294.9], `#FF734AC3`],
    [[0.6, 0.191, 344.9], `#FFCA449A`],
];

test(`oklch converts to the sRGB a browser draws`, () => {
    for (const [[l, c, h], expected] of KNOWN) {
        assert.equal(argb(fromOklch(l, c, h)), expected, `oklch(${l} ${c} ${h})`);
    }
});

test(`an sRGB colour survives the trip through OKLab`, () => {
    for (const rgb of [[0.2, 0.4, 0.6], [1, 0.55, 0], [0.01, 0.02, 0.03]]) {
        const hex = argb(fromSrgb(rgb));
        assert.equal(hex, `#FF${rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, `0`).toUpperCase()).join(``)}`);
    }
});

test(`a colour outside sRGB is clamped per channel, not wrapped`, () => {
    const hex = argb(fromOklch(0.9, 0.4, 145));
    assert.match(hex, /^#FF[\dA-F]{6}$/);
    assert.equal(hex.slice(5, 7), `FF`, `green saturates`);
    assert.equal(hex.slice(3, 5), `00`, `red clamps at zero`);
});

test(`color-mix in oklab and in srgb land where browsers put them`, () => {
    const white = fromSrgb([1, 1, 1]);
    const black = fromSrgb([0, 0, 0]);
    assert.equal(argb(mix(`oklab`, white, undefined, black, undefined)), `#FF636363`);
    assert.equal(argb(mix(`srgb`, white, 0.25, black, undefined)), `#FF404040`);
    assert.equal(argb(mix(`oklab`, white, 0.25, black, 0.25)), `#80636363`, `percentages under 100% scale the alpha`);
});

test(`mixing with transparent keeps the colour and lowers its alpha`, () => {
    const orange = fromOklch(0.7, 0.17, 55);
    assert.equal(argb(mix(`oklab`, orange, 0.26, TRANSPARENT, undefined)), `#42EC7C0E`);
    assert.equal(argb(mix(`oklab`, TRANSPARENT, undefined, orange, 0.1)), `#1AEC7C0E`);
});
