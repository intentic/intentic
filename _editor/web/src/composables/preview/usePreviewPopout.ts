import type { Router } from "vue-router";
import { createPopout, type Popout } from "../usePopout";
import { markPreviewOpened } from "./previewSurface";

/* The preview panel's pop-out window, the "app on the second monitor while the code fills the first"
 * arrangement, on exactly the chat's machinery (usePopout owns the window contract: remembered frame,
 * re-adoption across reloads, the keeper's liveness handshake). A module-level singleton like useChatPopout.
 *
 * The default frame is generous where the chat's is narrow: the thing in this window is somebody's whole app,
 * and a phone-width strip of it would misrepresent the work. Whatever the user drags it to wins afterwards,
 * the remembered frame outranks this on every reopen. */
const popout = createPopout(`preview`, `Intentic · Preview`, () => ({
    width: Math.max(Math.round(window.innerWidth * 0.6), 960),
    height: Math.min(window.innerHeight, 1000),
}));

export function usePreviewPopout(): Popout {
    return popout;
}

/* The pop-out toggle every explicit control routes through (the panel's own button, the palette command),
 * the chat's contract (chatSurface.toggleChatPopout): docking back lands the panel in its home, and its home
 * is the /preview area, so a press that said "bring it back" also walks there rather than leaving the panel
 * parked behind its tile, technically docked, visibly vanished. A window closed by its own × keeps the plain
 * dock (usePopout's keeper): that press said only "close this window". Here rather than in previewSurface.ts
 * because that module stays free of the pop-out machinery's window hook (sandboxScope imports it DOM-less). */
export const togglePreviewPopout = (router: Router): void => {
    const wasOut = popout.poppedOut.value;
    markPreviewOpened();
    popout.toggle();
    if (wasOut && router.currentRoute.value.name !== `preview`) {
        void router.push(`/preview`);
    }
};
