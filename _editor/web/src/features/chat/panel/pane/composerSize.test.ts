import "@intentic/testing/dom";
import { createApp, h, ref } from "vue";
import { growTextarea } from "@intentic/ui";
import { useComposerSize } from "./composerSize";

// Pins the composer box's cap (the pane's free height less the composer's chrome and a strip of transcript, floored,
// kept while nothing is laid out) and its growth: a keystroke that only adds text never collapses the box first.

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

// The box's height writes, and how often its content was measured; jsdom lays nothing out, so content height is given.
const watchedBox = (content: number) => {
    const input = document.createElement(`textarea`);
    const writes: string[] = [];
    let height = ``;
    Object.defineProperty(input.style, `height`, {
        configurable: true,
        get: () => height,
        set: (next: string) => {
            height = next;
            writes.push(next);
        },
    });
    Object.defineProperty(input, `scrollHeight`, { configurable: true, get: () => content });
    return { input, writes };
};

it(`grows a box whose text only gained characters without first collapsing it`, () => {
    const { input, writes } = watchedBox(40);
    const grow = (): void => growTextarea(input, 708);

    input.value = `hel`;
    grow();
    input.value = `help`;
    grow();
    input.value = `xhelp`;
    grow();

    // The first sizing collapses and measures; the two insertions reuse the height already set, and write nothing.
    expect(writes).toEqual([`auto`, `40px`]);
});

it(`collapses the box again when text was removed, replaced or left alone`, () => {
    const { input, writes } = watchedBox(40);
    const grow = (): void => growTextarea(input, 708);

    input.value = `hello`;
    grow();
    input.value = `hell`;
    grow();
    input.value = `jell`;
    grow();
    grow();

    expect(writes).toEqual([`auto`, `40px`, `auto`, `40px`, `auto`, `40px`, `auto`, `40px`]);
});
