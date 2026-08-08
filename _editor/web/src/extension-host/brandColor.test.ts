// The subpath, not the barrel: brandColor.ts is pure arithmetic, and `@intentic/ui` would drag the whole
// component graph (and a `window`) into a node-environment suite. Same reason the sibling suite imports
// `@intentic/ui/icons`.
import { brandPalette, contrastRatio, officialHex } from "@intentic/ui/brand-color";
import { describe, expect, it } from "vitest";

/* EVERY BRAND IN THE CATALOG IS LEGIBLE IN BOTH SCHEMES, AND KEEPS AS MUCH OF ITS OWN COLOUR AS THAT ALLOWS.
 *
 * The marks were painted in the theme's text colour for a real reason — honouring a brand hex put 13 of 20 of
 * them under 3:1 on the dark card — and the fix (brandColor.ts) is arithmetic, which means it can be wrong
 * quietly. A plate lightness nudged, a chroma ceiling raised, an achromatic threshold moved: any of those can
 * put a mark back under the bar, and nothing on screen says so until somebody squints at the one tile that went
 * dim. So the bar is asserted here, over the REAL hexes the CDN serves, in both schemes.
 *
 * The hexes are pinned rather than fetched, for the reason the sibling suite gives for not checking slugs at
 * all: a test that reaches a CDN fails on a train. What is under test is the arithmetic, not the network — and a
 * brand that rebrands changes what the CDN sends, not whether this maths clears 3:1 on what it is given.
 *
 * The SECOND assertion is the one that would otherwise rot. Clearing contrast is easy on its own: paint
 * everything white and the suite goes green while the catalog looks exactly as dead as it did before. So the
 * mid-tone brands are pinned to their EXACT official hex — that is the whole point of the exercise, and it is
 * the property a well-meant "just raise the contrast target" would silently trade away. */

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

// WCAG 1.4.11: a logo is a graphical object, so 3:1 is the bar. Asserted a hair under to leave the 8-bit
// rounding of the final hex room to land on the boundary rather than a whisker below it.
const MIN_CONTRAST = 2.99;

describe(`brand mark colours`, () => {
    for (const [slug, hex] of Object.entries(CATALOG)) {
        it(`clears the contrast bar in both schemes — ${slug}`, () => {
            const palette = brandPalette(hex);
            expect(palette).toBeDefined();
            expect(contrastRatio(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_CONTRAST);
            expect(contrastRatio(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThanOrEqual(MIN_CONTRAST);
        });
    }

    /* The brands whose official colour is already legible on both plates, which must therefore arrive UNTOUCHED.
     * These are the ones carrying the recognition: Docker's blue, npm's red, Linux's yellow, Reddit's orange. If
     * a change to the arithmetic starts rewriting these, the catalog is drifting back toward the grey grid this
     * replaced — whatever the contrast assertions above say. */
    const UNTOUCHED_IN_BOTH = [`discord`, `googlegemini`, `mysql`, `npm`, `postgresql`, `stripe`, `youtube`] as const;
    for (const slug of UNTOUCHED_IN_BOTH) {
        it(`paints the exact official hex in both schemes — ${slug}`, () => {
            const hex = CATALOG[slug];
            const palette = brandPalette(hex);
            expect(palette?.markLight.toLowerCase()).toBe(hex.toLowerCase());
            expect(palette?.markDark.toLowerCase()).toBe(hex.toLowerCase());
        });
    }

    /* A hueless brand has no colour to protect, and the minimum nudge lands it on mid-grey — the exact muddy
     * non-colour the whole change exists to remove. It must snap to the ink the brand itself uses: white on
     * dark, black on light. Pinned as a contrast floor far above the 3:1 bar, because "crisp" is the property
     * and 3:1 would be satisfied by the grey. */
    for (const slug of [`github`, `x`, `outline`, `opencode`, `invoiceninja`] as const) {
        it(`snaps a hueless brand to the scheme's ink — ${slug}`, () => {
            const palette = brandPalette(CATALOG[slug]);
            expect(contrastRatio(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThan(10);
            expect(contrastRatio(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThan(10);
        });
    }

    it(`keeps a nudged mark on its own hue rather than draining it`, () => {
        // Sentry's near-black violet is the mark that was invisible at 1.05:1, so it is the one that has to
        // move — and it has to stay violet doing it. Blue channel clearly ahead of red, red clearly ahead of
        // green, exactly as the official #362D59 is ordered.
        const dark = brandPalette(CATALOG.sentry)?.markDark ?? ``;
        const [r, g, b] = [dark.slice(1, 3), dark.slice(3, 5), dark.slice(5, 7)].map((c) => parseInt(c, 16));
        expect(b ?? 0).toBeGreaterThan(r ?? 0);
        expect(r ?? 0).toBeGreaterThan(g ?? 0);
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
