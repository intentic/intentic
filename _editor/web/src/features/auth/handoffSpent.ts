import type { LocationQuery } from "vue-router";
import { z } from "zod";

// A finished desktop sign-in hand-off, remembered in this browser by the app's nonce (`state`), so a tab restored hours
// later (a browser reopening with its tabs) says it is done instead of signing in again for an app that stopped
// waiting long ago: a restored tab restarted a hand-off finished five hours earlier.

// The route the hand-off runs on, in the reader's own browser. A tab that exists to be closed, so the workspace's
// runtime (its event stream, its queries, its chat) is not mounted there (App.vue).
export const HANDOFF_ROUTE = `desktop-auth`;

const KEY = `intentic.desktopAuth.spent`;
// As long as a browser plausibly restores a tab; the nonce is never reused, so this only bounds the list.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_COUNT = 20;

// Nonce to when its hand-off finished; anything else in the slot (an older shape, a hand edit) reads as nothing spent.
const SpentSchema = z.record(z.string(), z.number());

const read = (): Record<string, number> => {
    try {
        return SpentSchema.safeParse(JSON.parse(localStorage.getItem(KEY) ?? `{}`)).data ?? {};
        // allow(silent-catch): Unavailable or malformed local storage is an empty replay cache, not a failed sign-in.
    } catch {
        return {};
    }
};

// Whether this browser already handed the sign-in for this nonce to the app.
export const handoffSpent = (state: string, now: number = Date.now()): boolean => {
    const at = read()[state];
    return at !== undefined && now - at < KEEP_MS;
};

// Records the hand-off as done, keeping only the recent ones.
export const markHandoffSpent = (state: string, now: number = Date.now()): void => {
    const kept = Object.entries(read())
        .filter(([seen, at]) => seen !== state && now - at < KEEP_MS)
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, KEEP_COUNT - 1);
    try {
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([[state, now], ...kept])));
        // allow(silent-catch): Refused local storage disables only the cross-reload replay cache.
    } catch {
        // Storage refused (a private window's quota): the tab then restarts as before, which is no worse than today.
    }
};

// Whether arriving on the hand-off route starts Google's sign-in at once (the router's head start, before the page's own
// chunk): only for the app's own hand-off, carrying its nonce and challenge, and never for one this browser already
// finished, whose restored tab only says it is done and must not begin a sign-in it will never use.
const HandoffQuerySchema = z.object({ state: z.string(), challenge: z.string() });
export const mintsOnArrival = (query: LocationQuery, now: number = Date.now()): boolean => {
    const handoff = HandoffQuerySchema.safeParse(query);
    return handoff.success && !handoffSpent(handoff.data.state, now);
};
