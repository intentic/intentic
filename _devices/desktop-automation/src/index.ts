import { linuxApps } from "./apps-linux.js";
import { windowsApps } from "./apps-windows.js";
import { linuxInput } from "./input-linux.js";
import { windowsInput } from "./input-windows.js";
import { capture, frame } from "./screen.js";
import { type Desktop, DesktopError } from "./types.js";

export { windowsSession } from "./apps-windows.js";
export { parseChord, windowsChord, wtypeArgs, xdotoolChord, type Chord, type Modifier } from "./keys.js";
export { focusRefusal, looksLikeUrl, parseSessionJson, parseSwayTree, parseWindowsJson, parseWmctrl } from "./parse.js";
export { capture, frame, hasGraphicalSession, isWayland, pngSize } from "./screen.js";
export {
    DesktopError,
    type Desktop,
    type ForegroundWindow,
    type MouseButton,
    type Point,
    type ScreenFrame,
    type ScrollDirection,
    type SessionState,
    type WindowInfo,
} from "./types.js";

// Windows pointer methods take the frame's origin: screenshot pixels and OS coordinates differ there. The frame is
// read once per call, not per action, to avoid a PowerShell round trip each time.

// macOS and others: capture would work but input would not, so this errors instead of behaving partially.
const unsupported = async (): Promise<never> => {
    throw new DesktopError(`Controlling the screen is not supported on ${process.platform} yet: only Windows and Linux.`);
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
            ...windowsApps,
        };
    }
    if (process.platform === "linux") {
        return { frame, capture, ...linuxInput, ...linuxApps };
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
        windows: unsupported,
        focusWindow: unsupported,
        launch: unsupported,
        readClipboard: unsupported,
        writeClipboard: unsupported,
    };
};
