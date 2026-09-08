// @vitest-environment jsdom
// Pins that a binary diff renders an <img> with its fetched bytes in the DOM; needs jsdom since that's exactly
// what's asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain reads browser globals at import time (useDevice: matchMedia; environment.ts: window.env), stubbed
// package-wide by vitest.setup.ts.
vi.hoisted(() => {
    // jsdom's object URLs are opaque; naming them by byte length lets a test tell which blob an <img> holds.
    globalThis.URL.createObjectURL = (blob: Blob) => `blob:fake/${blob.size}`;
    globalThis.URL.revokeObjectURL = () => {};
    // No ResizeObserver/decode in jsdom; size stubbed from byte length so each side's dimensions stay distinct.
    globalThis.createImageBitmap = ((blob: Blob) =>
        Promise.resolve({ width: blob.size * 10, height: blob.size, close: () => {} })) as unknown as typeof createImageBitmap;
});

// Daemon fetch stubbed at the viewer's seam (bytes only, not auth). `same` returns one identical body for both
// sides, the case this viewer must call out explicitly.
const fetched: string[] = [];
vi.mock("../../sandbox/client/sandboxClient", () => ({
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
    // Icon/v-tooltip are usually installed app-wide; stand-ins keep the test off the whole UI plugin.
    app.component(`Icon`, IconStub);
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

// Decoded size and same-file comparison run their own promise chains after the picture is on screen; a macrotask
// turn drains them.
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
        expect(element.querySelectorAll(`img`)).toHaveLength(1);
    });

    // Guards against two distinct captures reading as "the same picture" due to rounding: each side states its own
    // picture size; the after side also states the delta.
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
        // Delta stated explicitly: "3 B" beside "4 B" is exactly where rounding would hide the +1 change.
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
