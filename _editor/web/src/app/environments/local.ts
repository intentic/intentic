import { ref } from "vue";
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
    // Set on the app's main window (windows.rs `HOME`), the one the app shows for work of its own: a setup handed over
    // from the workspace, a Docker start at launch. Every other local window is a folder or a document opened beside it.
    readonly home?: boolean;
}

declare global {
    interface Window {
        __INTENTIC_LOCAL__?: LocalFace;
    }
}

// Bumped each time the window is pointed at another folder in place (`wearFace`), so whatever reads the face inside a
// `computed` or a render reads it again. The face itself stays on the window, where the app and the tests set it.
// allow(module-state): the one window's one face, and how many times it has changed
const faceWorn = ref(0);

export const localFace = (): LocalFace | undefined => {
    void faceWorn.value;
    return window.__INTENTIC_LOCAL__;
};

/** The window now shows another folder, without a reload (local/folderSwitch.ts): the face it wears from here on. */
export const wearFace = (face: LocalFace): void => {
    window.__INTENTIC_LOCAL__ = Object.freeze({ ...face });
    faceWorn.value += 1;
};

// The "sandbox" the editor knows a local window's folder as, keying its tabs, tree and session: `local-<id>`, stable per
// folder, so a folder opened again finds what it left.
export const localSandboxId = (face: Pick<LocalFace, `id`>): string => `local-${face.id}`;

const isText = (value: unknown): value is string => typeof value === `string`;
const isOptional = (value: unknown, is: (value: unknown) => boolean): boolean => value === undefined || is(value);

/** A face as the app hands one over (`intentic:repoint`), read off a detail that crossed a process boundary; nothing for any other shape. */
export const faceOf = (detail: unknown): LocalFace | undefined => {
    if (typeof detail !== `object` || detail === null) {
        return undefined;
    }
    const face: Partial<Record<keyof LocalFace, unknown>> = detail;
    const whole =
        isText(face.daemonUrl) &&
        isText(face.token) &&
        isText(face.id) &&
        isText(face.name) &&
        isText(face.path) &&
        isOptional(face.file, isText) &&
        isOptional(face.sandbox, (value) => typeof value === `boolean`) &&
        isOptional(face.home, (value) => typeof value === `boolean`);
    // SAFETY: every field LocalFace names was checked just above.
    return whole ? (detail as LocalFace) : undefined;
};

// The compiled-in extensions a local window runs: the ones that show files. Every other one acts on a sandbox, which
// this window has none of.
export const LOCAL_EXTENSIONS: ReadonlySet<string> = new Set([`intentic.viewers`, `intentic.onlyoffice`]);

// What the window asks of the app, by link as every desktop page does (desktop.ts): the app accepts only these from a
// local window, and does the rest itself. `ask` starts an agent's conversation about one entry; the last four are about
// the folder's own sandbox, and each is answered with `LOCAL_PROJECT_EVENT` (local/bring-back/bringBack.ts).
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
// The answer to `changes`, `bring-back`, `restore` or `direction`, or the error that stopped one (local/bring-back/bringBack.ts).
export const LOCAL_PROJECT_EVENT = `intentic:project`;
// The app showing this window for a reason of its own (a setup handed over from the workspace, the tray's agent row): the
// screen it is for, as `detail.path`, a route of the local shell (`/device`). local/LocalShell.vue takes it there.
export const LOCAL_NAVIGATE_EVENT = `intentic:navigate`;
// This window's folder has its own sandbox now (the app's project.rs `remember`): the way to an agent becomes the way to
// that sandbox, without a reload (local/folderSandbox.ts).
export const LOCAL_SANDBOX_EVENT = `intentic:sandbox`;
// The app asking this window to put up its folder's sandbox dialog (`sandbox` asked by link for a folder with none).
export const LOCAL_PROJECT_ASK_EVENT = `intentic:project-ask`;
// This window pointed at another folder (the folder menu, an empty folder's offers): the folder's face, as `detail`.
// Cancelable: a page that moves to it in place takes it (local/folderSwitch.ts), and one that does not is reloaded onto
// it by the app (local.rs `face_pointed`). The desktop page seeds the folder's session first (desktop-app local/main.ts).
export const LOCAL_REPOINT_EVENT = `intentic:repoint`;
