import { fillPattern, matchPattern } from "./patterns.js";
import {
    type FloatingPanel,
    FLOATING_PANELS,
    isSandboxPage,
    LOCAL_PAGES,
    type LinkQuery,
    type LocalPageName,
    PAGE_PATTERNS,
    type PageLink,
    type PageName,
    TOP_PAGES,
    type TopPageName,
} from "./app-pages.js";

// WHERE A LINK IS DRAWN, AND ITS ADDRESS (2026-11-04). The first segment of every address in the workspace shell says
// its frame, so the address alone says what the screen shows, and Back, a reload and a shared link all agree with it:
//
//   /s/<sandbox>/<page>        inside the sandbox: its own rail, its sections, its status bar
//   /home/<sandbox>/<page>     in Home's frame: the rail of every sandbox, around this one's page
//   /home/<sandbox>            Home's frame around that sandbox's home conversation
//   /home/<account page>       the account's own pages opened from Home; `/s/<sandbox>/<account page>` from inside
//
// Until then the frame was the window's memory (a sessionStorage flag) and the sandbox the browser's (one localStorage
// key for every tab), so one address drew two screens and Back could not leave Home.

/** The address segment of each frame. */
export const SANDBOX_SEGMENT = `s`;
export const HOME_SEGMENT = `home`;

/** Inside a sandbox, or in Home's frame. */
export type FrameKind = `inside` | `home`;

/** Where a page is drawn: inside one sandbox, or in Home's frame (around one sandbox's page, or around the account's). */
export type Frame = { readonly kind: `inside`; readonly sandbox: string } | { readonly kind: `home`; readonly sandbox?: string | undefined };

const queryString = (query: LinkQuery): string => {
    const entries = Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ``);
    return entries.length === 0 ? `` : `?${new URLSearchParams(entries).toString()}`;
};

const suffix = (link: Pick<PageLink, `query` | `hash`>): string => `${queryString(link.query)}${link.hash === `` ? `` : `#${link.hash}`}`;

const joined = (...parts: readonly string[]): string => `/${parts.filter((part) => part !== ``).join(`/`)}`;

/** A page's path below its frame, no query: `agents/1a2b`. */
export const pagePath = (link: PageLink): string => fillPattern(PAGE_PATTERNS[link.page], link.params);

/** A link's address inside a sandbox: `/s/<sandbox>/<page>`, or the sandbox's own landing with no page. */
export const insidePath = (sandbox: string, link?: PageLink): string =>
    link === undefined ? joined(SANDBOX_SEGMENT, encodeURIComponent(sandbox)) : `${joined(SANDBOX_SEGMENT, encodeURIComponent(sandbox), pagePath(link))}${suffix(link)}`;

/**
 * A link's address in Home's frame: a sandbox's page beside the rail of every sandbox, that sandbox's home conversation
 * with no page, an account page with no sandbox needed, and Home itself with neither.
 */
export const homePath = (sandbox?: string, link?: PageLink): string => {
    if (link !== undefined && !isSandboxPage(link.page)) {
        return `${joined(HOME_SEGMENT, pagePath(link))}${suffix(link)}`;
    }
    if (sandbox === undefined) {
        if (link !== undefined) {
            throw new Error(`Home's frame shows the page ${link.page} of a sandbox, and none was named.`);
        }
        return joined(HOME_SEGMENT);
    }
    return link === undefined
        ? joined(HOME_SEGMENT, encodeURIComponent(sandbox))
        : `${joined(HOME_SEGMENT, encodeURIComponent(sandbox), pagePath(link))}${suffix(link)}`;
};

/** A link's address in a frame. */
export const framePath = (frame: Frame, link?: PageLink): string =>
    frame.kind === `inside` ? insidePath(frame.sandbox, link) : homePath(frame.sandbox, link);

/** A floating window's own address: one panel of one sandbox, with no shell around it. */
export const floatingPath = (sandbox: string, panel: FloatingPanel): string => joined(SANDBOX_SEGMENT, encodeURIComponent(sandbox), `floating`, panel);

/** A page that is no sandbox's, by name: `/login`, `/invite/<token>`. */
export const topPath = (name: TopPageName, params: Readonly<Record<string, string | undefined>> = {}, query: LinkQuery = {}): string =>
    `${joined(fillPattern(TOP_PAGES[name], params))}${queryString(query)}`;

/** A page of a desktop window on a folder (the app's local face). */
export const localPath = (name: LocalPageName, params: Readonly<Record<string, string | undefined>> = {}, extras: { query?: LinkQuery; hash?: string } = {}): string =>
    `${joined(fillPattern(LOCAL_PAGES[name], params))}${suffix({ query: extras.query ?? {}, hash: extras.hash ?? `` })}`;

/** What an address of the workspace shell names: its frame, its sandbox, and its page when it names one. */
export interface AppAddress {
    readonly frame: Frame;
    readonly page?: { readonly name: PageName; readonly params: Readonly<Record<string, string>> };
}

// SAFETY: PAGE_PATTERNS is a const literal whose own keys are exactly PageName; Object.keys only widens their type.
const PAGE_NAMES = Object.keys(PAGE_PATTERNS) as PageName[];

/** The page a path below a frame names (no query, no hash), if it names one. */
export const matchPage = (path: string): { readonly name: PageName; readonly params: Readonly<Record<string, string>> } | undefined => {
    for (const name of PAGE_NAMES) {
        const params = matchPattern(PAGE_PATTERNS[name], path);
        if (params !== undefined) {
            return { name, params };
        }
    }
    return undefined;
};

const decodeSegment = (segment: string): string => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
};

/**
 * What a path of the workspace shell names (query and hash are ignored), or undefined for any other path: one of a
 * top page's, a floating window's, an address from before frames (legacy.ts reads those), or none at all.
 */
export const parseAppPath = (address: string): AppAddress | undefined => {
    const path = address.split(/[?#]/, 1)[0] ?? ``;
    const segments = path.split(`/`).filter((segment) => segment !== ``);
    const [head, second, ...rest] = segments;
    if (head === SANDBOX_SEGMENT && second !== undefined) {
        const frame: Frame = { kind: `inside`, sandbox: decodeSegment(second) };
        if (rest[0] === `floating`) {
            return undefined;
        }
        if (rest.length === 0) {
            return { frame };
        }
        const page = matchPage(rest.join(`/`));
        return page === undefined ? undefined : { frame, page };
    }
    if (head === HOME_SEGMENT) {
        if (second === undefined) {
            return { frame: { kind: `home` } };
        }
        const account = matchPage([second, ...rest].join(`/`));
        if (account !== undefined && !isSandboxPage(account.name)) {
            return { frame: { kind: `home` }, page: account };
        }
        const frame: Frame = { kind: `home`, sandbox: decodeSegment(second) };
        if (rest.length === 0) {
            return { frame };
        }
        const page = matchPage(rest.join(`/`));
        return page === undefined ? undefined : { frame, page };
    }
    return undefined;
};

/** The sandbox and panel a floating window's address names, if it is one. */
export const parseFloatingPath = (address: string): { readonly sandbox: string; readonly panel: FloatingPanel } | undefined => {
    const path = address.split(/[?#]/, 1)[0] ?? ``;
    const [head, sandbox, floating, panel, ...rest] = path.split(`/`).filter((segment) => segment !== ``);
    const known = FLOATING_PANELS.find((candidate) => candidate === panel);
    return head === SANDBOX_SEGMENT && sandbox !== undefined && floating === `floating` && known !== undefined && rest.length === 0
        ? { sandbox: decodeSegment(sandbox), panel: known }
        : undefined;
};
