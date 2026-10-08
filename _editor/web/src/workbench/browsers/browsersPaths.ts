import type { RouteLocationRaw } from "vue-router";

// The Browsers view's tabs as addresses: what a tab is, its key, and the route that shows it. Pure, so the router and
// the status bar can name a tab without loading the view's state (browsersSurface.ts).
//
// A tab is one of four things, and its key is what the editor's address says after /browsers/:
// - web: a window of the sandbox's own Chromium, by its session name (`browser-…`), or none for "whichever matters most"
// - preview: a live app framed straight from its dev server, `preview:<target id>` (previewModel.ts's ids)
// - desktop: the sandbox's whole X display, `desktop`
// - app: one window on that display, `app:<window id>`

export type LiveTab =
    | { readonly kind: `web`; readonly session: string | undefined }
    | { readonly kind: `preview`; readonly id: string }
    | { readonly kind: `desktop` }
    | { readonly kind: `app`; readonly id: string };

export type PinnedTab = Exclude<LiveTab, { kind: `web` }>;

const PREVIEW = `preview:`;
const APP = `app:`;
const DESKTOP = `desktop`;

export const WEB_FRONT: LiveTab = { kind: `web`, session: undefined };

export const tabKey = (tab: LiveTab): string => {
    switch (tab.kind) {
        case `web`:
            return tab.session ?? ``;
        case `preview`:
            return `${PREVIEW}${tab.id}`;
        case `desktop`:
            return DESKTOP;
        case `app`:
            return `${APP}${tab.id}`;
    }
};

// Session names are `browser-…` (the daemon's browserSessionName), so none of them reads as one of the other kinds.
export const parseTabKey = (key: string | undefined): LiveTab => {
    if (key === undefined || key === ``) {
        return WEB_FRONT;
    }
    if (key.startsWith(PREVIEW) && key.length > PREVIEW.length) {
        return { kind: `preview`, id: key.slice(PREVIEW.length) };
    }
    if (key === DESKTOP) {
        return { kind: `desktop` };
    }
    if (key.startsWith(APP) && key.length > APP.length) {
        return { kind: `app`, id: key.slice(APP.length) };
    }
    return { kind: `web`, session: key };
};

export const sameTab = (left: LiveTab, right: LiveTab): boolean => tabKey(left) === tabKey(right);

// The address of a tab in the main window: what a link to it says, and what the route reads back.
export const browsersPath = (tab: LiveTab = WEB_FRONT): string => {
    const key = tabKey(tab);
    return key === `` ? `/browsers` : `/browsers/${key}`;
};

// Where the old /preview address goes: the app it named, or the one most worth seeing (`?preview`, which the view reads
// as "pick one" and then drops). The query is said whole, since a redirect otherwise carries the old `?target=` along.
export const previewRedirect = (target: unknown): RouteLocationRaw =>
    typeof target === `string` && target !== ``
        ? { path: browsersPath({ kind: `preview`, id: target }), query: {} }
        : { path: `/browsers`, query: { preview: null } };
