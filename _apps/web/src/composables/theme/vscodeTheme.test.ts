import { describe, expect, it } from "vitest";
import { compositeOver, parseHexColor, toHex, vscodeThemeToTokens } from "./vscodeTheme";

/* The theme importer is the biggest familiarity lever, so its color math has to be right: VSCode themes ship
 * alpha'd borders/hovers, and getting those wrong is exactly the kind of off-by-a-shade that makes an imported
 * theme look broken. These pin parsing (all four hex shapes), alpha compositing, and the sparse-theme mapping. */

describe(`parseHexColor`, () => {
    it(`parses #RRGGBB and #RRGGBBAA`, () => {
        expect(parseHexColor(`#1e1e1e`)).toEqual({ r: 0x1e, g: 0x1e, b: 0x1e, a: 1 });
        expect(parseHexColor(`#ffffff80`)).toEqual({ r: 255, g: 255, b: 255, a: 128 / 255 });
    });

    it(`expands the shorthand #RGB and #RGBA forms`, () => {
        expect(parseHexColor(`#abc`)).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
        expect(parseHexColor(`#0f08`)).toEqual({ r: 0x00, g: 0xff, b: 0x00, a: 0x88 / 255 });
    });

    it(`tolerates a missing # and rejects non-hex`, () => {
        expect(parseHexColor(`1e1e1e`)).toEqual({ r: 0x1e, g: 0x1e, b: 0x1e, a: 1 });
        expect(parseHexColor(`rgb(0,0,0)`)).toBeUndefined();
        expect(parseHexColor(`#12345`)).toBeUndefined();
    });
});

describe(`compositeOver`, () => {
    it(`composites a translucent foreground over an opaque background`, () => {
        // 50% white over black → mid grey.
        expect(compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 })).toEqual({ r: 128, g: 128, b: 128 });
        // A fully opaque fg ignores the backdrop.
        expect(compositeOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 200, g: 200, b: 200 })).toEqual({ r: 10, g: 20, b: 30 });
    });
});

describe(`vscodeThemeToTokens`, () => {
    it(`maps the identity colors and honors the declared type`, () => {
        const result = vscodeThemeToTokens({
            type: `dark`,
            colors: {
                "editor.background": `#1e1e1e`,
                "editor.foreground": `#d4d4d4`,
                "focusBorder": `#007acc`,
                "textLink.foreground": `#3794ff`,
            },
        });
        expect(result.mode).toBe(`dark`);
        expect(result.tokens[`--color-canvas`]).toBe(`#1e1e1e`);
        expect(result.tokens[`--color-content`]).toBe(`#d4d4d4`);
        expect(result.tokens[`--color-primary-500`]).toBe(`#007acc`);
        expect(result.tokens[`--color-link`]).toBe(`#3794ff`);
    });

    it(`composites an alpha'd border over the resolved canvas instead of stripping alpha`, () => {
        const result = vscodeThemeToTokens({
            type: `dark`,
            colors: {
                "editor.background": `#000000`,
                // 50% white border — the WRONG answer would be #ffffff (alpha stripped); the right one is grey.
                "panel.border": `#ffffff80`,
            },
        });
        expect(result.tokens[`--color-line`]).toBe(`#808080`);
    });

    it(`infers dark vs light from the canvas when type is absent`, () => {
        expect(vscodeThemeToTokens({ colors: { "editor.background": `#ffffff` } }).mode).toBe(`light`);
        expect(vscodeThemeToTokens({ colors: { "editor.background": `#101010` } }).mode).toBe(`dark`);
    });

    it(`fills every token from defaults when the theme is sparse`, () => {
        const result = vscodeThemeToTokens({ type: `light`, colors: {} });
        // All 13 identity tokens are present even with no source colors.
        expect(Object.keys(result.tokens)).toHaveLength(13);
        expect(result.tokens[`--color-canvas`]).toBe(`#ffffff`);
        expect(result.tokens[`--color-content`]).toBeDefined();
    });
});
