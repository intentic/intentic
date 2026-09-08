// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { AnchoredOverlay } from "@intentic/ui";
import { createApp, defineComponent, h, ref } from "vue";

// jsdom: the @intentic/ui barrel reaches window.matchMedia at import (stubbed in vitest.setup.ts). ResizeObserver is
// stubbed too, though unused here.

// Complements anchorPlacement.test.ts: that file pins the computed geometry, this one pins that it reaches the DOM.
// Assertions check the box's own `style` attribute, since the bug was placement applied then stripped a frame later.

// The composer's model pill near the bottom of a 1024×768 jsdom window, with a picker above it.
const PILL = { top: 560, left: 24, width: 120, height: 32 };
const PANEL = { top: 0, left: 0, width: 418, height: 300 };

const rect = (r: { top: number; left: number; width: number; height: number }): DOMRect => ({
    ...r,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => r,
});

// Every microtask the open path chains through: the watcher's tick, and the render its placement queues.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const open = ref(false);
const anchor = ref<HTMLElement>();
let app: ReturnType<typeof createApp> | undefined;

const mountPicker = (): void => {
    vi.spyOn(HTMLElement.prototype, `getBoundingClientRect`).mockReturnValue(rect(PANEL));
    app = createApp(
        defineComponent({
            setup: () => () =>
                h(`div`, [
                    h(`button`, { ref: anchor }, `gpt-5`),
                    h(
                        AnchoredOverlay,
                        {
                            anchor: anchor.value,
                            modelValue: open.value,
                            "onUpdate:modelValue": (value: boolean) => {
                                open.value = value;
                            },
                        },
                        () => h(`div`, `models`),
                    ),
                ]),
        }),
    );
    const container = document.createElement(`div`);
    document.body.appendChild(container);
    app.mount(container);
    // The pill's real box; jsdom reports 0×0 by default, which would read as an anchor that has gone away.
    anchor.value!.getBoundingClientRect = () => rect(PILL);
};

const boxStyle = (): CSSStyleDeclaration => {
    const box = document.body.querySelector<HTMLElement>(`.ui-anchored`);
    expect(box, `the overlay is open, so its box is in the anchor's document`).not.toBeNull();
    // Checks the whole `style` attribute rather than `box.style.left`, since the bug was the attribute vanishing.
    expect(box!.getAttribute(`style`), `the box kept an inline style`).not.toBeNull();
    return box!.style;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    open.value = false;
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

it(`leaves the placement on the box instead of stripping it a frame later`, async () => {
    mountPicker();
    open.value = true;
    await settle();

    const style = boxStyle();
    expect(style.left).toBe(`24px`); // the pill's own left edge (cross: start)
    expect(style.top).toBe(`252px`); // 560 − 8 gap − 300 tall
    expect(style.maxHeight).toBe(`544px`); // the room above the pill, less the viewport margin
    expect(style.getPropertyValue(`--ui-anchored-arrow`)).toBe(`60px`); // the pill's centre, in the box
    // The parking transform is cleared, not merely left hiding the box off-screen.
    expect(style.transform).toBe(``);
    expect(document.body.querySelector(`.ui-anchored`)?.className).toContain(`ui-anchored-top`);
});

it(`places it again on every open, not only the first`, async () => {
    mountPicker();
    open.value = true;
    await settle();
    open.value = false;
    await settle();
    open.value = true;
    await settle();

    expect(boxStyle().top).toBe(`252px`);
});
