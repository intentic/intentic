import { type FrameKind, legacyTarget, matchPattern, page, parseAppPath, parseFloatingPath, TOP_PAGES } from "@intentic/sandbox-contract/app-routes";
import { HOME_PATH } from "./firstScreens";
import { type PageLink, toInside } from "./links";

// Where a guest member may stand in the shell: the chat it drives, the board of its own conversations, its own
// settings, and the one sandbox section it has business in. Everywhere else the daemon refuses every read, so the
// shell sends it home rather than draw a screen of refusals. The daemon is the fence; this only spares the screen.
// Pure, apart from the composable that applies it (guestFence.ts), so the table can be pinned without a window. Judged
// by the page an address names and its frame (the shared table, @intentic/sandbox-contract/app-routes), in either form
// an address comes in, so a page's new address and its old one are fenced alike.

/** The one sandbox section every guest has business in: their own card and passkeys (sandboxNav.ts `GUEST_SECTION`). */
const GUEST_SETTINGS = `access`;

// The pages that are no sandbox's a guest may stand on: signing in, and the invite that let it in.
const TOP_ROOTS = [TOP_PAGES.login, TOP_PAGES.invite].map((pattern) => `/${pattern.split(`/`)[0] ?? ``}`);
const onTopPage = (path: string): boolean => TOP_ROOTS.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}?`));

// The panel a floating window shows, at its address or at the one before frames (`/floating/<panel>`), which a desktop
// app from then still opens.
const floatingPanelOf = (path: string): string | undefined =>
    parseFloatingPath(path)?.panel ?? matchPattern(`floating/:panel`, path.split(/[?#]/, 1)[0] ?? ``)?.[`panel`];

interface Placed {
    readonly frame: FrameKind;
    /** Undefined on Home's own page, which shows a home conversation and no page of the table. */
    readonly link?: Pick<PageLink, `page` | `params`>;
}

// The page and frame an address names: one of the shell's, or one from before frames, read where it would open.
const placeOf = (path: string): Placed | undefined => {
    const address = parseAppPath(path);
    if (address !== undefined) {
        return address.page === undefined ? { frame: address.frame.kind } : { frame: address.frame.kind, link: { page: address.page.name, params: address.page.params } };
    }
    const legacy = legacyTarget(path);
    return legacy === undefined ? undefined : { frame: legacy.frame, link: legacy.link };
};

// Either guest's own pages, in any frame: its settings, and its card in the sandbox's Access.
const ownPage = (link: Pick<PageLink, `page` | `params`>): boolean =>
    link.page === `account` || (link.page === `sandboxSettings` && link.params[`tab`] === GUEST_SETTINGS);

export const guestAllowedPath = (path: string): boolean => {
    if (onTopPage(path)) {
        return true;
    }
    const floating = floatingPanelOf(path);
    if (floating !== undefined) {
        return floating === `chat`;
    }
    const placed = placeOf(path);
    if (placed?.link === undefined) {
        return false;
    }
    const { page: shown } = placed.link;
    return ownPage(placed.link) || (placed.frame === `inside` && (shown === `chat` || shown === `agents` || shown === `agent` || shown === `agentPage`));
};

// A home-only guest (members.ts `agents: "home"`) has one conversation, its home, and the master view it lives in: no
// chat of its own to start, no board. It may read the sessions its home started (the ledger links to each), its own
// settings and the one sandbox section every guest has business in.
export const homeOnlyAllowedPath = (path: string): boolean => {
    if (onTopPage(path)) {
        return true;
    }
    const placed = placeOf(path);
    if (placed === undefined) {
        return false;
    }
    if (placed.link === undefined) {
        return placed.frame === `home`;
    }
    return ownPage(placed.link) || placed.link.page === `agent` || placed.link.page === `agentPage`;
};

/** Where a guest may stand, and where the shell sends it from anywhere else. */
export interface GuestFence {
    readonly home: string;
    readonly allowed: (path: string) => boolean;
}

/**
 * The fence by which kind of guest it is: Home for a home-only guest, the chat of the sandbox it stands in for any other
 * (Home when there is none to name).
 */
export const guestFenceOf = (homeOnly: boolean, sandbox?: string): GuestFence => {
    if (homeOnly) {
        return { home: HOME_PATH, allowed: homeOnlyAllowedPath };
    }
    return { home: sandbox === undefined ? HOME_PATH : toInside(sandbox, page.chat()), allowed: guestAllowedPath };
};
