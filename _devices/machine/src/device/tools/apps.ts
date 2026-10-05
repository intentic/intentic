import { type Desktop, DesktopError, type Frame, type FrameLog, frameName, toImage, viewFrame, type WindowInfo } from "@intentic/desktop-automation";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { calling, type Indicator, machineIndicator } from "../indicator.js";
import { assertScope } from "../policy.js";
import { assertTypable } from "./device.js";

// Operating the machine's applications, as opposed to its pixels: knowing what's on screen and which window
// typing reaches is the difference between a tool and a blindfolded hand. Scope follows what the action DOES:
// windows/clipboard read -> `screen`, focus/clipboard write -> `control`, open -> `shell`.

// A window list is for choosing between things, so it is rendered for reading rather than as JSON: the model
// picks by title, and the id it needs to pass back is right there. Places are in the pixels of `frame` when given,
// the screenshot the agent reads them against; desktop pixels otherwise.
export const describeWindows = (windows: readonly WindowInfo[], frame?: Frame): string => {
    if (windows.length === 0) {
        return "No windows are open on this device.";
    }
    const rows = windows.map((window) => {
        const at = frame === undefined ? window.bounds : toImage(frame, window.bounds);
        return `${window.focused ? "* " : "  "}[${window.id}] ${window.app}, ${window.title}  (${at.width}×${at.height} at ${at.x},${at.y})`;
    });
    const placed = frame === undefined ? "" : ` Sizes and places are pixels in ${frameName(frame)}.`;
    return [
        `${windows.length} window${windows.length === 1 ? "" : "s"} (* = focused). Pass the id in brackets to focus_window, ui_elements or screenshot.${placed}`,
        ...rows,
    ].join("\n");
};

export const listWindows = async (screen: Desktop, scopes: DeviceScopes, log?: FrameLog): Promise<string> => {
    assertScope(scopes, "screen");
    const windows = await screen.windows();
    return describeWindows(windows, log === undefined ? undefined : await viewFrame(screen, log));
};

// Focus is the precondition for typing, so this reports what it left focused rather than answering "ok": a
// focus that silently did not take is the most confusing way for a GUI sequence to go wrong.
export const focusWindow = async (screen: Desktop, id: string, scopes: DeviceScopes, indicator: Indicator = machineIndicator()): Promise<string> => {
    assertScope(scopes, "control");
    if (id === "") {
        throw new DesktopError(`"id" is required: take a window list first and pass the id in brackets.`);
    }
    // Focus decides where the person's own typing lands, so it is input like a click: shown, and held by a local pause.
    await indicator.control(calling.getStore());
    await screen.focusWindow(id);
    const focused = (await screen.windows().catch(() => [])).find((window) => window.focused);
    return focused === undefined ? `Asked this device to focus window ${id}.` : `Focused: ${focused.app}, ${focused.title}. Typing now goes here.`;
};

export const openTarget = async (screen: Desktop, target: string, scopes: DeviceScopes): Promise<string> => {
    // Starting a program is what the shell switch is about, whichever verb gets it started.
    assertScope(scopes, "shell");
    if (target === "") {
        throw new DesktopError(`"target" is required: an application name, a file path, or a URL.`);
    }
    await screen.launch(target);
    return `Opened ${target}. Give it a moment, then take a screenshot or list the windows to see it.`;
};

// Length, not content: a clipboard routinely holds a password the user copied a minute ago, and this string
// travels back into a transcript.
export const readClipboard = async (screen: Desktop, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const text = await screen.readClipboard();
    return text === "" ? "The clipboard is empty." : text;
};

export const writeClipboard = async (screen: Desktop, text: string, scopes: DeviceScopes, indicator: Indicator = machineIndicator()): Promise<string> => {
    assertScope(scopes, "control");
    // Pasted into a terminal it runs, so it is held to the same rule as typing it.
    assertTypable(text, scopes);
    // What the person pastes next is what this puts there, so it is shown and held by a local pause like any input.
    await indicator.control(calling.getStore());
    await screen.writeClipboard(text);
    return `Put ${text.length} characters on this device's clipboard.`;
};
