import { parseFloatingPath } from "@intentic/sandbox-contract/app-routes";

// WHICH KIND OF EDITOR WINDOW THIS PAGE IS, read once from its address at load: the app's main window, or a popped-out
// panel's own window (`/s/<sandbox>/floating/<panel>`, or `/floating/<panel>` as a desktop app from before frames still
// opens one; shell/window/FloatingSection.vue). Read from the address rather than from the
// floating claim (workbench/window/floating.ts), since what a window starts at boot (the session runtime, the cache's
// mirror) is decided before any route mounts. A window never changes kind while it lives: a floating window that has to
// become an ordinary one loads the app again rather than navigating there (FloatingSection.vue's close).

export type WindowRole = `main` | `floating`;

const FLOATING_PREFIX = `${import.meta.env.BASE_URL}floating/`;

const pathname = globalThis.location?.pathname ?? ``;

// The panel the address names: the floating window's own, or the old form's first segment after `floating/`.
const floatingPanel = (): string | undefined =>
    parseFloatingPath(`/${pathname.slice(import.meta.env.BASE_URL.length)}`)?.panel ??
    (pathname.startsWith(FLOATING_PREFIX) ? (pathname.slice(FLOATING_PREFIX.length).split(`/`)[0] ?? ``) : undefined);

const panel = floatingPanel();

export const windowRole: WindowRole = panel === undefined ? `main` : `floating`;

/** `main`, or `floating:chat` for a popped-out chat: what this window's diagnostic reports say it was. */
export const windowLabel: string = panel === undefined ? `main` : `floating:${panel}`;
