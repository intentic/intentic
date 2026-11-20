import { browserContract } from "@intentic/sandbox-contract/contracts/browser.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { browserWindowRecord } from "../sessions/browser-sessions.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { devtoolsBinding, devtoolsFrontendRoute, devtoolsSocketRoute } from "./devtools-proxy.js";

// The page tools that open something of Chromium's own for a tab: its DevTools (devtools-proxy.ts carries them) and its
// source, in a tab of its own.

// A DevTools frame stays open for a working session; past this a fresh one needs a fresh ticket.
const DEVTOOLS_TICKET_MS = 8 * 3_600_000;

const pageOf = (name: string, pageId: string) => {
    const record = browserWindowRecord(name);
    const entry = record?.pages.get(pageId);
    if (record === undefined || entry === undefined || entry.closed || entry.cdp === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "That tab is no longer open." });
    }
    return { record, entry, session: entry.cdp };
};

/** The window's DevTools port, while it runs and has one: what the proxy reaches Chromium on. */
export const devtoolsPortOf = (window: string): number | undefined => {
    const port = browserWindowRecord(window)?.port;
    return port === undefined || port <= 0 ? undefined : port;
};

export const createDevtoolsRoutes = (services: Pick<Services, "mediaTickets">) => {
    const i = implement(browserContract).$context<OrpcContext>();
    return {
        devtools: i.devtools.handler(async ({ input, context }) => {
            const { session } = pageOf(input.name, input.pageId);
            if (devtoolsPortOf(input.name) === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "This browser has no DevTools to open." });
            }
            const { targetInfo } = await session.send("Target.getTargetInfo");
            const { ticket, expiresAt } = services.mediaTickets.mint(devtoolsBinding(input.name, targetInfo.targetId), DEVTOOLS_TICKET_MS, context.identity?.email);
            const base = `/browser/devtools/${ticket}`;
            return { path: `${base}/inspector.html`, socket: `${base}/ws/page/${targetInfo.targetId}`, expiresAt };
        }),
        // A new tab of the same window, beside the page, the way view-source: opens from a browser's own menu.
        viewSource: i.viewSource.handler(async ({ input }) => {
            const { record, entry } = pageOf(input.name, input.pageId);
            const url = entry.page.url();
            if (!/^https?:/u.test(url)) {
                throw new ORPCError("BAD_REQUEST", { message: "Only a web page has source to show." });
            }
            const context = record.context;
            if (context === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That browser window is closed." });
            }
            const tab = await context.newPage();
            // allow(silent-catch): Chromium shows its own error page for a source it cannot fetch.
            void tab.goto(`view-source:${url}`, { waitUntil: "commit" }).catch(() => undefined);
            const opened = [...record.pages.values()].find((candidate) => candidate.page === tab);
            return opened === undefined ? {} : { pageId: opened.id };
        }),
    };
};

// The frontend's files and the page's socket, behind the ticket the devtools route minted.
export const browserDevtoolsRawRoutes = defineRawRoutes((services: Pick<Services, "mediaTickets">) => {
    const deps = { mediaTickets: services.mediaTickets, portOf: devtoolsPortOf };
    return {
        "GET /browser/devtools/{ticket}/ws/{kind}/{target}": devtoolsSocketRoute(deps),
        "GET /browser/devtools/{ticket}/*": devtoolsFrontendRoute(deps),
    };
});
