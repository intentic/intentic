// THE SWATCH LADDER: every colour the app lets a person pick (a sandbox's own colour, a preset logo's glyph) sits at one
// fixed OKLCH lightness, so any pick reads the same against light and dark grounds and none of them is the "loud" one.
// A pick is a hue and a saturation; the lightness is the ladder's. Out-of-gamut picks are reached by chroma only, the
// way oklch.ts maps them, so the page and a computed swatch agree.

import { hexToOklch, maxChroma, oklchToHex } from "./oklch.js";

/** Where every swatch sits: the lightness of the shipped accent ramp's step 600. */
const SWATCH_LIGHTNESS = 0.67;

/** Hue and saturation of a swatch, 0–360 and 0–1. */
export interface Swatch {
    readonly hue: number;
    /** Fraction of the chroma sRGB can hold at this hue and lightness; full means full at this hue. */
    readonly saturation: number;
}

/** The picker's swatches, in the order it lays them out. `key` names the swatch in `ui.colorPicker`. */
export const SWATCHES = [
    // Ember is the shipped accent exactly (full saturation at hue 55), so the app's own orange is one of the picks.
    { key: `ember`, hue: 55, saturation: 1 },
    { key: `vermilion`, hue: 25, saturation: 0.85 },
    { key: `rose`, hue: 350, saturation: 0.78 },
    { key: `orchid`, hue: 320, saturation: 0.8 },
    { key: `iris`, hue: 290, saturation: 0.85 },
    { key: `cobalt`, hue: 260, saturation: 0.9 },
    { key: `azure`, hue: 230, saturation: 0.95 },
    { key: `lagoon`, hue: 200, saturation: 1 },
    { key: `emerald`, hue: 172, saturation: 0.95 },
    { key: `fern`, hue: 145, saturation: 0.85 },
    { key: `moss`, hue: 115, saturation: 0.9 },
    { key: `brass`, hue: 85, saturation: 0.95 },
    { key: `graphite`, hue: 250, saturation: 0.14 },
] as const satisfies readonly (Swatch & { readonly key: string })[];

export type SwatchKey = (typeof SWATCHES)[number][`key`];

/** Hex for a hue and saturation, on the ladder. */
export const swatchHex = ({ hue, saturation }: Swatch): string =>
    oklchToHex({ L: SWATCH_LIGHTNESS, C: maxChroma(SWATCH_LIGHTNESS, hue) * Math.min(1, Math.max(0, saturation)), h: hue });

/** The first swatch's hex: what a colour that cannot be read falls back to. */
export const DEFAULT_SWATCH = swatchHex(SWATCHES[0]);

// Reads any hex back as a hue and saturation, discarding its lightness onto the ladder's own.
const readSwatch = (hex: string): Swatch | undefined => {
    const colour = hexToOklch(hex);
    if (colour === undefined) {
        return undefined;
    }
    const ceiling = maxChroma(SWATCH_LIGHTNESS, colour.h);
    return { hue: colour.h, saturation: ceiling === 0 ? 0 : Math.min(1, colour.C / ceiling) };
};

// Below this a colour is a grey with a cast rather than a hue, and reads as graphite.
const GREY_BELOW = 0.3;

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
    const read = readSwatch(hex);
    if (read === undefined) {
        return DEFAULT_SWATCH;
    }
    const hued = SWATCHES.filter((swatch) => swatch.key !== `graphite`);
    const pick =
        read.saturation < GREY_BELOW
            ? SWATCHES.find((swatch) => swatch.key === `graphite`)!
            : hued.reduce((best, swatch) => (hueGap(swatch.hue, read.hue) < hueGap(best.hue, read.hue) ? swatch : best));
    return swatchHex(pick);
};

/**
 * A ground tinted toward a swatch, for what cannot mix colours itself: the browser's own chrome (`theme-color`) beside a
 * rail painted in the swatch. Light enough to sit under dark text by day, dark enough under light text by night.
 */
export const tintedGround = (hex: string, dark: boolean): string => {
    const colour = hexToOklch(hex) ?? hexToOklch(DEFAULT_SWATCH)!;
    return oklchToHex({ L: dark ? 0.27 : 0.9, C: Math.min(colour.C * 0.35, dark ? 0.045 : 0.055), h: colour.h });
};
