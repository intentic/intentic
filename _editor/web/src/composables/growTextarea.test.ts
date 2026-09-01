// @vitest-environment jsdom
import { expect, it } from "vitest";
import { growTextarea } from "@intentic/ui";

/* The arithmetic four composers used to each carry, pinned here because @intentic/ui has no test runner of its
 * own and the boxes that break without it (the chat composer, the commit box) are this app's.
 *
 * jsdom lays nothing out, so `scrollHeight` is stubbed: what is under test is what the function DOES with a
 * measurement, which is exactly where the four copies had drifted apart. */
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

// The commit box's own two pixels: scrollHeight counts padding and never the border, so under border-box a
// height taken straight from it is short of its own text by however much border the caller wears.
it(`adds the box's own border under border-box sizing`, () => {
    const bordered = textarea(60, { boxSizing: `border-box`, borderTopWidth: `1px`, borderBottomWidth: `1px`, borderStyle: `solid` });
    growTextarea(bordered);
    expect(bordered.style.height).toBe(`62px`);

    const contentBox = textarea(60, { boxSizing: `content-box`, borderTopWidth: `1px`, borderBottomWidth: `1px`, borderStyle: `solid` });
    growTextarea(contentBox);
    expect(contentBox.style.height).toBe(`60px`);
});

/* The empty box's own case: a placeholder contributes nothing to `scrollHeight`, so a two-line one used to be
 * drawn into a one-line box with its second line sliced off. The stub answers per value, which is what pins the
 * fix: the height can only come out at two lines if the function measured the placeholder AS content — and the
 * box has to be empty again afterwards, since the app's own v-model says it is. */
it(`sizes an empty box to the placeholder it is showing`, () => {
    const element = document.createElement(`textarea`);
    Object.assign(element.style, { lineHeight: `20px`, paddingTop: `4px`, paddingBottom: `4px` });
    Object.defineProperty(element, `scrollHeight`, { get: () => (element.value === `` ? 28 : 48) });
    element.placeholder = `No message written for /workspace view · remove duplicate sandbox cards`;

    growTextarea(element, 192);

    expect(element.style.height).toBe(`48px`);
    expect(element.value).toBe(``);
});

// And a box with text in it is measured through the text, never through the placeholder underneath it.
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

/* A box that is not laid out yet reports less than one line of its own text, and writing that back pins it
 * shut with no later measurement to undo it. `auto` is the browser's own one-line size: what the box would
 * show if this had never run, and what the next call (a keystroke, a tab switch) measures properly from. */
it(`leaves an unmeasurable box at its one-row default`, () => {
    const detached = textarea(0);
    growTextarea(detached, 192);
    expect(detached.style.height).toBe(`auto`);

    const sliced = textarea(12);
    growTextarea(sliced, 192);
    expect(sliced.style.height).toBe(`auto`);
});
