/* OKLCH ⇄ sRGB — the colour-space floor everything that COMPUTES a colour in this kit stands on.
 *
 * Two callers with the same need: brandColor.ts places a brand's mark against its own plate, and themeColor.ts
 * builds the whole app's ramps out of one picked colour. Both need the same three things — read a hex, move a
 * colour along one axis without disturbing the others, write a hex back — and both need them in OKLab rather
 * than HSL, because only there is lightness perceptual: raising HSL's `l` on a saturated blue swings the hue
 * visibly toward cyan, and a distance in it means one thing on a pale colour and another on a deep one.
 *
 * Hue is in DEGREES here, matching CSS's own oklch() notation, so a value read out of this file can be written
 * straight into a stylesheet and a value read out of a stylesheet needs no conversion coming in. */

/** A colour in OKLCH: lightness 0–1, chroma (0 is grey, ~0.37 is the most sRGB holds), hue in degrees. */
export interface Oklch {
    readonly L: number;
    readonly C: number;
    readonly h: number;
}

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));
export const clampBetween = (value: number, a: number, b: number): number => Math.min(Math.max(a, b), Math.max(Math.min(a, b), value));

const DEG = 180 / Math.PI;

export const hexToRgb = (hex: string): readonly [number, number, number] | undefined => {
    const raw = hex.trim().replace(/^#/, ``);
    // Both forms the wild serves: #rgb and #rrggbb.
    const full = raw.length === 3 ? [...raw].map((c) => `${c}${c}`).join(``) : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) {
        return undefined;
    }
    return [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255] as const;
};

const rgbToHex = (rgb: readonly [number, number, number]): string =>
    `#${rgb
        .map((c) =>
            Math.round(clamp01(c) * 255)
                .toString(16)
                .padStart(2, `0`),
        )
        .join(``)}`;

// --- sRGB ⇄ OKLab. The matrices are Björn Ottosson's published constants.
export const rgbToOklch = (rgb: readonly [number, number, number]): Oklch => {
    const [R, G, B] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * DEG + 360) % 360 };
};

const oklchToRgb = ({ L, C, h }: Oklch): readonly [number, number, number] => {
    const a = Math.cos(h / DEG) * C;
    const b = Math.sin(h / DEG) * C;
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearToSrgb(-0.004196086 * l - 0.7034186147 * m + 1.707614701 * s),
    ] as const;
};

// A hair of slack, so a colour that lands on the edge of the gamut by float error is not treated as outside it
// and mapped for nothing.
const inGamut = (rgb: readonly [number, number, number]): boolean => rgb.every((c) => c >= -1e-4 && c <= 1.0001);
// Twenty halvings of the chroma range resolve far finer than the 8-bit channel this lands in.
const GAMUT_STEPS = 20;

/** The most chroma sRGB holds at a given lightness and hue — the ceiling a saturation control has to stop at. */
export const maxChroma = (L: number, h: number): number => {
    let fits = 0;
    let over = 0.4;
    for (let i = 0; i < GAMUT_STEPS; i += 1) {
        const mid = (fits + over) / 2;
        if (inGamut(oklchToRgb({ L, C: mid, h }))) {
            fits = mid;
        } else {
            over = mid;
        }
    }
    return fits;
};

/* Out of gamut, CHROMA is what gives way — never lightness, never hue. Clipping each channel at 0 and 1 (the
 * obvious move) yields LIGHTNESS quietly: the colour lands near the requested one, a little off the requested
 * hue, and short of whatever separation the caller was placing it for. Holding L and h and searching for the
 * chroma that fits is CSS Color 4's gamut mapping, and the same trade every browser makes for an
 * out-of-gamut oklch() — so a colour computed here and a colour written as CSS agree. */
export const oklchToHex = (colour: Oklch): string => {
    if (inGamut(oklchToRgb(colour))) {
        return rgbToHex(oklchToRgb(colour));
    }
    return rgbToHex(oklchToRgb({ ...colour, C: maxChroma(colour.L, colour.h) }));
};

/** A hex read as OKLCH, or `undefined` for anything that is not a colour. */
export const hexToOklch = (hex: string): Oklch | undefined => {
    const rgb = hexToRgb(hex);
    return rgb === undefined ? undefined : rgbToOklch(rgb);
};

/**
 * The one spelling of a colour — `#rrggbb`, lowercase — so that two of them can be compared as strings.
 * Byte-exact: this expands and lowercases, it does not go near a colour space, so nothing rounds.
 */
export const canonicalHex = (hex: string): string | undefined => {
    const rgb = hexToRgb(hex);
    return rgb === undefined ? undefined : rgbToHex(rgb);
};
