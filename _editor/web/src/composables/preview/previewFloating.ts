import { createFloatingSurface, type FloatingSurface } from "../floating";
import { markPreviewOpened } from "./previewSurface";

/* The preview panel's own window, the "app on the second monitor while the code fills the first" arrangement,
 * on exactly the chat's mechanism (composables/floating.ts owns the window contract: the remembered frame, the
 * heartbeat every other window reads, the oldest-claim rule that keeps the count at one).
 *
 * The default frame is generous where the chat's is narrow: the thing in this window is somebody's whole app,
 * and a phone-width strip of it would misrepresent the work. Whatever the user drags it to wins afterwards,
 * the remembered frame outranks this on every reopen. */
const surface = createFloatingSurface(`preview`, () => ({
    width: Math.max(Math.round(window.innerWidth * 0.6), 960),
    height: Math.min(window.innerHeight, 1000),
}));

export function usePreviewFloating(): FloatingSurface {
    return surface;
}

/* The toggle every explicit control routes through (the panel's own button, the palette command). All it adds
 * to the surface's own toggle is the panel's EXISTENCE: nothing preview-shaped mounts until someone has asked
 * to see it, and asking for it in a window of its own is asking. Landing a docked preview somewhere visible is
 * not this door's business, it is one watch that covers every door (shell/PoppablePanels.vue). */
export const togglePreviewFloating = (): void => {
    markPreviewOpened();
    surface.toggle();
};
