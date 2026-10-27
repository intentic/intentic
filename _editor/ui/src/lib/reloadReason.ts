// Why this page is about to load again, left for the load that follows. A reload the app starts itself (an update, a dead
// chunk, a storage wipe) is indistinguishable afterwards from the reader pressing F5 except by the navigation type, and
// analytics wants to tell a page that loaded because the app asked it to from one the reader did. The note rides in
// sessionStorage, which survives a reload of the same tab and nothing else, and carries the time it was written so a
// reload that never happened cannot label some later, unrelated load.
//
// THE BUDGET. A reload nobody pressed for (a dead chunk, a self-heal, the desktop opener's fallback) is a repair, and a
// repair that did not work runs again on the next load. On 2026-10-27 one cached 404 reloaded /sandbox about once a second
// for as long as the tab stayed open: the stale-chunk path capped itself, but every other chunk that loaded reset its cap.
// Each path still caps itself; this is the ceiling over all of them. Past AUTOMATIC_BUDGET of them within
// AUTOMATIC_WINDOW_MS the tab stops reloading itself and the caller's own failure shows. A reload the reader pressed for
// (taking an update, signing in or out) is never refused and never counted: it cannot repeat without them.
//
// LEAVING. A page on its way out has its requests cut, and each cut request reads like the sandbox going away: in the week
// to 2026-10-27, 201 of 245 "sandbox unreachable" reports came from pages within 100 ms of leaving. `pageLeaving` is how a
// reader of failures tells the two apart.

import { deviceKey, removeStoredValue, storedValue, storeValue } from "./browserStorage";

const REASONS = [`update`, `stale-chunk`, `self-heal`, `opener-fallback`, `sign-out`, `sign-in`] as const;
export type ReloadReason = (typeof REASONS)[number];

// The ones that follow a press: the update offer's button, the sign-in dialog, Sign out.
const PRESSED: ReadonlySet<ReloadReason> = new Set<ReloadReason>([`update`, `sign-in`, `sign-out`]);

// Device-scope keys: notes about this tab's loads, not about whoever is signed in.
const KEY = deviceKey(`intentic.reloadReason`);
const AUTOMATIC_KEY = deviceKey(`intentic.automaticReloads`);
/** This tab's reload notes, which a wipe of its session storage must put back (selfHeal.ts), or the budget would restart with every heal. */
export const RELOAD_TAB_KEYS: readonly string[] = [KEY, AUTOMATIC_KEY];
// A reload follows its note within moments; one that has not by now is not coming.
const FRESH_MS = 60_000;
// Three repairs in a minute is already one more than any healthy page needs: a dead chunk and a self-heal on one deploy.
const AUTOMATIC_BUDGET = 3;
const AUTOMATIC_WINDOW_MS = 60_000;
// A page whose reload was approved and is still here after this did not leave (a navigation the desktop app took over).
const LEAVING_GRACE_MS = 10_000;

/** What a caller knows about why it reloads, such as the files a dead chunk's page was refused; reported as it is. */
export interface ReloadDetails {
    readonly [field: string]: string | number | boolean | undefined;
}

/** What the watcher hears of each reload nobody pressed for: one that goes ahead, or one the budget refused. */
export interface AutomaticReload {
    readonly reason: ReloadReason;
    /** False when the budget refused it: the page stays, and what the caller shows for its failure is what the reader sees. */
    readonly allowed: boolean;
    /** Reloads nobody pressed for this tab started within the last minute, this one included when it goes ahead. */
    readonly inLastMinute: number;
    readonly details: ReloadDetails;
}

// allow(module-state): the one listener, set at boot by the layer that can report (clientDiagnostics.ts)
let watcher: ((reload: AutomaticReload) => void) | undefined;
// allow(module-state): when this page's own reload was approved; the next page starts without it
let leavingSince: number | undefined;
// allow(module-state): the page was hidden on its way out, until it returns from the back-forward cache
let hidden = false;

/** Hands every reload nobody pressed for, allowed or refused, to `watch` (one watcher; a later call replaces it). */
export const watchAutomaticReloads = (watch: (reload: AutomaticReload) => void): void => {
    watcher = watch;
};

const tell = (reload: AutomaticReload): void => {
    try {
        watcher?.(reload);
    } catch {
        // allow(silent-catch): reporting a reload must never be what stops it, or what lets it through
    }
};

// When this tab's reloads nobody pressed for started, newest last, kept as comma-separated times.
const recentAutomatic = (now: number): number[] =>
    (storedValue(AUTOMATIC_KEY, `session`) ?? ``)
        .split(`,`)
        .map(Number)
        .filter((at) => Number.isFinite(at) && at > 0 && at <= now && now - at < AUTOMATIC_WINDOW_MS);

/**
 * Leaves `reason` for the next load of this tab to find, and answers whether the reload may go ahead: false only for one
 * nobody pressed for, when this tab already started its budget of them within the last minute, or cannot remember that it
 * did. A caller told false does not reload. One that is told true is expected to reload now.
 */
export const noteReload = (reason: ReloadReason, details: ReloadDetails = {}): boolean => {
    const now = Date.now();
    if (!PRESSED.has(reason)) {
        const recent = recentAutomatic(now);
        if (recent.length >= AUTOMATIC_BUDGET) {
            tell({ reason, allowed: false, inLastMinute: recent.length, details });
            return false;
        }
        const counted = [...recent, now].join(`,`);
        storeValue(AUTOMATIC_KEY, counted, `session`);
        // A tab that cannot remember its own reloads cannot bound them either, so it does not start one.
        if (storedValue(AUTOMATIC_KEY, `session`) !== counted) {
            tell({ reason, allowed: false, inLastMinute: recent.length, details: { ...details, storage: `unavailable` } });
            return false;
        }
        tell({ reason, allowed: true, inLastMinute: recent.length + 1, details });
    }
    storeValue(KEY, `${reason}|${now}`, `session`);
    leavingSince = now;
    return true;
};

/** The reason the app left for this load, once: reading it clears it, so a later load by hand is not mislabelled. */
export const takeReloadReason = (): ReloadReason | undefined => {
    const note = storedValue(KEY, `session`);
    if (note === undefined) {
        return undefined;
    }
    removeStoredValue(KEY, `session`);
    const [reason, at] = note.split(`|`);
    return Date.now() - Number(at) < FRESH_MS ? REASONS.find((known) => known === reason) : undefined;
};

/**
 * Whether this page is on its way out: its own reload was approved within the last few seconds, or it has been hidden for
 * good (`pagehide`). A failure seen now is most likely the page cutting its own requests, not the far end going away.
 */
export const pageLeaving = (): boolean => hidden || (leavingSince !== undefined && Date.now() - leavingSince < LEAVING_GRACE_MS);

/**
 * Follows the page's own leaving, once at boot. No `beforeunload`: the desktop app hands its links over as navigations it
 * then cancels (app/environments/desktop.ts), and each would read as a page leaving that stays.
 */
export const watchPageLeaving = (target: Window = window): void => {
    target.addEventListener(`pagehide`, () => {
        hidden = true;
    });
    target.addEventListener(`pageshow`, () => {
        hidden = false;
        leavingSince = undefined;
    });
};
