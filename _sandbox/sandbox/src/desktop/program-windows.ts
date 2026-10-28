import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, isMissing } from "@intentic/base/errors";
import { desktop, type WindowInfo } from "@intentic/desktop-automation";
import { displayOf } from "../browser/cast/display.js";
import { agentDesktop, DESKTOP_KEY, desktopAvailable } from "./agent-desktop.js";

/* THE SANDBOX DESKTOP AS A RUN SEES IT: what a program started from a repository's Start button is handed so that its
   windows open there, and which windows are open with the program behind each, so the panels list can say which
   repository opened what. Nothing declares that a run has a window; the window appearing is what says so. */

export interface ProgramWindow {
    // The window's id, as the desktop's own list and the Browsers view's window tabs name it.
    readonly id: string;
    readonly title: string;
    // The directory the program behind it runs in; undefined when the window names no process or that process's cwd
    // cannot be read.
    readonly cwd: string | undefined;
}

// What a run's programs need for their windows to open on the sandbox desktop, starting the desktop when it is not up
// yet. Nothing on a sandbox without one (no browser pack): the run still starts, and a program that wants a window says
// in its terminal that it has no display.
export const desktopEnv = async (): Promise<Record<string, string>> => {
    if (!desktopAvailable()) {
        return {};
    }
    const { display } = await agentDesktop();
    return { DISPLAY: display.name };
};

// Where a process runs, or undefined when it has ended since the window list was read (ENOENT) or belongs to a user the
// daemon cannot look into (EACCES): either way it says nowhere. Any other failure is not an answer and is thrown.
const cwdOf = async (procRoot: string, pid: number): Promise<string | undefined> => {
    try {
        return await readlink(join(procRoot, String(pid), "cwd"));
    } catch (error) {
        if (isMissing(error) || errnoCode(error) === "EACCES") {
            return undefined;
        }
        throw error;
    }
};

// The windows open on the sandbox desktop now, each with where its program runs. Never starts the desktop: with none up
// there is nothing open.
export const programWindows = async (procRoot = "/proc"): Promise<ProgramWindow[]> => {
    const display = displayOf(DESKTOP_KEY);
    if (display === undefined) {
        return [];
    }
    let windows: readonly WindowInfo[];
    try {
        windows = await desktop({ env: { ...process.env, DISPLAY: display.name } }).windows();
    } catch {
        // allow(silent-catch): a desktop with no window manager, or no wmctrl, has no list to give, so no window is anyone's.
        return [];
    }
    return Promise.all(
        windows.map(async ({ id, title, pid }) => ({
            id,
            title,
            cwd: pid === undefined ? undefined : await cwdOf(procRoot, pid),
        })),
    );
};
