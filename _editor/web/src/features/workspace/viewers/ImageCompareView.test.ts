// Pins the two overlays: swipe clips the after picture at the handle, onion skin fades it, and the keyboard moves both.
import "@intentic/testing/dom";
import { describe, it, expect, afterEach } from "bun:test";
import { type App, createApp, h, nextTick } from "vue";
import ImageCompareView from "./ImageCompareView.vue";

let app: App | undefined;
const mount = (mode: "swipe" | "onion"): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ImageCompareView, { before: `blob:before`, after: `blob:after`, mode }) });
    app.mount(element);
    return element;
};
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

const after = (element: HTMLElement): HTMLImageElement => element.querySelectorAll(`img`)[1]!;

describe(`ImageCompareView`, () => {
    it(`starts at the middle and wipes the after picture from the handle rightwards`, () => {
        const element = mount(`swipe`);
        expect(after(element).style.clipPath).toBe(`inset(0 0 0 50%)`);
        expect(element.textContent).toContain(`50%`);
    });

    it(`fades the after picture to the handle's share in onion skin`, () => {
        const element = mount(`onion`);
        expect(after(element).style.opacity).toBe(`0.5`);
    });

    it(`moves the handle from the keyboard, a big step with shift`, async () => {
        const element = mount(`swipe`);
        const pane = element.querySelector<HTMLElement>(`[role="slider"]`)!;
        pane.dispatchEvent(new KeyboardEvent(`keydown`, { key: `ArrowRight`, shiftKey: true, bubbles: true }));
        await nextTick();
        expect(after(element).style.clipPath).toBe(`inset(0 0 0 60%)`);
        pane.dispatchEvent(new KeyboardEvent(`keydown`, { key: `ArrowLeft`, bubbles: true }));
        await nextTick();
        expect(after(element).style.clipPath).toBe(`inset(0 0 0 58%)`);
    });
});
