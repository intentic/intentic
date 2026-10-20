// Colour arithmetic for theme.mjs: CSS Color 4's oklch, OKLab and sRGB, and color-mix(), in plain numbers. A colour is
// `{ lab: [L, a, b], alpha }` in OKLab, the space every conversion passes through; sRGB values outside 0..1 are kept
// until the very end, as CSS keeps them, and clamped only when written as an Android colour.

// Björn Ottosson's OKLab matrices, the ones CSS Color 4 cites (https://bottosson.github.io/posts/oklab/). Only the
// forward pair is written: the way back is their exact inverse, so a colour that goes in and out comes back the same.
const LMS_FROM_LINEAR = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
];
const LAB_FROM_LMS = [
    [0.2104542553, 0.793617785, -0.0040720468],
    [1.9779984951, -2.428592205, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.808675766],
];

const invert = ([[a, b, c], [d, e, f], [g, h, i]]) => {
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
};
const LMS_FROM_LAB = invert(LAB_FROM_LMS);
const LINEAR_FROM_LMS = invert(LMS_FROM_LINEAR);

const times = (matrix, [x, y, z]) => matrix.map(([a, b, c]) => a * x + b * y + c * z);

/** sRGB's transfer function and its inverse, mirrored around zero so an out-of-gamut value survives the round trip. */
export const encode = (linear) => Math.sign(linear) * (Math.abs(linear) <= 0.0031308 ? 12.92 * Math.abs(linear) : 1.055 * Math.abs(linear) ** (1 / 2.4) - 0.055);
export const decode = (gamma) => Math.sign(gamma) * (Math.abs(gamma) <= 0.04045 ? Math.abs(gamma) / 12.92 : ((Math.abs(gamma) + 0.055) / 1.055) ** 2.4);

export const labFromLinear = (rgb) => times(LAB_FROM_LMS, times(LMS_FROM_LINEAR, rgb).map(Math.cbrt));
export const linearFromLab = (lab) => times(LINEAR_FROM_LMS, times(LMS_FROM_LAB, lab).map((v) => v ** 3));

/** Gamma-encoded sRGB, unclamped, 0..1 per channel in gamut. */
export const srgbOf = (colour) => linearFromLab(colour.lab).map(encode);
export const fromSrgb = (rgb, alpha = 1) => ({ lab: labFromLinear(rgb.map(decode)), alpha });

/** `oklch(L C H)` with L as 0..1, hue in degrees. */
export const fromOklch = (l, c, h, alpha = 1) => {
    const radians = (h * Math.PI) / 180;
    return { lab: [l, c * Math.cos(radians), c * Math.sin(radians)], alpha };
};

export const TRANSPARENT = { lab: [0, 0, 0], alpha: 0 };

/**
 * `color-mix(in <space>, first p, second q)`: premultiplied interpolation, as CSS Color 5 specifies, so mixing with
 * `transparent` keeps the other colour's hue and only lowers its alpha. Percentages are 0..1 here; a missing one is the
 * other's complement, and a pair summing under one scales the alpha down by that sum.
 */
export const mix = (space, first, p, second, q) => {
    const [wp, wq] = p === undefined && q === undefined ? [0.5, 0.5] : p === undefined ? [1 - q, q] : q === undefined ? [p, 1 - p] : [p, q];
    const sum = wp + wq;
    if (sum <= 0) {
        throw new Error(`color-mix: the percentages add up to nothing`);
    }
    const [a, b] = [wp / sum, wq / sum];
    const coords = space === `oklab` ? (colour) => colour.lab : space === `srgb` ? srgbOf : undefined;
    if (coords === undefined) {
        throw new Error(`color-mix: no interpolation in ${space} here (oklab and srgb are what the roles use)`);
    }
    const alpha = first.alpha * a + second.alpha * b;
    const [x, y] = [coords(first), coords(second)];
    const mixed = x.map((value, i) => (alpha === 0 ? 0 : (value * first.alpha * a + y[i] * second.alpha * b) / alpha));
    const colour = space === `oklab` ? { lab: mixed, alpha } : fromSrgb(mixed, alpha);
    return { ...colour, alpha: alpha * Math.min(sum, 1) };
};

const byte = (unit) => Math.round(Math.min(1, Math.max(0, unit)) * 255);
const hex = (value) => value.toString(16).padStart(2, `0`).toUpperCase();

/** `#AARRGGBB`, as Android writes a colour: each sRGB channel clamped into gamut, then rounded to eight bits. */
export const argb = (colour) => `#${[colour.alpha, ...srgbOf(colour)].map((unit) => hex(byte(unit))).join(``)}`;
