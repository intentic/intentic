import { createPopout, type Popout } from "../usePopout";

/* The global terminal panel's pop-out window (right-click the panel's tab strip, mirroring the chat strip):
 * the WHOLE panel, every tab's live xterm, moves into a real, resizable, full-screenable window while the
 * shared session cache keeps streaming, so shells and dev servers stay watchable beside other apps. While
 * popped out the shell teleports the panel there, the docked slot renders nothing, and the tab strip stands
 * on the window's left edge. */

const popout = createPopout(`terminal`, `Intentic · Terminal`, () => ({
    width: Math.min(window.innerWidth, 1100),
    height: Math.min(window.innerHeight, 700),
}));

export function useTerminalPopout(): Popout {
    return popout;
}
