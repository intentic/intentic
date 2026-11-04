import { isSandboxPage, legacyPathOf, legacyTarget, page, parseAppPath } from "@intentic/sandbox-contract/app-routes";
import { frameOf, pageOf, type RouteRead } from "./links";

/** Home's own page: its chat of one sandbox (`/home/<sandbox>`), or Home with none named yet (`/home`). */
export const isHomePath = (path: string): boolean => {
    const address = parseAppPath(path);
    return address !== undefined && address.frame.kind === `home` && address.page === undefined;
};

/**
 * The account's deleted sandboxes: a page of the account's, like Settings, never a section of one sandbox's screen, since
 * the trash is every sandbox the account deleted, wherever it ran, and recovery has to work with no sandbox left at all.
 * Its address from before frames, which the router opens in the frame it is pressed in (router/legacyRoutes.ts); a new
 * link is `here(page.deletedSandboxes())` (lib/routes/links.ts).
 */
export const DELETED_PATH = legacyPathOf(page.deletedSandboxes());

/**
 * Account pages stay available without a connected sandbox or a completed setup: Home's own page, and the account's
 * settings and deleted sandboxes in either frame, at an address of either form (an older one too: `/settings/…`).
 */
export const isAccountPath = (path: string): boolean => {
    const address = parseAppPath(path);
    if (address === undefined) {
        const legacy = legacyTarget(path);
        return legacy !== undefined && !isSandboxPage(legacy.link.page);
    }
    return address.page === undefined ? address.frame.kind === `home` : !isSandboxPage(address.page.name);
};

/** The same of a route: Home's own page, or one of the account's in either frame. */
export const isAccountRoute = (route: RouteRead): boolean => {
    const shown = pageOf(route);
    return shown === undefined ? frameOf(route) === `home` : !isSandboxPage(shown);
};
