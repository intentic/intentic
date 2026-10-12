import { type Ref, watch } from "vue";

// A page that slept: hidden for a long while, restored from the back-forward cache, or left on screen by a machine that
// slept. That last one says nothing through visibility (its timers just stop), so a beat that runs long after it was
// due is that sleep, told by the clock. Hidden beats are not read: a browser throttles a hidden page's timers to a
// minute or more, which is not a sleep.
//
// One beat for every watcher in the window, however many there are (a chat pane each, the sandbox connection): each
// reads the same beat against its own gap and its own idea of whether the page is on screen.

// Long enough that a busy main thread never reads as a sleep; short enough that a laptop lid closed over lunch does.
export const WAKE_GAP_MS = 60_000;
// How often the shared beat runs; a sleep is told no sooner than one beat after the machine wakes.
export const BEAT_MS = 15_000;

/** Whether the page is on screen, and word when that changes. */
export interface PageVisibility {
    readonly shown: () => boolean;
    /** Calls `changed` on every change; returns the way to stop. */
    readonly follow: (changed: (shown: boolean) => void) => () => void;
}

/** The document's own word. A window hidden in the Windows tray still says visible here; workbench/window/onScreen.ts
 * knows better, and a caller above this layer passes it through `refVisibility`. */
export const documentVisibility: PageVisibility = {
    shown: () => document.visibilityState !== `hidden`,
    follow: (changed) => {
        const listener = (): void => changed(document.visibilityState !== `hidden`);
        document.addEventListener(`visibilitychange`, listener);
        return () => document.removeEventListener(`visibilitychange`, listener);
    },
};

/** A visibility ref (onScreen) as a source. */
export const refVisibility = (shown: Readonly<Ref<boolean>>): PageVisibility => ({
    shown: () => shown.value,
    follow: (changed) => watch(shown, changed, { flush: `sync` }),
});

export interface PageWakeOptions {
    /** How long away counts as a sleep. */
    readonly gapMs?: number;
    readonly visibility?: PageVisibility;
    /** The page coming back into view after less than a sleep. */
    readonly returned?: () => void;
}

interface Watcher {
    // When this watcher last knew the page was awake: a hide, a return or a restore starts it over, so one sleep is
    // never counted twice.
    since: number;
    readonly beat: (now: number, beatAt: number) => void;
}

// The one beat this window runs for every watcher.
const watchers = new Set<Watcher>();
let beat: ReturnType<typeof setInterval> | undefined;
let beatAt = 0;

const tick = (): void => {
    const now = Date.now();
    const last = beatAt;
    beatAt = now;
    for (const watcher of watchers) {
        watcher.beat(now, last);
    }
};

const join = (watcher: Watcher): (() => void) => {
    watchers.add(watcher);
    if (beat === undefined) {
        beatAt = Date.now();
        beat = setInterval(tick, BEAT_MS);
    }
    return () => {
        watchers.delete(watcher);
        if (watchers.size === 0 && beat !== undefined) {
            clearInterval(beat);
            beat = undefined;
        }
    };
};

/** Calls `woke` when the page comes back from a sleep; returns the way to stop. */
export const watchPageWake = (woke: () => void, { gapMs = WAKE_GAP_MS, visibility = documentVisibility, returned }: PageWakeOptions = {}): (() => void) => {
    let hiddenAt: number | undefined = visibility.shown() ? undefined : Date.now();
    const watcher: Watcher = {
        since: Date.now(),
        beat: (now, last) => {
            // How long past due this beat ran, counted from whichever came later: the last beat, or this watcher's own
            // fresh start.
            const late = now - Math.max(last, watcher.since) - BEAT_MS;
            watcher.since = now;
            if (late >= gapMs && hiddenAt === undefined && visibility.shown()) {
                woke();
            }
        },
    };
    const stopFollowing = visibility.follow((shown) => {
        const now = Date.now();
        watcher.since = now;
        if (!shown) {
            hiddenAt = now;
            return;
        }
        const away = hiddenAt === undefined ? 0 : now - hiddenAt;
        hiddenAt = undefined;
        if (away >= gapMs) {
            woke();
        } else {
            returned?.();
        }
    });
    // A page the back-forward cache froze may say nothing through visibility: its streams are gone however long it was
    // away, so the restore is a wake.
    const restored = (event: PageTransitionEvent): void => {
        if (event.persisted) {
            watcher.since = Date.now();
            woke();
        }
    };
    window.addEventListener(`pageshow`, restored);
    const leave = join(watcher);
    return () => {
        leave();
        stopFollowing();
        window.removeEventListener(`pageshow`, restored);
    };
};
