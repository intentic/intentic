import { ORPCError } from "@orpc/server";
import type { BrowserSession, OpenBrowserResult, RunnerDesktop } from "@intentic/sandbox-contract/schemas/terminal";
import type { Logger } from "pino";
import type { RunnerBrowserTab, RunnerTabAnswer } from "./runner-live-doors.js";
import { fromEachRunner, olderRunner, type RunnerRoster, type RunnerSockets } from "./runner-calls.js";

/* A RUNNER'S BROWSER WINDOWS AND DESKTOP, LISTED BY THE PARENT BESIDE ITS OWN (2026-11-23). The editor reads one
   `system.browsers` and one `system.desktop`; each connected runner's are read through its doors (runner-live-doors.ts)
   and merged in, a window named `<runner>~<the runner's own name>` with `runner` set, so it can never collide with one of
   this sandbox's (a runner's id never holds `~`, runner-view-tickets.ts). A runner that is older, slow or failing is left
   out of the list rather than failing it. Closing a runner's window, or one of its tabs, and opening a tab in a runner's
   own window are carried to it by the same name. Its picture opens through `runners.openView`. */

export interface RunnerBrowserDeps {
    readonly logger: Pick<Logger, "info">;
    readonly runnerHub: RunnerSockets;
    readonly runners: RunnerRoster;
}

const SEP = "~";

const runnerWindowName = (runner: string, name: string): string => `${runner}${SEP}${name}`;

// The runner and its own name for a window the merged list named, when the name is one and the runner is enrolled.
export const runnerWindowOf = async (
    deps: Pick<RunnerBrowserDeps, "runners">,
    name: string,
): Promise<{ readonly runner: string; readonly name: string } | undefined> => {
    const at = name.indexOf(SEP);
    if (at <= 0) {
        return undefined;
    }
    const runner = name.slice(0, at);
    return (await deps.runners.list()).some((enrolled) => enrolled.id === runner) ? { runner, name: name.slice(at + 1) } : undefined;
};

const warnOf = (deps: RunnerBrowserDeps, what: string) => (runner: string, error: Error) =>
    deps.logger.info({ err: error, runner }, `runner ${what}: left out of the list`);

export const runnerBrowserSessions = async (deps: RunnerBrowserDeps): Promise<BrowserSession[]> =>
    (
        await fromEachRunner(deps.runners, deps.runnerHub, (client, signal) => client.browsers(undefined, { signal }), warnOf(deps, "browsers"))
    ).flatMap(({ runner, value }) => value.sessions.map((session) => ({ ...session, name: runnerWindowName(runner, session.name), runner })));

export const runnerDesktops = async (deps: RunnerBrowserDeps): Promise<RunnerDesktop[]> =>
    (await fromEachRunner(deps.runners, deps.runnerHub, (client, signal) => client.desktop(undefined, { signal }), warnOf(deps, "desktop"))).map(
        ({ runner, value }) => ({ runner, state: value }),
    );

// The runner's client for an act on one of its windows; a clear refusal when it is away or older than the door.
const actOn = async <T>(
    deps: RunnerBrowserDeps,
    runner: string,
    act: (client: NonNullable<ReturnType<RunnerBrowserDeps["runnerHub"]["client"]>>) => Promise<T>,
): Promise<T> => {
    const client = deps.runnerHub.client(runner);
    if (client === undefined) {
        throw new ORPCError("SERVICE_UNAVAILABLE", { message: deps.runnerHub.offline(runner) });
    }
    try {
        return await act(client);
    } catch (error) {
        if (error instanceof Error && olderRunner(error)) {
            throw new ORPCError("PRECONDITION_FAILED", {
                message: `The runner "${runner}" runs a build older than its browsers shown here; update the runner.`,
            });
        }
        throw error;
    }
};

/** Closes a runner's window by its merged name; false for a name that is not a runner's. */
export const closeRunnerBrowser = async (deps: RunnerBrowserDeps, name: string): Promise<boolean> => {
    const window = await runnerWindowOf(deps, name);
    if (window === undefined) {
        return false;
    }
    await actOn(deps, window.runner, (client) => client.closeBrowser({ name: window.name }));
    return true;
};

/** Closes one tab of a runner's window by its merged name; false for a name that is not a runner's. */
export const closeRunnerBrowserPage = async (deps: RunnerBrowserDeps, name: string, pageId: string): Promise<boolean> => {
    const window = await runnerWindowOf(deps, name);
    if (window === undefined) {
        return false;
    }
    await actOn(deps, window.runner, (client) => client.closeBrowserPage({ name: window.name, pageId }));
    return true;
};

/** Opens a tab in the runner's own window, answered by its merged name. */
export const openRunnerBrowser = async (deps: RunnerBrowserDeps, runner: string, url: string | undefined): Promise<OpenBrowserResult> => {
    if (!(await deps.runners.list()).some((enrolled) => enrolled.id === runner)) {
        throw new ORPCError("NOT_FOUND", { message: `"${runner}" is not one of this sandbox's runners` });
    }
    const opened = await actOn(deps, runner, (client) => client.openBrowser(url === undefined ? {} : { url }));
    return { ...opened, name: runnerWindowName(runner, opened.name) };
};

/** A tab's own menu or the strip's drag on a runner's window by its merged name, carried to the runner; undefined for a
 *  name that is not a runner's. An answer naming a window names it as the merged list does. */
export const runnerBrowserTab = async (
    deps: RunnerBrowserDeps,
    input: RunnerBrowserTab,
): Promise<RunnerTabAnswer | undefined> => {
    const window = await runnerWindowOf(deps, input.name);
    if (window === undefined) {
        return undefined;
    }
    const answer = await actOn(deps, window.runner, (client) => client.browserTab({ ...input, name: window.name }));
    return answer.name === undefined ? answer : { ...answer, name: runnerWindowName(window.runner, answer.name) };
};
