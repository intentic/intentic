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
 * theme root is mirrored, and the panel is Teleported into its body. Closing it (its own ×, or this tab going
 * away) docks the panel back. */

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
// the window at every size the user drags it to (full-screen included).
const dressWindow = (win: Window, title: string): void => {
    const doc = win.document;
    // about:blank normally parses to an empty html/head/body; write one if the browser handed over a bare
    // document, so the appends below have somewhere to land.
    if (doc.body === null) {
        doc.write(`<!doctype html><html><head></head><body></body></html>`);
        doc.close();
    }
    doc.title = title;
    for (const node of document.head.querySelectorAll(`style, link[rel="stylesheet"]`)) {
        doc.head.appendChild(node.cloneNode(true));
    }
    mirrorRoot(doc);
    doc.body.style.cssText = `margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden`;
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

export interface Popout {
    readonly poppedOut: Ref<boolean>;
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

    // This tab going away (reload, navigation) must not leave a floating panel behind with nothing driving it.
    const closeWindow = (): void => popoutWindow?.close();

    const dock = (): void => {
        if (!poppedOut.value) {
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
        void nextTick(() => holder?.remove());
        window.removeEventListener(`beforeunload`, closeWindow);
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
        dressWindow(win, title);
        popoutWindow = win;
        body.value = win.document.body; // set the target before activating the teleport
        poppedOut.value = true;
        win.focus();
        // beforeunload fires while the document is still whole (so `salvage` can rescue the panel); pagehide
        // is the backstop for the paths that skip it.
        win.addEventListener(`beforeunload`, dock);
        win.addEventListener(`pagehide`, dock);
        window.addEventListener(`beforeunload`, closeWindow);
        themeObserver = new MutationObserver(() => mirrorRoot(win.document));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [`data-mode`, `class`] });
    };

    const toggle = (): void => {
        if (poppedOut.value) {
            dock();
            return;
        }
        popOut();
    };

    const overlayTarget = computed<HTMLElement | "body">(() => (poppedOut.value ? (body.value ?? `body`) : `body`));

    return { poppedOut, body, overlayTarget, popOut, dock, toggle };
};
