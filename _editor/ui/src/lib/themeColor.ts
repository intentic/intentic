// THE SWATCHES: every colour the app lets a person pick (a sandbox's own colour, a preset logo's glyph). Earth pigments
// beside the app's warm stone and paper, anchored on Ember, the brand's own orange: clay, ochre, moss, a muted teal,
// slate, plum and a warm stone grey. Each is only as colourful as it can be while still sitting in that warm room, so
// the further a hue is from the stone's (about 65°), the quieter it is: a blue at Ember's strength is the complement of
// everything around it and shouts. The one chroma for every hue they shared until 2026-11-24 painted pastel pinks,
// lilacs and cyans on warm paper. The hues are about 30° to 80° apart, warm vs green vs cool vs purple telling two
// sandboxes apart even on a tinted rail, where the warm ones all lean brown.

import { hexToOklch, maxChroma, oklchToHex } from "./oklch.js";

/** Where a swatch sits unless it says otherwise: the lightness of the shipped accent ramp's step 600. */
const SWATCH_LIGHTNESS = 0.67;
/** How colourful a swatch is unless it says otherwise: Ember's. */
const SWATCH_CHROMA = 0.1;

/** A swatch's hue in degrees, and its chroma and lightness where they are not Ember's. */
export interface Swatch {
    readonly hue: number;
    readonly chroma?: number;
    readonly lightness?: number;
}

/** The picker's swatches, in the order it lays them out. `key` names the swatch in `ui.colorPicker`. */
export const SWATCHES = [
    { key: `ember`, hue: 50 },
    // A brick, deeper than the rest: at their lightness a red this calm is salmon-pink.
    { key: `clay`, hue: 30, chroma: 0.08, lightness: 0.6 },
    { key: `ochre`, hue: 82, chroma: 0.085, lightness: 0.7 },
    { key: `moss`, hue: 132, chroma: 0.062 },
    { key: `teal`, hue: 195, chroma: 0.052 },
    { key: `slate`, hue: 250, chroma: 0.052 },
    { key: `plum`, hue: 335, chroma: 0.058 },
    // The stone's own grey, for a sandbox that should stay quiet.
    { key: `stone`, hue: 65, chroma: 0.014 },
] as const satisfies readonly (Swatch & { readonly key: string })[];

export type SwatchKey = (typeof SWATCHES)[number][`key`];

/** Hex for a swatch. */
export const swatchHex = ({ hue, chroma = SWATCH_CHROMA, lightness = SWATCH_LIGHTNESS }: Swatch): string =>
    oklchToHex({ L: lightness, C: Math.min(chroma, maxChroma(lightness, hue)), h: hue });

/** The first swatch's hex: what a colour that cannot be read falls back to. */
export const DEFAULT_SWATCH = swatchHex(SWATCHES[0]);

// Below this chroma a colour is a grey with a cast rather than a hue, and reads as stone.
const GREY_BELOW = 0.035;

const hueGap = (a: number, b: number): number => {
    const gap = Math.abs(a - b) % 360;
    return gap > 180 ? 360 - gap : gap;
};

/**
 * The swatch a colour is nearest, as its hex: by hue, or stone for a near-grey. A colour stored by hand or drawn
 * from a logo then still lands on one of the picker's own, so the picker can say which one is worn. Anything
 * unreadable is the first swatch.
 */
export const nearestSwatch = (hex: string): string => {
    const read = hexToOklch(hex);
    if (read === undefined) {
        return DEFAULT_SWATCH;
    }
    const hued = SWATCHES.filter((swatch) => swatch.key !== `stone`);
    const pick =
        read.C < GREY_BELOW
            ? SWATCHES.find((swatch) => swatch.key === `stone`)!
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
