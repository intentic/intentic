// @vitest-environment jsdom
//
// THE LADDER, AS THE COMPONENT ACTUALLY CLIMBS IT. brandMark.test.ts asserts what the artwork gate ACCEPTS;
// this asserts what <BrandMark> then DRAWS, which is the half a passing gate cannot promise on its own — a tier
// that resolves and is never reached looks identical, from the gate's side, to one that works.
//
// Mounted with plain Vue rather than @vue/test-utils, as ReviewStat.test.ts and markdownFigures.test.ts do.
import { BrandMark } from "@intentic/ui";
import { describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#6C4FE0"/></svg>`;

/* The tiers as a caller supplies them. Spelled out rather than taken as a loose bag, because `h()` checks what
 * it is handed against the component's own props — so a typo in a tier name here would otherwise mount a mark
 * that declares nothing and quietly assert the fallback it was meant to be testing the absence of. */
interface MarkProps {
    readonly name: string;
    readonly art?: string;
    readonly logo?: string;
    readonly icon?: string;
    readonly flush?: boolean;
}

/* No network, ever. The brand tier fetches, and a suite that reached a CDN would be slow when it worked and red
 * on a train — the same argument extensionMarks.test.ts makes for not checking slugs at all. Stubbed to never
 * resolve rather than to fail, so the "art beats logo" case cannot pass merely because the fetch lost a race. */
const mount = async (props: MarkProps): Promise<HTMLElement> => {
    globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
    const host = document.createElement(`div`);
    document.body.appendChild(host);
    createApp({ render: () => h(BrandMark, { size: 28, ...props }) }).mount(host);
    await nextTick();
    return host;
};

describe(`BrandMark tiers`, () => {
    it(`draws the artwork as an inert <img>, carrying the document it was given`, async () => {
        const host = await mount({ name: `intentic.example`, art: MARK });
        const img = host.querySelector(`img`);
        expect(img, `artwork should render as an <img>, never inline — see the component's note`).not.toBeNull();
        expect(decodeURIComponent((img?.getAttribute(`src`) ?? ``).replace(/^data:image\/svg\+xml,/u, ``))).toBe(MARK);
    });

    it(`lets artwork beat a brand slug and a glyph, so an author's own mark is the one drawn`, async () => {
        const host = await mount({ name: `intentic.example`, art: MARK, logo: `discord`, icon: `sparkles` });
        expect(host.querySelector(`img`)).not.toBeNull();
        // The monogram is the tell that a lower tier got in: it is the only one that renders as text.
        expect(host.textContent?.trim()).toBe(``);
    });

    it(`falls to the glyph when the artwork would not draw, rather than leaving a hole`, async () => {
        // A truncated document — the realistic failure, and the one that would otherwise paint a broken image.
        const host = await mount({ name: `intentic.example`, art: `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#6C`, icon: `sparkles` });
        expect(host.querySelector(`img`)).toBeNull();
        expect(host.textContent?.trim(), `a declared glyph should carry the row, not its initials`).toBe(``);
    });

    it(`falls all the way to initials when nothing above them can draw`, async () => {
        const host = await mount({ name: `intentic.example`, art: `not a document`, icon: `no-such-glyph-in-this-build` });
        expect(host.querySelector(`img`)).toBeNull();
        expect(host.textContent?.trim()).toBe(`IE`);
    });

    /* WHICH TIER DRAWS AND WHICH SHAPE IT DRAWS IN ARE INDEPENDENT, and this is here because the two arrived
     * from different branches and met for the first time in a merge. `flush` governs the outline — the caller's
     * card already has a border, so the mark drops its own — and it must have no opinion at all about artwork.
     * Folding either into the other reads as a tidy-up and silently costs a whole shape somebody asks for. */
    it(`still draws artwork as a flush band, where the outline belongs to the card around it`, async () => {
        const host = await mount({ name: `intentic.example`, art: MARK, flush: true });
        const box = host.firstElementChild;
        expect(host.querySelector(`img`), `flush governs the border, not which tier draws`).not.toBeNull();
        expect(box?.className, `a flush mark sits inside a border that is already drawn`).not.toContain(`border-line`);
        // The plate is artwork's call in either shape: a drawing brings its own square.
        expect(box?.className).not.toContain(`bg-content/5`);
    });

    it(`keeps its own border and plate as a badge, which is the other shape`, async () => {
        const host = await mount({ name: `intentic.example`, icon: `sparkles` });
        const box = host.firstElementChild;
        expect(box?.className).toContain(`border-line`);
        expect(box?.className, `a glyph needs the plate a drawing would have replaced`).toContain(`bg-content/5`);
    });
});
