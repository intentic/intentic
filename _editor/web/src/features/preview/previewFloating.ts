import { createFloatingSurface, type FloatingSurface } from "../../shell/window/floating";
import { markPreviewOpened } from "./previewSurface";

// Preview panel's own window, on the chat's floating mechanism (composables/floating.ts owns the window contract).
// Default frame is generous, since the window holds someone's whole app; the remembered frame outranks it on every
// reopen.
const surface = createFloatingSurface(`preview`, () => ({
    width: Math.max(Math.round(window.innerWidth * 0.6), 960),
    height: Math.min(window.innerHeight, 1000),
}));

export function usePreviewFloating(): FloatingSurface {
    return surface;
}

// Toggle every explicit control routes through; adds the panel's existence to the surface's toggle, since nothing
// preview-shaped mounts until asked. Docking a preview elsewhere is PoppablePanels.vue's job.
export const togglePreviewFloating = (): void => {
    markPreviewOpened();
    surface.toggle();
};
