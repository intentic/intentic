// Computes each brand's mark and plate colour per scheme, guaranteeing a perceptual (OKLab lightness) separation
// between them rather than a WCAG contrast ratio, since WCAG's flare term makes the same ratio read weaker in dark
// mode. The plate slides first, within a bounded band; the mark moves only for what the slide can't cover.

import { clamp01, clampBetween, hexToRgb, type Oklch, oklchToHex, rgbToOklch, srgbToLinear } from "./oklch.js";

/** A brand's four resolved colours, the mark and its plate, in each scheme. */
export interface BrandPalette {
    readonly markLight: string;
    readonly markDark: string;
    readonly plateLight: string;
    readonly plateDark: string;
}

// Below this chroma a brand has no hue worth preserving (pure grey is 0; off-blacks land near 0.0008).
const ACHROMATIC = 0.03;

/** One scheme's placement rules. The two below are the whole configuration of this file. */
interface Scheme {
    /** Which way the mark lies from its plate: brighter in dark, darker in light. */
    readonly direction: 1 | -1;
    /** Guaranteed OKLab lightness distance between mark and plate; dark needs more than light. */
    readonly separation: number;
    /** Where the plate sits by default, and how far it may slide to buy separation before the mark moves. */
    readonly plateLightness: number;
    readonly plateLimit: number;
    /** How much hue a plate may carry: a tint (Docker's tile faintly blue), not a fill. */
    readonly plateChroma: number;
    /** Where a hueless brand starts, the ink the brand itself uses in this scheme. */
    readonly inkLightness: number;
}

const DARK: Scheme = { direction: 1, separation: 0.45, plateLightness: 0.27, plateLimit: 0.16, plateChroma: 0.04, inkLightness: 0.97 };
const LIGHT: Scheme = { direction: -1, separation: 0.42, plateLightness: 0.955, plateLimit: 0.985, plateChroma: 0.03, inkLightness: 0.15 };

// Colour-space conversion and gamut mapping live in oklch.ts; out-of-gamut colours there spend chroma, not
// lightness, so the separation promised here still holds when sRGB can't reach the exact hue.

const lightnessOf = (hex: string): number => rgbToOklch(hexToRgb(hex) ?? ([0, 0, 0] as const)).L;

/**
 * Perceptual lightness distance between two hex colours; the quantity the placement above guarantees. Measured
 * over the rounded sRGB the browser paints, not the underlying float.
 */
export const lightnessSeparation = (a: string, b: string): number => Math.abs(lightnessOf(a) - lightnessOf(b));

// WCAG relative luminance and contrast ratio, kept only as an independent sanity check against drift; placement
// itself doesn't use it.
const luminance = (hex: string): number => {
    const rgb = hexToRgb(hex) ?? ([0, 0, 0] as const);
    const [r, g, b] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two hex colours, 1:1 … 21:1. */
export const contrastRatio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

/** One scheme's mark and plate for a brand: the plate slides for what it can, the mark covers the rest. */
const resolve = (brand: Oklch, scheme: Scheme): { readonly mark: string; readonly plate: string } => {
    // A hueless brand starts from the scheme's ink lightness instead of its own.
    const wanted = brand.C < ACHROMATIC ? scheme.inkLightness : brand.L;
    // Plate slides away from the mark first, as far as the gap needs within its band.
    const plateLightness = clampBetween(wanted - scheme.direction * scheme.separation, scheme.plateLightness, scheme.plateLimit);
    // Mark keeps its own lightness unless that falls inside the gap the plate just opened.
    const nearest = plateLightness + scheme.direction * scheme.separation;
    const markLightness = scheme.direction * wanted > scheme.direction * nearest ? wanted : nearest;
    return {
        plate: oklchToHex({ L: plateLightness, C: Math.min(brand.C, scheme.plateChroma), h: brand.h }),
        mark: oklchToHex({ L: clamp01(markLightness), C: brand.C, h: brand.h }),
    };
};

/**
 * Both schemes' mark and plate for one official brand hex (`#rrggbb` or `#rgb`).
 * `undefined` if not a colour; callers fall back to their themed tiers.
 */
export const brandPalette = (hex: string): BrandPalette | undefined => {
    const rgb = hexToRgb(hex);
    if (rgb === undefined) {
        return undefined;
    }
    const brand = rgbToOklch(rgb);
    const dark = resolve(brand, DARK);
    const light = resolve(brand, LIGHT);
    return { markDark: dark.mark, plateDark: dark.plate, markLight: light.mark, plateLight: light.plate };
};

/**
 * Official colour from a simple-icons SVG's `fill` attribute, so there's no brand-colour table to maintain.
 * `undefined` if the SVG carries no fill; the mark stays on its themed tier.
 */
export const officialHex = (svg: string): string | undefined => {
    const match = /fill\s*=\s*["']?(#[0-9a-fA-F]{3,8})/.exec(svg);
    const hex = match?.[1];
    // 4- and 8-digit hex forms carry alpha and are rejected.
    return hex !== undefined && hexToRgb(hex) !== undefined ? hex : undefined;
};
