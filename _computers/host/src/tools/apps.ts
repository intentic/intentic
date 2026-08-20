import { type Desktop, DesktopError, type WindowInfo } from "@intentic/desktop";
import type { HostScopes } from "@intentic/sandbox-contract";
import { assertScope } from "../policy.js";

/* Operating the machine's APPLICATIONS, as opposed to its pixels.
 *
 * Clicking a coordinate is only useful once the agent knows what is on the screen and which window its typing
 * will reach. Without these, `computer` is a blindfolded hand: it can press where a button was in a screenshot,
 * but it cannot tell whether the window moved, whether the app is even open, or whether the keystrokes it just
 * sent went to the browser or to the terminal behind it. That is the difference between a demo and a tool.
 *
 * WHICH SCOPE EACH ONE TAKES follows what the action DOES, not which package implements it:
 *   windows / clipboard read  → `screen`, because both are ways of seeing what is on the machine.
 *   focus / clipboard write   → `control`, because both change what the machine is doing.
 *   open                      → `shell`, because it starts a process, which is what that switch governs.
 * A user who granted "see the screen" and nothing else gets a machine they can inspect and not touch, which is a
 * coherent thing to have granted. */

// A window list is for choosing between things, so it is rendered for reading rather than as JSON: the model
// picks by title, and the id it needs to pass back is right there.
export const describeWindows = (windows: readonly WindowInfo[]): string => {
    if (windows.length === 0) {
        return "No windows are open on this computer.";
    }
    const rows = windows.map(
        (window) =>
            `${window.focused ? "* " : "  "}[${window.id}] ${window.app} — ${window.title}  (${window.bounds.width}×${window.bounds.height} at ${window.bounds.x},${window.bounds.y})`,
    );
    return [`${windows.length} window${windows.length === 1 ? "" : "s"} (* = focused). Pass the id in brackets to focus_window.`, ...rows].join("\n");
};

export const listWindows = async (screen: Desktop, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "screen");
    return describeWindows(await screen.windows());
};

/* Focus is the precondition for typing, so this reports what it left focused rather than answering "ok", the
 * agent's next action depends on it, and a focus that silently did not take is the single most confusing way for
 * a GUI sequence to go wrong. */
export const focusWindow = async (screen: Desktop, id: string, scopes: HostScopes): Promise<string> => {
    assertScope(scopes, "control");
    if (id === "") {
        throw new DesktopError(`"id" is required — take a window list first and pass the id in brackets.`);
    }
    await screen.focusWindow(id);
    const focused = (await screen.windows().catch(() => [])).find((window) => window.focused);
    return focused === undefined ? `Asked this computer to focus window ${id}.` : `Focused: ${focused.app} — ${focused.title}. Typing now goes here.`;
};

export const openTarget = async (screen: Desktop, target: string, scopes: HostScopes): Promise<string> => {
    // Starting a program is what the shell switch is about, whichever verb gets it started.
    assertScope(scopes, "shell");
    if (target === "") {
        throw new DesktopError(`"target" is required — an application name, a file path, or a URL.`);
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
    return `Put ${text.length} characters on this computer's clipboard.`;
};
