/* A BRAND'S OWN COLOUR, MADE LEGIBLE ON OUR OWN PLATE — the colour half of <BrandMark>.
 *
 * The marks used to be painted in the theme's text colour, every one of them, and the reason was sound: a brand
 * hex is picked to work on white, and a capability tile is white in one scheme and near-black in the other
 * across four themes, so honouring the hex left most marks unreadable on the dark card. What that bought was
 * legibility and what it cost was recognition — a grid of 35 identical grey glyphs, which is how the catalog
 * came to read as a graveyard.
 *
 * BOTH ARE AVAILABLE, and the move that gets them is to stop treating the plate as a fixed surface the mark has
 * to survive. Here each mark brings its OWN plate, derived from its own hue and OPAQUE — which is what takes the
 * four themes out of the question entirely, because the contrast a mark has to clear becomes a fact settled here
 * rather than a fact about whichever theme is loaded.
 *
 * THE BAR IS A PERCEPTUAL DISTANCE, NOT A WCAG RATIO, and that is this file's one substantive claim. The first
 * cut of this asked for a WCAG 2.x ratio of 3:1 and searched for the smallest nudge that cleared it. It cleared
 * it, and the dark grid still read as smudges: PostgreSQL, MySQL, Sentry and Redmine all passed and all looked
 * like dirt. The metric is why. WCAG 2.x contrast is (L+0.05)/(L+0.05) over relative luminance, and that 0.05
 * flare term dominates when both sides are dark — so the SAME ratio of 3:1 measures roughly twice the apparent
 * contrast against our light plate as against our dark one (about Lc 54 against Lc 25 on APCA, over the real
 * catalog). One threshold in that metric cannot mean one thing in two schemes, and dark mode was living at the
 * bottom of it. So separation is measured as a distance in OKLab lightness, which is perceptual and has no
 * polarity built in, and it is GUARANTEED BY CONSTRUCTION rather than searched for: the mark and its plate are
 * placed a known distance apart, so there is no threshold to squeak under.
 *
 * THE PLATE MOVES FIRST, and that is what keeps the colour. Brand hexes are chosen to work on white, so they
 * arrive with separation to spare against a near-white plate and short against a near-black one — the shortfall
 * is nearly all in dark mode. Dragging every mark brighter to cover it is the obvious fix and the wrong one:
 * sRGB has no bright saturated red, so Reddit's orange and YouTube's red come back as salmon, and the brands
 * that looked RIGHT are the ones that get wrecked to rescue the ones that didn't. So the plate slides away from
 * the mark first, within a bounded band, and the mark is only moved for the shortfall the slide could not cover.
 * On the real catalog that leaves the vivid brands on their exact official hex with a darker tile under them,
 * and moves only the genuinely dim ones — Sentry's near-black violet, Paperless' bottle green — which move along
 * their own hue and stay recognisably themselves.
 *
 * ACHROMATIC BRANDS ARE THE ONE EXCEPTION, and they are the reason this is not just a clamp. GitHub, X, Outline
 * and OpenCode are pure black: there is no hue to preserve, and moving one the minimum distance lands it on
 * mid-grey — the exact muddy non-colour this exists to get rid of. So a brand with no chroma starts from the ink
 * it uses in its own dark-mode material — white on dark, black on light — and the placement below then treats
 * that as the colour it is protecting. Crisp, and correct by the brand's own hand.
 *
 * BOTH SCHEMES ARE COMPUTED TOGETHER, once per brand, because the caller cannot know which it will need: the
 * mark is painted from CSS custom properties that the mode flips, so switching theme repaints without re-running
 * any of this and without a second fetch. */

import { clamp01, clampBetween, hexToRgb, type Oklch, oklchToHex, rgbToOklch, srgbToLinear } from "./oklch.js";

/** A brand's four resolved colours — the mark and its plate, in each scheme. */
export interface BrandPalette {
    readonly markLight: string;
    readonly markDark: string;
    readonly plateLight: string;
    readonly plateDark: string;
}

/* Below this chroma a brand has no hue worth preserving — see the achromatic case above. Set just above the
 * chroma OKLCH gives a pure grey (0) with room for the off-blacks (#181717 lands at ~0.0008). */
const ACHROMATIC = 0.03;

/** One scheme's placement rules. The two below are the whole configuration of this file. */
interface Scheme {
    /** Which way the mark lies from its plate: brighter in dark, darker in light. Lets one expression below
     *  say "no closer than" without asking which scheme it is in. */
    readonly direction: 1 | -1;
    /** The guaranteed OKLab lightness distance between mark and plate. Dark asks for more than light because
     *  its marks are the ones that have to survive being the bright thing on a dark field: at equal distance
     *  the dark scheme measures the weaker of the two on any polarity-aware metric. */
    readonly separation: number;
    /** Where the plate sits when nothing forces it elsewhere, and how far it may slide away from the mark to
     *  buy separation before the mark itself is moved. The band is narrow on purpose — the tiles still have to
     *  read as one set on a row, and a plate that chased every brand would leave the grid speckled. */
    readonly plateLightness: number;
    readonly plateLimit: number;
    /** How much of its hue a plate may carry. A tint, not a fill: enough that Docker's tile is faintly blue and
     *  WhatsApp's faintly green, not enough for 35 of them to fight each other or the mark sitting on top. */
    readonly plateChroma: number;
    /** Where a hueless brand starts — the ink the brand itself uses in this scheme. */
    readonly inkLightness: number;
}

const DARK: Scheme = { direction: 1, separation: 0.45, plateLightness: 0.27, plateLimit: 0.16, plateChroma: 0.04, inkLightness: 0.97 };
const LIGHT: Scheme = { direction: -1, separation: 0.42, plateLightness: 0.955, plateLimit: 0.985, plateChroma: 0.03, inkLightness: 0.15 };

/* The sRGB ⇄ OKLCH conversions, the gamut mapping and the small clamps all live in oklch.ts — the placement
 * below is this file's own, the colour space is not. Out of gamut, that module holds L and h and spends
 * CHROMA, which is what keeps the promise made here: the placement asks for a lightness, sRGB has no bright
 * saturated red to answer with, and clipping channels instead would yield the lightness quietly and leave the
 * mark short of the separation that was the entire point. */

const lightnessOf = (hex: string): number => rgbToOklch(hexToRgb(hex) ?? ([0, 0, 0] as const)).L;

/**
 * The perceptual lightness distance between two hex colours — the quantity the placement here guarantees, and
 * so the one worth asserting. Measured over the rounded sRGB the browser will actually paint, not the float
 * behind it, so what is asserted is what ships.
 */
export const lightnessSeparation = (a: string, b: string): number => Math.abs(lightnessOf(a) - lightnessOf(b));

// WCAG relative luminance + contrast ratio. Not what anything here is placed by — see the header for why — but
// kept because it is the number every external audit tool will report, and a floor in it is a useful independent
// check that the placement has not drifted somewhere strange.
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
    // A hueless brand has nothing to protect at its own lightness, so it starts from the scheme's ink and
    // everything below treats THAT as the lightness worth keeping.
    const wanted = brand.C < ACHROMATIC ? scheme.inkLightness : brand.L;
    // The plate goes first, sliding away from the mark as far as the gap needs and its band allows. For most
    // brands the gap is already open and it simply sits where it prefers to.
    const plateLightness = clampBetween(wanted - scheme.direction * scheme.separation, scheme.plateLightness, scheme.plateLimit);
    // Then the mark, which keeps its own lightness unless that would bring it inside the gap the plate just
    // opened. `direction` is what lets this read as "no brighter than needed" in dark and its mirror in light.
    const nearest = plateLightness + scheme.direction * scheme.separation;
    const markLightness = scheme.direction * wanted > scheme.direction * nearest ? wanted : nearest;
    return {
        plate: oklchToHex({ L: plateLightness, C: Math.min(brand.C, scheme.plateChroma), h: brand.h }),
        mark: oklchToHex({ L: clamp01(markLightness), C: brand.C, h: brand.h }),
    };
};

/**
 * Both schemes' mark and plate for one official brand hex (`#rrggbb` or `#rgb`).
 * `undefined` for anything that is not a colour — the caller falls back to its themed tiers.
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
 * The official colour out of a simple-icons SVG. The CDN bakes each brand's own hex into the `fill` of the
 * single path it serves, which makes the fetched mark the source of truth for the colour — no table to keep in
 * step with a set of 3000 brands, and a slug an extension invents next week is coloured correctly with no
 * change here. `undefined` if the document carries no fill (or is not an SVG at all), which reads as "no
 * official colour" and leaves the mark on its themed tier.
 */
export const officialHex = (svg: string): string | undefined => {
    const match = /fill\s*=\s*["']?(#[0-9a-fA-F]{3,8})/.exec(svg);
    const hex = match?.[1];
    // 4- and 8-digit forms carry alpha, which a brand colour has no business doing; the parse rejects them.
    return hex !== undefined && hexToRgb(hex) !== undefined ? hex : undefined;
};
