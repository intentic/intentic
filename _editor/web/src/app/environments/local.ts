import { openDesktopLink } from "./desktop";

// The desktop app's window on a folder of the user's own disk (_editor/desktop-app, its "local face"): this same
// editor, with its file reads answered by the app's intentic-files sidecar (_devices/local-files) instead of a sandbox.
// The app marks such a window with `__INTENTIC_LOCAL__` before any module runs, and its bootstrap seeds the session
// the sandbox client reads, so the file views reach the sidecar exactly as they reach a daemon. What differs is said
// here, and only the few places that must behave differently ask.

export interface LocalFace {
    // The sidecar's loopback address, where every daemon call of this window goes.
    readonly daemonUrl: string;
    // The bearer the sidecar knows this window by. It decides the folder; nothing the page sends can.
    readonly token: string;
    // Stable per folder, so a folder opened again finds its tabs; keys the editor's state as `local-<id>`.
    readonly id: string;
    // The folder's or document's own name, for the title.
    readonly name: string;
    // The folder's absolute path, shown under the name.
    readonly path: string;
    // Set when one document was opened on its own: that document, relative to its folder.
    readonly file?: string;
    // Set when the folder already has a sandbox of its own (the app's projects.json), which the way to an agent opens.
    readonly sandbox?: boolean;
}

declare global {
    interface Window {
        __INTENTIC_LOCAL__?: LocalFace;
    }
}

export const localFace = (): LocalFace | undefined => window.__INTENTIC_LOCAL__;

// The compiled-in extensions a local window runs: the ones that show files. Every other one acts on a sandbox, which
// this window has none of.
export const LOCAL_EXTENSIONS: ReadonlySet<string> = new Set([`intentic.viewers`, `intentic.onlyoffice`]);

// What the window asks of the app, by link as every desktop page does (desktop.ts): the app accepts only these from a
// local window, and does the rest itself. `ask` starts an agent's conversation about one entry; the last four are about
// the folder's own sandbox, and each is answered with `LOCAL_PROJECT_EVENT` (local/bringBack.ts).
export type LocalVerb = `open-folder` | `open-file` | `reveal` | `sandbox` | `ask` | `changes` | `bring-back` | `restore` | `direction`;

// Which way a folder and its sandbox sync: `to-sandbox` carries the folder's edits over and an agent's back only when
// asked (copy-first); `both` carries each side's edits to the other at once.
export type SyncDirection = `to-sandbox` | `both`;

// What a verb carries, each under the name the app reads it by. Paths are relative to the window's folder.
export interface LocalAsk {
    // The entry `reveal` and `ask` are about.
    readonly path?: string | undefined;
    // The entries a bring-back takes, as JSON on the link; left out, it takes everything the sandbox changed.
    readonly paths?: readonly string[] | undefined;
    // The restore point a bring-back answered with, which `restore` puts the folder back to.
    readonly point?: string | undefined;
    // The way `direction` switches the sync to.
    readonly value?: SyncDirection | undefined;
}

export const askLocalApp = (verb: LocalVerb, ask: LocalAsk = {}): void => {
    const params = new URLSearchParams({ do: verb });
    if (ask.path !== undefined) {
        params.set(`path`, ask.path);
    }
    if (ask.paths !== undefined) {
        params.set(`paths`, JSON.stringify(ask.paths));
    }
    if (ask.point !== undefined) {
        params.set(`point`, ask.point);
    }
    if (ask.value !== undefined) {
        params.set(`value`, ask.value);
    }
    openDesktopLink(`intentic://local?${params.toString()}`);
};

/* WHAT THE APP TELLS A LOCAL WINDOW: `window` CustomEvents it dispatches into the page. */

// The window is being closed while the app last heard it held unsaved edits (`markDesktopWindowDirty`, desktop.ts): the
// page asks the reader, and answers with `confirmDesktopWindowClose` or not at all.
export const LOCAL_CLOSE_REQUESTED_EVENT = `intentic:close-requested`;
// An entry of this window's folder opened from outside the window (a double-click in the file manager), as
// `detail.path`, relative to the folder (local/appEvents.ts).
export const LOCAL_OPEN_EVENT = `intentic:open`;
// The answer to `changes`, `bring-back`, `restore` or `direction`, or the error that stopped one (local/bringBack.ts).
export const LOCAL_PROJECT_EVENT = `intentic:project`;
