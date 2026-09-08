// Expands one accent hex into the brand and neutral colour ramps every semantic token resolves through. Per
// ladder step:
// - lightness is fixed (not set by the pick): legibility promises in semantic-colors.css are about a step's lightness.
// - hue is held constant down the ramp; there's no drift rule that works for every hue.
// - chroma is scaled by the picked colour's chroma over the reference ramp's, applied to both ramps together, so a
//   muted pick mutes the neutrals too.
// Out-of-gamut steps are emitted as CSS oklch() and gamut-mapped by the browser the same way oklch.ts does
// (chroma only), so the page and a computed swatch agree.

import { canonicalHex, clampBetween, hexToOklch, maxChroma, oklchToHex } from "./oklch.js";

/** Where the accent itself sits on the ladder, step 600, the shade the picker shows and stores. */
const ACCENT_LIGHTNESS = 0.67;

// Tolerance for "on the ladder": ~0.002 lightness drift from 8-bit rounding, nothing more.
const LADDER_TOLERANCE = 0.005;

// Chroma of step 600 in the original ramp; every scale is a ratio against this.
const REFERENCE_CHROMA = 0.175;

// Scaling bounds: the floor keeps a near-grey pick from erasing the accent as a colour; the ceiling caps a
// chroma-generous hue from overshooting the tuned ramp.
const MIN_SCALE = 0.12;
const MAX_SCALE = 1.25;

// Default accent: the shipped ramp's step 600 as the browser actually paints it (already gamut-mapped).
export const DEFAULT_ACCENT = `#e07400`;

/* [step, lightness, chroma at full scale]. Both ladders are the shipped ramps, read off primitive-colors.css. */
const BRAND_LADDER: readonly (readonly [string, number, number])[] = [
    [`0`, 0.97, 0.02],
    [`50`, 0.96, 0.035],
    [`100`, 0.93, 0.06],
    [`200`, 0.88, 0.1],
    [`300`, 0.8, 0.11],
    [`400`, 0.75, 0.13],
    [`500`, 0.7, 0.15],
    [`600`, ACCENT_LIGHTNESS, REFERENCE_CHROMA],
    [`700`, 0.58, 0.16],
    [`800`, 0.5, 0.135],
    [`900`, 0.44, 0.115],
    [`950`, 0.33, 0.085],
];

const NEUTRAL_LADDER: readonly (readonly [string, number, number])[] = [
    [`0`, 0.99, 0.002],
    [`50`, 0.98, 0.003],
    [`100`, 0.96, 0.005],
    [`200`, 0.92, 0.007],
    [`300`, 0.87, 0.009],
    [`400`, 0.71, 0.01],
    [`500`, 0.58, 0.011],
    [`600`, 0.48, 0.011],
    [`700`, 0.4, 0.01],
    [`800`, 0.3, 0.009],
    [`900`, 0.23, 0.008],
    [`950`, 0.16, 0.007],
];

/** Hue and saturation of an accent, 0–360 and 0–1, how the picker's swatches are stated. */
export interface Accent {
    readonly hue: number;
    /** Fraction of the chroma sRGB can hold at this hue and lightness; full means full at this hue. */
    readonly saturation: number;
}

/**
 * Hex for a hue and saturation. Saturation is a fraction of what that hue can hold, not an absolute chroma, since
 * the ceiling varies nearly threefold across the wheel.
 */
export const accentHex = ({ hue, saturation }: Accent): string =>
    oklchToHex({ L: ACCENT_LIGHTNESS, C: maxChroma(ACCENT_LIGHTNESS, hue) * Math.min(1, Math.max(0, saturation)), h: hue });

// Reads any hex back as a hue and saturation, discarding its lightness onto the ladder's own.
const readAccent = (hex: string): Accent | undefined => {
    const colour = hexToOklch(hex);
    if (colour === undefined) {
        return undefined;
    }
    const ceiling = maxChroma(ACCENT_LIGHTNESS, colour.h);
    return { hue: colour.h, saturation: ceiling === 0 ? 0 : Math.min(1, colour.C / ceiling) };
};

/**
 * Snaps a hex onto the accent's lightness, or its canonical form if already there. Exits early for an on-ladder
 * colour: rebuilding it via hue/saturation drifts by rounding each time, and repeated saves would ratchet it away
 * from its own swatch.
 */
export const normalizeAccent = (hex: string): string => {
    const colour = hexToOklch(hex);
    if (colour === undefined) {
        return DEFAULT_ACCENT;
    }
    if (Math.abs(colour.L - ACCENT_LIGHTNESS) <= LADDER_TOLERANCE) {
        return canonicalHex(hex) ?? DEFAULT_ACCENT;
    }
    const accent = readAccent(hex);
    return accent === undefined ? DEFAULT_ACCENT : accentHex(accent);
};

const round = (value: number, places: number): number => Number(value.toFixed(places));

/**
 * Every custom property one accent implies (both ramps), keyed exactly as primitive-colors.css names them, so
 * writing them on <html> re-resolves every semantic scale, role token and Tailwind utility in one assignment.
 */
export const themeVars = (hex: string): Readonly<Record<string, string>> => {
    const colour = hexToOklch(hex) ?? hexToOklch(DEFAULT_ACCENT)!;
    const scale = clampBetween(colour.C / REFERENCE_CHROMA, MIN_SCALE, MAX_SCALE);
    const hue = round(colour.h, 1);
    const vars: Record<string, string> = {};
    for (const [step, L, C] of BRAND_LADDER) {
        vars[`--color-brand-${step}`] = `oklch(${round(L * 100, 1)}% ${round(C * scale, 4)} ${hue})`;
    }
    for (const [step, L, C] of NEUTRAL_LADDER) {
        vars[`--color-neutral-${step}`] = `oklch(${round(L * 100, 1)}% ${round(C * scale, 4)} ${hue})`;
    }
    return vars;
};

/**
 * Same properties as one declaration string, for index.html's anti-flash script: it can assign this to the root
 * element's `style` before any module has loaded, with no colour maths of its own.
 */
export const themeCss = (hex: string): string =>
    Object.entries(themeVars(hex))
        .map(([name, value]) => `${name}:${value}`)
        .join(`;`);
