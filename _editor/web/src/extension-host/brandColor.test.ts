// The subpath, not the barrel: brandColor.ts is pure arithmetic, and `@intentic/ui` would drag the whole
// component graph (and a `window`) into a node-environment suite. Same reason the sibling suite imports
// `@intentic/ui/icons`.
import { brandPalette, contrastRatio, lightnessSeparation, officialHex } from "@intentic/ui/brand-color";
import { describe, expect, it } from "vitest";

/* EVERY BRAND IN THE CATALOG IS LEGIBLE IN BOTH SCHEMES, AND KEEPS AS MUCH OF ITS OWN COLOUR AS THAT ALLOWS.
 *
 * The marks were painted in the theme's text colour for a real reason: honouring a brand hex left most of them
 * unreadable on the dark card, and the fix (brandColor.ts) is arithmetic, which means it can be wrong quietly.
 * A plate band narrowed, a chroma ceiling raised, an achromatic threshold moved: any of those can put a mark
 * back under the bar, and nothing on screen says so until somebody squints at the one tile that went dim. So the
 * bar is asserted here, over the REAL hexes the CDN serves, in both schemes.
 *
 * THE BAR IS THE PERCEPTUAL ONE, because the WCAG one is what let this go wrong the first time. An earlier cut
 * asked for a WCAG 2.x ratio of 3:1, passed on every brand, and still left PostgreSQL, MySQL, Sentry and Redmine
 * looking like dirt on the dark card: that ratio is not perceptual and not symmetric between schemes, so one
 * number in it does not mean one thing. What is asserted first is therefore the distance brandColor.ts actually
 * places by. The WCAG floor is kept underneath it as an independent check in the metric every external audit
 * tool reports, and it is set at 4 rather than 3 because the placement clears that in both schemes with room to
 * spare: if a change drops it back toward 3, something has drifted even if the separation still just passes.
 *
 * The hexes are pinned rather than fetched, for the reason the sibling suite gives for not checking slugs at
 * all: a test that reaches a CDN fails on a train. What is under test is the arithmetic, not the network, and a
 * brand that rebrands changes what the CDN sends, not whether this maths clears the bar on what it is given. */

// As served by cdn.simpleicons.org, which bakes each brand's official colour into the mark it returns.
const CATALOG = {
    docker: `#2496ED`,
    discord: `#5865F2`,
    github: `#181717`,
    gitlab: `#FC6D26`,
    googlegemini: `#8E75B2`,
    invoiceninja: `#000000`,
    linux: `#FCC624`,
    mysql: `#4479A1`,
    npm: `#CB3837`,
    opencode: `#000000`,
    openproject: `#0770B8`,
    outline: `#000000`,
    paperlessngx: `#17541F`,
    pnpm: `#F69220`,
    postgresql: `#4169E1`,
    reddit: `#FF4500`,
    redmine: `#B32024`,
    sentry: `#362D59`,
    stripe: `#635BFF`,
    telegram: `#26A5E4`,
    turborepo: `#FF1E56`,
    whatsapp: `#25D366`,
    x: `#000000`,
    youtube: `#FF0000`,
} as const;

/* The distances brandColor.ts places by, asserted a hair under so the 8-bit rounding of the final hex can land
 * on the boundary rather than a whisker below it. Dark asks for more than light for the reason the module gives:
 * at equal distance the bright-on-dark pairing is the weaker of the two. */
const MIN_SEPARATION_DARK = 0.44;
const MIN_SEPARATION_LIGHT = 0.41;
// The independent cross-check, in the metric everything outside this repo measures in.
const MIN_CONTRAST = 4;

describe(`brand mark colours`, () => {
    for (const [slug, hex] of Object.entries(CATALOG)) {
        it(`clears the separation bar in both schemes: ${slug}`, () => {
            const palette = brandPalette(hex);
            expect(palette).toBeDefined();
            expect(lightnessSeparation(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThanOrEqual(MIN_SEPARATION_DARK);
            expect(lightnessSeparation(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_SEPARATION_LIGHT);
            expect(contrastRatio(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThanOrEqual(MIN_CONTRAST);
            expect(contrastRatio(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_CONTRAST);
        });
    }

    /* THE RECOGNITION HALF, and the one that would otherwise rot. Clearing contrast is easy on its own: paint
     * everything white and the suite goes green while the catalog looks exactly as dead as it did before.
     *
     * Which brands arrive untouched is a fact about WHERE THE ROOM IS, and it splits by scheme because a brand
     * hex is chosen to work on white. The bright brands have the room on a dark plate, so dark mode is where
     * Docker's blue, Reddit's orange, Linux's yellow and YouTube's red arrive exactly as their owners set them.
     * The dark brands have it on a near-white plate, so light mode is where PostgreSQL's, npm's, Sentry's and
     * Redmine's exact hexes survive. A brand dropping out of its list means the plate stopped covering for it
     * and the mark is being repainted instead, which is the change that quietly drains the grid. */
    const EXACT_IN_DARK = [`docker`, `gitlab`, `googlegemini`, `linux`, `pnpm`, `reddit`, `telegram`, `turborepo`, `whatsapp`, `youtube`] as const;
    for (const slug of EXACT_IN_DARK) {
        it(`paints the exact official hex on the dark plate: ${slug}`, () => {
            expect(brandPalette(CATALOG[slug])?.markDark.toLowerCase()).toBe(CATALOG[slug].toLowerCase());
        });
    }

    const EXACT_IN_LIGHT = [`mysql`, `npm`, `openproject`, `paperlessngx`, `postgresql`, `redmine`, `sentry`] as const;
    for (const slug of EXACT_IN_LIGHT) {
        it(`paints the exact official hex on the light plate: ${slug}`, () => {
            expect(brandPalette(CATALOG[slug])?.markLight.toLowerCase()).toBe(CATALOG[slug].toLowerCase());
        });
    }

    /* A hueless brand has no colour to protect, and moving it the minimum distance lands it on mid-grey: the
     * exact muddy non-colour the whole change exists to remove. It must snap to the ink the brand itself uses:
     * white on dark, black on light. Pinned as a contrast floor far above the bar, because "crisp" is the
     * property and the bar alone would be satisfied by the grey. */
    for (const slug of [`github`, `x`, `outline`, `opencode`, `invoiceninja`] as const) {
        it(`snaps a hueless brand to the scheme's ink, ${slug}`, () => {
            const palette = brandPalette(CATALOG[slug]);
            expect(contrastRatio(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThan(10);
            expect(contrastRatio(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThan(10);
        });
    }

    it(`keeps a moved mark on its own hue rather than draining it`, () => {
        // Sentry's near-black violet is the mark that was effectively invisible before any of this, so it is the
        // one the plate cannot rescue on its own and the one that has to move. It has to stay violet doing it:
        // blue channel clearly ahead of red, red clearly ahead of green, exactly as the official #362D59 is
        // ordered.
        const dark = brandPalette(CATALOG.sentry)?.markDark ?? ``;
        const [r, g, b] = [dark.slice(1, 3), dark.slice(3, 5), dark.slice(5, 7)].map((c) => parseInt(c, 16));
        expect(b ?? 0).toBeGreaterThan(r ?? 0);
        expect(r ?? 0).toBeGreaterThan(g ?? 0);
    });

    it(`spends chroma, not lightness, when sRGB cannot hold the colour it is asked for`, () => {
        /* YouTube's red on the light plate is the case that catches a per-channel clip. The placement asks for
         * #FF0000's hue and chroma at a much lower lightness, and sRGB has no such colour: something has to
         * give. Clipping gives up lightness silently, landing short of the separation that was the point; the
         * gamut mapping gives up chroma and keeps the promise. So: the distance is met exactly, the hue is still
         * pure red, and the colour is duller than the official one rather than lighter. */
        const palette = brandPalette(CATALOG.youtube);
        const mark = palette?.markLight ?? ``;
        expect(lightnessSeparation(mark, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_SEPARATION_LIGHT);
        const [r, g, b] = [mark.slice(1, 3), mark.slice(3, 5), mark.slice(5, 7)].map((c) => parseInt(c, 16));
        expect(g).toBe(0);
        expect(b).toBe(0);
        expect(r ?? 0).toBeLessThan(0xff);
    });

    it(`reads the official colour out of the document the CDN serves`, () => {
        expect(officialHex(`<svg role="img" viewBox="0 0 24 24"><title>Docker</title><path d="M0 0h1" fill="#2496ED"/></svg>`)).toBe(`#2496ED`);
        // An error page or a redirect served as 200 carries no brand colour, and must not be mistaken for one.
        expect(officialHex(`<html><body>Not Found</body></html>`)).toBeUndefined();
    });

    it(`declines anything that is not a colour, so the mark falls to its themed tiers`, () => {
        expect(brandPalette(``)).toBeUndefined();
        expect(brandPalette(`currentColor`)).toBeUndefined();
        expect(brandPalette(`#12345`)).toBeUndefined();
    });
});
