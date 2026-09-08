// @vitest-environment jsdom
import { expect, it } from "vitest";
import { growTextarea } from "@intentic/ui";

// The arithmetic four composers used to each carry, pinned here since @intentic/ui has no test runner. jsdom lays
// nothing out, so `scrollHeight` is stubbed: what is under test is what the function does with a measurement.
const textarea = (scrollHeight: number, css: Partial<CSSStyleDeclaration> = {}): HTMLTextAreaElement => {
    const element = document.createElement(`textarea`);
    Object.assign(element.style, { lineHeight: `20px`, paddingTop: `4px`, paddingBottom: `4px`, ...css });
    Object.defineProperty(element, `scrollHeight`, { get: () => scrollHeight });
    return element;
};

it(`sizes to content and stops at the cap`, () => {
    const short = textarea(60);
    growTextarea(short, 192);
    expect(short.style.height).toBe(`60px`);

    const long = textarea(400);
    growTextarea(long, 192);
    expect(long.style.height).toBe(`192px`);
});

// `scrollHeight` counts padding but never border, so under border-box a height taken straight from it is short by the
// box's own border.
it(`adds the box's own border under border-box sizing`, () => {
    const bordered = textarea(60, { boxSizing: `border-box`, borderTopWidth: `1px`, borderBottomWidth: `1px`, borderStyle: `solid` });
    growTextarea(bordered);
    expect(bordered.style.height).toBe(`62px`);

    const contentBox = textarea(60, { boxSizing: `content-box`, borderTopWidth: `1px`, borderBottomWidth: `1px`, borderStyle: `solid` });
    growTextarea(contentBox);
    expect(contentBox.style.height).toBe(`60px`);
});

// An empty box is measured against its placeholder, not a blank value, so a two-line placeholder does not get sliced
// into a one-line box.
it(`sizes an empty box to the placeholder it is showing`, () => {
    const element = document.createElement(`textarea`);
    Object.assign(element.style, { lineHeight: `20px`, paddingTop: `4px`, paddingBottom: `4px` });
    Object.defineProperty(element, `scrollHeight`, { get: () => (element.value === `` ? 28 : 48) });
    element.placeholder = `No message written for /workspace view · remove duplicate sandbox cards`;

    growTextarea(element, 192);

    expect(element.style.height).toBe(`48px`);
    expect(element.value).toBe(``);
});

// A box with text in it is measured through the text, never through the placeholder underneath it.
it(`ignores the placeholder once there is content`, () => {
    const element = document.createElement(`textarea`);
    Object.assign(element.style, { lineHeight: `20px`, paddingTop: `4px`, paddingBottom: `4px` });
    Object.defineProperty(element, `scrollHeight`, { get: () => (element.value === `typed` ? 28 : 48) });
    element.placeholder = `No message written for /workspace view · remove duplicate sandbox cards`;
    element.value = `typed`;

    growTextarea(element, 192);

    expect(element.style.height).toBe(`28px`);
    expect(element.value).toBe(`typed`);
});

// An unmeasured box reports less than one line of its own text; writing that back would pin it shut. `auto` is the
// browser's one-line default, which the next real measurement corrects.
it(`leaves an unmeasurable box at its one-row default`, () => {
    const detached = textarea(0);
    growTextarea(detached, 192);
    expect(detached.style.height).toBe(`auto`);

    const sliced = textarea(12);
    growTextarea(sliced, 192);
    expect(sliced.style.height).toBe(`auto`);
});
