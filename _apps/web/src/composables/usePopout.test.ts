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

// The window's document going away under the panel: its own ×, or a reload out there. Both arrive here as the
// unload listeners attach() armed, with nothing to tell them apart.
const unload = (win: ReturnType<typeof fakeWindow>): void => {
    for (const [type, listener] of win.addEventListener.mock.calls) {
        if (type === `pagehide`) {
            (listener as () => void)();
        }
    }
};

// A page load in that same window: the window object survives a navigation, the document under it does not.
const reload = (win: ReturnType<typeof fakeWindow>): void => {
    win.document = document.implementation.createHTMLDocument(win.name);
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
    it(`opens the pop-out page and lets the window ask for the panel`, () => {
        const popout = createPopout(`open-panel`, `Panel`, size);
        const win = fakeWindow(`open-panel`);
        const open = vi.spyOn(window, `open`).mockReturnValue(win as unknown as Window);

        popout.popOut();

        // A real page of this app, named for the panel it holds — where about:blank left the window with no
        // address, no icon and a white rectangle in it until the panel landed.
        expect(open).toHaveBeenCalledWith(`/popout.html?panel=open-panel`, `open-panel`, expect.stringContaining(`popup=1`));
        expect(win.focus).toHaveBeenCalled();
        // Nothing is pushed out there from here: the panel stays docked and live until the window's own page
        // reports in, which is the same handshake a reload comes back through.
        expect(popout.poppedOut.value).toBe(false);

        expect(adopt(`open-panel`, win)).toBe(true);

        expect(popout.poppedOut.value).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
        open.mockRestore();
    });

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
        // What the previous page left behind: its own stylesheet clone, marked as a clone, and the panel DOM it
        // teleported out — inert now that the realm animating it is gone.
        const stale = Object.assign(win.document.createElement(`style`), { textContent: `.dead{}` });
        stale.setAttribute(`data-intentic-clone`, ``);
        win.document.head.appendChild(stale);
        win.document.body.appendChild(win.document.createElement(`div`));
        // The pop-out PAGE's own head (popout.html): its icon, its anti-flash style, its keeper. Dressing a
        // window is not loading a new page into it, so none of that is ours to clear.
        win.document.head.appendChild(Object.assign(win.document.createElement(`link`), { rel: `icon`, href: `/assets/intentic-logo-sized.png` }));

        adopt(`dress-panel`, win);

        const styles = [...win.document.head.querySelectorAll(`style`)].map((node) => node.textContent);
        expect(styles).toEqual([`.live{color:red}`]);
        expect(win.document.head.querySelectorAll(`link[rel="icon"]`)).toHaveLength(1);
        expect(win.document.body.children).toHaveLength(0);
        expect(win.document.title).toBe(`Dressed`);
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

    it(`hands the panel back on unload without closing the window`, () => {
        const popout = createPopout(`unload-panel`, `Panel`, size);
        const win = fakeWindow(`unload-panel`);
        adopt(`unload-panel`, win);
        const panel = win.document.createElement(`div`); // stands in for the DOM the Teleport put out there
        win.document.body.appendChild(panel);

        unload(win);

        expect(popout.poppedOut.value).toBe(false);
        expect(popout.body.value).toBeUndefined();
        // A window that is closing needs no closing — and one that is merely RELOADING must not be closed, or
        // an F5 out there aborts mid-navigation and takes the user's floating panel with it.
        expect(win.close).not.toHaveBeenCalled();
        // Rescued into this document rather than left in one that is being torn down: same live elements, so a
        // streaming transcript and an attached xterm come back rather than being rebuilt.
        expect(panel.ownerDocument).toBe(document);
        expect(sessionStorage.getItem(`ui-popout-unload-panel`)).toBeNull();

        // …and it WAS a reload: the fresh page reports in under the same window name and gets the panel back.
        reload(win);
        expect(adopt(`unload-panel`, win)).toBe(true);
        expect(popout.poppedOut.value).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
    });

    it(`takes back a window whose page reloaded without the unload reaching us`, () => {
        const popout = createPopout(`swap-panel`, `Panel`, size);
        const win = fakeWindow(`swap-panel`);
        adopt(`swap-panel`, win);
        const stale = popout.body.value;

        reload(win);

        // The window is the same object across a navigation; the document under it is not. The panel is in the
        // old one, so "yes, still driving you" would leave the window holding a page with nothing in it.
        expect(adopt(`swap-panel`, win)).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
        expect(popout.body.value).not.toBe(stale);
        expect(popout.poppedOut.value).toBe(true);
        expect(win.close).not.toHaveBeenCalled();
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

    /* The other half of "the panel is a view of the app, not a picture of it": it has to answer the pointer out
     * there. Every overlay in the app arms one listener on `document` to catch the click that dismisses it, and
     * `document` in this realm is the main window's — so these pin that a click in the pop-out reaches it. */
    it(`hands a pop-out document the app's dismiss listeners, real event and all`, () => {
        const popout = createPopout(`dismiss-panel`, `Panel`, size);
        const targets: (EventTarget | null)[] = [];
        const onClick = vi.fn((event: Event) => targets.push(event.target));
        // Armed BEFORE the window opens — an overlay already open when the user pops the panel out. It gets the
        // window on attach, or the first thing the user clicked out there would be the thing that never closes.
        document.addEventListener(`click`, onClick);
        const win = fakeWindow(`dismiss-panel`);
        adopt(`dismiss-panel`, win);

        const empty = win.document.createElement(`div`);
        win.document.body.appendChild(empty);
        empty.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));

        // The REAL click, with the REAL target: PrimeVue reads it to tell "outside" from "the trigger that just
        // opened me" and from "my own content". Re-dispatching a synthetic click into this document instead
        // would name this document as the target — and close every popover on the click that opened it.
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(targets).toEqual([empty]);

        // Disarmed here is disarmed there: the overlay closed, so the listener must not outlive it out in the
        // window and dismiss the NEXT one on its first click.
        document.removeEventListener(`click`, onClick);
        empty.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        expect(onClick).toHaveBeenCalledTimes(1);

        // Docked, the window is no longer a window the app renders into, so nothing armed afterwards belongs out
        // there. (A fresh node, because docking salvages the panel's own nodes INTO this document — see dock.)
        popout.dock();
        const leftover = win.document.createElement(`div`);
        win.document.body.appendChild(leftover);
        document.addEventListener(`click`, onClick);
        leftover.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
        document.removeEventListener(`click`, onClick);
    });

    it(`shares what the user points at, not what the document itself is doing`, () => {
        createPopout(`scope-panel`, `Panel`, size);
        const onVisibility = vi.fn();
        // The shell watches this to know whether the APP is on screen (it pauses polling when it isn't). A
        // pop-out's own visibility is not that answer, so this one stays on the document that asked.
        document.addEventListener(`visibilitychange`, onVisibility);
        const win = fakeWindow(`scope-panel`);
        adopt(`scope-panel`, win);

        win.document.dispatchEvent(new Event(`visibilitychange`));

        expect(onVisibility).not.toHaveBeenCalled();
        document.removeEventListener(`visibilitychange`, onVisibility);
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

    it(`syncs dynamically added style tags in document.head to pop-out documents`, async () => {
        createPopout(`dynamic-style-panel`, `Panel`, size);
        const win = fakeWindow(`dynamic-style-panel`);
        adopt(`dynamic-style-panel`, win);

        const dynamicStyle = document.createElement(`style`);
        dynamicStyle.setAttribute(`data-primevue-style-id`, `contextmenu-style`);
        dynamicStyle.textContent = `.p-contextmenu { background: red; }`;
        document.head.appendChild(dynamicStyle);

        await vi.advanceTimersByTimeAsync(10);

        const clonedStyles = Array.prototype.slice.call(win.document.head.querySelectorAll(`style[data-primevue-style-id="contextmenu-style"]`)) as Element[];
        expect(clonedStyles).toHaveLength(1);
        expect(clonedStyles[0]?.textContent).toBe(`.p-contextmenu { background: red; }`);
        expect(clonedStyles[0]?.getAttribute(`data-intentic-clone`)).toBe(``);

        dynamicStyle.remove();
    });
});
