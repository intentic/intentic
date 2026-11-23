import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import type { RunnerOpenViewInput } from "@intentic/sandbox-contract/schemas/runner-views";

// A BROWSER WINDOW ON A RUNNER, as this sandbox lists it beside its own (`system.browsers`): `runner` set, and its name
// `<runner>~<the runner's own name>`, split on the first `~`. Closing it, or a tab of it, goes through the usual routes
// under that merged name; its picture opens through `runners.openView` under the runner's own name. Pure, so the turn's
// facts can name a window without loading the views.

/** The merged name this sandbox lists a runner's window under. */
export const runnerWindowName = (runner: string, own: string): string => `${runner}~${own}`;

/** The runner and the runner's own name of a merged window name, or undefined for a name of this sandbox's. */
export const splitRunnerWindow = (name: string): { readonly runner: string; readonly own: string } | undefined => {
    const at = name.indexOf(`~`);
    return at <= 0 || at === name.length - 1 ? undefined : { runner: name.slice(0, at), own: name.slice(at + 1) };
};

/**
 * What the view of a runner's window asks `runners.openView` for, or undefined for a window of this sandbox's. The view is
 * asked through the conversation that opened the window, else any conversation placed on that runner; with none known
 * there is nothing to ask through.
 */
export const runnerWindowView = (
    window: Pick<BrowserSession, `name` | `runner` | `owner`>,
    conversationOn: (runner: string) => string | undefined,
): RunnerOpenViewInput | undefined => {
    if (window.runner === undefined) {
        return undefined;
    }
    const split = splitRunnerWindow(window.name);
    const own = split !== undefined && split.runner === window.runner ? split.own : window.name;
    const conversationId = window.owner ?? conversationOn(window.runner);
    return conversationId === undefined ? undefined : { conversationId, kind: `browser-view`, session: own };
};

/**
 * The window a runner conversation's browser hand-off opens: listed under its merged name, else the window on that runner
 * the conversation opened, else the merged name all the same (the list may not have caught up yet).
 */
export const conversationWindow = (
    windows: readonly Pick<BrowserSession, `name` | `runner` | `owner` | `running`>[],
    at: { readonly runner: string; readonly conversationId: string; readonly own: string },
): string => {
    const merged = runnerWindowName(at.runner, at.own);
    const open = windows.filter((window) => window.running && window.runner === at.runner);
    return (open.find((window) => window.name === merged) ?? open.find((window) => window.owner === at.conversationId))?.name ?? merged;
};
