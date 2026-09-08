// The subpath, not the barrel: brandColor.ts is pure arithmetic, and `@intentic/ui` would drag the whole component
// graph (and a `window`) into a node-environment suite.
import { brandPalette, contrastRatio, lightnessSeparation, officialHex } from "@intentic/ui/brand-color";
import { describe, expect, it } from "vitest";

// Every brand in the catalog is legible in both schemes and keeps as much of its own colour as that allows. The marks
// are painted in the theme's text colour where honouring the brand hex would be unreadable; brandColor.ts computes that
// arithmetically, so it can be wrong quietly, which is why the bar is asserted here over the real CDN hexes in both
// schemes.
//
// The bar is the perceptual one: a plain WCAG ratio is not perceptual or symmetric between schemes and can pass while a
// mark still reads as dirt on the dark card. The WCAG floor is kept as an independent check, set at 4 rather than the
// usual 3 since the real placement clears it with room to spare.
//
// Hexes are pinned rather than fetched, so the test does not depend on network access; what is under test is the
// arithmetic, not the CDN.

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

// The distances brandColor.ts places by, asserted a hair under so 8-bit rounding can land on the boundary rather than a
// whisker below it. Dark asks for more than light since at equal distance the bright-on-dark pairing is the weaker of
// the two.
const MIN_SEPARATION_DARK = 0.44;
const MIN_SEPARATION_LIGHT = 0.41;
// The independent cross-check, in the metric everything outside this repo measures in.
const MIN_CONTRAST = 4;

describe(`brand mark colours`, () => {
    for (const [slug, hex] of Object.entries(CATALOG)) {
        it(`clears the separation bar in both schemes: ${slug}`, () => {
            const palette = brandPalette(hex);
            expect(lightnessSeparation(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThanOrEqual(MIN_SEPARATION_DARK);
            expect(lightnessSeparation(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_SEPARATION_LIGHT);
            expect(contrastRatio(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThanOrEqual(MIN_CONTRAST);
            expect(contrastRatio(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_CONTRAST);
        });
    }

    // The recognition half, which would otherwise rot: clearing contrast alone is easy (paint everything white) while
    // the catalog looks just as dead.
    //
    // Which brands arrive untouched is a fact about where the room is, split by scheme since a brand hex is chosen to
    // work on white: bright brands keep their exact hex on the dark plate, dark brands on the near-white light plate. A
    // brand dropping out of its list means the plate stopped covering for it and the mark is being repainted instead.
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

    // A hueless brand has no colour to protect, and moving it the minimum distance would land it on mid-grey, the muddy
    // non-colour the change exists to remove. It must snap to the scheme's ink instead: white on dark, black on light.
    for (const slug of [`github`, `x`, `outline`, `opencode`, `invoiceninja`] as const) {
        it(`snaps a hueless brand to the scheme's ink, ${slug}`, () => {
            const palette = brandPalette(CATALOG[slug]);
            expect(contrastRatio(palette?.markDark ?? ``, palette?.plateDark ?? ``)).toBeGreaterThan(10);
            expect(contrastRatio(palette?.markLight ?? ``, palette?.plateLight ?? ``)).toBeGreaterThan(10);
        });
    }

    it(`keeps a moved mark on its own hue rather than draining it`, () => {
        // Sentry's near-black violet is the mark that was effectively invisible before this, so it is the one that has
        // to move, and it must stay violet doing it: blue clearly ahead of red, red clearly ahead of green, as the
        // official hex orders them.
        const dark = brandPalette(CATALOG.sentry)?.markDark ?? ``;
        const [r, g, b] = [dark.slice(1, 3), dark.slice(3, 5), dark.slice(5, 7)].map((c) => Number.parseInt(c, 16));
        expect(b ?? 0).toBeGreaterThan(r ?? 0);
        expect(r ?? 0).toBeGreaterThan(g ?? 0);
    });

    it(`spends chroma, not lightness, when sRGB cannot hold the colour it is asked for`, () => {
        // YouTube's red on the light plate catches a per-channel clip: sRGB has no colour at #FF0000's hue and chroma
        // at the needed lightness. Clipping would silently give up lightness short of the separation target; gamut
        // mapping gives up chroma instead and keeps the promise, landing duller than official rather than lighter.
        const palette = brandPalette(CATALOG.youtube);
        const mark = palette?.markLight ?? ``;
        expect(lightnessSeparation(mark, palette?.plateLight ?? ``)).toBeGreaterThanOrEqual(MIN_SEPARATION_LIGHT);
        const [r, g, b] = [mark.slice(1, 3), mark.slice(3, 5), mark.slice(5, 7)].map((c) => Number.parseInt(c, 16));
        expect(g).toBe(0);
        expect(b).toBe(0);
        expect(r ?? 0).toBeLessThan(0xff);
    });

    it(`reads the official colour out of the document the CDN serves`, () => {
        expect(officialHex(`<svg role="img" viewBox="0 0 24 24"><title>Docker</title><path d="M0 0h1" fill="#2496ED"/></svg>`)).toBe(`#2496ED`);
        // An error page or redirect served as 200 carries no brand colour and must not be mistaken for one.
        expect(officialHex(`<html><body>Not Found</body></html>`)).toBeUndefined();
    });

    it(`declines anything that is not a colour, so the mark falls to its themed tiers`, () => {
        expect(brandPalette(``)).toBeUndefined();
        expect(brandPalette(`currentColor`)).toBeUndefined();
        expect(brandPalette(`#12345`)).toBeUndefined();
    });
});
