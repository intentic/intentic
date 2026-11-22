import { parseFloatingPath, SANDBOX_SEGMENT } from "@intentic/sandbox-contract/app-routes";

// WHICH KIND OF EDITOR WINDOW THIS PAGE IS, read once from its address at load: the app's main window, a popped-out
// panel's own window (`/s/<sandbox>/floating/<panel>`, or `/floating/<panel>` as a desktop app from before frames still
// opens one; shell/window/FloatingSection.vue), or a computer's screen in a window of its own
// (`/s/<sandbox>/floating/screen`, or `/floating/screen` as the screen is opened; ScreenWindow.vue). Read from the
// address rather than from the floating claim (workbench/window/floating.ts), since what a window starts at boot (the
// session runtime, the cache's mirror) is decided before any route mounts. A window never changes kind while it lives: a
// floating window that has to become an ordinary one loads the app again rather than navigating there
// (FloatingSection.vue's close).

export type WindowRole = `main` | `floating` | `screen`;

const FLOATING_PREFIX = `${import.meta.env.BASE_URL}floating/`;

const pathname = globalThis.location?.pathname ?? ``;
const address = `/${pathname.slice(import.meta.env.BASE_URL.length)}`;

// The panel the address names: the floating window's own, or the old form's first segment after `floating/`.
const floatingPanel = (): string | undefined =>
    parseFloatingPath(address)?.panel ?? (pathname.startsWith(FLOATING_PREFIX) ? (pathname.slice(FLOATING_PREFIX.length).split(`/`)[0] ?? ``) : undefined);

// A computer's screen in a window of its own, under its sandbox's segment or (as it is opened) under none.
const SCREEN_WINDOW_PATH = new RegExp(`^/(?:${SANDBOX_SEGMENT}/[^/]+/)?floating/screen/?$`, `u`);

const screenWindow = SCREEN_WINDOW_PATH.test(address);
const panel = floatingPanel();

export const windowRole: WindowRole = screenWindow ? `screen` : panel === undefined ? `main` : `floating`;

/** `main`, `floating:chat` for a popped-out chat, `screen` for a computer's screen: what this window's diagnostic reports say it was. */
export const windowLabel: string = screenWindow ? `screen` : panel === undefined ? `main` : `floating:${panel}`;
