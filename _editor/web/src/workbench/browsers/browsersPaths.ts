import { here, page, type PageLink } from "../../lib/routes/links";

// The Browsers view's tabs as addresses: what a tab is, its key, and the route that shows it. Pure, so the router and
// the status bar can name a tab without loading the view's state (browsersSurface.ts).
//
// A tab is one of four things, and its key is what the editor's address says after /browsers/:
// - web: a window of the sandbox's own Chromium, by its session name (`browser-…`), or none for "whichever matters most"
// - preview: a live app framed straight from its dev server, `preview:<target id>` (previewModel.ts's ids)
// - desktop: the sandbox's whole X display, `desktop`; a runner's, `desktop:<runner>`
// - app: one window on that display, `app:<window id>`; on a runner's, `app:<runner>~<window id>`
// (A runner is another machine's sandbox a conversation runs on: its desktop is shown here for that conversation.)

export type LiveTab =
    | { readonly kind: `web`; readonly session: string | undefined }
    | { readonly kind: `preview`; readonly id: string }
    | { readonly kind: `desktop`; readonly runner?: string | undefined }
    | { readonly kind: `app`; readonly id: string; readonly runner?: string | undefined };

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
            return tab.runner === undefined ? DESKTOP : `${DESKTOP}:${tab.runner}`;
        case `app`:
            return `${APP}${tab.runner === undefined ? `` : `${tab.runner}~`}${tab.id}`;
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
    if (key.startsWith(`${DESKTOP}:`) && key.length > DESKTOP.length + 1) {
        return { kind: `desktop`, runner: key.slice(DESKTOP.length + 1) };
    }
    if (key.startsWith(APP) && key.length > APP.length) {
        // A window id is the display's own (`0x1a00007`), never holding a `~`; what comes before one is the runner.
        const id = key.slice(APP.length);
        const at = id.indexOf(`~`);
        return at > 0 && at < id.length - 1 ? { kind: `app`, id: id.slice(at + 1), runner: id.slice(0, at) } : { kind: `app`, id };
    }
    return { kind: `web`, session: key };
};

export const sameTab = (left: LiveTab, right: LiveTab): boolean => tabKey(left) === tabKey(right);

// The page of a tab in the main window: what a link to it names, and what the route reads back.
const browsersLink = (tab: LiveTab = WEB_FRONT): PageLink<`browsers`> => {
    const key = tabKey(tab);
    return page.browsers(key === `` ? undefined : key);
};

// The address of a tab, in the frame and the sandbox the reader is in.
export const browsersPath = (tab: LiveTab = WEB_FRONT): string => here(browsersLink(tab));
