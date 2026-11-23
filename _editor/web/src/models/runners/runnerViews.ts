import type { RunnerOpenViewInput, RunnerView } from "@intentic/sandbox-contract/schemas/runner-views";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { currentSandboxTarget } from "../../client/sandbox/sandboxTarget";

// A PERSON'S LIVE VIEW OF A CONVERSATION THAT RUNS ON A RUNNER (another machine's sandbox container). The editor talks
// only to this sandbox: `runners.openView` answers a path under `/system/runner-view/<runner>/…` on this sandbox's own
// address and a query carrying a one-shot ticket, so every dial asks again. The terminal door (runnerTerminals.ts),
// the browser view (useBrowserView.ts) and the desktop view (useDesktopView.ts) dial through here.

/** What a runner view reaches; a test's to replace. */
export interface RunnerViewSeams {
    readonly openView: (input: RunnerOpenViewInput) => Promise<RunnerView>;
    // This sandbox's base (`https://…`), undefined while there is nowhere to dial.
    readonly base: () => string | undefined;
}

export const runnerViewSeams: RunnerViewSeams = {
    openView: (input) => sandboxRpc.runners.openView(input),
    base: () => currentSandboxTarget()?.base,
};

/** The view's own query (its ticket, session) with the view's parameters added; an undefined one is left out. */
export const viewQuery = (view: Pick<RunnerView, `query`>, extra: Readonly<Record<string, string | undefined>> = {}): string => {
    const query = new URLSearchParams(view.query);
    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) {
            query.set(key, value);
        }
    }
    return query.toString();
};

/** A view's socket as a ws(s) URL on this sandbox's base. */
export const viewSocketUrl = (base: string, view: RunnerView, extra: Readonly<Record<string, string | undefined>> = {}): string =>
    `${base.replace(/^http/u, `ws`)}${view.path}?${viewQuery(view, extra)}`;

/** Asks for a fresh ticket and answers the socket's URL; undefined while this sandbox is unreachable. */
export const runnerSocketUrl = async (
    input: RunnerOpenViewInput,
    extra: Readonly<Record<string, string | undefined>> = {},
    seams: RunnerViewSeams = runnerViewSeams,
): Promise<string | undefined> => {
    const base = seams.base();
    if (base === undefined) {
        return undefined;
    }
    return viewSocketUrl(base, await seams.openView(input), extra);
};
