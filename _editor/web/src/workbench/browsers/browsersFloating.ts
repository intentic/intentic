import { createFloatingSurface, type FloatingSurface } from "../window/floating";
import { markBrowsersOpened } from "./browsersSurface";

// The Browsers view's own window, on the chat's floating mechanism (workbench/window/floating.ts owns the window
// contract). Default frame is generous, since the window holds someone's whole app or a browser; the remembered frame
// outranks it on every reopen.
const surface = createFloatingSurface(`browsers`, () => ({
    width: Math.max(Math.round(window.innerWidth * 0.6), 960),
    height: Math.min(window.innerHeight, 1000),
}));

export function useBrowsersFloating(): FloatingSurface {
    return surface;
}

// Toggle every explicit control routes through; adds the view's existence to the surface's toggle, since nothing
// mounts until asked. Docking it elsewhere is PoppablePanels.vue's job.
export const toggleBrowsersFloating = (): void => {
    markBrowsersOpened();
    surface.toggle();
};
