// The pointer's look over castd's picture: a keyword as it is, the X cursor's own image at the screen's density with its
// hotspot in CSS px, and nothing from the wire that could break out of the declaration.
import { cursorCss } from "./cursorCss";

const PNG = `iVBORw0KGgo=`;

it("passes a CSS keyword through, and falls back to the default arrow for none", () => {
    expect(cursorCss({ css: `text` }, 1, true)).toBe(`text`);
    expect(cursorCss({}, 1, true)).toBe(`default`);
    expect(cursorCss(undefined, 2, true)).toBe(`default`);
});

it("shows the X cursor's image at its own size, hotspot as sent, keyword behind it", () => {
    expect(cursorCss({ png: PNG, hotX: 4, hotY: 7, css: `pointer` }, 1, true)).toBe(`url("data:image/png;base64,${PNG}") 4 7, pointer`);
});

it("draws the image at the screen's density on a DPR-2 screen, hotspot in CSS px", () => {
    expect(cursorCss({ png: PNG, hotX: 9, hotY: 4 }, 2, true)).toBe(`image-set(url("data:image/png;base64,${PNG}") 2x) 5 2, default`);
});

it("falls back to the image at its own size where the browser takes no image-set in a cursor", () => {
    expect(cursorCss({ png: PNG, hotX: 9, hotY: 4 }, 2, false)).toBe(`url("data:image/png;base64,${PNG}") 9 4, default`);
});

it("takes nothing from the wire that could leave the url or the declaration", () => {
    expect(cursorCss({ png: `abc") ; background: red; ("`, css: `move` }, 1, true)).toBe(`move`);
    expect(cursorCss({ css: `pointer; color: red` }, 1, true)).toBe(`default`);
});
