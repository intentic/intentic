import { execFile } from "node:child_process";
import { DesktopError } from "./types.js";

/* Running the one external program a backend needs, with the two failures that matter told apart.
 *
 * "Not installed" and "ran and refused" are different problems with different fixes, and a caller that collapses
 * them reports "could not click" for a machine that only needed `apt install xdotool`. ENOENT is the first; a
 * non-zero exit is the second, and its own stderr is a better message than anything invented here. */

// No desktop action should take this long. A hung `xdotool` (a display that stopped answering) would otherwise
// hold a tool call open until something far upstream gave up.
const TIMEOUT_MS = 15_000;

export const run = async (command: string, args: readonly string[], install?: string): Promise<string> =>
    await new Promise<string>((resolvePromise, reject) => {
        execFile(command, [...args], { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
            if (error === null) {
                resolvePromise(stdout);
                return;
            }
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                reject(new DesktopError(`This computer has no "${command}".`, install));
                return;
            }
            const said = `${stderr}`.trim();
            reject(new DesktopError(said === "" ? `"${command}" failed: ${error.message}` : `"${command}" failed: ${said}`, install));
        });
    });

// Whether a program is on PATH at all — how a backend picks between the tools a desktop MIGHT have, without
// making the choice by catching a failure from the real action.
export const has = async (command: string): Promise<boolean> => {
    const probe = process.platform === "win32" ? "where" : "which";
    try {
        await run(probe, [command]);
        return true;
    } catch {
        return false;
    }
};
