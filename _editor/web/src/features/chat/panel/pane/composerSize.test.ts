import "@intentic/testing/dom";
import { afterEach, expect, it } from "bun:test";
import { createApp, h, ref } from "vue";
import { useComposerSize } from "./composerSize";

// Pins the composer box's cap: the pane's free height less the composer's own chrome and the strip of transcript kept
// in view, never under the floor, and left alone while nothing is laid out to measure.

// An element whose layout reads as given; jsdom lays nothing out.
const laidOut = <E extends HTMLElement>(element: E, box: { readonly offsetHeight?: number; readonly clientHeight?: number }): E => {
    for (const [name, value] of Object.entries(box)) {
        Object.defineProperty(element, name, { configurable: true, value });
    }
    return element;
};

let unmount: (() => void) | undefined;
const sizeOf = (layout: { readonly pane: number; readonly footer: number; readonly field: number }) => {
    const scroller = ref<HTMLElement | null>(laidOut(document.createElement(`div`), { clientHeight: layout.pane }));
    const footer = ref<HTMLElement | null>(laidOut(document.createElement(`div`), { offsetHeight: layout.footer }));
    const input = ref<HTMLTextAreaElement | null>(laidOut(document.createElement(`textarea`), { offsetHeight: layout.field }));
    let size: ReturnType<typeof useComposerSize> | undefined;
    const app = createApp({
        setup: () => {
            size = useComposerSize({ scroller, footer, input });
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    return { footer, input, size: size! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
});

it(`caps the box at the pane's height less the composer's chrome and the transcript strip`, () => {
    const { size } = sizeOf({ pane: 900, footer: 160, field: 40 });

    size.grow();

    // 900 - (160 - 40) - 72
    expect(size.composerCap.value).toBe(708);
});

it(`never caps it under the floor, however short the pane`, () => {
    const { size } = sizeOf({ pane: 300, footer: 160, field: 40 });

    size.grow();

    expect(size.composerCap.value).toBe(192);
});

it(`keeps the last good cap while nothing is laid out, or the composer has gone`, () => {
    const { size, footer, input } = sizeOf({ pane: 900, footer: 160, field: 40 });
    size.grow();

    laidOut(footer.value!, { offsetHeight: 0 });
    size.grow();
    expect(size.composerCap.value).toBe(708);

    input.value = null;
    size.grow();
    expect(size.composerCap.value).toBe(708);
});
