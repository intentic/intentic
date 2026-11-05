import {
    type FloatingPanel,
    floatingPath,
    type FrameKind,
    homePath,
    insidePath,
    isSandboxPage,
    legacyTarget,
    type LinkQuery,
    localPath,
    type NamedSandbox,
    type PageLink,
    type PageName,
    parseAppPath,
    sandboxOfSegment,
    sandboxSegment,
    topPath,
    type TopPageName,
} from "@intentic/sandbox-contract/app-routes";
import { type Ref, shallowRef } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";
import { localFace } from "../../app/environments/local";
import { activeSandboxId } from "../../app/storage/activeSandbox";

// THE EDITOR'S LINKS (2026-11-04). Every address of the app is made from the shared table of pages
// (@intentic/sandbox-contract/app-routes), and the editor makes it here: in the frame and the sandbox the reader is
// looking at (`here`), or in a frame named outright (`toInside`, `toHome`), and the route read back the same way
// (`frameOf`, `pageOf`, `routeSandbox`). The address says which frame and which sandbox, so these read the route and
// nothing else: no window's memory decides what a link opens. The sandbox is written by its name and the tail of its id
// (`/s/intentic-zi4n3i/agents`, sandbox-segment.ts) and read back to its id, so the rest of the app only ever holds ids.

export {
    type FrameKind,
    isSandboxPage,
    type LinkQuery,
    page,
    type PageLink,
    type PageName,
    type SandboxPageName,
} from "@intentic/sandbox-contract/app-routes";

declare module "vue-router" {
    interface RouteMeta {
        /** The frame the page is drawn in: inside its sandbox, or in Home's frame. None for a page outside the shell. */
        frame?: FrameKind;
        /** The page of the shared table the route draws; none for Home's own page and the shell's redirects. */
        page?: PageName;
    }
}

/** A route's name in the shell: the frame and the page, `inside:agents`, `home:workspace` (router/pageRoutes.ts). */
export const routeName = (frame: FrameKind, name: PageName): string => `${frame}:${name}`;

/** What the readers below read of a route: a guard's, a resolved one and the current one alike. */
export type RouteRead = Pick<RouteLocationNormalizedLoaded, `meta` | `params`>;

// The router is handed in by the navigation registry (workbench/navigation/navigation.ts) when the route table installs
// it, since this layer may not import that one. A ref, so a computed read before the router is in reads again once it is.
// allow(module-state): the app's one router, as the route table installed it
const installed = shallowRef<Pick<Router, `currentRoute`>>();

/** Hands this module the app's router; the navigation registry's to call. */
export const readRoutesOf = (router: Pick<Router, `currentRoute`>): void => {
    installed.value = router;
};

/** The route on screen, reactively; none before the route table has installed the router. */
export const currentRoute = (): RouteLocationNormalizedLoaded | undefined => installed.value?.currentRoute.value;

/** The frame a route is drawn in; none for a page outside the shell (sign-in, a floating window). */
export const frameOf = (route: RouteRead): FrameKind | undefined => route.meta.frame;

/** The page of the shared table a route draws; none for Home's own page and for a page outside the shell. */
export const pageOf = (route: RouteRead): PageName | undefined => route.meta.page;

/** Whether a route draws that page, in whichever frame. */
export const isPage = (route: RouteRead, name: PageName): boolean => pageOf(route) === name;

// The account's sandboxes as the shell lists them, handed in by client/sandbox/useSandbox.ts, since this layer may not
// import that one: what an address names a sandbox among. Empty until the list is in, when every sandbox is written by
// its whole id, which reads back as well.
// allow(module-state): the account's list, as its owner hands it in
const listed = shallowRef<Readonly<Ref<readonly NamedSandbox[]>>>();

/** Hands this module the account's sandbox list; useSandbox's to call. */
export const nameSandboxesFrom = (list: Readonly<Ref<readonly NamedSandbox[]>>): void => {
    listed.value = list;
};

const listedSandboxes = (): readonly NamedSandbox[] => listed.value?.value ?? [];

/** The segment an address names a sandbox by (`intentic-zi4n3i`); its whole id while the list does not have it. */
export const segmentOf = (sandbox: string, rows: readonly NamedSandbox[] = listedSandboxes()): string => {
    const row = rows.find((entry) => entry.id === sandbox);
    return row === undefined ? sandbox : sandboxSegment(row, rows);
};

/** The id of the sandbox an address's segment names; the segment as it stands while no listed sandbox answers to it. */
export const sandboxOfAddress = (segment: string, rows: readonly NamedSandbox[] = listedSandboxes()): string =>
    sandboxOfSegment(segment, rows)?.id ?? segment;

/** The sandbox segment of a route's address as it is written (`intentic-zi4n3i`), if it names one. */
export const routeSegment = (route: Pick<RouteRead, `params`>): string | undefined => {
    const named = [route.params[`sandbox`]].flat()[0];
    return named === undefined || named === `` ? undefined : named;
};

/** The id of the sandbox a route's address names, if it names one. */
export const routeSandbox = (route: Pick<RouteRead, `params`>): string | undefined => {
    const named = routeSegment(route);
    return named === undefined ? undefined : sandboxOfAddress(named);
};

// A desktop window on a folder (router/localRoutes.ts) has two of the shell's pages under addresses of its own: the
// folder's files and the account's settings. A link to either is written in the window's form there, so what the shell
// and that window share (the shortcut sheet, a file reference, the account's menu) opens in whichever it is pressed in.
const inFolderWindow = (link: PageLink): string | undefined => {
    if (localFace() === undefined) {
        return undefined;
    }
    if (link.page === `account`) {
        return localPath(`account`, link.params, link);
    }
    return link.page === `workspace` ? localPath(`files`, link.params, link) : undefined;
};

/**
 * A link's address in the frame and the sandbox of a route (the current one unless another is named): inside it, or in
 * Home's frame when that is where the route stands, so a link to any page of the same sandbox keeps the reader where
 * they are. The sandbox is the route's, else the one opened last; the account's pages need none in Home's frame. With
 * no sandbox known at all, a sandbox's page has nowhere to be shown, and Home is the answer. In a desktop window on a
 * folder, the two pages it has are at its own addresses.
 */
export const here = (link: PageLink, route: RouteRead | undefined = currentRoute()): string => {
    const folderWindows = inFolderWindow(link);
    if (folderWindows !== undefined) {
        return folderWindows;
    }
    const frame = route === undefined ? undefined : frameOf(route);
    const sandbox = (route === undefined ? undefined : routeSandbox(route)) ?? activeSandboxId.value;
    if (!isSandboxPage(link.page)) {
        return frame === `inside` && sandbox !== undefined ? toInside(sandbox, link) : homePath(undefined, link);
    }
    if (sandbox === undefined) {
        return homePath();
    }
    return frame === `home` ? toHome(sandbox, link) : toInside(sandbox, link);
};

/** A link's address in the frame of a route (the current one unless another is named), of another sandbox named. */
export const hereIn = (sandbox: string, link: PageLink, route: RouteRead | undefined = currentRoute()): string =>
    !isSandboxPage(link.page) || route === undefined || frameOf(route) !== `home` ? toInside(sandbox, link) : toHome(sandbox, link);

/** A link's address inside a sandbox, named by its id; the sandbox's own landing with no page. */
export const toInside = (sandbox: string, link?: PageLink): string => insidePath(segmentOf(sandbox), link);

/**
 * A link's address in Home's frame, the sandbox named by its id: a sandbox's page, its home conversation with no page,
 * Home itself with neither.
 */
export const toHome = (sandbox?: string, link?: PageLink): string => homePath(sandbox === undefined ? undefined : segmentOf(sandbox), link);

/** A floating window's address: one panel of one sandbox, named by its id. */
export const toFloating = (sandbox: string, panel: FloatingPanel): string => floatingPath(segmentOf(sandbox), panel);

/** A page that is no sandbox's: `/login`, `/invite/<token>`. */
export const toTop = (name: TopPageName, params?: Readonly<Record<string, string | undefined>>, query?: LinkQuery): string =>
    topPath(name, params, query);

// The board owns the agents opened from it, as their addresses say by sitting below it.
const pagesBelow = (name: PageName): readonly PageName[] => (name === `agents` ? [`agent`, `agentPage`] : []);

/**
 * Whether a page is another's or below it: the same page, or one it owns (an agent of the board), with every value the
 * outer one names (an extension's view, a folder of the workspace, which a file in it is below).
 */
export const pageCovers = (outer: Pick<PageLink, `page` | `params`>, inner: Pick<PageLink, `page` | `params`>): boolean =>
    (inner.page === outer.page || pagesBelow(outer.page).includes(inner.page)) &&
    Object.entries(outer.params).every(([key, value]) => {
        const held = inner.params[key];
        return value === undefined || value === `` || (held !== undefined && (held === value || held.startsWith(`${value}/`)));
    });

/** Whether two links are the same page with the same values. */
export const samePage = (left: Pick<PageLink, `page` | `params`>, right: Pick<PageLink, `page` | `params`>): boolean =>
    pageCovers(left, right) && pageCovers(right, left);

/**
 * Whether a route shows the page an address names (a rail tile's, in either form) or a page below it, in whichever
 * frame. An address that names no page is matched as a path, itself or anything below it.
 */
export const routeShows = (route: Pick<RouteLocationNormalizedLoaded, `path`>, address: string): boolean => {
    const target = linkOf(address);
    if (target === undefined) {
        const path = address.split(/[?#]/, 1)[0] ?? address;
        return route.path === path || route.path.startsWith(`${path}/`);
    }
    const shown = linkOf(route.path);
    return shown !== undefined && pageCovers(target, shown);
};

/**
 * The page an address names, in either form it comes in: one of the shell's (`/s/<sandbox>/…`, `/home/…`), or one from
 * before frames (`/agents/<id>`, `/sandbox/models`), its query and hash kept. None for anything else.
 */
export const linkOf = (address: string): PageLink | undefined => {
    const parsed = parseAppPath(address)?.page;
    if (parsed === undefined) {
        return legacyTarget(address)?.link;
    }
    const hashAt = address.indexOf(`#`);
    const beforeHash = hashAt === -1 ? address : address.slice(0, hashAt);
    const queryAt = beforeHash.indexOf(`?`);
    return {
        page: parsed.name,
        params: parsed.params,
        query: queryAt === -1 ? {} : Object.fromEntries(new URLSearchParams(beforeHash.slice(queryAt + 1))),
        hash: hashAt === -1 ? `` : address.slice(hashAt + 1),
    };
};
