import { computed, ref, type ComputedRef } from "vue";
import { DESKTOP_UPDATE_EVENT, DESKTOP_UPDATE_LINK, desktopApp, openDesktopLink, type DesktopUpdateEvent } from "./environments/desktop";
import { buildId } from "./buildEpoch";

// One offer merges two causes, a stale tab (the deploy moved) and a stale desktop app (a build finished
// downloading), so they can't become two contradicting banners. The app is almost never reloaded (the desktop
// window hides on close instead of closing), so staying current depends on this file. It only ever offers:
// reloading mid-draft is worse than a stale build, and the one auto-install is on quit, inside the desktop app. A
// dismissal lasts only until the next build ships.

/** How often to ask what is deployed. Long: the answer only matters when the user next has a natural pause. */
const POLL_EVERY_MS = 15 * 60 * 1000;

// A tab back from the background is the most likely to be stale, but not worth rechecking on every alt-tab.
const RECHECK_ON_FOCUS_AFTER_MS = 2 * 60 * 1000;

export type AppUpdate =
    // A downloaded, verified build in the desktop app; taking it restarts the app (which also reloads this page), so
    // it supersedes `web` rather than stacking with it.
    | { readonly kind: "app"; readonly version: string }
    /* A newer web build is deployed. Taking it is a reload of this tab. */
    | { readonly kind: "web" };

const available = ref<AppUpdate | undefined>(undefined);
const dismissed = ref<string | undefined>(undefined);

/** What identifies "this offer", so a dismissal covers exactly it and not the next one. */
const offerKey = (update: AppUpdate): string => (update.kind === `app` ? `app:${update.version}` : `web`);

// One poller per document, however many components ask; module-level so two callers can't disagree about whether
// there's an update.
let started = false;
let lastPoll = 0;

// What's deployed, per `build.json` (emitted beside the bundle by vite.config.ts, served `no-store`). Every
// failure reads as silently "no information" — offline, mid-deploy, or predating the stamp must never show a
// banner.
const deployedBuild = async (): Promise<string | undefined> => {
    try {
        const response = await fetch(`/build.json`, { cache: `no-store`, credentials: `omit` });
        if (!response.ok) {
            return undefined;
        }
        const body = (await response.json()) as { buildId?: unknown };
        return typeof body.buildId === `string` && body.buildId !== `` ? body.buildId : undefined;
    } catch {
        return undefined;
    }
};

// Pure identity check, kept apart from the fetch: a dev build reports `dev` on both sides (never triggers), and
// "different" rather than "newer" catches a rollback too, a just-pulled version is exactly as stale as an old one.
export const isStaleBuild = (running: string, deployed: string | undefined): boolean =>
    deployed !== undefined && running !== `dev` && deployed !== `dev` && deployed !== running;

const poll = async (): Promise<void> => {
    lastPoll = Date.now();
    // The desktop update wins: taking it restarts the app, which reloads this page anyway, so `web` would be a second
    // offer for the same restart.
    if (available.value?.kind === `app`) {
        return;
    }
    if (isStaleBuild(buildId(), await deployedBuild())) {
        available.value = { kind: `web` };
    }
};

/** Start watching, once per document. Idempotent, so every mount can call it without coordinating. */
const watchForUpdates = (): void => {
    if (started) {
        return;
    }
    started = true;

    // The desktop app's answer, in both orderings: injected at load if the download finished first, dispatched as an
    // event if this page was already open.
    const alreadyDownloaded = desktopApp()?.update;
    if (alreadyDownloaded !== undefined && alreadyDownloaded !== null && alreadyDownloaded !== ``) {
        available.value = { kind: `app`, version: alreadyDownloaded };
    }
    window.addEventListener(DESKTOP_UPDATE_EVENT, (event) => {
        const version = (event as CustomEvent<DesktopUpdateEvent>).detail?.version;
        if (typeof version === `string` && version !== ``) {
            available.value = { kind: `app`, version };
        }
    });

    void poll();
    setInterval(() => void poll(), POLL_EVERY_MS);
    document.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `visible` && Date.now() - lastPoll > RECHECK_ON_FOCUS_AFTER_MS) {
            void poll();
        }
    });
};

export interface AppUpdateOffer {
    /** The offer to show, or undefined when there is nothing to say — including after it has been dismissed. */
    readonly offer: ComputedRef<AppUpdate | undefined>;
    /** Take it: a restart in the app, a reload in a browser. Neither returns. */
    readonly take: () => void;
    readonly dismiss: () => void;
}

// Derived, not stored, so a dismissal can't outlive its build: once `available` moves to a newer one, the key
// stops matching and the banner returns, which is what "not now" means.
const offer = computed<AppUpdate | undefined>(() => {
    const current = available.value;
    return current !== undefined && offerKey(current) !== dismissed.value ? current : undefined;
});

export const useAppUpdate = (): AppUpdateOffer => {
    watchForUpdates();
    return {
        offer,
        take: (): void => {
            const current = offer.value;
            if (current === undefined) {
                return;
            }
            if (current.kind === `app`) {
                // The app installs what it already holds and comes back on it; this page reloads with it.
                openDesktopLink(DESKTOP_UPDATE_LINK);
                return;
            }
            globalThis.location.reload();
        },
        dismiss: (): void => {
            if (available.value !== undefined) {
                dismissed.value = offerKey(available.value);
            }
        },
    };
};
