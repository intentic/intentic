import { AsyncLocalStorage } from "node:async_hooks";
import { errnoCode } from "@intentic/base/errors";
import { runBounded } from "@intentic/base/process";
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
const MAX_OUTPUT = 16 * 1024 * 1024;

// What a program wrote, both streams: a few programs (xdotool on a key name it does not know) report on stderr and still exit 0.
export interface Output {
    readonly stdout: string;
    readonly stderr: string;
}

// `timeoutMs` for the one read that is slow by nature (a big window's accessibility tree). `install` is only for a program
// that is not there: the sandbox turns any error carrying one into "it arrives with the next rebuild", which is false
// for a program that is installed and merely failed or ran out of time.
export const runOutput = async (command: string, args: readonly string[], install?: string, timeoutMs: number = TIMEOUT_MS): Promise<Output> => {
    // A window's element tree runs to megabytes, so the cap stays where execFile's maxBuffer was: past it the output
    // is cut in the middle rather than refused, which a JSON reader still rejects, as it did the overflow error.
    const result = await runBounded(command, args, { timeoutMs, maxOutput: MAX_OUTPUT, env: environment() });
    if (result.exitCode === 0) {
        return { stdout: result.stdout.text, stderr: result.stderr.text };
    }
    if (result.spawnError !== undefined) {
        if (errnoCode(result.spawnError) === "ENOENT") {
            throw new DesktopError(`This device has no "${command}".`, install);
        }
        throw new DesktopError(`"${command}" failed: ${result.spawnError.message}`);
    }
    // A stop at the deadline leaves stderr empty, which read as an unexplained failure; say what happened.
    if (result.timedOut) {
        throw new DesktopError(`"${command}" did not answer within ${timeoutMs / 1_000}s and was stopped.`);
    }
    const said = result.stderr.text.trim();
    const ended = result.exitCode === null ? `ended by ${result.exitSignal ?? "a signal"}` : `exit ${result.exitCode}`;
    throw new DesktopError(said === "" ? `"${command}" failed (${ended})` : `"${command}" failed: ${said}`);
};

export const run = async (command: string, args: readonly string[], install?: string, timeoutMs?: number): Promise<string> =>
    (await runOutput(command, args, install, timeoutMs)).stdout;

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
