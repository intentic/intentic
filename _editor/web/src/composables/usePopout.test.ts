// @vitest-environment jsdom
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onScreen } from "./onScreen";
import { createPopout, type Popout } from "./usePopout";

/* The reload contract. A page refresh (dev-server HMR, an update, F5) destroys the realm driving a popped-out
 * panel but NOT the window it lives in: the window's keeper asks whatever page answers on the opener next
 * whether anyone is driving it, and this module's hook answers — taking the window over when nobody is.
 *
 * What is pinned here is that side of the handshake, and the ANSWER as much as the adoption. A pop-out window
 * renders state that lives in another window's realm, so a keeper that hears `live` from a page that is not
 * actually drawing in it is how a panel ends up a photograph of the app: still showing the tabs, the selection
 * and the drafts of a realm that is gone, while the board in the live window moves on without it. Which is why
 * the answer is three-valued and comes from the PANEL — `waiting` is the whole of the difference between a
 * window whose app is coming and a window whose app has forgotten it. */

// A stand-in for the pop-out window: a real (detached) document, so dressing it is exercised for real, plus the
// window surface createPopout touches.
const fakeWindow = (name: string) => {
    const doc = document.implementation.createHTMLDocument(name);
    return {
        name,
        document: doc,
        closed: false,
        // Where the user left it: the four numbers window.open takes back, which is what makes a frame
        // rememberable at all. These stand for a window dragged onto a second screen.
        screenX: 2200,
        screenY: 180,
        outerWidth: 900,
        outerHeight: 1100,
        focus: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
};

// One keeper tick: "is a live page drawing in me?" — the three-valued answer is what the window acts on
// (`live` uncovers the panel, `waiting` veils it but keeps it, `none` starts the count towards closing).
const adopt = (name: string, win: ReturnType<typeof fakeWindow>) => window.__intentic?.adoptPopout(name, win as unknown as Window) ?? `none`;

/* The panel HOST, which in the app is the component that renders the panel into whichever window currently
 * holds it (shell/PoppablePanels.vue). Its own scope is what ends the hold, so mounting and unmounting one is
 * an effect scope here — and every test that expects a window to be told it is `live` has to have one, which is
 * the point: nothing else in the page can honestly say a panel is on screen out there. */
const renders = (popout: Popout): (() => void) => {
    const scope = effectScope();
    scope.run(() => popout.holdWhile(() => true));
    return () => scope.stop();
};

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
    localStorage.clear(); // where the pop-out window's last frame is kept — see the frame tests below
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe(`createPopout`, () => {
    it(`opens the pop-out page and lets the window ask for the panel`, () => {
        const popout = createPopout(`open-panel`, `Panel`, size);
        renders(popout);
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

        expect(adopt(`open-panel`, win)).toBe(`live`);

        expect(popout.poppedOut.value).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
        open.mockRestore();
    });

    /* The pop-out page is addressed by URL, so it is addressed under the app's BASE — this same build is served
     * under a prefix by the marketing site's recorded demo (`/demo/`), where a root-absolute `/popout.html` is
     * that site's 404 page: a window nothing in it can answer the keeper's handshake from, and therefore a panel
     * that never leaves its column. */
    it(`opens the pop-out page under the app's base`, () => {
        vi.stubEnv(`BASE_URL`, `/demo/`);
        const popout = createPopout(`based-panel`, `Panel`, size);
        const open = vi.spyOn(window, `open`).mockReturnValue(fakeWindow(`based-panel`) as unknown as Window);

        popout.popOut();

        expect(open).toHaveBeenCalledWith(`/demo/popout.html?panel=based-panel`, `based-panel`, expect.stringContaining(`popup=1`));
        open.mockRestore();
        vi.unstubAllEnvs();
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

    it(`answers live to the keeper of the window it already owns, without re-attaching`, () => {
        sessionStorage.setItem(`ui-popout-repeat-panel`, `1`);
        const popout = createPopout(`repeat-panel`, `Panel`, size);
        renders(popout);
        const win = fakeWindow(`repeat-panel`);

        adopt(`repeat-panel`, win);
        const listeners = win.addEventListener.mock.calls.length;
        const driven = adopt(`repeat-panel`, win); // the keeper asks on every tick, forever

        // `live` IS the proof of life: this page ran the code that produced it, and something in it is drawing.
        // The window keeps its panel uncovered on the strength of it, so it must never be heard from a page
        // that has stopped rendering into it.
        expect(driven).toBe(`live`);
        expect(win.addEventListener.mock.calls).toHaveLength(listeners);
        expect(win.close).not.toHaveBeenCalled();
        expect(popout.poppedOut.value).toBe(true);
    });

    it(`hands the panel back on unload without closing the window`, () => {
        const popout = createPopout(`unload-panel`, `Panel`, size);
        renders(popout);
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
        expect(adopt(`unload-panel`, win)).toBe(`live`);
        expect(popout.poppedOut.value).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
    });

    it(`takes back a window whose page reloaded without the unload reaching us`, () => {
        const popout = createPopout(`swap-panel`, `Panel`, size);
        renders(popout);
        const win = fakeWindow(`swap-panel`);
        adopt(`swap-panel`, win);
        const stale = popout.body.value;

        reload(win);

        // The window is the same object across a navigation; the document under it is not. The panel is in the
        // old one, so "still drawing in you" would leave the window holding a page with nothing in it.
        expect(adopt(`swap-panel`, win)).toBe(`live`);
        expect(popout.body.value).toBe(win.document.body);
        expect(popout.body.value).not.toBe(stale);
        expect(popout.poppedOut.value).toBe(true);
        expect(win.close).not.toHaveBeenCalled();
    });

    it(`says none for a window no page on this load is driving`, () => {
        createPopout(`silent-panel`, `Panel`, size);
        const win = fakeWindow(`other-panel`);

        // A name this page has no store for, and a store that never adopted this window — the keeper of either
        // hears `none`, veils its panel and starts counting towards closing rather than showing a dead one.
        expect(adopt(`no-such-panel`, win)).toBe(`none`);
    });

    it(`stops holding the docked slot for a window that never reports in — but still takes it if it does`, () => {
        sessionStorage.setItem(`ui-popout-late-panel`, `1`);
        const popout = createPopout(`late-panel`, `Panel`, size);
        renders(popout);

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

        expect(driven).toBe(`live`);
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

        expect(driven).toBe(`none`);
        expect(popout.poppedOut.value).toBe(false);
        expect(win.close).toHaveBeenCalled();
    });

    /* THE GHOST. Everything below is one bug, reported as "I refreshed and ended up with the chat in a floating
     * window AND in its column, and the floating one doesn't react to anything". It was possible because the
     * answer used to be a claim — "I attached to this window once" — so any state that left a store attached to
     * a window it was not drawing into told that window it was live, forever. The veil never came, the
     * twelve-second self-close never came, and the window sat frozen on its last frame beside a perfectly live
     * docked panel. */
    it(`answers waiting, not live, for a window it has claimed but is not drawing in`, () => {
        sessionStorage.setItem(`ui-popout-blank-panel`, `1`);
        const popout = createPopout(`blank-panel`, `Panel`, size);
        const win = fakeWindow(`blank-panel`);

        // No host: the app has adopted the window in the gap before the panel is mounted — every reload has one,
        // and a session that lands on /login or a sandbox that never resolves never leaves it.
        const driven = adopt(`blank-panel`, win);

        // Claimed, so the panel has somewhere to go the moment it exists…
        expect(popout.poppedOut.value).toBe(true);
        expect(popout.body.value).toBe(win.document.body);
        // …and honest about there being nothing in it yet, which is what lets the window veil itself and, if
        // this never resolves, eventually close. `live` here is the whole of the reported bug.
        expect(driven).toBe(`waiting`);
        expect(win.close).not.toHaveBeenCalled();
    });

    it(`goes live the moment the panel arrives, and waiting again when it leaves`, () => {
        const popout = createPopout(`arrive-panel`, `Panel`, size);
        const win = fakeWindow(`arrive-panel`);
        adopt(`arrive-panel`, win);

        const unmount = renders(popout);
        expect(adopt(`arrive-panel`, win)).toBe(`live`);

        // The host going away — a hot update re-creating it, a shell swap, the workspace ending. The window is
        // told the truth on the very next tick rather than being left with a picture of the app.
        unmount();
        expect(adopt(`arrive-panel`, win)).toBe(`waiting`);
    });

    it(`hands a window back when its panel leaves and does not come back`, () => {
        const popout = createPopout(`handback-panel`, `Panel`, size);
        const unmount = renders(popout);
        const win = fakeWindow(`handback-panel`);
        adopt(`handback-panel`, win);

        unmount();
        // Nothing happens on the spot: from here an unmount is indistinguishable from the first half of a
        // remount, and closing the window on that is what used to take a floating chat away on every hot update.
        expect(win.close).not.toHaveBeenCalled();

        vi.advanceTimersByTime(3000);

        expect(win.close).toHaveBeenCalled();
        expect(popout.poppedOut.value).toBe(false);
    });

    it(`keeps the window through a host that comes straight back`, () => {
        const popout = createPopout(`remount-panel`, `Panel`, size);
        const unmount = renders(popout);
        const win = fakeWindow(`remount-panel`);
        adopt(`remount-panel`, win);

        unmount();
        vi.advanceTimersByTime(500);
        renders(popout); // the successor mounts, well inside the grace

        vi.advanceTimersByTime(3000);

        expect(win.close).not.toHaveBeenCalled();
        expect(popout.poppedOut.value).toBe(true);
        expect(adopt(`remount-panel`, win)).toBe(`live`);
    });

    /* The other half of the same lesson, and the reason handing back is not simply dock(): losing the host is
     * not the user asking for the panel in its column. A store that treated it as one refused every window that
     * reported in afterwards — so a teardown in the seconds after a refresh (the sign-in settling, a sandbox
     * resolving) permanently closed the window the reload was supposed to give back. */
    it(`stays adoptable after handing a window back`, () => {
        const popout = createPopout(`readopt-panel`, `Panel`, size);
        const unmount = renders(popout);
        const gone = fakeWindow(`readopt-panel`);
        adopt(`readopt-panel`, gone);
        unmount();
        vi.advanceTimersByTime(3000);

        // The panel is mounted again and the user pops out again — or the same window's keeper reports in late.
        renders(popout);
        const back = fakeWindow(`readopt-panel`);

        expect(adopt(`readopt-panel`, back)).toBe(`live`);
        expect(popout.poppedOut.value).toBe(true);
        expect(back.close).not.toHaveBeenCalled();
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
        // `visibilitychange` describes the document it was armed on, so a listener asking after THIS window must
        // not be answered by a pop-out minimizing. Whether the app is on screen anywhere is a separate question,
        // and onScreen.ts answers it by asking each window for itself — see the test below.
        document.addEventListener(`visibilitychange`, onVisibility);
        const win = fakeWindow(`scope-panel`);
        adopt(`scope-panel`, win);

        win.document.dispatchEvent(new Event(`visibilitychange`));

        expect(onVisibility).not.toHaveBeenCalled();
        document.removeEventListener(`visibilitychange`, onVisibility);
    });

    /* A pop-out window is one of the app's own windows, and the gates that ask "is anyone looking?" — the unread
     * badge, presence idle — have to count it. Everything out there is drawn by the realm in the app's TAB, so
     * for as long as they read that tab's visibility, a chat being read on a second screen counted as nobody
     * looking whenever the tab itself sat behind something. */
    it(`counts the window a panel floats in as somewhere the app is on screen`, () => {
        const popout = createPopout(`screen-panel`, `Panel`, size);
        const win = fakeWindow(`screen-panel`);
        // jsdom answers `visible` for the page's own document and `prerender` for a detached one, and neither
        // can be set — so both windows are dressed by hand, the way the browser would report them.
        Object.defineProperty(win.document, `visibilityState`, { value: `visible`, configurable: true });
        Object.defineProperty(document, `visibilityState`, { value: `hidden`, configurable: true });
        document.dispatchEvent(new Event(`visibilitychange`)); // the tab going behind another one

        adopt(`screen-panel`, win);

        expect(onScreen.value).toBe(true);

        popout.dock();

        // Docked, the window shows nothing of the app and stops answering for it — leaving the tab, which is
        // behind another one.
        expect(onScreen.value).toBe(false);
        Reflect.deleteProperty(document, `visibilityState`);
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

    /* WHERE THE WINDOW COMES BACK. Popping a panel out is a many-times-a-day gesture, so a window that always
     * opens centred on the app is a window the user drags to the same corner of the same screen a dozen times a
     * day. The frame it was last left in is what reopening asks for — the one part of the cost of this action
     * that no amount of surfacing the ACTION could pay off. */
    it(`reopens the window in the frame the user left it in`, () => {
        const popout = createPopout(`frame-panel`, `Panel`, size);
        const win = fakeWindow(`frame-panel`);
        adopt(`frame-panel`, win);

        unload(win); // the window's own × — the last moment its geometry is still readable

        const open = vi.spyOn(window, `open`).mockReturnValue(null);
        popout.popOut();

        // The second screen it was dragged to, at the size it was dragged to — not `size()` centred on the app.
        expect(open).toHaveBeenCalledWith(expect.any(String), `frame-panel`, `popup=1,width=900,height=1100,left=2200,top=180`);
        open.mockRestore();
    });

    it(`centres a panel whose window has never been placed`, () => {
        const popout = createPopout(`unplaced-panel`, `Panel`, size);
        const open = vi.spyOn(window, `open`).mockReturnValue(null);

        popout.popOut();

        // jsdom's window is 1024×768 at the screen's origin, so the 500×400 panel centres at 262,184.
        expect(open).toHaveBeenCalledWith(expect.any(String), `unplaced-panel`, `popup=1,width=500,height=400,left=262,top=184`);
        open.mockRestore();
    });

    it(`re-centres a frame stranded on a monitor that has gone away`, () => {
        localStorage.setItem(`ui-popout-frame-gone-panel`, `2200,180,900,1100`);
        // One screen attached now, and the remembered frame is off the side of it: the monitor it names has been
        // unplugged, and a window opened out there is one the user can neither find nor close. Only a browser
        // that says `false` proves this — silence keeps the frame, because silence is also what a second monitor
        // sounds like.
        Object.defineProperty(window.screen, `isExtended`, { value: false, configurable: true });
        const popout = createPopout(`gone-panel`, `Panel`, size);
        const open = vi.spyOn(window, `open`).mockReturnValue(null);

        popout.popOut();

        expect(open).toHaveBeenCalledWith(expect.any(String), `gone-panel`, `popup=1,width=500,height=400,left=262,top=184`);
        open.mockRestore();
        Reflect.deleteProperty(window.screen, `isExtended`);
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

        const clonedStyles = Array.prototype.slice.call(
            win.document.head.querySelectorAll(`style[data-primevue-style-id="contextmenu-style"]`),
        ) as Element[];
        expect(clonedStyles).toHaveLength(1);
        expect(clonedStyles[0]?.textContent).toBe(`.p-contextmenu { background: red; }`);
        expect(clonedStyles[0]?.getAttribute(`data-intentic-clone`)).toBe(``);

        dynamicStyle.remove();
    });

    /* A popped-out panel is drawn by THIS realm into another window, so everything the design system reads off
     * <html> has to be put there by hand — and kept there. The text size is the one that changes the layout
     * rather than the colours, so a window left behind on the old size is the most visible way for the two
     * windows to disagree: a chat set a step smaller than the app it was torn off. */
    it(`carries the base text size out to a pop-out window, and follows it when the reader changes it`, async () => {
        createPopout(`text-size-panel`, `Panel`, size);
        const win = fakeWindow(`text-size-panel`);

        document.documentElement.setAttribute(`data-text-size`, `large`);
        adopt(`text-size-panel`, win);
        expect(win.document.documentElement.getAttribute(`data-text-size`)).toBe(`large`);

        // Changed while the window is open — the pop-out page's own restore script ran once, at load, so this
        // is the only thing that can move it.
        document.documentElement.setAttribute(`data-text-size`, `compact`);
        await vi.advanceTimersByTimeAsync(10);
        expect(win.document.documentElement.getAttribute(`data-text-size`)).toBe(`compact`);

        // And back to the default, which is the ABSENCE of the attribute — a stale `compact` left behind here
        // would strand the window one size below the app for as long as it stayed open.
        document.documentElement.removeAttribute(`data-text-size`);
        await vi.advanceTimersByTimeAsync(10);
        expect(win.document.documentElement.hasAttribute(`data-text-size`)).toBe(false);
    });
});
