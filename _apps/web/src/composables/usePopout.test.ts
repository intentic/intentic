// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPopout } from "./usePopout";

/* The reload contract. A page refresh (dev-server HMR, an update, F5) destroys the realm driving a popped-out
 * panel but NOT the window it lives in: the window's keeper asks whatever page answers on the opener next
 * whether anyone is driving it, and this module's hook answers — taking the window over when nobody is.
 *
 * What is pinned here is that side of the handshake, and the ANSWER as much as the adoption. A pop-out window
 * renders state that lives in another window's realm, so a keeper that hears "yes" from a page that is not
 * actually driving it is how a panel ends up a photograph of the app: still showing the tabs, the selection
 * and the drafts of a realm that is gone, while the board in the live window moves on without it. */

// A stand-in for the pop-out window: a real (detached) document, so dressing it is exercised for real, plus the
// window surface createPopout touches.
const fakeWindow = (name: string) => {
    const doc = document.implementation.createHTMLDocument(name);
    return {
        name,
        document: doc,
        closed: false,
        focus: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
};

// One keeper tick: "is a live page driving me?" — the boolean is what the window acts on.
const adopt = (name: string, win: ReturnType<typeof fakeWindow>): boolean => window.__intentic?.adoptPopout(name, win as unknown as Window) === true;

const size = () => ({ width: 500, height: 400 });

beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe(`createPopout`, () => {
    it(`adopts the window a reload left floating, without docking on the way`, () => {
        sessionStorage.setItem(`ui-popout-reload-panel`, `1`);
        const popout = createPopout(`reload-panel`, `Panel`, size);
        // The shell keeps the column collapsed and the panel unmounted while this is true — the frames between
        // load and adoption are exactly where a docked flash would show.
        expect(popout.restoring.value).toBe(true);
        expect(popout.poppedOut.value).toBe(false);

        const win = fakeWindow(`reload-panel`);
        adopt(`reload-panel`, win);

        expect(popout.poppedOut.value).toBe(true);
        expect(popout.restoring.value).toBe(false);
        expect(popout.body.value).toBe(win.document.body);
        expect(win.close).not.toHaveBeenCalled();
    });

    it(`dresses an adopted window in this page's styles, dropping the dead page's`, () => {
        document.head.appendChild(Object.assign(document.createElement(`style`), { textContent: `.live{color:red}` }));
        sessionStorage.setItem(`ui-popout-dress-panel`, `1`);
        const popout = createPopout(`dress-panel`, `Dressed`, size);
        const win = fakeWindow(`dress-panel`);
        // What the previous page left behind: its own stylesheet clone, and the panel DOM it teleported out —
        // inert now that the realm animating it is gone.
        win.document.head.appendChild(Object.assign(win.document.createElement(`style`), { textContent: `.dead{}` }));
        win.document.body.appendChild(win.document.createElement(`div`));

        adopt(`dress-panel`, win);

        const styles = [...win.document.head.querySelectorAll(`style`)].map((node) => node.textContent);
        expect(styles).toEqual([`.live{color:red}`]);
        expect(win.document.body.children).toHaveLength(0);
        expect(win.document.title).toBe(`Dressed`);
        // The keeper is the live thing that brought the window back — re-dressing must not drop or duplicate it.
        expect(win.document.querySelectorAll(`script[data-intentic-keeper]`)).toHaveLength(1);
        expect(popout.body.value).toBe(win.document.body);
    });

    it(`answers yes to the keeper of the window it already owns, without re-attaching`, () => {
        sessionStorage.setItem(`ui-popout-repeat-panel`, `1`);
        const popout = createPopout(`repeat-panel`, `Panel`, size);
        const win = fakeWindow(`repeat-panel`);

        adopt(`repeat-panel`, win);
        const listeners = win.addEventListener.mock.calls.length;
        const driven = adopt(`repeat-panel`, win); // the keeper asks on every tick, forever

        // The yes IS the proof of life: this page ran the code that produced it. The window keeps its panel
        // uncovered on the strength of it, so it must never be answered by a page that isn't driving it.
        expect(driven).toBe(true);
        expect(win.addEventListener.mock.calls).toHaveLength(listeners);
        expect(win.close).not.toHaveBeenCalled();
        expect(popout.poppedOut.value).toBe(true);
    });

    it(`says no for a window no page on this load is driving`, () => {
        createPopout(`silent-panel`, `Panel`, size);
        const win = fakeWindow(`other-panel`);

        // A name this page has no store for, and a store that never adopted this window — the keeper of either
        // hears no, veils its panel and keeps asking rather than showing a dead one.
        expect(adopt(`no-such-panel`, win)).toBe(false);
    });

    it(`stops holding the docked slot for a window that never reports in — but still takes it if it does`, () => {
        sessionStorage.setItem(`ui-popout-late-panel`, `1`);
        const popout = createPopout(`late-panel`, `Panel`, size);

        vi.advanceTimersByTime(3000);

        // The wait is over, so the panel shows in its column rather than nowhere.
        expect(popout.restoring.value).toBe(false);
        expect(popout.poppedOut.value).toBe(false);
        expect(sessionStorage.getItem(`ui-popout-late-panel`)).toBeNull();

        // ...and here it is, a beat late: a reload behind a slow tunnel, a cold dev server, a throttled
        // background tab. It is a live window the user is looking at, so it gets the panel back. Closing it on
        // the strength of a 2.5-second timer is the old behaviour and it took the user's floating chat with it.
        const win = fakeWindow(`late-panel`);
        const driven = adopt(`late-panel`, win);

        expect(driven).toBe(true);
        expect(popout.poppedOut.value).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
        expect(win.close).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(`ui-popout-late-panel`)).toBe(`1`);
    });

    it(`turns away a window that reports in after the panel was docked deliberately`, () => {
        sessionStorage.setItem(`ui-popout-docked-panel`, `1`);
        const popout = createPopout(`docked-panel`, `Panel`, size);

        // Docking while a window is still expected is a decision, not a timeout: the user asked for the panel
        // in its column, so a leftover window arriving afterwards has nothing to show and is closed.
        popout.dock();
        const win = fakeWindow(`docked-panel`);
        const driven = adopt(`docked-panel`, win);

        expect(driven).toBe(false);
        expect(popout.poppedOut.value).toBe(false);
        expect(win.close).toHaveBeenCalled();
    });

    it(`starts docked with nothing remembered`, () => {
        const popout = createPopout(`fresh-panel`, `Panel`, size);

        expect(popout.restoring.value).toBe(false);
        expect(popout.poppedOut.value).toBe(false);
    });

    it(`forgets the window on dock, so a later reload stays docked`, () => {
        sessionStorage.setItem(`ui-popout-dock-panel`, `1`);
        const popout = createPopout(`dock-panel`, `Panel`, size);
        const win = fakeWindow(`dock-panel`);
        adopt(`dock-panel`, win);

        expect(sessionStorage.getItem(`ui-popout-dock-panel`)).toBe(`1`);

        popout.dock();

        expect(popout.poppedOut.value).toBe(false);
        expect(popout.body.value).toBeUndefined();
        expect(win.close).toHaveBeenCalled();
        expect(sessionStorage.getItem(`ui-popout-dock-panel`)).toBeNull();
    });
});
