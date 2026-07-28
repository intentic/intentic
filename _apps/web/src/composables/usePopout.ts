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
 * The window is same-origin about:blank, so this realm owns its document outright: styles are cloned in, the
 * theme root is mirrored, and the panel is Teleported into its body. Closing it (its own ×) docks the panel
 * back.
 *
 * A page reload does NOT dock it. The window outlives the realm that opened it and is re-adopted by the fresh
 * page (see the keeper below), because a reload is not a decision to dock — dev-server HMR, an update reload
 * or an F5 would otherwise yank a full-screened chat back into its column every time. */

declare global {
    interface Window {
        // The handshake a pop-out window's keeper calls on its opener to be re-adopted. Installed by this
        // module on every load, so a window opened by the PREVIOUS page finds it on the next one.
        __intentic?: { readonly adoptPopout: (name: string, win: Window) => void };
    }
}

// Marks the keeper script, so re-dressing an adopted document leaves the one live script in it alone.
const KEEPER_ATTR = `data-intentic-keeper`;

// How long a remembered window gets to come back before the panel gives up and docks. One keeper tick plus
// the app's own boot; overshooting only means an emptier column for a moment, undershooting docks a window
// that was about to return.
const RECLAIM_GRACE_MS = 2500;

/* The only script that runs INSIDE the pop-out window — and the only thing about the panel that survives the
 * opener reloading, since every other part of it lives in the opener's realm. Each tick it offers the window
 * back to whatever page currently answers on the opener, so the fresh load re-adopts it; when nobody is
 * coming — the tab was closed, or navigated away from the app — it closes itself rather than leaving a
 * floating panel with nothing driving it. `window.name` is the target name window.open gave it, which is the
 * key the opener's stores are registered under. */
const KEEPER_SOURCE = `(() => {
    let misses = 0;
    setInterval(() => {
        const opener = window.opener;
        if (!opener || opener.closed) {
            window.close();
            return;
        }
        let adopt;
        try {
            adopt = opener.__intentic?.adoptPopout;
        } catch {
            window.close(); // opener navigated cross-origin: its realm is unreachable, nobody can drive us
            return;
        }
        if (typeof adopt === "function") {
            misses = 0;
            adopt(window.name, window);
            return;
        }
        misses += 1;
        if (misses > 50) {
            window.close(); // ~10s with no app on the other end
        }
    }, 200);
})();`;

// The document arrives styleless with a light-mode root; mirror the theme attribute/classes so the dark preset
// and role tokens key the same way as the main window.
const mirrorRoot = (doc: Document): void => {
    doc.documentElement.className = document.documentElement.className;
    const mode = document.documentElement.getAttribute(`data-mode`);
    if (mode === null) {
        doc.documentElement.removeAttribute(`data-mode`);
    } else {
        doc.documentElement.setAttribute(`data-mode`, mode);
    }
};

// Clone every stylesheet (Vite/Tailwind/PrimeVue inject <style> in dev, <link> in prod) into the pop-out
// document, mirror the theme root, and make the body a full-height flex column so the teleported panel fills
// the window at every size the user drags it to (full-screen included). Re-runnable: adopting a window that
// outlived its opener means clearing out that page's stylesheet clones and its now-inert panel DOM first.
const dressWindow = (win: Window, title: string): void => {
    const doc = win.document;
    // about:blank normally parses to an empty html/head/body; write one if the browser handed over a bare
    // document, so the appends below have somewhere to land.
    if (doc.body === null) {
        doc.write(`<!doctype html><html><head></head><body></body></html>`);
        doc.close();
    }
    // Head first, title after: the clear-out takes everything the previous page put there (its stylesheet
    // clones, its <title>) and spares only the keeper, which is the live script that brought the window back.
    for (const node of doc.head.querySelectorAll(`:scope > :not([${KEEPER_ATTR}])`)) {
        node.remove();
    }
    doc.title = title;
    doc.body.replaceChildren();
    for (const node of document.head.querySelectorAll(`style, link[rel="stylesheet"]`)) {
        doc.head.appendChild(node.cloneNode(true));
    }
    mirrorRoot(doc);
    doc.body.style.cssText = `margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden`;
    if (doc.querySelector(`script[${KEEPER_ATTR}]`) === null) {
        const keeper = doc.createElement(`script`);
        keeper.setAttribute(KEEPER_ATTR, ``);
        keeper.textContent = KEEPER_SOURCE;
        doc.head.appendChild(keeper);
    }
};

// Where the window opens: the panel's current size, centred on the screen the app is on. Chrome only honors a
// separate window (rather than a tab) when `popup` is asked for.
const features = (size: { width: number; height: number }): string => {
    const width = Math.round(size.width);
    const height = Math.round(size.height);
    const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - width) / 2));
    const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - height) / 2));
    return `popup=1,width=${width},height=${height},left=${left},top=${top}`;
};

// Every pop-out store on the page, by window name — a keeper knows only its own name, and the page it calls
// back may be a completely fresh load, so the hook resolves the store at call time.
const adopters = new Map<string, (win: Window) => void>();
window.__intentic = { adoptPopout: (name, win) => adopters.get(name)?.(win) };

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

// One pop-out store. `name` is the window's target name, so re-popping reuses that window slot rather than
// stacking; `size` is read at popOut() time so the window opens at the panel's current dimensions.
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
    // Docked away while a window was still expected: stop waiting, and shut the window down if it does report
    // in (its keeper cannot know the panel was closed on this side in the meantime).
    let dismissed = false;
    const giveUp = (): void => {
        restoring.value = false;
        remember(false);
        dismissed = true;
    };
    if (restoring.value) {
        window.setTimeout(() => {
            if (restoring.value) {
                giveUp();
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

    /* This tab going away takes the panel's JS with it, so what is left in the window is a frozen picture of
     * it: dim it and stop it taking clicks, so the seconds until the fresh page re-adopts it (or its keeper
     * closes it) read as "reconnecting" rather than "typing here does nothing". pageshow undoes it for the
     * back/forward cache, where the same realm comes back alive; a reload re-dresses the body instead. */
    const markStale = (): void => {
        const shown = popoutWindow?.document.body;
        if (shown !== undefined) {
            shown.style.opacity = `0.55`;
            shown.style.pointerEvents = `none`;
        }
    };
    const markLive = (): void => {
        const shown = popoutWindow?.document.body;
        if (shown !== undefined) {
            shown.style.opacity = ``;
            shown.style.pointerEvents = ``;
        }
    };

    const attach = (win: Window): void => {
        dressWindow(win, title);
        popoutWindow = win;
        body.value = win.document.body; // set the target before activating the teleport
        restoring.value = false;
        poppedOut.value = true;
        remember(true);
        // beforeunload fires while the document is still whole (so `salvage` can rescue the panel); pagehide
        // is the backstop for the paths that skip it.
        win.addEventListener(`beforeunload`, dock);
        win.addEventListener(`pagehide`, dock);
        window.addEventListener(`pagehide`, markStale);
        window.addEventListener(`pageshow`, markLive);
        themeObserver = new MutationObserver(() => mirrorRoot(win.document));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [`data-mode`, `class`] });
    };

    // The keeper offers its window on every tick, from the moment it is popped out — so the common call is the
    // window this page already owns, and only a window from before the reload is actually taken over.
    adopters.set(name, (win) => {
        if (popoutWindow === win || win.closed) {
            return;
        }
        if (dismissed || poppedOut.value) {
            win.close();
            return;
        }
        attach(win);
    });

    const dock = (): void => {
        if (!poppedOut.value) {
            giveUp();
            return;
        }
        const win = popoutWindow;
        popoutWindow = undefined;
        themeObserver?.disconnect();
        themeObserver = undefined;
        if (win) {
            win.removeEventListener(`beforeunload`, dock);
            win.removeEventListener(`pagehide`, dock);
        }
        const holder = salvage();
        // Flip after the rescue so the Teleport's move lands on nodes that are already in this document; the
        // now-empty holder goes on the tick after that move.
        poppedOut.value = false;
        body.value = undefined;
        remember(false);
        void nextTick(() => holder?.remove());
        window.removeEventListener(`pagehide`, markStale);
        window.removeEventListener(`pageshow`, markLive);
        win?.close();
    };

    const popOut = (): void => {
        if (poppedOut.value) {
            return;
        }
        const win = window.open(``, name, features(size()));
        if (win === null) {
            return; // blocked by the popup blocker — the panel stays docked
        }
        dismissed = false;
        attach(win);
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
