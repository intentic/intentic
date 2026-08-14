// The subpath, not the barrel: brandMark.ts is a string gate and an encoder, and `@intentic/ui` would drag the
// whole component graph (and a `window`) into a node-environment suite. Same reason its two sibling suites
// import `@intentic/ui/brand-color` and `@intentic/ui/icons`.
import { artSrc } from "@intentic/ui/brand-mark";
import { describe, expect, it } from "vitest";

/* WHAT A REGISTRY ROW IS ALLOWED TO PAINT.
 *
 * `art` is the one mark tier whose document comes from a stranger — a row in somebody's registry, rendered by
 * this app before a line of the extension's code has been cloned — and it is the only one that arrives as a
 * whole document rather than as a name to look up. Both halves of that need holding down.
 *
 * The SAFETY half is not this function's to hold and must not be mistaken for it: the document goes to an
 * <img>, where the browser refuses script and external references whatever the bytes say. What is asserted
 * here is that the gate never PAINTS a hole — every string that would put the browser's broken-image glyph in
 * a 28px tile has to answer `undefined`, so the ladder drops to a tier that has something real to draw.
 *
 * The ENCODING half is asserted because it fails silently and totally. Every mark worth drawing carries `#`
 * in a fill, `#` opens a URL fragment, and an unescaped one truncates the data URI at the first colour —
 * which is not a broken tile but a subtly wrong one, on every mark at once. */

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#6C4FE0"/></svg>`;

describe(`artSrc`, () => {
    it(`turns a drawn mark into a data URI an <img> will load`, () => {
        const src = artSrc(MARK);
        expect(src).toBeDefined();
        expect(src).toMatch(/^data:image\/svg\+xml,/u);
    });

    it(`escapes the fragment character, so a mark keeps every colour past its first`, () => {
        // The whole failure this catches: `fill="#6C4FE0"` unescaped ends the URI at the `#`, and what loads is
        // a document truncated mid-attribute — one that still parses, and paints in the wrong colour or not at all.
        const src = artSrc(MARK) ?? ``;
        expect(src).not.toContain(`#`);
        expect(decodeURIComponent(src.replace(/^data:image\/svg\+xml,/u, ``))).toBe(MARK);
    });

    it(`accepts a document that opens with a prolog or a comment, which exported files do`, () => {
        expect(artSrc(`<?xml version="1.0"?>${MARK}`)).toBeDefined();
        expect(artSrc(`<!-- drawn by hand -->${MARK}`)).toBeDefined();
    });

    it(`accepts surrounding whitespace, which JSON-embedded documents collect`, () => {
        expect(artSrc(`\n  ${MARK}\n`)).toBeDefined();
    });

    for (const [label, value] of [
        [`nothing declared`, undefined],
        [`an empty field`, ``],
        [`whitespace only`, `   \n `],
        [`a URL, in the field that takes a document`, `https://example.com/mark.svg`],
        [`base64, in the field that takes readable SVG`, `PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=`],
        [`a document truncated mid-attribute`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect fill="#6C`],
        [`a document truncated just short of its close`, `<svg xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32"/>`],
        [`an empty root, which is valid SVG that paints an invisible tile`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>`],
        [`markup that is not SVG at all`, `<html><body>nope</body></html>`],
        [`a bare word`, `sparkles`],
    ] as const) {
        it(`draws the tier below for ${label}`, () => {
            expect(artSrc(value)).toBeUndefined();
        });
    }

    it(`refuses a mark carrying script — belt to the <img>'s braces, and said out loud`, () => {
        /* NOT the security boundary. An SVG in an <img> never runs script, so this changes no outcome an
         * attacker cares about — it is here so that "a mark with script in it is not a mark we draw" is a
         * sentence a registry reviewer can rely on rather than infer, and so that removing the <img> for an
         * inline <svg> someday breaks a test instead of a person. */
        expect(artSrc(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)).toBeUndefined();
    });
});
