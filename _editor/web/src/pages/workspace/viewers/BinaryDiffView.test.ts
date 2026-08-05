// @vitest-environment jsdom
//
// jsdom because the whole point of this viewer is what it RENDERS. The bug it exists to fix was a review
// surface that said "Binary file — no text diff to show." over a PNG, so the assertion that matters is that an
// <img> reaches the DOM with the fetched bytes behind it — which only a mounted render can show.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The component's import chain pulls in app-wide singletons that read browser/runtime globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env). vi.hoisted runs
// before the imports evaluate, mirroring what the real page has in place by then.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
    // jsdom's own object URLs are opaque uuids, so nothing downstream could tell which blob an <img> is
    // showing. Named by byte length instead — that is the assertion each pane is holding ITS OWN side's bytes.
    globalThis.URL.createObjectURL = (blob: Blob) => `blob:fake/${blob.size}`;
    globalThis.URL.revokeObjectURL = () => {};
    // Each pane's ImageView watches its own size to keep a fitted image fitted; jsdom ships no ResizeObserver,
    // and it never lays anything out to report anyway. A no-op leaves the render — which is what is asserted.
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
});

// The daemon fetch, stubbed at the seam the viewer uses — the test is about rendering bytes, not about auth.
const fetched: string[] = [];
vi.mock("../../../composables/sandbox/sandboxClient", () => ({
    sandboxBlob: (path: string) => {
        fetched.push(path);
        return path.includes(`missing`)
            ? Promise.reject(new Error(`Request failed (404).`))
            : Promise.resolve(new Blob([new Uint8Array(path.includes(`before`) ? [1, 2, 3] : [4, 5, 6, 7])]));
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
        // Each side's own bytes, not the same blob twice — the sizes differ, so the URLs must too.
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
        expect(element.textContent).toContain(`no preview for this type`);
        expect(element.textContent).toContain(`Download`);
    });

    it(`reports a side that failed to load against that side, leaving the other one showing`, async () => {
        const element = mount({ path: `logo.png`, before: `/diff/raw?before&missing`, after: `/diff/raw?after` });
        await settle();

        expect(element.textContent).toContain(`Request failed (404).`);
        // The half that DID load still renders — one dead side must not blank the comparison.
        expect(element.querySelectorAll(`img`)).toHaveLength(1);
    });

    it(`says so plainly when the daemon reported a binary change with no bytes on either end`, async () => {
        const element = mount({ path: `logo.png` });
        await settle();

        expect(element.textContent).toContain(`neither side has content`);
        expect(fetched).toHaveLength(0);
    });
});
