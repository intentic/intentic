import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { moveTab, reopenClosedTab, tabAction } from "./browser-tabs.js";

// The `system.*BrowserPage*` procedures a tab's own menu and the strip's drag call (browser-tabs.ts), merged into the
// system routes beside closeBrowserPage. A tab or a window already gone answers the window alone, as a close of one does.
export const createBrowserTabRoutes = () => {
    const i = implement(systemContract).$context<OrpcContext>();
    return {
        reopenBrowserPage: i.reopenBrowserPage.handler(({ input }) => reopenClosedTab(input.name, input.closedId)),
        moveBrowserPage: i.moveBrowserPage.handler(({ input }) => {
            moveTab(input.name, input.pageId, input.index);
            return { ok: true };
        }),
        browserPageAction: i.browserPageAction.handler(({ input }) => tabAction(input.name, input.pageId, input.action)),
    };
};
