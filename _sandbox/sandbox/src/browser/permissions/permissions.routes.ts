import { browserContract } from "@intentic/sandbox-contract/contracts/browser.contract";
import { legacyPathOf, page } from "@intentic/sandbox-contract/app-routes";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { OPERATORS } from "../../push/push-audience.js";
import { browserWindowRecord } from "../sessions/browser-sessions.js";
import { answerPermissionAsk, clearSiteData, configurePermissions, NotArmed, sitePermissions, setSitePermission } from "./window-permissions.js";

// The routes behind a window's permission prompt and its site info (window-permissions.ts). Building them is also where
// the module learns where each profile's decisions are kept and where an allowed site's notifications go: once, as the
// daemon's routes are built, before any window opens.

const windowOf = (name: string) => {
    const record = browserWindowRecord(name);
    if (record === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "That browser window is closed." });
    }
    return record;
};

// A window that answers no permissions (no page has opened in it yet) is one with nothing to say about a site.
const answered = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (error) {
        if (error instanceof NotArmed) {
            throw new ORPCError("CONFLICT", { message: error.message });
        }
        throw error;
    }
};

export const createPermissionsRoutes = (services: Pick<Services, "workspace" | "pushSender">) => {
    configurePermissions({
        root: services.workspace.root,
        // As one of Intentic's own notifications, collapsed per site, opening the browsers view.
        notify: ({ origin, title, body }) => {
            void services.pushSender.notify(
                { title: `${new URL(origin).host}: ${title || "Notification"}`, body, tag: `browser-${origin}`, url: legacyPathOf(page.browsers(undefined)) },
                OPERATORS,
            );
        },
    });
    const i = implement(browserContract).$context<OrpcContext>();
    return {
        answerPermission: i.answerPermission.handler(async ({ input }) => {
            await answered(() => answerPermissionAsk(windowOf(input.name), input.ask, input.setting, input.location));
            return { ok: true };
        }),
        site: i.site.handler(({ input }) => answered(() => sitePermissions(windowOf(input.name), input.origin))),
        setSitePermission: i.setSitePermission.handler(async ({ input }) => {
            await answered(() => setSitePermission(windowOf(input.name), input));
            return { ok: true };
        }),
        clearSiteData: i.clearSiteData.handler(async ({ input }) => {
            await answered(() => clearSiteData(windowOf(input.name), input.origin));
            return { ok: true };
        }),
    };
};
