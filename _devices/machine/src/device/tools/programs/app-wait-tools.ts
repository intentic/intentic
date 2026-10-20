import type { Desktop } from "@intentic/desktop-automation";
import { errorMessage } from "@intentic/base/errors";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { LOG_FALLBACK_MS, waitForEnd, waitForLogMatch } from "./app-wait.js";
import { type AppRun, appLogs, appStatus, assertEither, findRun, MAX_LOG_LINES, readRuns, refreshIsolated, runOutput, runState, waitGone } from "./programs.js";

// app_status and app_logs with a wait asked for (2026-10-20): waitFor answers once the program prints a matching line,
// untilExit once it ends, each within timeoutMs, so an agent asks once instead of calling in a loop. The waits
// themselves are app-wait.ts; this is what they are pointed at for one run.

export const DEFAULT_APP_WAIT_MS = 60_000;
export const MAX_APP_WAIT_MS = 10 * 60_000;

export interface AppWaitOptions {
    readonly waitFor?: string | undefined;
    readonly untilExit?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
}

const parseWaitPattern = (waitFor: string): RegExp => {
    try {
        return new RegExp(waitFor, "i");
    } catch (error) {
        throw new Error(`waitFor is not a usable pattern: ${errorMessage(error)}`, { cause: error });
    }
};

// Whether the run ended within the timeout. An isolated run's end is only ever written by refreshIsolated (nothing here
// holds the program inside the VM), so it is looked at after one, less often since each look lists the machine's
// processes; any other run goes by its exit event (waitGone).
const runEnded = async (run: AppRun, timeoutMs: number, sandboxUrl: string, signal: AbortSignal): Promise<boolean> => {
    if (run.isolated !== true) {
        return await waitGone(run, timeoutMs, signal);
    }
    const isEnded = async (): Promise<boolean> => {
        await refreshIsolated(sandboxUrl);
        return (await runState((await readRuns(sandboxUrl)).find((entry) => entry.id === run.id) ?? run)) === "ended";
    };
    return await waitForEnd({ timeoutMs, isEnded, fallbackMs: LOG_FALLBACK_MS, signal });
};

// The note a wait leaves above the answer when it ran out or the program ended first; undefined when nothing was asked
// to wait for, or what was waited for came.
const applyAppWait = async (run: AppRun, options: AppWaitOptions | undefined, sandboxUrl: string): Promise<string | undefined> => {
    if (options === undefined || (options.waitFor === undefined && options.untilExit !== true)) {
        return undefined;
    }
    const timeoutMs = Math.min(Math.max(1, options.timeoutMs ?? DEFAULT_APP_WAIT_MS), MAX_APP_WAIT_MS);
    const seconds = Math.round(timeoutMs / 1000);
    const done = new AbortController();
    try {
        if (options.untilExit === true) {
            return (await runEnded(run, timeoutMs, sandboxUrl, done.signal)) ? undefined : `(untilExit: still running after ${seconds}s.)`;
        }
        const waitFor = options.waitFor ?? "";
        const pattern = parseWaitPattern(waitFor);
        // The line's wait also ends when the program does: no line comes after that. A wait that ran out or was called
        // off settles never, so it is not read as the program ending.
        const ended = runEnded(run, timeoutMs, sandboxUrl, done.signal).then(async (gone) => (gone ? undefined : await new Promise<void>(() => undefined)));
        const outcome = await waitForLogMatch({ path: run.log, pattern, timeoutMs, read: async () => (await runOutput(run, MAX_LOG_LINES)).text, ended });
        if (outcome === "matched") {
            return undefined;
        }
        return outcome === "ended" ? `(waitFor: the program ended without printing a line matching /${waitFor}/i.)` : `(waitFor: no line matched /${waitFor}/i within ${seconds}s.)`;
    } finally {
        done.abort();
    }
};

// The answer comes once the wait is over, read afresh then, with the wait's note above it when there is one.
export const appStatusAfterWait = async (id: string | undefined, scopes: DeviceScopes, sandboxUrl: string, screen: () => Desktop, wait?: AppWaitOptions): Promise<string> => {
    assertEither(scopes);
    const note = id === undefined ? undefined : await applyAppWait(await findRun(id, sandboxUrl), wait, sandboxUrl);
    const answer = await appStatus(id, scopes, sandboxUrl, screen);
    return note === undefined ? answer : `${note}\n${answer}`;
};

export const appLogsAfterWait = async (id: string, lines: number, grep: string | undefined, scopes: DeviceScopes, sandboxUrl: string, wait?: AppWaitOptions): Promise<string> => {
    assertEither(scopes);
    const note = await applyAppWait(await findRun(id, sandboxUrl), wait, sandboxUrl);
    const answer = await appLogs(id, lines, grep, scopes, sandboxUrl);
    return note === undefined ? answer : `${note}\n${answer}`;
};
