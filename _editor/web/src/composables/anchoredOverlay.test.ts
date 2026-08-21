// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { AnchoredOverlay } from "@intentic/ui";
import { createApp, defineComponent, h, ref } from "vue";

// The barrel reaches window.matchMedia (useDevice) at import: hence jsdom, and the
// stub vitest.setup.ts installs for every suite in the package. ResizeObserver is the other one: the overlay re-places on the panel's own resize, and nothing here
// resizes, so observing is a no-op.

/* THE OTHER HALF OF anchorPlacement.test.ts, and pinned here for the same reason: @intentic/ui carries no
 * test runner of its own, and the surfaces that break without this (the composer's model and mode pickers, the
 * tab strip's history menu) live in this app. That file pins the geometry an anchored panel is GIVEN. This one
 * pins that the geometry REACHES the box: everything between placeAnchored's answer and the pixels.
 *
 * WHICH IS ITS OWN BUG, not a corollary of the first: the placement used to be written straight onto the
 * element (`el.style.left = …`) while the same element carried a `:style` binding for the off-screen parking
 * that hides it until it is measured. The frame that binding went from the parked object to nothing, Vue
 * patched it as `removeAttribute("style")` and took the coordinates with it, so the panel painted UNSTYLED,
 * in the window's top-left corner, which is precisely the flash the parking exists to prevent. A pop-out
 * window showed it worst, because what recovered the box was the ResizeObserver's first delivery and an
 * observer watching an element in ANOTHER window rides the opener's rendering loop.
 *
 * Hence the assertion below is on the box's own `style` attribute rather than on any coordinate the component
 * computed: the report was never "placed wrong", it was "placed, then unplaced". */

// The composer's model pill, near the bottom of a jsdom window (1024 × 768), with a picker above it.
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

// Every microtask the open path chains through: the watcher's own tick, and the render its placement queues.
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
    // The pill's own box, which jsdom otherwise reports as 0×0: the size an anchor that has gone away has, and
    // the overlay closes on it rather than pointing at nothing.
    anchor.value!.getBoundingClientRect = () => rect(PILL);
};

const boxStyle = (): CSSStyleDeclaration => {
    const box = document.body.querySelector<HTMLElement>(`.ui-anchored`);
    expect(box, `the overlay is open, so its box is in the anchor's document`).not.toBeNull();
    // Not `box.style.left`: the failure being guarded is the whole attribute going away, so read that first.
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
    // …and the parking it was measured behind is gone, rather than still holding it off-screen.
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
