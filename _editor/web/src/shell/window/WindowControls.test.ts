// @vitest-environment jsdom
// The corner this pins: a bar arrives at the window's right edge with its own controls at its right end, and the
// reserve for the window's buttons only reached it on the NEXT frame, so one frame painted that bar's last control
// under the buttons. Every view mounts through a dynamic import, so no click, keypress or route change is still
// pending when its bars land; the measurement has to follow the document instead. Frames are pumped by hand here,
// and the assertions that matter are the ones made without pumping one.
import { IconStub } from "@intentic/ui/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp } from "vue";
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

const RESERVE = `padding-inline-end`;

let app: App | undefined;
let pending: FrameRequestCallback | undefined;

const frame = (): void => {
    const run = pending;
    pending = undefined;
    run?.(0);
};

const mountControls = (): void => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp(WindowControls);
    app.component(`Icon`, IconStub);
    app.mount(host);
};

// jsdom lays nothing out, so the geometry is supplied the way the browser would have measured it: the buttons in the
// top-right corner of a 1280-wide window, and every bar running the window's full width along the top edge — into
// the corner, which is exactly the case under test.
const layOut = (): void => {
    vi.spyOn(HTMLElement.prototype, `getBoundingClientRect`).mockImplementation(function (this: HTMLElement) {
        return this.classList.contains(`window-controls`) ? new DOMRect(1160, 0, 120, 36) : new DOMRect(0, 0, 1280, 36);
    });
};

// The document as a view leaves it: one bar inside a subtree, the way a route's component mounts it.
const mountView = (): HTMLElement => {
    const view = document.createElement(`div`);
    view.innerHTML = `<div class="ws"><div class="view-header">file tabs</div><div class="pane"></div></div>`;
    document.body.append(view);
    return view;
};

const barOf = (view: HTMLElement): HTMLElement => view.querySelector(`.view-header`) as HTMLElement;

// One turn of the microtask queue, which is where the arrival observer runs; never a frame.
const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

beforeEach(() => {
    document.body.replaceChildren();
    pending = undefined;
    layOut();
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
    vi.restoreAllMocks();
});

it(`reserves the corner on a bar that arrived after mount, before the frame it would have painted under the buttons in`, async () => {
    mountControls();
    frame();

    const view = mountView();
    await settle();

    expect(barOf(view).style.getPropertyValue(RESERVE)).toBe(`var(--window-controls-width)`);
    expect(pending, `a frame is still pending, so the reserve was not what this one landed`).toBeUndefined();
});

/* ONE BAR HOLDS THE CORNER AT A TIME, and it hands the corner over the moment the layout changes under it. */
it(`hands the corner from one bar to the next as views come and go`, async () => {
    mountControls();
    frame();

    const first = mountView();
    await settle();
    first.remove();
    await settle();

    expect(barOf(first).style.getPropertyValue(RESERVE), `a bar that left keeps no reserve`).toBe(``);

    const second = mountView();
    await settle();

    expect(barOf(second).style.getPropertyValue(RESERVE)).toBe(`var(--window-controls-width)`);
});

/* Nothing but the three buttons is drawn: no bar, no strip, no fill — the page under them is the handle. */
it(`draws the window's three buttons and marks the document frameless for as long as it is up`, () => {
    mountControls();

    expect(document.querySelectorAll(`.window-control`)).toHaveLength(3);
    expect(document.documentElement.hasAttribute(`data-frameless`)).toBe(true);
    expect(document.querySelector(`.window-controls`)?.parentElement?.children).toHaveLength(1);

    app?.unmount();
    app = undefined;

    expect(document.documentElement.hasAttribute(`data-frameless`)).toBe(false);
});
