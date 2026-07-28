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
}

// Marks the keeper script, so re-dressing an adopted document leaves the one live script in it alone.
const KEEPER_ATTR = `data-intentic-keeper`;

// How long a remembered window gets to come back before the panel stops holding its docked slot shut. One
// keeper tick plus the app's own boot. Both ways of being wrong are now cheap: overshooting means an emptier
// column for a moment, and undershooting only means the panel shows docked until the window reports in — it is
// no longer a deadline the window has to beat to survive (see stopWaiting).
const RECLAIM_GRACE_MS = 2500;

/* The only script that runs INSIDE the pop-out window — and the only thing about the panel that survives the
 * opener reloading, since every other part of it lives in the opener's realm. That makes it the only party
 * that can speak for this window when the realm behind it dies, so each tick it asks whatever page currently
 * answers on the opener whether anyone is driving it, and acts on the answer:
 *   · yes — a live page holds it (a fresh load takes it over on the very tick it first answers). Nothing to do.
 *   · no  — veil the panel NOW. It may be a page mid-reload, in which case the veil lifts a few ticks later;
 *           what it must never be is a dead panel that still looks like the app.
 *   · nobody, for ~12s — close. The tab was shut, or navigated away from the app; a floating window with
 *           nothing driving it is worse than no window.
 * `window.name` is the target name window.open gave it, which is the key the opener's stores are registered
 * under. */
const KEEPER_SOURCE = `(() => {
    const VEIL = "data-intentic-veil";
    let orphaned = 0;
    // Covers the panel the moment nobody answers for it, so a frozen picture of the app can never be mistaken
    // for the app. Re-created rather than toggled: an adoption re-dresses this document (body and head are
    // cleared), and the next tick simply puts it back if it is still needed.
    const veil = (on) => {
        const shown = document.querySelector("[" + VEIL + "]");
        if (!on) {
            if (shown) shown.remove();
            return;
        }
        if (shown) return;
        const el = document.createElement("div");
        el.setAttribute(VEIL, "");
        el.textContent = "Reconnecting…";
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font:500 13px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.62)";
        (document.body || document.documentElement).appendChild(el);
    };
    setInterval(() => {
        const opener = window.opener;
        if (!opener || opener.closed) {
            window.close();
            return;
        }
        let driven = false;
        try {
            const adopt = opener.__intentic?.adoptPopout;
            // Running the opener's code IS the proof of life — a page mid-reload has no hook yet, and a dead
            // realm has none ever again. Either way the answer is false and this window says so.
            driven = typeof adopt === "function" && adopt(window.name, window) === true;
        } catch {
            window.close(); // opener navigated cross-origin: its realm is unreachable, nobody can drive us
            return;
        }
        veil(!driven);
        orphaned = driven ? 0 : orphaned + 1;
        if (orphaned > 60) {
            window.close(); // ~12s with nothing on the other end — long enough to outlast a slow reload
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
// back may be a completely fresh load, so the hook resolves the store at call time. An unknown name answers
// false rather than nothing: this page drives no window by that name, which is exactly what the asker needs
// to hear.
const adopters = new Map<string, (win: Window) => boolean>();
window.__intentic = { adoptPopout: (name, win) => adopters.get(name)?.(win) === true };

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
        body.value = win.document.body; // set the target before activating the teleport
        restoring.value = false;
        poppedOut.value = true;
        remember(true);
        // beforeunload fires while the document is still whole (so `salvage` can rescue the panel); pagehide
        // is the backstop for the paths that skip it.
        win.addEventListener(`beforeunload`, dock);
        win.addEventListener(`pagehide`, dock);
        themeObserver = new MutationObserver(() => mirrorRoot(win.document));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [`data-mode`, `class`] });
    };

    /* The keeper's question, answered for this store's window. It arrives every 200ms from the moment the
     * window opens, so the common case by far is "yes, still mine, still alive" — and answering it at all is
     * the proof, since a torn-down realm never gets here. The three ways to say no each mean something
     * different to the asker: a window this page no longer holds (docked deliberately, or replaced by another)
     * is told to close, while a page that simply isn't driving it — because it never adopted it — lets the
     * keeper veil the panel and keep asking. */
    adopters.set(name, (win) => {
        if (win.closed) {
            return false;
        }
        if (popoutWindow === win) {
            return true;
        }
        if (dismissed || poppedOut.value) {
            win.close();
            return false;
        }
        attach(win);
        return true;
    });

    const dock = (): void => {
        if (!poppedOut.value) {
            stopWaiting();
            dismissed = true;
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
