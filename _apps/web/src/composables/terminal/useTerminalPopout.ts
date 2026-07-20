import { createPopout, type Popout } from "../usePopout";

/* The global terminal panel's pop-out window (right-click the panel's tab strip, mirroring the chat strip):
 * the WHOLE panel — every tab's live xterm — moves into a floating always-on-top window while the shared
 * session cache keeps streaming, so shells and dev servers stay watchable beside other apps. While popped
 * out the shell teleports the panel there and the docked slot renders nothing. */

const popout = createPopout(() => ({
    width: Math.min(window.innerWidth, 1100),
    height: Math.min(window.innerHeight, 520),
}));

export function useTerminalPopout(): Popout {
    return popout;
}
