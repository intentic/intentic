// @vitest-environment jsdom
// The corner this pins: a bar arrives at the window's right edge with its own controls at its right end, and the
// reserve for the window's buttons only reached it on the NEXT frame, so one frame painted that bar's last control
// under the buttons. Every view mounts through a dynamic import, so no click, keypress or route change is still
// pending when its bars land; the measurement has to follow the document instead. Frames are pumped by hand here,
// and the assertions that matter are the ones made without pumping one.
import { IconStub } from "@intentic/ui/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp } from "vue";
import { workDesktopWindow } from "../../app/environments/desktop";
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

/* THE PRESS THAT MOVES THE WINDOW. The move loop the platform starts is asynchronous and cannot be told the button
   is already up, so the page asks for it only once the press has travelled with the button held, and never once the
   page itself has started a drag. A click on the background, or a drag a surface took over, used to leave the window
   glued to the pointer. */
describe(`a press on the background`, () => {
    const verb = vi.mocked(workDesktopWindow);
    let ground: HTMLElement;

    // Below the title band (the buttons are 36 high), on a plain element: nothing claims it, so it is the window's.
    const press = (x: number, y: number, detail = 1): void => {
        ground.dispatchEvent(new MouseEvent(`mousedown`, { bubbles: true, button: 0, clientX: x, clientY: y, detail }));
    };
    const travel = (x: number, y: number, buttons = 1): void => {
        window.dispatchEvent(new MouseEvent(`pointermove`, { bubbles: true, buttons, clientX: x, clientY: y }));
    };

    beforeEach(() => {
        // jsdom lays nothing out: an element wide enough that no press lands on its scrollbar edge.
        vi.spyOn(HTMLElement.prototype, `clientWidth`, `get`).mockReturnValue(1280);
        vi.spyOn(HTMLElement.prototype, `clientHeight`, `get`).mockReturnValue(800);
        ground = document.createElement(`div`);
        document.body.append(ground);
        mountControls();
        verb.mockClear();
    });

    it(`asks for the window only once the press has travelled with the button down`, () => {
        press(600, 300);
        expect(verb).not.toHaveBeenCalled();
        travel(602, 301);
        expect(verb, `a shaky click is not a drag`).not.toHaveBeenCalled();
        travel(612, 300);
        expect(verb).toHaveBeenCalledWith(`drag`);
        expect(verb).toHaveBeenCalledTimes(1);
        travel(640, 300);
        expect(verb, `asked once per press`).toHaveBeenCalledTimes(1);
    });

    it(`never asks after the button came up`, () => {
        press(600, 300);
        window.dispatchEvent(new MouseEvent(`pointerup`, { bubbles: true, button: 0, clientX: 600, clientY: 300 }));
        travel(640, 300);
        expect(verb).not.toHaveBeenCalled();
    });

    it(`never asks while the button is no longer held, even if its release was never seen`, () => {
        press(600, 300);
        travel(640, 300, 0);
        expect(verb).not.toHaveBeenCalled();
        travel(680, 300);
        expect(verb, `the press was let go when the button read up`).not.toHaveBeenCalled();
    });

    it(`never asks once the page started a drag of its own`, () => {
        press(600, 300);
        window.dispatchEvent(new Event(`dragstart`, { bubbles: true }));
        travel(640, 300);
        expect(verb).not.toHaveBeenCalled();
    });

    it(`still maximises on the second click in the band, on the press itself`, () => {
        press(600, 10, 2);
        expect(verb).toHaveBeenCalledWith(`maximize`);
    });
});
