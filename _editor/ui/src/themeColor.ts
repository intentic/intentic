/* ONE COLOUR, THE WHOLE APP — the accent a person picks, expanded into every ramp the design system reads.
 *
 * This replaced four hand-built brand themes (an orange, a graphite, a violet, a gold), and the thing worth
 * saying about that is what a theme actually WAS: not a colour, but two ramps. A brand ramp of twelve steps
 * that links, fills, focus rings and selected states pick shades out of, and a neutral ramp of twelve that
 * every surface, border and piece of text resolves through. Handing someone a colour input and pointing it at
 * the accent alone would have recoloured the buttons and left the app around them in the old theme's tone —
 * which is the half-done version of this, and looks it.
 *
 * So both ramps are generated here, from one hex.
 *
 * THE LADDER IS FIXED AND THE COLOUR MOVES THROUGH IT. Each step's LIGHTNESS is a constant of this file, taken
 * from the ramp the app shipped with, and a picked colour never gets to move one: lightness is what contrast is
 * made of, and every legibility promise in semantic-colors.css is a promise about a STEP — `--role-link` is
 * primary-700 on light and primary-400 on dark, `--role-content` is surface-900 on light. Let the picked colour
 * set lightness too and a dark navy would produce a link no one can read on the card behind it, in a way no
 * amount of care in the picker could prevent. What the colour does set is HUE, everywhere, and how much CHROMA
 * the ladder carries — which is the whole visible difference between a vivid orange app and a muted slate one,
 * and was the difference between two of the themes this replaced.
 *
 * HUE IS HELD CONSTANT DOWN EACH RAMP. The four themes each eased theirs a little at the dark end — the orange
 * toward red, the gold toward amber, the violet away from magenta — and no two eased the same way, because the
 * right drift for a colour is a fact about that colour. There is no rule that generalises to a hue nobody has
 * looked at yet, and a wrong one is worse than none: a green eased "toward red" turns olive in its shadows. A
 * constant hue is the honest reading of "this app is that colour".
 *
 * CHROMA IS SCALED, NOT COPIED, and this is what makes a muted pick mute the entire app rather than just its
 * buttons. The picked colour's chroma against the reference below is a ratio, and every step of both ramps is
 * multiplied by it — so a steel blue gives quiet neutrals and a quiet accent together, in proportion. The
 * neutral ramp carries about a hundredth of the brand's chroma, which is the tint that makes a surface read as
 * warm-grey next to an orange accent and as cool-grey next to a blue one, without ever reading as coloured.
 *
 * OUT-OF-GAMUT STEPS ARE THE BROWSER'S PROBLEM ON PURPOSE. sRGB holds far more chroma at some hues than others
 * (a yellow at 70% lightness, nothing like it in blue), so asking every hue for the same ladder asks some of
 * them for a colour that does not exist. These are emitted as CSS oklch(), and a browser gamut-maps that by
 * holding lightness and hue and spending chroma — exactly what oklch.ts does in TypeScript, so the colour the
 * page paints and the colour computed here for a swatch agree. */

import { canonicalHex, clampBetween, hexToOklch, maxChroma, oklchToHex } from "./oklch.js";

/** Where the accent itself sits on the ladder — step 600, the shade the picker shows and stores. */
const ACCENT_LIGHTNESS = 0.67;

/* How far off that a colour may read and still count as being ON the ladder. Writing a colour as eight bits a
 * channel moves its lightness by up to ~0.002, so this is the rounding and nothing more — see normalizeAccent,
 * which is the reason a tolerance exists at all. */
const LADDER_TOLERANCE = 0.005;

/* The chroma step 600 carries in the ramp this file's ladders come from. Everything is scaled against it, so a
 * colour picked at this chroma reproduces the original ramp and one at half of it halves the app's colour. */
const REFERENCE_CHROMA = 0.175;

/* How far the scaling may run. The floor keeps a near-grey pick from erasing the accent entirely (a link has to
 * stay findable as a colour, not only as an underline); the ceiling stops a hue that sRGB happens to be
 * generous at from arriving louder than the ramp was ever tuned to be. */
const MIN_SCALE = 0.12;
const MAX_SCALE = 1.25;

/* The accent the app opens with — the orange it shipped in, as a colour rather than a theme name. It is the
 * shipped ramp's step 600 as the BROWSER paints it: that step asked for slightly more chroma than sRGB holds at
 * this hue and lightness, so the value here is the gamut-mapped one, and picking the default reproduces the
 * app's original orange rather than something a few percent off it. */
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

/** Hue and saturation of an accent, 0–360 and 0–1 — how the picker's swatches are stated. */
export interface Accent {
    readonly hue: number;
    /** Fraction of the chroma sRGB can hold at this hue and the accent lightness, so full means full HERE. */
    readonly saturation: number;
}

/**
 * The hex for a hue and a saturation. Saturation is a fraction of what the hue can actually hold rather than an
 * absolute chroma, because the two differ by nearly threefold across the wheel — one absolute figure across a
 * set of colours would leave the blues washed out and the magentas shouting.
 */
export const accentHex = ({ hue, saturation }: Accent): string =>
    oklchToHex({ L: ACCENT_LIGHTNESS, C: maxChroma(ACCENT_LIGHTNESS, hue) * Math.min(1, Math.max(0, saturation)), h: hue });

/* Any hex read back as a hue and a saturation. A colour from outside — a value stored by an older build, or
 * one handed in by a caller — keeps both and gives up its lightness to the ladder. */
const readAccent = (hex: string): Accent | undefined => {
    const colour = hexToOklch(hex);
    if (colour === undefined) {
        return undefined;
    }
    const ceiling = maxChroma(ACCENT_LIGHTNESS, colour.h);
    return { hue: colour.h, saturation: ceiling === 0 ? 0 : Math.min(1, colour.C / ceiling) };
};

/**
 * A hex snapped onto the accent's own lightness — what an arbitrary colour becomes when it is chosen, and the
 * canonical `#rrggbb` spelling of one that was already legal.
 *
 * A COLOUR ALREADY ON THE LADDER IS RETURNED BYTE FOR BYTE, and that early exit is load-bearing rather than an
 * optimisation. Decoding a colour and rebuilding it moves a channel by one, and not randomly: `saturation`
 * above is a FRACTION of the chroma available at whatever hue was just read back, so a colour whose hue shifts
 * by a rounding step is rebuilt a shade duller — and a shade duller again the next time. Left in, that ratchet
 * walks the stored accent away from the swatch it was picked from (three of the thirteen moved on the first
 * pass, one of them every pass), and a picker whose swatches are compared by value then shows nothing as
 * chosen. Exiting early makes this a projection: everything it returns is a fixed point of itself.
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
 * Every custom property one accent implies — the two primitive ramps, keyed exactly as primitive-colors.css
 * names them, so writing these on <html> re-resolves the semantic scales, the role tokens, the PrimeVue `--p-*`
 * bridge and every Tailwind utility built on them, in one assignment and with no rebuild.
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
 * The same properties as one declaration string. This exists for the page's anti-flash script, which has to
 * restore the accent before the first paint and long before any module has loaded: it assigns this to the root
 * element's `style` in two lines and needs no colour maths of its own to do it.
 */
export const themeCss = (hex: string): string =>
    Object.entries(themeVars(hex))
        .map(([name, value]) => `${name}:${value}`)
        .join(`;`);
