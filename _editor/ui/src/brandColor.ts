/* A BRAND'S OWN COLOUR, MADE LEGIBLE ON OUR OWN PLATE — the colour half of <BrandMark>.
 *
 * The marks used to be painted in the theme's text colour, every one of them, and the reason was sound: a brand
 * hex is picked to work on white, and a capability tile is white in one scheme and near-black in the other
 * across four themes, so honouring the hex put 13 of 20 marks under 3:1 on the dark card (Sentry at 1.05:1 was
 * not visible at all). What that bought was legibility and what it cost was recognition — a grid of 35
 * identical grey glyphs, which is how the catalog came to read as a graveyard.
 *
 * BOTH ARE AVAILABLE, and the move that gets them is to stop treating the plate as a fixed surface the mark has
 * to survive. Here each mark brings its OWN plate, derived from its own hue and OPAQUE — which is what takes the
 * four themes out of the question entirely. The plate's lightness is pinned (near-white in light, near-black in
 * dark), so the contrast the mark has to clear is known here rather than being a fact about whichever theme is
 * loaded, and every tile still weighs the same on the row because every plate shares one lightness and one
 * chroma ceiling.
 *
 * THE MARK THEN MOVES AS LITTLE AS POSSIBLE. Hue and chroma are never touched — they are the brand — and
 * lightness is nudged only until the mark clears 3:1 against its plate (WCAG 1.4.11: a logo is a graphical
 * object, not text). On the real catalog that leaves 15 of 24 marks on their EXACT official hex in dark and 17
 * of 24 in light: Docker's blue, npm's red, Linux's yellow, Reddit's orange all arrive untouched. The ones that
 * move are the ones that genuinely cannot be seen otherwise — Sentry's near-black violet, Paperless' bottle
 * green — and they move along their own hue, so they stay recognisably themselves.
 *
 * ACHROMATIC BRANDS ARE THE ONE EXCEPTION, and they are the reason this is not just a clamp. GitHub, X, Outline
 * and OpenCode are pure black: there is no hue to preserve, and nudging one the minimum distance lands it on
 * mid-grey — the exact muddy non-colour this exists to get rid of. So a brand with no chroma snaps to the ink it
 * uses in its own dark-mode material: white on dark, black on light. Crisp, and correct by the brand's own
 * hand.
 *
 * BOTH SCHEMES ARE COMPUTED TOGETHER, once per brand, because the caller cannot know which it will need: the
 * mark is painted from CSS custom properties that the mode flips, so switching theme repaints without re-running
 * any of this and without a second fetch. */

/** A brand's four resolved colours — the mark and its plate, in each scheme. */
export interface BrandPalette {
    readonly markLight: string;
    readonly markDark: string;
    readonly plateLight: string;
    readonly plateDark: string;
}

/* WCAG 1.4.11 non-text contrast. The bar for a logo, and deliberately not the 4.5:1 text bar: at 4.5 the nudge
 * pulls 18 of 24 marks off their official hex for a glyph that carries no reading load, which trades away the
 * recognition this is for. */
const MIN_CONTRAST = 3;
/* Below this chroma a brand has no hue worth preserving — see the achromatic case above. Set just above the
 * chroma OKLCH gives a pure grey (0) with room for the off-blacks (#181717 lands at ~0.0008). */
const ACHROMATIC = 0.03;
/* The plate's pinned lightness, and the mark's when a hueless brand snaps to the scheme's ink. The plates sit a
 * touch off the card they lie on (cards are ~0.99 light / ~0.22–0.24 dark across the themes) so a tile reads as
 * a plate rather than as a hole. */
const PLATE_L_LIGHT = 0.955;
const PLATE_L_DARK = 0.27;
const INK_L_LIGHT = 0.15;
const INK_L_DARK = 0.97;
/* How much of its hue a plate may carry. A tint, not a fill: enough that Docker's tile is faintly blue and
 * WhatsApp's faintly green, not enough for 35 of them to fight each other or the mark sitting on top. */
const PLATE_C_LIGHT = 0.03;
const PLATE_C_DARK = 0.04;

interface Lch {
    readonly L: number;
    readonly C: number;
    readonly h: number;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));

const hexToRgb = (hex: string): readonly [number, number, number] | undefined => {
    const raw = hex.trim().replace(/^#/, ``);
    // Both forms the wild serves: #rgb and #rrggbb.
    const full = raw.length === 3 ? [...raw].map((c) => `${c}${c}`).join(``) : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) {
        return undefined;
    }
    return [
        parseInt(full.slice(0, 2), 16) / 255,
        parseInt(full.slice(2, 4), 16) / 255,
        parseInt(full.slice(4, 6), 16) / 255,
    ] as const;
};

const rgbToHex = (rgb: readonly [number, number, number]): string =>
    `#${rgb.map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, `0`)).join(``)}`;

// --- sRGB ⇄ OKLab. The matrices are Björn Ottosson's published constants; OKLab is used rather than HSL
// because lightness there is perceptual, so nudging L leaves the hue where the brand put it. HSL's `l` does
// not: raising it on a saturated blue swings the hue visibly toward cyan.
const rgbToOklch = (rgb: readonly [number, number, number]): Lch => {
    const [R, G, B] = [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
};

const oklchToHex = ({ L, C, h }: Lch): string => {
    const a = Math.cos(h) * C;
    const b = Math.sin(h) * C;
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    // Out-of-gamut combinations clip per channel. Only the plates and the snapped inks can reach for one, and
    // both sit well inside sRGB at the lightnesses pinned above.
    return rgbToHex([
        linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearToSrgb(-0.004196086 * l - 0.7034186147 * m + 1.707614701 * s),
    ]);
};

// WCAG relative luminance + contrast ratio, over the sRGB hex the browser will actually paint — computed on the
// rounded output rather than on the float, so what is asserted is what ships.
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

const plateFor = (brand: Lch, dark: boolean): string =>
    oklchToHex({
        L: dark ? PLATE_L_DARK : PLATE_L_LIGHT,
        C: Math.min(brand.C, dark ? PLATE_C_DARK : PLATE_C_LIGHT),
        h: brand.h,
    });

/* The mark: the official colour where it can be seen, and the smallest step along its own lightness where it
 * cannot. Stepping in 1% increments rather than solving for L directly because the target is a ratio over
 * ROUNDED sRGB — the 8-bit rounding is not monotonic enough to invert cleanly, and 100 steps of cheap integer
 * maths is nothing beside the fetch that produced the hex. */
const markFor = (brand: Lch, plate: string, dark: boolean): string => {
    if (brand.C < ACHROMATIC) {
        return oklchToHex({ ...brand, L: dark ? INK_L_DARK : INK_L_LIGHT });
    }
    const step = dark ? 0.01 : -0.01;
    let L = brand.L;
    for (let i = 0; i <= 100; i += 1) {
        const hex = oklchToHex({ ...brand, L });
        if (contrastRatio(hex, plate) >= MIN_CONTRAST) {
            return hex;
        }
        L += step;
        if (L > 1 || L < 0) {
            break;
        }
    }
    // Nothing along this hue clears the bar (a chroma so high that every lightness stays mid-tone). The
    // scheme's ink is the honest fallback: legible, and still the brand's hue at its extreme.
    return oklchToHex({ ...brand, L: dark ? INK_L_DARK : INK_L_LIGHT });
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
    const plateLight = plateFor(brand, false);
    const plateDark = plateFor(brand, true);
    return {
        plateLight,
        plateDark,
        markLight: markFor(brand, plateLight, false),
        markDark: markFor(brand, plateDark, true),
    };
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
