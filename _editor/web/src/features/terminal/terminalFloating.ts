import { createFloatingSurface, type FloatingSurface } from "../../shell/window/floating";

/* The global terminal panel's own window (right-click the panel's tab strip, mirroring the chat strip): the WHOLE panel, every tab, in a real, resizable. */

const surface = createFloatingSurface(`terminal`, () => ({
    width: Math.min(window.innerWidth, 1100),
    height: Math.min(window.innerHeight, 700),
}));

export function useTerminalFloating(): FloatingSurface {
    return surface;
}
