import { computed, ref, shallowRef } from "vue";
import { useLayout } from "../useLayout";

/* Pops the chat panel out into a floating window via the native Document Picture-in-Picture API — a
 * module-level singleton like the rest of the layout/chat state. The panel's DOM is teleported into the pip
 * window while the JS stays in this realm, so the useChat singleton (streaming turn, session, connection) keeps
 * working untouched: no state duplication, the live stream never drops. Chromium only; `supported` gates the
 * button so Firefox/Safari never see it. When popped out the shell collapses the chat grid column. */

// Not in the DOM lib types yet; a local shape on window keeps the interop cast in this one spot.
interface DocumentPictureInPictureApi {
    requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
const dpipApi = (): DocumentPictureInPictureApi | undefined =>
    (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture;

const layout = useLayout();

const poppedOut = ref(false);
const pipBody = shallowRef<HTMLElement>();
let pipWindow: Window | undefined;
let themeObserver: MutationObserver | undefined;

// The pip document loads with no CSS and light-mode root; mirror the theme attribute/classes so the dark preset
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

// Clone every stylesheet (Vite/Tailwind/PrimeVue inject <style> in dev, <link> in prod) into the pip document,
// mirror the theme root, and make the body a full-height flex column so the teleported panel fills it.
const copyStyles = (doc: Document): void => {
    for (const node of document.head.querySelectorAll(`style, link[rel="stylesheet"]`)) {
        doc.head.appendChild(node.cloneNode(true));
    }
    mirrorRoot(doc);
    doc.body.style.cssText = `margin:0;height:100vh;display:flex;flex-direction:column`;
};

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
    const pip = await api.requestWindow({ width: layout.chatWidth.value, height: Math.min(window.innerHeight, 900) });
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

// Where the chat's PrimeVue overlays (Selects, Popovers) render — the pip body while popped out so they open in
// the floating window, otherwise the default document body.
const overlayTarget = computed<HTMLElement | "body">(() => (poppedOut.value ? (pipBody.value ?? `body`) : `body`));

export function useChatPopout() {
    return {
        supported: dpipApi() !== undefined,
        poppedOut,
        pipBody,
        overlayTarget,
        popOut,
        dock,
        toggle,
    };
}
