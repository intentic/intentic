import type { ViewBadge } from "@intentic/extension-api";
import type { Component, Ref } from "vue";
import { askLocalApp } from "./local";

// THE APP'S HALF OF A LOCAL WINDOW'S SHELL. The editor draws the shell around a folder of this computer (local/LocalShell.vue):
// its rail, its Files view, the place chip and the way to agents. What only the desktop app can answer comes from here:
// the folders and documents this computer has opened, pointing the window at another folder, whether this install has an
// account and which sandboxes the workspace last listed for it, and the views the app adds to the rail (This device). The app installs its host on the window before the
// editor's modules run (`__INTENTIC_LOCAL_HOST__`, _editor/desktop-app/src/host.ts), so it is there when the router
// builds its routes. A window without one (a dev server, a test) gets `LINK_HOST`: what any local window can ask by link.

/** A folder or a document of this computer the app remembers opening, newest first (the app's state.rs `RecentView`). */
export interface LocalPlace {
    readonly path: string;
    readonly folder: boolean;
    /** When it was last opened: Unix seconds, epoch ms or an ISO instant, as the app kept it (local/places.ts `openedAtMs`). */
    readonly openedAt: number | string;
    /** Still there when the list was read: one that has moved is drawn as moved, and opens nothing. */
    readonly exists: boolean;
    /** It has a sandbox of its own, kept in sync with it (the app's projects.json). */
    readonly sandbox: boolean;
}

/** What this install knows that the shell draws differently by. */
export interface LocalFacts {
    /** A sign-in has completed here, or the workspace was shown: the way to agents is the workspace, not a sign-in. */
    readonly accountSeen: boolean;
    /** The folder the app opens its main window on when nothing else is asked for (`~/intentic/local` at first). */
    readonly homeFolder: string;
}

/** A sandbox of the account, as the workspace's switcher last listed it (the app's setup_link.rs `RosterEntry`). */
export interface LocalSandbox {
    readonly id: string;
    readonly name: string;
    /** Where it runs, as the workspace's switcher marked it: a placement kind, read by placement.ts `placementOfKind`. */
    readonly place: string;
    /** Somebody else's sandbox, shared with this account. */
    readonly shared: boolean;
}

/** A view the app adds to the local shell: a rail tile and the route it opens (This device, in the desktop app). */
export interface LocalView {
    /** The route's path under the shell, without its slash (`device`), which is also the route's name. */
    readonly path: string;
    /** The section its tile is drawn and ranked as (`devices`: the kit's glyph for this computer, `sectionIcon`). */
    readonly section: string;
    /** Its name on the rail and in the window, asked for when drawn so it follows the reader's language. */
    readonly title: () => string;
    /** Its screen, fetched the first time it is opened (the router wraps it as every in-shell view is, `asyncView`). */
    readonly load: () => Promise<{ readonly default: Component }>;
    /** What its tile carries (a setup running here, an update waiting), when it carries anything. */
    readonly badge?: Readonly<Ref<ViewBadge | undefined>>;
}

/** Every verb rejects with a sentence written for the reader, shown where the press was. */
export interface LocalHost {
    /** Whether this host reaches the app itself; the link-only host cannot read anything the app keeps. */
    readonly native: boolean;
    readonly views: readonly LocalView[];
    facts(): Promise<LocalFacts>;
    /** The recent folders and documents, newest first. */
    places(): Promise<readonly LocalPlace[]>;
    /**
     * The account's sandboxes as the workspace last told the app (desktop.ts `announceDesktopRoster`): a local window
     * cannot ask the platform itself. Empty before the workspace has said, and after a sign-out.
     */
    sandboxes(): Promise<readonly LocalSandbox[]>;
    /** Show `path`, a folder, in THIS window, in place of the folder it shows now. */
    point(path: string): Promise<void>;
    /** Open `path` where the app puts it: raised where a window shows it, handed to the folder window holding it, or a window of its own. */
    open(path: string): Promise<void>;
    /** The system's folder dialog, then the folder chosen shown in this window; nothing chosen changes nothing. */
    pickFolder(): Promise<void>;
    /** The system's file dialog, then the document chosen opened as `open` opens one. */
    pickFile(): Promise<void>;
    /** Take one entry off the recents; the folder or document itself is not touched. */
    forget(path: string): Promise<void>;
    /** Platform sign-in, in the default browser: the account comes back to the app, which opens the workspace. */
    signIn(): Promise<void>;
    /** The workspace (agents and sandboxes), in this window's place, at its root or a path under it. */
    openWorkspace(path?: string): Promise<void>;
}

declare global {
    interface Window {
        __INTENTIC_LOCAL_HOST__?: LocalHost;
    }
}

const nothing = (): Promise<void> => Promise.resolve();

/** What any local window can do without the app's host: ask by link for a dialog, which opens in a window of its own. */
export const LINK_HOST: LocalHost = {
    native: false,
    views: [],
    facts: () => Promise.resolve({ accountSeen: false, homeFolder: `` }),
    places: () => Promise.resolve([]),
    sandboxes: () => Promise.resolve([]),
    point: nothing,
    open: nothing,
    pickFolder: () => {
        askLocalApp(`open-folder`);
        return Promise.resolve();
    },
    pickFile: () => {
        askLocalApp(`open-file`);
        return Promise.resolve();
    },
    forget: nothing,
    signIn: nothing,
    openWorkspace: nothing,
};

export const localHost = (): LocalHost => window.__INTENTIC_LOCAL_HOST__ ?? LINK_HOST;
