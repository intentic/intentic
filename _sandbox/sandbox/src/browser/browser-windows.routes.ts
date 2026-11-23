import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import { errorMessage } from "@intentic/base/errors";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { browserSessionPage, closeBrowserSession, listBrowserSessions } from "./sessions/browser-sessions.js";
import { openOwnBrowser } from "./sessions/own-browser.js";
import { desktopState } from "../desktop/agent-desktop.js";
import {
    closeRunnerBrowser,
    closeRunnerBrowserPage,
    openRunnerBrowser,
    runnerBrowserSessions,
    runnerDesktops,
} from "../runners/live/runner-browsers.js";

// The `system.*Browser*` window procedures and `system.desktop`, merged into the system routes: this sandbox's own windows
// and desktop, with each connected runner's beside them for the conversations that run there (2026-11-23).
export const createBrowserWindowRoutes = (services: Pick<Services, "logger" | "runnerHub" | "runners" | "workspace">) => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        // The agent's Chromiums and open pages; records this daemon keeps itself, not shelled out for.
        // A conversation's runner's windows are merged in by name (runners/live/runner-browsers.ts).
        browsers: i.browsers.handler(async () => ({ sessions: [...listBrowserSessions(), ...(await runnerBrowserSessions(services))] })),
        // The person's own window: a tab in it, starting it first when it is closed. A start that fails says why (no
        // browser installed, no display) rather than leaving the view waiting on a window that will never come.
        openBrowser: i.openBrowser.handler(async ({ input }) => {
            if (input.runner !== undefined) {
                return await openRunnerBrowser(services, input.runner, input.url);
            }
            try {
                return await openOwnBrowser(
                    {
                        root: services.workspace.root,
                        warn: (fields, message) => services.logger.warn(fields, message),
                        info: (fields, message) => services.logger.info(fields, message),
                    },
                    input.url,
                );
            } catch (error) {
                services.logger.warn({ err: error }, "own browser: could not open");
                throw new ORPCError("SERVICE_UNAVAILABLE", { message: `Couldn't open your browser: ${errorMessage(error)}` });
            }
        }),
        closeBrowser: i.closeBrowser.handler(async ({ input }) => {
            if (await closeRunnerBrowser(services, input.name)) {
                return { ok: true };
            }
            await closeBrowserSession(input.name);
            return { ok: true };
        }),
        // Closing what is already gone is the outcome asked for; the roster relists either way, as after a close over
        // the picture's socket (browser-view.ts).
        closeBrowserPage: i.closeBrowserPage.handler(async ({ input }) => {
            if (await closeRunnerBrowserPage(services, input.name, input.pageId)) {
                return { ok: true };
            }
            await browserSessionPage(input.name, input.pageId)
                ?.close()
                // allow(silent-catch): a page or browser already gone is the close asked for
                .catch(() => undefined);
            return { ok: true };
        }),
        // The sandbox's own desktop: whether it is up and how many windows it has, which never starts it.
        // Each connected runner's beside it, for the conversations that run there (runners/live/runner-browsers.ts).
        desktop: i.desktop.handler(async () => {
            const [own, runners] = await Promise.all([desktopState(), runnerDesktops(services)]);
            return runners.length === 0 ? own : { ...own, runners };
        }),
    };
};
