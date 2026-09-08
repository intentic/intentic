// The subpath, not the barrel: brandMark.ts is a string gate and an encoder, and `@intentic/ui` would drag the whole
// component graph (and a `window`) into a node-environment suite.
import { artSrc } from "@intentic/ui/brand-mark";
import { describe, expect, it } from "vitest";

// What a registry row is allowed to paint. `art` is the one mark tier whose document comes from a stranger, arriving as
// a whole document rather than a name to look up.
//
// Safety is not this function's to hold: the document goes to an <img>, where the browser refuses script and external
// references regardless. What is asserted is that the gate never paints a hole: a string that would show a broken-image
// glyph must answer `undefined` so the ladder drops to a tier with something real to draw.
//
// Encoding is asserted because it fails silently: `#` in a fill opens a URL fragment, and unescaped it truncates the
// data URI at the first colour, which is a subtly wrong tile rather than a broken one.

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#6C4FE0"/></svg>`;

describe(`artSrc`, () => {
    it(`turns a drawn mark into a data URI an <img> will load`, () => {
        const src = artSrc(MARK);
        expect(src).toEqual(expect.any(String));
        expect(src).toMatch(/^data:image\/svg\+xml,/u);
    });

    it(`escapes the fragment character, so a mark keeps every colour past its first`, () => {
        // The whole failure this catches: `fill="#6C4FE0"` unescaped ends the URI at the `#`, loading a document
        // truncated mid-attribute that still parses but paints the wrong colour or none at all.
        const src = artSrc(MARK) ?? ``;
        expect(src).not.toContain(`#`);
        expect(decodeURIComponent(src.replace(/^data:image\/svg\+xml,/u, ``))).toBe(MARK);
    });

    it(`accepts a document that opens with a prolog or a comment, which exported files do`, () => {
        expect(artSrc(`<?xml version="1.0"?>${MARK}`)).toEqual(expect.any(String));
        expect(artSrc(`<!-- drawn by hand -->${MARK}`)).toEqual(expect.any(String));
    });

    it(`accepts surrounding whitespace, which JSON-embedded documents collect`, () => {
        expect(artSrc(`\n  ${MARK}\n`)).toEqual(expect.any(String));
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

    it(`refuses a mark carrying script: belt to the <img>'s braces, and said out loud`, () => {
        // Not the security boundary: an SVG in an <img> never runs script, so this changes no outcome an attacker cares
        // about. It exists so "a mark with script in it is not a mark we draw" is a sentence a reviewer can rely on
        // rather than infer.
        expect(artSrc(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)).toBeUndefined();
    });
});
