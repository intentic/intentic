// @vitest-environment jsdom
//
// jsdom because the whole point of this viewer is what it RENDERS. The bug it exists to fix was a review
// surface that said "Binary file: no text diff to show." over a PNG, so the assertion that matters is that an
// <img> reaches the DOM with the fetched bytes behind it, which only a mounted render can show.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The component's import chain pulls in app-wide singletons that read browser/runtime globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env), stood up for the
// package by vitest.setup.ts before this file is loaded: what the real page has in place by then.
vi.hoisted(() => {
    // jsdom's own object URLs are opaque uuids, so nothing downstream could tell which blob an <img> is
    // showing. Named by byte length instead: that is the assertion each pane is holding ITS OWN side's bytes.
    globalThis.URL.createObjectURL = (blob: Blob) => `blob:fake/${blob.size}`;
    globalThis.URL.revokeObjectURL = () => {};
    // Each pane's ImageView watches its own size to keep a fitted image fitted; jsdom ships no ResizeObserver,
    // and it never lays anything out to report anyway. A no-op leaves the render, which is what is asserted.
    // jsdom decodes nothing either, so the caption's dimensions are stubbed from the byte length: each side
    // then reports its OWN size, which is what the assertions are about.
    globalThis.createImageBitmap = ((blob: Blob) =>
        Promise.resolve({ width: blob.size * 10, height: blob.size, close: () => {} })) as unknown as typeof createImageBitmap;
});

// The daemon fetch, stubbed at the seam the viewer uses: the test is about rendering bytes, not about auth.
// `same` hands both sides one identical body, the shape a reviewer reads as "it shows me the same picture
// twice" and the one case this viewer must name out loud rather than leave to the eye.
const fetched: string[] = [];
vi.mock("../../../composables/sandbox/sandboxClient", () => ({
    sandboxBlob: (path: string) => {
        fetched.push(path);
        if (path.includes(`missing`)) {
            return Promise.reject(new Error(`Request failed (404).`));
        }
        if (path.includes(`same`)) {
            return Promise.resolve(new Blob([new Uint8Array([9, 9, 9])]));
        }
        return Promise.resolve(new Blob([new Uint8Array(path.includes(`before`) ? [1, 2, 3] : [4, 5, 6, 7])]));
    },
}));

const { default: BinaryDiffView } = await import("./BinaryDiffView.vue");

let app: App | undefined;
const mount = (props: { path: string; before?: string; after?: string }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(BinaryDiffView, props) });
    // Icon and v-tooltip are both registered app-wide by installUi. Stand-ins keep the test
    // off the whole UI plugin.
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// The fetches resolve on the microtask queue; two ticks let the render that follows them land.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// …and the answers that come AFTER the picture is on screen (its decoded size, and whether the two sides are
// one file) run their own chains of promises behind it. A turn of the macrotask queue drains all of them.
const settleComparison = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
};

beforeEach(() => {
    fetched.length = 0;
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`BinaryDiffView`, () => {
    it(`renders a modified image as two panes, one <img> per side`, async () => {
        const element = mount({
            path: `shots/rg-2.png`,
            before: `/diff/raw?source=working&which=before`,
            after: `/diff/raw?source=working&which=after`,
        });
        await settle();

        const images = element.querySelectorAll(`img`);
        expect(images).toHaveLength(2);
        // Each side's own bytes, not the same blob twice: the sizes differ, so the URLs must too.
        expect(images[0]?.getAttribute(`src`)).toBe(`blob:fake/3`);
        expect(images[1]?.getAttribute(`src`)).toBe(`blob:fake/4`);
        expect(element.textContent).toContain(`Before`);
        expect(element.textContent).toContain(`After`);
        expect(fetched).toHaveLength(2);
    });

    it(`gives an added file's one side the whole view rather than an empty half`, async () => {
        const element = mount({ path: `rg-5.png`, after: `/diff/raw?source=working&which=after` });
        await settle();

        expect(element.querySelectorAll(`img`)).toHaveLength(1);
        expect(element.textContent).toContain(`After`);
        expect(element.textContent).not.toContain(`Before`);
        expect(fetched).toEqual([`/diff/raw?source=working&which=after`]);
    });

    it(`offers the bytes of a binary with no visual form instead of a blank pane`, async () => {
        const element = mount({ path: `fonts/Inter.woff2`, after: `/diff/raw?source=working&which=after` });
        await settle();

        expect(element.querySelectorAll(`img`)).toHaveLength(0);
        expect(element.querySelector(`button[aria-label*="Download"]`)).not.toBeNull();
    });

    it(`reports a side that failed to load against that side, leaving the other one showing`, async () => {
        const element = mount({ path: `logo.png`, before: `/diff/raw?before&missing`, after: `/diff/raw?after` });
        await settle();

        expect(element.textContent).toContain(`Request failed (404).`);
        // The half that DID load still renders: one dead side must not blank the comparison.
        expect(element.querySelectorAll(`img`)).toHaveLength(1);
    });

    /* The report this pair of tests exists for: "it always displays the same picture in both". Two captures of
     * one screen ARE two pictures, but fitted into half a pane they read as one, and the caption's only fact,
     * a size rounded to two figures, agreed with that reading. So each side states the size of the PICTURE,
     * and the after side states what the file gained or lost. */
    it(`states each side's dimensions and what the file gained or lost`, async () => {
        const element = mount({
            path: `shots/board.png`,
            before: `/diff/raw?source=working&which=before`,
            after: `/diff/raw?source=working&which=after`,
        });
        await settleComparison();

        // 3 bytes → 30 × 3, 4 bytes → 40 × 4 (the decode stub), so the two sides cannot be confused.
        expect(element.textContent).toContain(`30 × 3`);
        expect(element.textContent).toContain(`40 × 4`);
        // One byte gained, stated as a delta, because "3 B" beside "4 B" is where the rounding hid the change.
        expect(element.textContent).toContain(`+1 B`);
        expect(element.textContent).not.toContain(`same file`);
    });

    it(`says so outright when both sides really are one picture`, async () => {
        const element = mount({
            path: `shots/board.png`,
            before: `/diff/raw?source=working&same&which=before`,
            after: `/diff/raw?source=working&same&which=after`,
        });
        await settleComparison();

        const images = element.querySelectorAll(`img`);
        expect(images).toHaveLength(2);
        expect(images[0]?.getAttribute(`src`)).toBe(images[1]?.getAttribute(`src`));
        expect(element.textContent).not.toContain(`+1 B`);
    });

    it(`says so plainly when the daemon reported a binary change with no bytes on either end`, async () => {
        const element = mount({ path: `logo.png` });
        await settle();

        expect(element.querySelectorAll(`img`)).toHaveLength(0);
        expect(fetched).toHaveLength(0);
        expect(element.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
});
