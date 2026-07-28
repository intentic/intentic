// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPopout } from "./usePopout";

/* The reload contract. A page refresh (dev-server HMR, an update, F5) destroys the realm driving a popped-out
 * panel but NOT the window it lives in: the window's keeper offers itself back to whatever page answers on the
 * opener next, and this module's hook takes it over. What is pinned here is that side of the handshake — the
 * fresh page adopts the returning window instead of docking the panel, gives up on one that never reports in,
 * and turns away one that arrives after the panel has been docked. */

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

const adopt = (name: string, win: ReturnType<typeof fakeWindow>): void => {
    window.__intentic?.adoptPopout(name, win as unknown as Window);
};

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

    it(`ignores the keeper re-offering the window it already owns`, () => {
        sessionStorage.setItem(`ui-popout-repeat-panel`, `1`);
        const popout = createPopout(`repeat-panel`, `Panel`, size);
        const win = fakeWindow(`repeat-panel`);

        adopt(`repeat-panel`, win);
        const listeners = win.addEventListener.mock.calls.length;
        adopt(`repeat-panel`, win); // the keeper offers on every tick, forever

        expect(win.addEventListener.mock.calls).toHaveLength(listeners);
        expect(win.close).not.toHaveBeenCalled();
        expect(popout.poppedOut.value).toBe(true);
    });

    it(`gives up on a window that never reports in, and turns it away if it does`, () => {
        sessionStorage.setItem(`ui-popout-gone-panel`, `1`);
        const popout = createPopout(`gone-panel`, `Panel`, size);

        vi.advanceTimersByTime(3000);

        expect(popout.restoring.value).toBe(false);
        expect(popout.poppedOut.value).toBe(false);
        // Nothing is coming back — the remembered state goes, so the next load starts docked.
        expect(sessionStorage.getItem(`ui-popout-gone-panel`)).toBeNull();

        const win = fakeWindow(`gone-panel`);
        adopt(`gone-panel`, win);

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
