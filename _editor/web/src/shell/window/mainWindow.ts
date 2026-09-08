import { getCurrentScope, onScopeDispose, watch } from "vue";
import type { RouteLocationRaw, Router } from "vue-router";
import { floatingWindowPanel, floatsElsewhere } from "./floating";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { uuid } from "../../lib/uuid";

// A link pressed in a popped-out panel is handed as an errand (not a navigation) to whichever window with the app in it
// last had the reader's attention, never to itself; addressed (`to`), not broadcast, so exactly one acts. If none is
// open, one is opened and the errand waits for it to announce itself.

/**
 * What a popped-out window asks the main window to do: a `file` reference carries a line and checkout a URL can't; a
 * `route` is any other in-app destination.
 */
export type MainWindowErrand =
    | {
          readonly kind: `file`;
          readonly path: string;
          readonly line: number | undefined;
          readonly scope: { readonly agent: string | undefined } | undefined;
      }
    | { readonly kind: `route`; readonly path: string };

// Notes windows exchange; only `here` carries state. `roll` lets a newly loaded window learn who's out there without
// waiting for a heartbeat.
export type MainWindowNote =
    | { readonly kind: `here`; readonly id: string; readonly at: number }
    | { readonly kind: `gone`; readonly id: string }
    | { readonly kind: `roll` }
    | { readonly kind: `errand`; readonly to: string; readonly errand: MainWindowErrand };

const HEARTBEAT_MS = 750;
const STALE_MS = 2500;

// Long enough for a cold boot to finish, short enough to miss a window opened later by hand.
const DOORSTEP_MS = 30_000;

const channel = typeof window === `undefined` || window.BroadcastChannel === undefined ? undefined : new BroadcastChannel(`intentic.main-window`);

const post = (note: MainWindowNote): void => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel, not window: this postMessage takes no targetOrigin
    channel?.postMessage(note);
};

// Windows with the app open, as last heard; swept lazily on read rather than on a timer.
const sightings = new Map<string, { readonly at: number; readonly seenAt: number }>();

// Picks the window whose reader touched it most recently, ties broken by id.
const pick = (): string | undefined => {
    const now = Date.now();
    let best: string | undefined;
    let bestAt = Number.NEGATIVE_INFINITY;
    for (const [id, sighting] of sightings) {
        if (now - sighting.seenAt > STALE_MS) {
            sightings.delete(id);
        } else if (sighting.at > bestAt || (sighting.at === bestAt && best !== undefined && id < best)) {
            best = id;
            bestAt = sighting.at;
        }
    }
    return best;
};

// Held errand for a window that's still booting; one slot, so a second click replaces it.
let doorstep: { readonly errand: MainWindowErrand; readonly until: number } | undefined;

const deliver = (): void => {
    if (doorstep === undefined) {
        return;
    }
    if (Date.now() > doorstep.until) {
        doorstep = undefined;
        return;
    }
    const to = pick();
    if (to !== undefined) {
        post({ kind: `errand`, to, errand: doorstep.errand });
        doorstep = undefined;
    }
};

// This window's own note reader, installed by useMainWindow; a set avoids a stale one from a hot update.
const readers = new Set<(note: MainWindowNote) => void>();

/**
 * The single entry point for an incoming note, shared by the channel listener and tests (see floating.ts's own version
 * of this seam).
 */
export const receiveMainWindowNote = (note: MainWindowNote): void => {
    if (note.kind === `here`) {
        sightings.set(note.id, { at: note.at, seenAt: Date.now() });
        deliver();
    } else if (note.kind === `gone`) {
        sightings.delete(note.id);
    }
    for (const reader of readers) {
        reader(note);
    }
};

channel?.addEventListener(`message`, (event: MessageEvent<MainWindowNote>) => receiveMainWindowNote(event.data));

// Roll-call once per load: a floating window must know who's out there before the reader clicks anything.
post({ kind: `roll` });

/**
 * Hands an errand to the app's own window; returns false in an ordinary window, where there's nothing to hand off to
 * and the caller must act itself.
 */
export const handOffToMainWindow = (errand: MainWindowErrand): boolean => {
    if (floatingWindowPanel.value === undefined) {
        return false;
    }
    const to = pick();
    if (to !== undefined) {
        post({ kind: `errand`, to, errand });
        return true;
    }
    // Opened synchronously off the click, so the browser still treats it as user-initiated.
    const path = errand.kind === `route` ? errand.path.replace(/^\//u, ``) : `workspace`;
    const win = window.open(`${import.meta.env.BASE_URL}${path}`, `intentic-main`);
    win?.focus(); // null when the popup blocker refused; the errand simply expires on the doorstep.
    if (errand.kind === `file`) {
        doorstep = { errand, until: Date.now() + DOORSTEP_MS };
    }
    return true;
};

/**
 * Navigates from wherever the reader is: in an ordinary window this window goes, in a popped-out panel the app's own
 * window goes instead. Use this for any in-app navigation from a surface that could be in either.
 */
export const navigateInApp = (router: Router, to: RouteLocationRaw): void => {
    if (!handOffToMainWindow({ kind: `route`, path: router.resolve(to).fullPath })) {
        void router.push(to);
    }
};

// Delegated listener for every link inside a popped-out window, caught in the capture phase before the router
// (pages/FloatingArea.vue). A modified click (new tab/window) is left to the browser.
export const sendLinkToMainWindow = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(`a[href]`);
    if (link === null || link === undefined || link.hasAttribute(`download`) || (link.target !== `` && link.target !== `_self`)) {
        return;
    }
    // A file mention carries more than its href (line, checkout); its own handler already routes it.
    if (link.classList.contains(`md-file-link`)) {
        return;
    }
    const base = import.meta.env.BASE_URL;
    const url = new URL(link.href, window.location.href);
    // Not this app: another origin, a mailto:, or a path outside BASE_URL.
    if (url.origin !== window.location.origin || !url.pathname.startsWith(base)) {
        return;
    }
    const path = `/${url.pathname.slice(base.length)}${url.search}${url.hash}`;
    if (path.startsWith(`/floating/`)) {
        return;
    }
    if (handOffToMainWindow({ kind: `route`, path })) {
        event.preventDefault();
    }
};

/**
 * Marks this window as one of the app's own for as long as the shell is mounted (its only caller is
 * WorkspaceShell.vue); announcing elsewhere would hand an errand to a window with no workspace to show it in.
 */
export const useMainWindow = (show: (errand: MainWindowErrand) => void): void => {
    const id = uuid();
    // When the reader last had this window's attention; a fresh load counts, too.
    let at = Date.now();
    const touched = (): void => {
        at = Date.now();
    };
    const beat = (): void => post({ kind: `here`, id, at });

    // Announces only while some panel is floating, the only time anything could ask for it.
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = watch(
        floatsElsewhere,
        (floats) => {
            if (floats && timer === undefined) {
                beat();
                timer = setInterval(beat, HEARTBEAT_MS);
            } else if (!floats && timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
        // Sync flush: a window that just popped out must find this one on the very next tick.
        { immediate: true, flush: `sync` },
    );

    const heard = (note: MainWindowNote): void => {
        if (note.kind === `roll`) {
            beat();
        } else if (note.kind === `errand` && note.to === id) {
            // Raised as well as filled, so the file is shown in a window the reader can see.
            window.focus();
            show(note.errand);
        }
    };
    readers.add(heard);

    // Fast path only: a window that dies without this is written off a few seconds later by its own silence.
    const leaving = (): void => post({ kind: `gone`, id });
    window.addEventListener(`focus`, touched);
    window.addEventListener(`pagehide`, leaving);

    const release = (): void => {
        stop();
        if (timer !== undefined) {
            clearInterval(timer);
        }
        readers.delete(heard);
        window.removeEventListener(`focus`, touched);
        window.removeEventListener(`pagehide`, leaving);
        leaving();
    };
    if (getCurrentScope() !== undefined) {
        onScopeDispose(release);
    }
};

// One channel and reader set per window: a hot update must not leave the listener on a stale instance.
reloadOnHotUpdate(import.meta);
