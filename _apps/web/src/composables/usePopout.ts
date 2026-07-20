import { computed, type ComputedRef, ref, type Ref, shallowRef, type ShallowRef } from "vue";

/* Document Picture-in-Picture pop-out core, shared by the chat panel and the terminal panel. createPopout
 * builds one independent pop-out store: the panel's DOM is teleported into the pip window while the JS stays
 * in this realm, so the owning singletons (the useChat stream, the terminal session cache) keep working
 * untouched — no state duplication, live streams never drop. Chromium only; `supported` gates every entry
 * point so Firefox/Safari never see one. The browser allows a single pip window per page: opening the second
 * pop-out fires the first's `pagehide`, which docks it — both panels stay consistent without coordination. */

// Not in the DOM lib types yet; a local shape on window keeps the interop cast in this one spot.
interface DocumentPictureInPictureApi {
    requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
const dpipApi = (): DocumentPictureInPictureApi | undefined =>
    (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture;

export interface Popout {
    readonly supported: boolean;
    readonly poppedOut: Ref<boolean>;
    readonly pipBody: ShallowRef<HTMLElement | undefined>;
    // Where the panel's PrimeVue overlays (Selects, Popovers, menus, dialogs) render — the pip body while
    // popped out so they open in the floating window, otherwise the default document body.
    readonly overlayTarget: ComputedRef<HTMLElement | "body">;
    readonly popOut: () => Promise<void>;
    readonly dock: () => void;
    readonly toggle: () => void;
}

// The pip document loads with no CSS and light-mode root; mirror the theme attribute/classes so the dark
// preset and role tokens key the same way as the main window.
const mirrorRoot = (doc: Document): void => {
    doc.documentElement.className = document.documentElement.className;
    const mode = document.documentElement.getAttribute(`data-mode`);
    if (mode === null) {
        doc.documentElement.removeAttribute(`data-mode`);
    } else {
        doc.documentElement.setAttribute(`data-mode`, mode);
    }
};

// Clone every stylesheet (Vite/Tailwind/PrimeVue inject <style> in dev, <link> in prod) into the pip document,
// mirror the theme root, and make the body a full-height flex column so the teleported panel fills it.
const copyStyles = (doc: Document): void => {
    for (const node of document.head.querySelectorAll(`style, link[rel="stylesheet"]`)) {
        doc.head.appendChild(node.cloneNode(true));
    }
    mirrorRoot(doc);
    doc.body.style.cssText = `margin:0;height:100vh;display:flex;flex-direction:column`;
};

// One pop-out store; `size` is read at popOut() time so the window opens at the panel's current dimensions.
export const createPopout = (size: () => { width: number; height: number }): Popout => {
    const poppedOut = ref(false);
    const pipBody = shallowRef<HTMLElement>();
    let pipWindow: Window | undefined;
    let themeObserver: MutationObserver | undefined;

    const dock = (): void => {
        if (!poppedOut.value) {
            return;
        }
        // Flip first so the Teleport moves the panel back into the main grid before the pip document is torn down.
        poppedOut.value = false;
        pipBody.value = undefined;
        themeObserver?.disconnect();
        themeObserver = undefined;
        const pip = pipWindow;
        pipWindow = undefined;
        if (pip) {
            pip.removeEventListener(`pagehide`, dock);
            pip.close();
        }
    };

    const popOut = async (): Promise<void> => {
        const api = dpipApi();
        if (!api || poppedOut.value) {
            return;
        }
        // requestWindow needs the click's user activation, so it goes first (before any style work).
        const pip = await api.requestWindow(size());
        copyStyles(pip.document);
        pipWindow = pip;
        pipBody.value = pip.document.body; // set the target before activating the teleport
        poppedOut.value = true;
        pip.addEventListener(`pagehide`, dock);
        themeObserver = new MutationObserver(() => mirrorRoot(pip.document));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: [`data-mode`, `class`] });
    };

    const toggle = (): void => {
        if (poppedOut.value) {
            dock();
            return;
        }
        void popOut();
    };

    const overlayTarget = computed<HTMLElement | "body">(() => (poppedOut.value ? (pipBody.value ?? `body`) : `body`));

    return { supported: dpipApi() !== undefined, poppedOut, pipBody, overlayTarget, popOut, dock, toggle };
};
