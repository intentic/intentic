import { linuxInput } from "./input-linux.js";
import { windowsInput } from "./input-windows.js";
import { capture, frame } from "./screen.js";
import { type Desktop, DesktopError } from "./types.js";

export { parseChord, windowsChord, wtypeArgs, xdotoolChord, type Chord, type Modifier } from "./keys.js";
export { capture, frame, hasGraphicalSession, isWayland, pngSize } from "./screen.js";
export { DesktopError, type Desktop, type MouseButton, type Point, type ScreenFrame, type ScrollDirection } from "./types.js";

/* The desktop of the machine this process is running on.
 *
 * Platform dispatch happens once, here, rather than inside every method: the two backends have genuinely
 * different shapes (Windows needs the virtual-desktop origin, Linux needs to know Wayland from X11) and mixing
 * them behind per-method branches is how a backend ends up half-implemented without anyone noticing.
 *
 * The pointer backends take the frame's `origin` because screenshot pixels and OS coordinates are not the same
 * space on Windows. Reading the frame per action costs a PowerShell round trip, so it is read once per call
 * here — a monitor rearranged mid-action is not a case worth paying for on every click. */

// macOS and the rest: capture would work, but input would not, and a Desktop that silently cannot click is worse
// than one that says so.
const unsupported = async (): Promise<never> => {
    throw new DesktopError(`Controlling the screen is not supported on ${process.platform} yet — only Windows and Linux.`);
};

export const desktop = (): Desktop => {
    if (process.platform === "win32") {
        return {
            frame,
            capture,
            move: async (to) => await windowsInput.move(to, (await frame()).origin),
            click: async (at, button) => await windowsInput.click(at, button, (await frame()).origin),
            doubleClick: async (at) => await windowsInput.doubleClick(at, (await frame()).origin),
            drag: async (from, to) => await windowsInput.drag(from, to, (await frame()).origin),
            type: windowsInput.type,
            key: windowsInput.key,
            scroll: async (at, direction, amount) => await windowsInput.scroll(at, direction, amount, (await frame()).origin),
        };
    }
    if (process.platform === "linux") {
        return { frame, capture, ...linuxInput };
    }
    return {
        frame,
        capture,
        move: unsupported,
        click: unsupported,
        doubleClick: unsupported,
        drag: unsupported,
        type: unsupported,
        key: unsupported,
        scroll: unsupported,
    };
};
