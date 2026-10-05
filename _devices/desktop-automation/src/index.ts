import { linuxApps } from "./apps-linux.js";
import { windowsApps } from "./apps-windows.js";
import { CuaClient, cuaDesktop, findCuaDriver } from "./cua.js";
import { windowsElements } from "./elements-windows.js";
import { linuxInput } from "./input-linux.js";
import { windowsInput } from "./input-windows.js";
import { windowsNotice } from "./notice-windows.js";
import { withEnvironment } from "./run.js";
import { capture, displays, frame } from "./screen.js";
import { type Desktop, DesktopError, type Notice, type NoticeEvents } from "./types.js";

export { windowsSession } from "./apps-windows.js";
export { CuaClient, cuaDesktop, cuaDriverCandidates, cuaKey, findCuaDriver, parseCuaElements, parseCuaWindows } from "./cua.js";
export { parseChord, windowsChord, wtypeArgs, xdotoolChord, type Chord, type Modifier } from "./keys.js";
export { focusRefusal, looksLikeUrl, parseSessionJson, parseSwayTree, parseWindowsJson, parseWmctrl } from "./parse.js";
export { capture, displays, frame, hasGraphicalSession, isWayland, pngSize } from "./screen.js";
export { crop, decodePng, downscale, encodePng, type Pixels } from "./png.js";
export {
    defaultFrame,
    fitSize,
    type Frame,
    FrameLog,
    type ImageLimits,
    MODEL_IMAGE_LIMITS,
    regionOf,
    type Shot,
    shoot,
    toDesktop,
    toImage,
} from "./frames.js";
export {
    describeInput,
    type InputAction,
    type InputCall,
    keyboardText,
    MAX_WAIT_MS,
    perform,
    SETTLE_MS,
    settle,
} from "./actions.js";
export {
    describeDisplays,
    describeShot,
    desktopPointing,
    ElementRefs,
    elementNow,
    frameName,
    type Pointing,
    pointingFor,
    regionFor,
    reshoot,
    type ScreenshotTarget,
    viewFrame,
} from "./view.js";
export { parseDisplaysJson, parseElementJson, parseElementTreeJson, parseSwayOutputs, parseXrandrMonitors, roleOf } from "./parse.js";
export {
    DesktopError,
    type Desktop,
    type DisplayInfo,
    type ElementAction,
    type ElementTree,
    type Rect,
    type UiElement,
    type ForegroundWindow,
    type MouseButton,
    type Notice,
    type NoticeEvents,
    type Point,
    type ScreenFrame,
    type ScrollDirection,
    type SessionState,
    type WindowInfo,
} from "./types.js";

// Windows pointer methods take the frame's origin: screenshot pixels and OS coordinates differ there. The frame is
// read once per call, not per action, to avoid a PowerShell round trip each time.

// Without cua-driver, macOS and others: capture would work but input would not, so this errors instead of behaving
// partially.
const unsupported = async (): Promise<never> => {
    throw new DesktopError(
        `Controlling the screen on ${process.platform} needs cua-driver, and none is installed here.`,
        "Install cua-driver (https://cua.ai/driver): curl -fsSL https://cua.ai/driver/install.sh | bash",
    );
};

// Linux's own tools have no element reader: AT-SPI answers only over D-Bus, which nothing here speaks without a native
// module. Said as what to do instead, since the screenshot still works.
const noElements = async (): Promise<never> => {
    throw new DesktopError(
        "Reading a window's controls here needs cua-driver, which is not installed. Use a screenshot and its coordinates.",
        "Install cua-driver (https://cua.ai/driver): curl -fsSL https://cua.ai/driver/install.sh | bash",
    );
};

export interface DesktopOptions {
    // The environment the desktop's programs run in; `DISPLAY` in it picks the X display to drive. The process's
    // own when absent.
    readonly env?: NodeJS.ProcessEnv;
}

// One driver process per binary and display, for the process's life: `desktop()` is asked for per tool call.
const clients = new Map<string, CuaClient>();

const cuaClient = (env: NodeJS.ProcessEnv): CuaClient | undefined => {
    const binary = findCuaDriver(env);
    if (binary === undefined) {
        return undefined;
    }
    const key = `${binary}\u0000${env["DISPLAY"] ?? ""}`;
    let client = clients.get(key);
    if (client === undefined) {
        client = new CuaClient(binary, env);
        clients.set(key, client);
    }
    return client;
};

// INTENTIC_DESKTOP_DRIVER=cua drives the whole desktop through cua-driver where this package has its own backend
// too: its background delivery leaves the owner's mouse where they left it.
const wantsCua = (env: NodeJS.ProcessEnv): boolean => env["INTENTIC_DESKTOP_DRIVER"] === "cua";

// Linux's own backend, reading a window's controls through cua-driver where it is installed. A window id from the
// native list (an X window id) is matched to the driver's own (pid:window) by the X id they share.
const linuxElements = (env: NodeJS.ProcessEnv): Pick<Desktop, "elements" | "element" | "elementAct"> => {
    const client = cuaClient(env);
    if (client === undefined) {
        return { elements: noElements, element: noElements, elementAct: noElements };
    }
    const cua = cuaDesktop(client);
    return {
        elements: async (window) => {
            if (window === undefined) {
                return await cua.elements();
            }
            const matched = (await cua.windows()).find((candidate) => Number(candidate.id.split(":")[1]) === Number(window) || candidate.id === window);
            if (matched === undefined) {
                throw new DesktopError(`cua-driver does not see window ${window}. List the windows again.`);
            }
            return await cua.elements(matched.id);
        },
        element: cua.element,
        elementAct: cua.elementAct,
    };
};

// Every method of `desktop` run with `env` as its programs' environment. Spelled out method by method, so a method
// added to Desktop and forgotten here fails to compile rather than running against the process's own display.
const scopedTo = (env: NodeJS.ProcessEnv, desktop: Desktop): Desktop => {
    const within =
        <Args extends readonly unknown[], Result>(method: (...args: Args) => Promise<Result>) =>
        async (...args: Args): Promise<Result> =>
            await withEnvironment(env, async () => await method(...args));
    return {
        frame: within(desktop.frame),
        capture: within(desktop.capture),
        displays: within(desktop.displays),
        move: within(desktop.move),
        click: within(desktop.click),
        doubleClick: within(desktop.doubleClick),
        drag: within(desktop.drag),
        type: within(desktop.type),
        key: within(desktop.key),
        scroll: within(desktop.scroll),
        windows: within(desktop.windows),
        focusWindow: within(desktop.focusWindow),
        launch: within(desktop.launch),
        readClipboard: within(desktop.readClipboard),
        writeClipboard: within(desktop.writeClipboard),
        elements: within(desktop.elements),
        element: within(desktop.element),
        elementAct: within(desktop.elementAct),
    };
};

export const desktop = (options: DesktopOptions = {}): Desktop => {
    const env = options.env ?? process.env;
    const chosen = platformDesktop(env);
    return options.env === undefined ? chosen : scopedTo(options.env, chosen);
};

const platformDesktop = (env: NodeJS.ProcessEnv): Desktop => {
    const driver = wantsCua(env) || (process.platform !== "win32" && process.platform !== "linux") ? cuaClient(env) : undefined;
    if (driver !== undefined) {
        return cuaDesktop(driver);
    }
    if (process.platform === "win32") {
        return {
            frame,
            capture,
            displays,
            move: async (to) => await windowsInput.move(to, (await frame()).origin),
            click: async (at, button) => await windowsInput.click(at, button, (await frame()).origin),
            doubleClick: async (at) => await windowsInput.doubleClick(at, (await frame()).origin),
            drag: async (from, to) => await windowsInput.drag(from, to, (await frame()).origin),
            type: windowsInput.type,
            key: windowsInput.key,
            scroll: async (at, direction, amount) => await windowsInput.scroll(at, direction, amount, (await frame()).origin),
            ...windowsApps,
            ...windowsElements,
        };
    }
    if (process.platform === "linux") {
        return { frame, capture, displays, ...linuxInput, ...linuxApps, ...linuxElements(env) };
    }
    return {
        frame,
        capture,
        displays,
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
        elements: unsupported,
        element: unsupported,
        elementAct: unsupported,
    };
};

// Windows only. Elsewhere there is no notice to open, and a caller treats that as nothing to show.
export const notice = (hotkey: string, events: NoticeEvents): Notice | undefined =>
    process.platform === "win32" ? windowsNotice(hotkey, events) : undefined;
