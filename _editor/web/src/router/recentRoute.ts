// A cold start of the installed app at its bare start URL returns to the page it was last on, when that was recent: a
// phone kills a backgrounded app within minutes, and "/" would otherwise land on the board every time. A link, a
// notification tap or a shortcut names its own destination and keeps it; a browser tab at "/" is a typed address.
import { z } from "zod";
import { storedValue, storeValue } from "../lib/browserStorage";

const LAST_ROUTE_KEY = `intentic.lastRoute`;
const RECENT_VISIT_MS = 30 * 60_000;
const SavedRoute = z.object({ path: z.string(), at: z.number() });

export const recentRoute = (stored: string | null, now: number): string | undefined => {
    try {
        const saved = SavedRoute.safeParse(JSON.parse(stored ?? `null`));
        return saved.success && saved.data.path.startsWith(`/`) && !saved.data.path.startsWith(`//`) && saved.data.path !== `/` &&
            now >= saved.data.at && now - saved.data.at < RECENT_VISIT_MS
            ? saved.data.path
            : undefined;
    // allow(silent-catch): Corrupt browser storage should leave the app at its normal root route.
    } catch {
        return undefined;
    }
};

// Launched from the home screen (the installed web app, the Android app; `navigator.standalone` is iOS's own flag for it)
// rather than opened in a browser tab.
export const installedApp = (): boolean =>
    globalThis.matchMedia?.(`(display-mode: standalone)`).matches === true || (`standalone` in navigator && navigator.standalone === true);

export const rememberRoute = (path: string, now: number): void => storeValue(LAST_ROUTE_KEY, JSON.stringify({ path, at: now }));

export const lastRoute = (now: number): string | undefined => recentRoute(storedValue(LAST_ROUTE_KEY) ?? null, now);

// Whether a navigation is the app's first, aimed at its bare start URL. "/" redirects to a home page before any guard
// runs, so a guard sees where it went, and the address it was opened at is `redirectedFrom`.
export const coldStartAtRoot = (to: { readonly fullPath: string; readonly redirectedFrom?: { readonly fullPath: string } | undefined }, first: boolean): boolean =>
    first && (to.redirectedFrom ?? to).fullPath === `/`;
