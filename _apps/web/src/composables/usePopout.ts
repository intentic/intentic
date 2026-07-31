import { computed, type ComputedRef, nextTick, ref, type Ref, shallowRef, type ShallowRef } from "vue";

/* Pop-out window core, shared by the chat panel and the terminal panel. createPopout builds one independent
 * pop-out store: the panel's DOM is teleported into a REAL browser window (window.open) while the JS stays in
 * this realm, so the owning singletons (the useChat stream, the terminal session cache) keep working untouched
 * — no state duplication, live streams never drop.
 *
 * A real window, not Document Picture-in-Picture: the pip window was a fixed always-on-top strip with no
 * chrome — it could not be maximized, full-screened, tiled by the window manager, or even opened twice (the
 * browser allows ONE pip window per page, so popping the terminal out docked the chat). An ordinary popup is a
 * first-class OS window: maximize, full-screen, snap, and one per panel at the same time. It is also portable —
 * every browser opens windows, where document PiP was Chromium-only, so there is no `supported` gate left to
 * ask about.
 *
 * The window opens on a real page of this app — /popout.html, a near-empty document whose whole job is to hold
 * a panel and report in (src/popout/keeper.ts) — rather than the about:blank it used to be. Same origin either
 * way, so this realm owns that document outright: styles are cloned in, the theme root is mirrored, and the
 * panel is Teleported into its body. Closing it (its own ×) docks the panel back. What the address buys is what
 * the WINDOW is: one of the app's own, with the app's URL in the bar and its icon in the taskbar, painting the
 * canvas from the first frame — where about:blank read to the user (and to the browser's own chrome) as a
 * window that came from nowhere.
 *
 * It also means the keeper is the window's OWN code rather than a script injected from here, so the window can
 * speak for itself before anything is teleported into it. Which makes the handshake below the ONE way a panel
 * ever reaches a window: popping out is window.open plus the keeper's first question, so opening a window and
 * re-adopting one that outlived a reload are the same path, held to the same tests.
 *
 * A page reload does NOT dock it. The window outlives the realm that opened it and is re-adopted by the fresh
 * page (src/popout/keeper.ts), because a reload is not a decision to dock — dev-server HMR, an update reload
 * or an F5 would otherwise yank a full-screened chat back into its column every time.
 *
 * WHICH MAKES LIVENESS THE ONE INVARIANT THIS MODULE OWES THE REST OF THE APP: everything a pop-out window
 * shows is rendered by a realm in ANOTHER window, so the moment that realm goes away the panel out there stops
 * being a view of the app and becomes a photograph of it — same pixels, no state behind them. Selecting a chat
 * on the board leaves it unmoved; the tabs it lists are the ones that were open when the realm died; a draft
 * that has since been swept sits there focused. Every "the popped-out window is out of sync" report is this,
 * because two windows CANNOT hold divergent state while one realm drives both.
 *
 * So the keeper's tick is a question, not an announcement, and the answer below is the whole contract: a live
 * page holding this window answers true, and anything else — no page, a page that has since docked the panel,
 * a realm torn down mid-reload — answers false or doesn't answer at all. A window nobody answers for veils
 * itself ("Reconnecting…") within a tick and closes itself if no page takes it over, so a stale panel is
 * visibly stale for ~200ms and gone for good in seconds. It can never sit there looking live. */

declare global {
    interface Window {
        /* The question a pop-out window's keeper puts to its opener on every tick: "is a live page driving me?"
         * Installed by this module on every load, so a window opened by the PREVIOUS page finds it on the next
         * one. The BOOLEAN is what makes it a liveness check rather than only a re-adoption hook — and it is
         * answered by running this page's own code, which is the only proof of life that can't be faked by a
         * document still sitting on screen. */
        __intentic?: { readonly adoptPopout: (name: string, win: Window) => boolean };
    }

    /* The one fact the Window Management API gives a page without asking permission: whether the desktop spans
     * more than one screen. Chromium answers, the DOM lib TypeScript builds against doesn't know it yet, and
     * everyone else stays silent — so it is declared OPTIONAL, because "the browser didn't say" is a third
     * answer this module acts on (see onSomeScreen). */
    interface Screen {
        readonly isExtended?: boolean;
    }
}

// The page every popped-out panel floats in (popout.html, at the app's root). Opened with the panel named in
// its query, for the readers that see a window's address but not its title bar: the address bar itself, the
// browser's window list, and the session it restores from.
const POPOUT_PAGE = `/popout.html`;

// Marks the stylesheets THIS realm clones into a pop-out document, so re-dressing one replaces its clones and
// leaves the page's own head — its icon, its keeper — untouched.
const CLONE_ATTR = `data-intentic-clone`;

// How long a remembered window gets to come back before the panel stops holding its docked slot shut. One
// keeper tick plus the app's own boot. Both ways of being wrong are now cheap: overshooting means an emptier
// column for a moment, and undershooting only means the panel shows docked until the window reports in — it is
// no longer a deadline the window has to beat to survive (see stopWaiting).
const RECLAIM_GRACE_MS = 2500;

// What the design system keys off <html>: the color scheme (the PrimeVue dark preset and the role tokens) and
// the brand theme (themes.css token overrides). The pop-out page ships a static guess at the scheme for its
// first paint and nothing else, so both are mirrored from the live root here and re-mirrored on every change.
const THEME_ATTRIBUTES = [`data-mode`, `data-theme`];

const mirrorRoot = (doc: Document): void => {
    doc.documentElement.className = document.documentElement.className;
    for (const attribute of THEME_ATTRIBUTES) {
        const value = document.documentElement.getAttribute(attribute);
        if (value === null) {
            doc.documentElement.removeAttribute(attribute);
        } else {
            doc.documentElement.setAttribute(attribute, value);
        }
    }
};

const syncDocStyles = (doc: Document): void => {
    const clones = doc.head.querySelectorAll(`[${CLONE_ATTR}]`);
    for (let i = 0; i < clones.length; i++) {
        clones[i]?.remove();
    }
    const sheets = document.head.querySelectorAll(`style, link[rel="stylesheet"]`);
    for (let i = 0; i < sheets.length; i++) {
        const clone = sheets[i]?.cloneNode(true) as Element | undefined;
        if (clone) {
            clone.setAttribute(CLONE_ATTR, ``);
            doc.head.appendChild(clone);
        }
    }
};

// Clone every stylesheet (Vite/Tailwind/PrimeVue inject <style> in dev, <link> in prod) into the pop-out
// document, mirror the theme root, and make the body a full-height flex column on the app's canvas so the
// teleported panel fills the window at every size the user drags it to (full-screen included). Re-runnable:
// adopting a window that outlived its opener means dropping that page's stylesheet clones and its now-inert
// panel DOM first.
const dressWindow = (win: Window, title: string): void => {
    const doc = win.document;
    doc.title = title;
    doc.body.replaceChildren();
    syncDocStyles(doc);
    mirrorRoot(doc);
    // Inline rather than in the page's own stylesheet, because the clones above land after it: the layout the
    // Teleport target needs cannot be something an app-wide `body` rule gets to override.
    doc.body.style.cssText = `margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--color-canvas);color:var(--color-content)`;
};

/* WHERE THE WINDOW OPENS — the four numbers window.open takes, which are exactly the four a window hands back
 * (screenX / screenY / outerWidth / outerHeight). Being the same four is what lets the frame the user left the
 * window in be asked for again: popping out is a many-times-a-day gesture, and a window that always opens
 * centred on the app is one the user drags back to the same corner of the same screen every single time.
 * Chrome only honors a separate window (rather than a tab) when `popup` is asked for. */
interface Frame {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

const features = (frame: Frame): string =>
    `popup=1,width=${Math.round(frame.width)},height=${Math.round(frame.height)},left=${Math.round(frame.left)},top=${Math.round(frame.top)}`;

// Where a panel with nothing remembered opens: its current size, centred on the screen the app is on.
const centred = (size: { width: number; height: number }): Frame => ({
    width: size.width,
    height: size.height,
    left: window.screenX + Math.max(0, (window.outerWidth - size.width) / 2),
    top: window.screenY + Math.max(0, (window.outerHeight - size.height) / 2),
});

// Nobody deliberately leaves a window this small, so a frame under it is a bad reading (a window mid-close, a
// minimized one reporting zeros) rather than a preference — reopening into it would hand back an unusable sliver.
const MIN_FRAME = 240;

/* A remembered frame is honored verbatim, INCLUDING a position on a screen this page cannot measure — that is
 * the whole point, since the second monitor is where a popped-out panel tends to live. The one case worth
 * second-guessing is the monitor that has since been unplugged, whose coordinates now name nothing: a window
 * opened out there is one the user can neither find nor close. `screen.isExtended` is all a page is told about
 * the desktop's shape without asking permission, and only its FALSE is actionable — one screen attached, so a
 * frame that doesn't overlap it is stranded and the panel opens centred instead. Undefined (a browser that
 * doesn't answer) or true leaves the frame alone; guessing there would strand the multi-monitor user this
 * remembers the frame for. */
const onSomeScreen = (frame: Frame): boolean =>
    window.screen.isExtended !== false ||
    (frame.left < window.screen.availWidth && frame.top < window.screen.availHeight && frame.left + frame.width > 0 && frame.top + frame.height > 0);

// Every pop-out store on the page, by window name — a keeper knows only its own name, and the page it calls
// back may be a completely fresh load, so the hook resolves the store at call time. An unknown name answers
// false rather than nothing: this page drives no window by that name, which is exactly what the asker needs
// to hear.
const adopters = new Map<string, (win: Window) => boolean>();
window.__intentic = { adoptPopout: (name, win) => adopters.get(name)?.(win) === true };

/* DISMISSAL, IN THE WINDOW THE USER ACTUALLY CLICKED IN.
 *
 * Every overlay in the app arms itself the same way while it is open: ONE listener on `document`, watching for
 * the click that landed outside it (Escape is the same trick with a keydown). `document` in this realm is the
 * MAIN window's — and a popped-out panel's overlays are open in ANOTHER document, where a click on empty space
 * dispatches and dies without ever reaching that listener. So out there nothing dismissed: the model picker,
 * the mode menu, the tab context menu and the past-chats panel all stayed up until something else closed them.
 * One line inside PrimeVue, multiplied by every overlay type the panels use (Popover, ContextMenu, Select,
 * Dialog…) and by the app's own.
 *
 * So the fix is at the registration rather than at the call sites — the same choice the tooltip directive makes
 * by deriving its window from the anchor: a document-level interaction listener armed in this realm is armed on
 * every document the app is currently rendering into, and disarmed from them together. Nothing has to know it
 * is in a pop-out, and an overlay added later inherits this for free.
 *
 * Mirroring the LISTENER, not forwarding the event, is the whole point. Each overlay receives the real click,
 * with its real target, so its own guards still decide the outcome — PrimeVue reads that target to tell "truly
 * outside" from "the trigger I was just opened by" and from "my own content". A synthetic click re-dispatched
 * into the main document would carry the main document as its target, and every popover would close on the very
 * click that opened it. */

// What an overlay dismisses on: a press, a click, a context menu, a key. Deliberately not every document event
// — the rest (`visibilitychange`, `DOMContentLoaded`, …) describe the document that owns the listener rather
// than where the user is pointing, and sharing those would report a pop-out's lifecycle as the app's.
const SHARED_EVENTS = new Set([`pointerdown`, `pointerup`, `mousedown`, `mouseup`, `click`, `dblclick`, `contextmenu`, `keydown`, `keyup`]);

interface SharedListener {
    readonly type: string;
    readonly listener: EventListenerOrEventListenerObject;
    // Identifies the registration alongside type + listener, and the only option a removal is matched on.
    readonly capture: boolean;
    readonly options: boolean | AddEventListenerOptions | undefined;
}

const sharedListeners: SharedListener[] = [];
const popoutDocuments = new Set<Document>();

const captureOf = (options: boolean | AddEventListenerOptions | EventListenerOptions | undefined): boolean =>
    typeof options === `boolean` ? options : options?.capture === true;

const nativeAdd = document.addEventListener.bind(document);
const nativeRemove = document.removeEventListener.bind(document);

document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
): void => {
    if (listener === null) {
        return; // a null callback registers nothing, here or anywhere else
    }
    nativeAdd(type, listener, options);
    // `once` is a single shot, and it belongs to whichever document fires first — there is no way to spend it
    // out in the pop-out without risking spending it twice, so a once-listener stays where it was armed.
    if (!SHARED_EVENTS.has(type) || (typeof options === `object` && options.once === true)) {
        return;
    }
    const capture = captureOf(options);
    // addEventListener is idempotent per (type, listener, capture), so this registry has to be too: a second
    // arming the browser itself ignored must not leave a duplicate to replay into the next window that opens.
    if (sharedListeners.some((entry) => entry.type === type && entry.listener === listener && entry.capture === capture)) {
        return;
    }
    sharedListeners.push({ type, listener, capture, options });
    for (const doc of popoutDocuments) {
        doc.addEventListener(type, listener, options);
    }
}) as Document[`addEventListener`];

document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
): void => {
    if (listener === null) {
        return;
    }
    nativeRemove(type, listener, options);
    const capture = captureOf(options);
    const index = sharedListeners.findIndex((entry) => entry.type === type && entry.listener === listener && entry.capture === capture);
    if (index === -1) {
        return;
    }
    sharedListeners.splice(index, 1);
    // Capture is the only option a removal is matched on, so the caller's own is enough to undo the arming.
    for (const doc of popoutDocuments) {
        doc.removeEventListener(type, listener, options);
    }
}) as Document[`removeEventListener`];

let headObserver: MutationObserver | undefined;

const syncAllPopoutStyles = (): void => {
    popoutDocuments.forEach((doc) => {
        syncDocStyles(doc);
    });
};

const startHeadObserver = (): void => {
    if (headObserver !== undefined || typeof MutationObserver === `undefined` || !document.head) {
        return;
    }
    headObserver = new MutationObserver(() => {
        if (popoutDocuments.size > 0) {
            syncAllPopoutStyles();
        }
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
};

const stopHeadObserver = (): void => {
    if (popoutDocuments.size === 0 && headObserver !== undefined) {
        headObserver.disconnect();
        headObserver = undefined;
    }
};

// A pop-out document joins the set of documents the app renders into: everything armed so far is armed on it,
// so an overlay that was ALREADY open when the panel popped out dismisses out there too.
const shareListeners = (doc: Document): void => {
    popoutDocuments.add(doc);
    startHeadObserver();
    for (const entry of sharedListeners) {
        doc.addEventListener(entry.type, entry.listener, entry.options);
    }
};

// …and leaves it on dock. The window is usually closing, but not always the way it looks: a window this page
// hands back keeps its document, and a page that adopts it next arms its own realm's listeners on it.
const unshareListeners = (doc: Document): void => {
    popoutDocuments.delete(doc);
    stopHeadObserver();
    for (const entry of sharedListeners) {
        doc.removeEventListener(entry.type, entry.listener, entry.options);
    }
};

export interface Popout {
    readonly poppedOut: Ref<boolean>;
    // A window from before this page's load is expected back (this load follows a reload that left one
    // floating) and has not reported in yet. The shell keeps the panel's docked slot collapsed and unmounted
    // while it is true, so the panel materialises straight into the returning window instead of flashing
    // docked for a few frames on every refresh.
    readonly restoring: Ref<boolean>;
    // The pop-out document's body — the Teleport target while popped out, undefined while docked.
    readonly body: ShallowRef<HTMLElement | undefined>;
    // Where the panel's PrimeVue overlays (Selects, Popovers, menus, dialogs) render — the pop-out body while
    // popped out so they open in the floating window, otherwise the default document body.
    readonly overlayTarget: ComputedRef<HTMLElement | "body">;
    readonly popOut: () => void;
    readonly dock: () => void;
    readonly toggle: () => void;
}

// One pop-out store. `name` is the panel's slug, and every identity the window has is that one string: its
// target name (so re-popping reuses the window rather than stacking), the `?panel=` in its address, the key its
// keeper reports in under, and the key of its session note. `size` is read at popOut() time so the window opens
// at the panel's current dimensions.
export const createPopout = (name: string, title: string, size: () => { width: number; height: number }): Popout => {
    const poppedOut = ref(false);
    const body = shallowRef<HTMLElement>();
    let popoutWindow: Window | undefined;
    let themeObserver: MutationObserver | undefined;

    /* "This TAB had the panel floating when it went away" — the note the fresh page reads to know a window is
     * on its way back, so it can hold the panel's docked slot shut instead of flashing it open. sessionStorage
     * because that is exactly the scope of the claim: it survives reloads and dies with the tab, where
     * localStorage would have a SECOND app tab waiting on a window that only ever belonged to the first.
     * Written when the window opens, cleared when the panel docks — so the only stale note is one left by a
     * window dying without its unload handlers (a crash), which the grace timer below writes off.
     *
     * The note is an optimization, not the mechanism: adoption is driven by the returning window's own
     * handshake, so a panel comes back even when the note is missing — just a few frames later. */
    const storageKey = `ui-popout-${name}`;
    const remember = (open: boolean): void => {
        if (open) {
            sessionStorage.setItem(storageKey, `1`);
        } else {
            sessionStorage.removeItem(storageKey);
        }
    };

    const restoring = ref(sessionStorage.getItem(storageKey) === `1`);

    /* THE FRAME THE WINDOW COMES BACK IN. localStorage, not the sessionStorage note above, because the two are
     * different claims: that note says "THIS tab had the panel floating a moment ago" and dies with the tab,
     * while where the user keeps this window is a habit that outlives tabs, sessions and browser restarts.
     * Written when the panel LEAVES the window — its ×, a dock, a reload out there — which is the last moment
     * the geometry is still readable, and the moment a user who has just finished moving the window has
     * finished moving it. */
    const frameKey = `ui-popout-frame-${name}`;
    const rememberFrame = (win: Window): void => {
        // A window mid-close reports zeros, and parking the next one in the top-left corner at 0×0 is worse
        // than forgetting where this one was.
        if (win.closed || win.outerWidth < MIN_FRAME || win.outerHeight < MIN_FRAME) {
            return;
        }
        localStorage.setItem(frameKey, [win.screenX, win.screenY, win.outerWidth, win.outerHeight].join(`,`));
    };

    const rememberedFrame = (): Frame | undefined => {
        const stored = localStorage.getItem(frameKey);
        if (stored === null) {
            return undefined;
        }
        const [left, top, width, height] = stored.split(`,`).map(Number);
        if (left === undefined || top === undefined || width === undefined || height === undefined) {
            return undefined;
        }
        // A NaN or an Infinity anywhere in a hand-edited (or half-written) note makes the sum non-finite.
        if (!Number.isFinite(left + top + width + height) || width < MIN_FRAME || height < MIN_FRAME) {
            return undefined;
        }
        const frame = { left, top, width, height };
        return onSomeScreen(frame) ? frame : undefined;
    };

    /* Two ways the wait for a returning window can end, and they are NOT the same decision — running them
     * through one flag is what let a window that reported in a beat late get closed under the user, panel and
     * all, for the crime of a slow reload:
     *   · THE GRACE RUNS OUT — stop holding the docked slot shut, and nothing more. The window may well still
     *     be alive out there (a reload behind a tunnel, a cold dev server, a throttled background tab), and its
     *     keeper is still asking every 200ms; taking it over late is exactly what the user wants, so the store
     *     stays adoptable and the panel simply pops back out when it arrives.
     *   · THE PANEL IS DOCKED DELIBERATELY — refuse it. A window reporting in after that is a leftover with
     *     nothing to show, and closing it is the only way it stops floating.
     */
    let dismissed = false;
    const stopWaiting = (): void => {
        restoring.value = false;
        remember(false);
    };
    if (restoring.value) {
        window.setTimeout(() => {
            if (restoring.value) {
                stopWaiting();
            }
        }, RECLAIM_GRACE_MS);
    }

    /* The panel's live DOM is IN the closing document, and Vue only moves it back on the next flush — by which
     * time the window is gone. So rescue the nodes synchronously into a detached holder in this document
     * first: they are the same elements either way (a live xterm, a streaming transcript), and the Teleport
     * lifts them out of the holder into the docked slot a tick later. */
    const salvage = (): HTMLElement | undefined => {
        const from = body.value;
        if (from === undefined) {
            return undefined;
        }
        const holder = document.createElement(`div`);
        holder.style.display = `none`;
        document.body.appendChild(holder);
        while (from.firstChild !== null) {
            holder.appendChild(from.firstChild); // appending across documents adopts
        }
        return holder;
    };

    const attach = (win: Window): void => {
        dressWindow(win, title);
        popoutWindow = win;
        shareListeners(win.document);
        body.value = win.document.body; // set the target before activating the teleport
        restoring.value = false;
        poppedOut.value = true;
        remember(true);
        // beforeunload fires while the document is still whole (so `salvage` can rescue the panel); pagehide
        // is the backstop for the paths that skip it.
        win.addEventListener(`beforeunload`, released);
        win.addEventListener(`pagehide`, released);
        themeObserver = new MutationObserver(() => mirrorRoot(win.document));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [...THEME_ATTRIBUTES, `class`] });
    };

    /* The keeper's question, answered for this store's window. It arrives from the moment the window's page
     * loads and every 200ms after, so the common case by far is "yes, still mine, still alive" — and answering
     * it at all is the proof, since a torn-down realm never gets here. The ways to say no each mean something
     * different to the asker: a window this page no longer holds (docked deliberately, or replaced by another)
     * is told to close, while a page that simply isn't driving it — because it never adopted it — lets the
     * keeper veil the panel and keep asking. */
    adopters.set(name, (win) => {
        if (win.closed) {
            return false;
        }
        if (popoutWindow === win) {
            // Ours — unless the document beneath it has been swapped for a new one, which is a reload out there
            // whose unload never reached us. The panel is in the old document, so this is a window to take over
            // again rather than one to reassure: answering yes would leave it holding an empty page.
            if (body.value === win.document.body) {
                return true;
            }
            released();
        } else if (dismissed || poppedOut.value) {
            win.close();
            return false;
        }
        attach(win);
        return true;
    });

    /* The two ways a panel leaves a window differ in exactly one thing — what happens to the window:
     *   · released() — the window is going away on its own, so there is nothing to close. It is also the path a
     *     RELOAD out there takes, and closing the window on that would abort the navigation and take the panel
     *     with it; left alone, the reloading window comes back, reports in and is re-adopted, so the panel spends
     *     a beat in its column and pops straight back out.
     *   · dock() — the user asked for the panel in its column, so the window has no reason to exist: close it. */
    const released = (): void => {
        if (!poppedOut.value) {
            return;
        }
        const win = popoutWindow;
        popoutWindow = undefined;
        themeObserver?.disconnect();
        themeObserver = undefined;
        if (win) {
            // Before anything else: this runs from `beforeunload` / `pagehide`, while the window is still whole
            // and its frame still readable. A moment later it is a closed window reporting zeros.
            rememberFrame(win);
            win.removeEventListener(`beforeunload`, released);
            win.removeEventListener(`pagehide`, released);
        }
        // The document the panel is IN, which is not always `win.document`: a window whose page has already been
        // replaced hands back the new one, and the listeners — like the panel below — belong to the old.
        const shared = body.value?.ownerDocument;
        if (shared !== undefined) {
            unshareListeners(shared);
        }
        const holder = salvage();
        // Flip after the rescue so the Teleport's move lands on nodes that are already in this document; the
        // now-empty holder goes on the tick after that move.
        poppedOut.value = false;
        body.value = undefined;
        remember(false);
        void nextTick(() => holder?.remove());
    };

    const dock = (): void => {
        if (!poppedOut.value) {
            stopWaiting();
            dismissed = true;
            return;
        }
        const win = popoutWindow;
        released();
        win?.close();
    };

    /* Opening the window is the whole of popping out: the page it loads asks to be adopted (src/popout/keeper.ts)
     * and the hook above teleports the panel into it, so there is no second path for pushing a panel out and no
     * way for this one to skip the liveness handshake. The panel stays docked and LIVE for the load in between —
     * a local page, so a frame or two — rather than being unmounted while the window boots. */
    const popOut = (): void => {
        if (poppedOut.value) {
            return;
        }
        // A matching target name reuses the window it already refers to, navigating it: re-popping cannot stack
        // windows, and a window a reload left floating is taken back over rather than joined by a second one.
        const win = window.open(`${POPOUT_PAGE}?panel=${name}`, name, features(rememberedFrame() ?? centred(size())));
        if (win === null) {
            return; // blocked by the popup blocker — the panel stays docked
        }
        dismissed = false;
        win.focus();
    };

    const toggle = (): void => {
        if (poppedOut.value) {
            dock();
            return;
        }
        popOut();
    };

    const overlayTarget = computed<HTMLElement | "body">(() => (poppedOut.value ? (body.value ?? `body`) : `body`));

    return { poppedOut, restoring, body, overlayTarget, popOut, dock, toggle };
};
