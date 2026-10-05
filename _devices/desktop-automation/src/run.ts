import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { DesktopError } from "./types.js";

// The environment every program here runs in: the process's own, unless a desktop was opened on a display of its
// own (`desktop({ env })`), as the sandbox does for the virtual screen an agent drives beside its browsers. Held per
// call chain rather than written into process.env, which every other part of a long-lived process also reads.
const scoped = new AsyncLocalStorage<NodeJS.ProcessEnv>();

export const environment = (): NodeJS.ProcessEnv => scoped.getStore() ?? process.env;

export const withEnvironment = <T>(env: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> => scoped.run(env, work);

/* Running the one external program a backend needs, with the two failures that matter told apart. */

// No desktop action should take this long. A hung `xdotool` (a display that stopped answering) would otherwise
// hold a tool call open until something far upstream gave up.
const TIMEOUT_MS = 15_000;

// `timeoutMs` for the one read that is slow by nature (a big window's accessibility tree).
export const run = async (command: string, args: readonly string[], install?: string, timeoutMs: number = TIMEOUT_MS): Promise<string> =>
    await new Promise<string>((resolvePromise, reject) => {
        // A window's element tree runs to megabytes; execFile's 1 MB default would cut it off mid-JSON.
        execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment() }, (error, stdout, stderr) => {
            if (error === null) {
                resolvePromise(stdout);
                return;
            }
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                reject(new DesktopError(`This device has no "${command}".`, install));
                return;
            }
            // A kill at the timeout leaves stderr empty and error.message only echoing the command line, which read
            // as an unexplained failure; say what happened.
            if (error.killed === true) {
                reject(new DesktopError(`"${command}" did not answer within ${timeoutMs / 1_000}s and was stopped.`, install));
                return;
            }
            const said = `${stderr}`.trim();
            reject(new DesktopError(said === "" ? `"${command}" failed: ${error.message}` : `"${command}" failed: ${said}`, install));
        });
    });

// Whether a program is on PATH at all, how a backend picks between the tools a desktop MIGHT have, without
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
