import { computed, ref, type ComputedRef } from "vue";
import { DESKTOP_UPDATE_EVENT, DESKTOP_UPDATE_LINK, desktopApp, openDesktopLink, type DesktopUpdateEvent } from "../environments/desktop";
import { buildId } from "./buildEpoch";

/* "YOU ARE NOT RUNNING THE CURRENT VERSION" — one question, asked of two different things, answered by one
 * banner.
 *
 * A tab is stale when the deploy moved under it. The desktop app is stale when a newer build has been released
 * and downloaded. They sound like separate problems and they are the same sentence to the person reading it —
 * *there is a newer Intentic, take it* — which is why they are one model with two `kind`s rather than two
 * notices that would eventually contradict each other.
 *
 * WHY THE WEB HALF MATTERS AT ALL, given that reloading a page is the most ordinary thing on the internet:
 * this app is not reloaded. It is a workspace people leave open across days, and inside the desktop app it is
 * literally never reloaded — that window is HIDDEN on close rather than destroyed, on purpose, so it keeps the
 * session it signed in with (desktop-app/src-tauri/src/windows.rs). Half of what a desktop user looks at is
 * this hosted SPA, so "always on the newest version" is only half true without this.
 *
 * IT OFFERS, IT NEVER ACTS. Nothing here reloads a page or restarts an app on its own. A reload in the middle
 * of a half-written message is a worse outcome than a stale build, and there is no version of "we saved your
 * draft first" that is worth trusting on somebody else's behalf. The one exception is not here at all: the
 * desktop app installs on QUIT, where there is nothing to interrupt.
 *
 * DISMISSAL LASTS THE SESSION AND NO LONGER. Somebody who says "not now" means not now, not "never tell me
 * again" — and the next build that ships re-asks, because the thing they dismissed is no longer the thing on
 * offer. */

/** How often to ask what is deployed. Long: the answer only matters when the user next has a natural pause. */
const POLL_EVERY_MS = 15 * 60 * 1000;

/* A tab that has been in the background for hours is the one most likely to be stale, and the one whose timers
 * a browser has been throttling. Coming back to it is worth a fresh ask — but not on every alt-tab, which on a
 * two-monitor setup is a request every few seconds. */
const RECHECK_ON_FOCUS_AFTER_MS = 2 * 60 * 1000;

export type AppUpdate =
    /* The desktop app holds a newer build, already downloaded, already verified. Taking it is a restart, and
     * the restart also reloads this page — so this one supersedes `web` rather than stacking with it. */
    | { readonly kind: "app"; readonly version: string }
    /* A newer web build is deployed. Taking it is a reload of this tab. */
    | { readonly kind: "web" };

const available = ref<AppUpdate | undefined>(undefined);
const dismissed = ref<string | undefined>(undefined);

/** What identifies "this offer", so a dismissal covers exactly it and not the next one. */
const offerKey = (update: AppUpdate): string => (update.kind === `app` ? `app:${update.version}` : `web`);

/* ONE POLLER PER DOCUMENT, however many components ask. The state above is module-level for the same reason
 * the offer is: two banners disagreeing about whether there is an update would be worse than no banner. */
let started = false;
let lastPoll = 0;

/* WHAT IS DEPLOYED, according to the origin serving this app. `build.json` is emitted beside the bundle
 * (vite.config.ts) and served `no-store`, so this is always a real answer rather than the one this tab already
 * had.
 *
 * Every failure is silently "no information": a poll that runs while the network is down, while a deploy is
 * mid-swap, or against a build predating the stamp must never put a banner on screen. The only thing that
 * counts is a well-formed id that differs from ours. */
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

/* WHETHER A DEPLOYED ID MEANS THIS TAB IS BEHIND. Pure, and separate from the fetch, because the two ways to
 * get this wrong are both about identity rather than about the network:
 *
 *   • a dev build reports `dev` for every session, so it would compare unequal to a real stamp forever;
 *   • an id that matches is the common case and must never draw anything.
 *
 * "Different" rather than "newer" is deliberate. A rollback is a deploy too, and a tab running the version
 * that was just pulled is exactly as wrong as one running a version that is too old. */
export const isStaleBuild = (running: string, deployed: string | undefined): boolean =>
    deployed !== undefined && running !== `dev` && deployed !== `dev` && deployed !== running;

const poll = async (): Promise<void> => {
    lastPoll = Date.now();
    // The desktop app's own update wins: taking it restarts the app, which reloads this page onto whatever is
    // deployed anyway. Two offers for one restart is one offer too many.
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

    // The desktop app's answer, in both orderings: injected at load for a page that opened after the download
    // finished, and dispatched into the page for one that was already open when it did.
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

/* The offer, minus anything the user has already waved away. Derived rather than stored, so a dismissal of
 * THIS build cannot outlive it: the moment `available` moves on to a newer one the key stops matching and the
 * banner returns, which is the behaviour somebody who pressed "Not now" actually asked for. */
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
