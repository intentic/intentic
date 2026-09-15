// @vitest-environment jsdom
// The flicker this pins: a bar arrives wearing its own background — the file-tab row's `bg-card` — and the title
// fill only reaches it on the NEXT frame, so the top of a frameless window paints grey and then turns black. Every
// view mounts through a dynamic import, so no click, keypress or route change is still pending when its bars land;
// the measurement has to follow the document instead. Frames are pumped by hand here, and the assertions that
// matter are the ones made without pumping one.
import { IconStub } from "@intentic/ui/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp } from "vue";
import { TITLE_BAR } from "./titleBar";
import WindowControls from "./WindowControls.vue";

// Partial, over the real module: the component reaches for whatever the desktop lane grows next, and a mock listing
// its exports by hand fails the mount the day one is added.
vi.mock(import("../../app/environments/desktop"), async (importOriginal) => ({
    ...(await importOriginal()),
    desktopFrameless: () => true,
    // Both fire on mount; the real ones navigate to an `intentic://` link jsdom cannot follow.
    workDesktopWindow: vi.fn(),
    announceDesktopMode: vi.fn(),
}));

vi.mock("vue-router", () => ({ useRoute: () => ({ fullPath: `/workspace` }) }));

let app: App | undefined;
let pending: FrameRequestCallback | undefined;

const frame = (): void => {
    const run = pending;
    pending = undefined;
    run?.(0);
};

// jsdom lays nothing out, so every bar reads top 0 — which is the top row, and exactly the case under test.
const mountControls = (): void => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp(WindowControls);
    app.component(`Icon`, IconStub);
    app.mount(host);
};

// The document as a view leaves it: one bar inside a subtree, the way a route's component mounts it.
const mountView = (): HTMLElement => {
    const view = document.createElement(`div`);
    view.innerHTML = `<div class="ws"><div class="view-header">file tabs</div><div class="pane"></div></div>`;
    document.body.append(view);
    return view;
};

// One turn of Vue's queue, which is where the strip follows the measurement; never a frame.
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

beforeEach(() => {
    document.body.replaceChildren();
    pending = undefined;
    vi.stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback) => {
        pending = callback;
        return 1;
    });
    vi.stubGlobal(`cancelAnimationFrame`, () => {
        pending = undefined;
    });
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.unstubAllGlobals();
});

it(`fills a bar that arrived after mount, before the frame it would have painted grey in`, async () => {
    mountControls();
    frame();

    const view = mountView();
    await settle();

    expect(view.querySelector(`.view-header`)?.hasAttribute(TITLE_BAR)).toBe(true);
    expect(pending, `a frame is still pending, so the fill was not what this one landed`).toBeUndefined();
});

/* THE STRIP STANDS IN FOR A MISSING BAR (titleBar.ts `STRIP`), so it has to hand the row over the moment one arrives. */
it(`hands the top row between the stand-in strip and a real bar as views come and go`, async () => {
    mountControls();
    frame();
    await settle();

    expect(document.querySelector(`.window-titlebar`), `no bar is up, so the strip should be`).not.toBeNull();

    const view = mountView();
    await settle();

    expect(document.querySelector(`.window-titlebar`), `a real bar is up, so the strip should not be`).toBeNull();

    view.remove();
    await settle();

    expect(document.querySelector(`.window-titlebar`)).not.toBeNull();
});
