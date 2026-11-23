import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import type { OpenBrowserResult } from "@intentic/sandbox-contract/schemas/terminal";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { type RunnerBrowserDeps, runnerBrowserTab } from "../../runners/live/runner-browsers.js";
import type { RunnerTabAnswer } from "../../runners/live/runner-live-doors.js";
import { moveTab, reopenClosedTab, tabAction } from "./browser-tabs.js";

// The `system.*BrowserPage*` procedures a tab's own menu and the strip's drag call (browser-tabs.ts), merged into the
// system routes beside closeBrowserPage. A tab or a window already gone answers the window alone, as a close of one does.
// A runner's window (`<runner>~<name>`, runners/live/runner-browsers.ts) is acted on there, by its own name (2026-11-23).

// What a reopen or an action answers: a window and the tab acted on; an answer from a runner that named no window is its
// window's own.
const opened = (name: string, answer: RunnerTabAnswer): OpenBrowserResult => {
    if (answer.name === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `${name} has no such tab` });
    }
    return { ...answer, name: answer.name };
};

export const createBrowserTabRoutes = (deps: RunnerBrowserDeps) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        reopenBrowserPage: i.reopenBrowserPage.handler(async ({ input }) => {
            const remote = await runnerBrowserTab(deps, { op: "reopen", ...input });
            return remote === undefined ? await reopenClosedTab(input.name, input.closedId) : opened(input.name, remote);
        }),
        moveBrowserPage: i.moveBrowserPage.handler(async ({ input }) => {
            if ((await runnerBrowserTab(deps, { op: "move", ...input })) === undefined) {
                moveTab(input.name, input.pageId, input.index);
            }
            return { ok: true };
        }),
        browserPageAction: i.browserPageAction.handler(async ({ input }) => {
            const remote = await runnerBrowserTab(deps, { op: "action", ...input });
            return remote === undefined ? await tabAction(input.name, input.pageId, input.action) : opened(input.name, remote);
        }),
    };
};
