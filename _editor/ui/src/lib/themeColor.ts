// THE SWATCHES: every colour the app lets a person pick (a sandbox's own colour, a preset logo's glyph). All sit at one
// OKLCH lightness and one chroma, so they read as one family beside the app's warm neutrals and none is louder than the
// rest; only the hue differs. A share of each hue's own sRGB ceiling (how they were stated before 2026-11-25) made the
// blues and greens far louder than the cyans, and the yellow-greens went olive on the warm stone of a tinted rail.
// The hues are spaced about 40° apart, which keeps two sandboxes apart even at the low chroma of a tinted surface.

import { hexToOklch, maxChroma, oklchToHex } from "./oklch.js";

/** Where every swatch sits: the lightness of the shipped accent ramp's step 600. */
const SWATCH_LIGHTNESS = 0.67;
/** How colourful every hued swatch is. In sRGB at this lightness for every hue the picker offers. */
const SWATCH_CHROMA = 0.1;

/** A swatch's hue in degrees, and its chroma where it is not the family's. */
export interface Swatch {
    readonly hue: number;
    readonly chroma?: number;
}

/** The picker's swatches, in the order it lays them out. `key` names the swatch in `ui.colorPicker`. */
export const SWATCHES = [
    { key: `ember`, hue: 50 },
    { key: `rose`, hue: 10 },
    { key: `orchid`, hue: 330 },
    { key: `iris`, hue: 290 },
    { key: `cobalt`, hue: 255 },
    { key: `lagoon`, hue: 215 },
    { key: `emerald`, hue: 175 },
    { key: `brass`, hue: 90 },
    // A near-grey with a blue cast, for a sandbox that should stay quiet.
    { key: `graphite`, hue: 250, chroma: 0.02 },
] as const satisfies readonly (Swatch & { readonly key: string })[];

export type SwatchKey = (typeof SWATCHES)[number][`key`];

/** Hex for a swatch. */
export const swatchHex = ({ hue, chroma = SWATCH_CHROMA }: Swatch): string =>
    oklchToHex({ L: SWATCH_LIGHTNESS, C: Math.min(chroma, maxChroma(SWATCH_LIGHTNESS, hue)), h: hue });

/** The first swatch's hex: what a colour that cannot be read falls back to. */
export const DEFAULT_SWATCH = swatchHex(SWATCHES[0]);

// Below this chroma a colour is a grey with a cast rather than a hue, and reads as graphite.
const GREY_BELOW = 0.035;

const hueGap = (a: number, b: number): number => {
    const gap = Math.abs(a - b) % 360;
    return gap > 180 ? 360 - gap : gap;
};

/**
 * The swatch a colour is nearest, as its hex: by hue, or graphite for a near-grey. A colour stored by hand or drawn
 * from a logo then still lands on one of the picker's own, so the picker can say which one is worn. Anything
 * unreadable is the first swatch.
 */
export const nearestSwatch = (hex: string): string => {
    const read = hexToOklch(hex);
    if (read === undefined) {
        return DEFAULT_SWATCH;
    }
    const hued = SWATCHES.filter((swatch) => swatch.key !== `graphite`);
    const pick =
        read.C < GREY_BELOW
            ? SWATCHES.find((swatch) => swatch.key === `graphite`)!
            : hued.reduce((best, swatch) => (hueGap(swatch.hue, read.h) < hueGap(best.hue, read.h) ? swatch : best));
    return swatchHex(pick);
};

/** The grounds a swatch tints, each at a fixed lightness with its chroma capped, so every hue is as calm as the next. */
export interface Tints {
    /** A surface in the light scheme: a rail, the browser's chrome. */
    readonly light: string;
    /** The same in the dark scheme. */
    readonly dark: string;
    /** A shade under dark, for the deepest stone (Sanctum's rail). */
    readonly deep: string;
    /** A mid tone a picture takes its hue from (a `color` blend over the wallpaper). */
    readonly haze: string;
}

/**
 * A swatch's tinted grounds. Built from its hue rather than mixed into whatever surface they land on: a swatch mixed
 * into a warm brown came out olive, and the stronger hues outshouted the weaker ones.
 */
export const tintsOf = (hex: string): Tints => {
    const colour = hexToOklch(hex) ?? hexToOklch(DEFAULT_SWATCH)!;
    const at = (L: number, share: number, cap: number): string => oklchToHex({ L, C: Math.min(colour.C * share, cap), h: colour.h });
    return { light: at(0.9, 0.42, 0.042), dark: at(0.29, 0.4, 0.038), deep: at(0.25, 0.35, 0.032), haze: at(0.6, 0.6, 0.06) };
};
