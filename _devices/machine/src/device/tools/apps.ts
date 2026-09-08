import { type Desktop, DesktopError, type WindowInfo } from "@intentic/desktop-automation";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

// Operating the machine's applications, as opposed to its pixels: knowing what's on screen and which window
// typing reaches is the difference between a tool and a blindfolded hand. Scope follows what the action DOES:
// windows/clipboard read -> `screen`, focus/clipboard write -> `control`, open -> `shell`.

// A window list is for choosing between things, so it is rendered for reading rather than as JSON: the model
// picks by title, and the id it needs to pass back is right there.
export const describeWindows = (windows: readonly WindowInfo[]): string => {
    if (windows.length === 0) {
        return "No windows are open on this device.";
    }
    const rows = windows.map(
        (window) =>
            `${window.focused ? "* " : "  "}[${window.id}] ${window.app}, ${window.title}  (${window.bounds.width}×${window.bounds.height} at ${window.bounds.x},${window.bounds.y})`,
    );
    return [`${windows.length} window${windows.length === 1 ? "" : "s"} (* = focused). Pass the id in brackets to focus_window.`, ...rows].join("\n");
};

export const listWindows = async (screen: Desktop, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    return describeWindows(await screen.windows());
};

// Focus is the precondition for typing, so this reports what it left focused rather than answering "ok": a
// focus that silently did not take is the most confusing way for a GUI sequence to go wrong.
export const focusWindow = async (screen: Desktop, id: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (id === "") {
        throw new DesktopError(`"id" is required: take a window list first and pass the id in brackets.`);
    }
    await screen.focusWindow(id);
    const focused = (await screen.windows().catch(() => [])).find((window) => window.focused);
    return focused === undefined ? `Asked this device to focus window ${id}.` : `Focused: ${focused.app}, ${focused.title}. Typing now goes here.`;
};

export const openTarget = async (screen: Desktop, target: string, scopes: HostScopes): Promise<string> => {
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
export const readClipboard = async (screen: Desktop, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    const text = await screen.readClipboard();
    return text === "" ? "The clipboard is empty." : text;
};

export const writeClipboard = async (screen: Desktop, text: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    await screen.writeClipboard(text);
    return `Put ${text.length} characters on this device's clipboard.`;
};
