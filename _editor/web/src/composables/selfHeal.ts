/* The last line of defence against poisoned local state: a crash in the app's first moments is, in practice,
 * almost always something this browser REMEMBERED — a persisted blob whose shape an update outgrew, written by
 * a build that no longer exists. Every known cause has a targeted guard (the query buster and mirror drop in
 * buildEpoch, the hello identities in systemEventRouting); this module is for the causes nobody has met yet,
 * whose user-visible alternative is a workspace that stays broken until its owner is told to find "clear site
 * data" in the browser's application tab.
 *
 * Mechanism: a script or render error inside the startup window wipes everything this origin stored and
 * reloads — ONCE, marked in sessionStorage, so a crash that survives a clean slate (a real bug, no storage
 * involved) surfaces on the second pass instead of looping. The wipe itself is split across the reload:
 * localStorage/sessionStorage clear synchronously here, but a database delete issued by a page with live
 * connections sits blocked until those connections die WITH the page — so this page only marks the intent, and
 * the next boot (purgeIfMarked, awaited in main.ts before anything opens a mirror) performs the deletes while
 * it is still the only party at the table.
 *
 * Unhandled REJECTIONS are deliberately not a trigger: the first seconds of a session legitimately reject
 * promises — a daemon asleep behind its tunnel, a lost loopback probe — and none of that is storage's fault. */

// How long after boot an error still reads as "the app failed to start" rather than "the app hit a bug".
// Generous on purpose: hydration paints from mirrors well within this, and a false positive costs one wipe of
// caches that refetch plus one reload — cheap next to a workspace stuck broken.
const STARTUP_WINDOW_MS = 15_000;

// sessionStorage: survives the recovery reload, dies with the tab — the scope a "we already tried" claim has.
const HEALED_MARKER = `intentic.selfHealed`;
// localStorage: the one key that must outlive the reload that acts on it (everything else was just cleared).
const WIPE_KEY = `intentic.wipeOnBoot`;

// What the next boot deletes when indexedDB.databases() is unavailable: idb-keyval's default store (the
// vue-query mirror) and the transcript mirror.
const KNOWN_DATABASES = [`keyval-store`, `intentic.chat`];

const startedAt = performance.now();
let healing = false;

const marked = (): boolean => {
    try {
        return sessionStorage.getItem(HEALED_MARKER) !== null;
    } catch {
        return true; // No storage means nothing persisted to heal — never wipe-reload.
    }
};

const heal = (error: unknown): void => {
    healing = true;
    console.error(`[self-heal] startup crashed — wiping this origin's stored state and reloading once:`, error);
    try {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem(HEALED_MARKER, `1`);
        localStorage.setItem(WIPE_KEY, `1`);
    } catch {
        // Storage unavailable — then storage cannot be what crashed us either; fall through to the reload,
        // which at worst repeats the crash and surfaces it (the marker branch is unreachable without storage).
    }
    location.reload();
};

/** Route an error that MAY mean "this browser's stored state is poisoned" — called by the global handlers
 *  below and by Vue's errorHandler (main.ts), whose render errors are where a bad hydrated blob first bites. */
export const reportStartupError = (error: unknown): void => {
    if (healing || performance.now() - startedAt > STARTUP_WINDOW_MS) {
        return;
    }
    if (marked()) {
        // The clean slate did not fix it — a real bug, so let it surface instead of looping the wipe.
        console.error(`[self-heal] crashed again after a wipe — not storage, leaving the error to surface.`);
        return;
    }
    heal(error);
};

export const installSelfHeal = (): void => {
    window.addEventListener(`error`, (event) => {
        // Only genuine script errors: resource-load and cross-origin events carry no Error and name no cause.
        if (event.error instanceof Error) {
            reportStartupError(event.error);
        }
    });
    // A healthy startup retires the marker, so a crash in some LATER session of this tab may heal again. While
    // the window is still open the marker stands, which is exactly the once-per-attempt guarantee.
    setTimeout(() => {
        try {
            sessionStorage.removeItem(HEALED_MARKER);
        } catch {
            // Unavailable — marked() already treats that as "never heal".
        }
    }, STARTUP_WINDOW_MS);
};

const deleteDatabase = (name: string): Promise<void> =>
    new Promise((resolve) => {
        try {
            const request = indexedDB.deleteDatabase(name);
            // `blocked` cannot happen on a boot that has opened nothing, but resolving on it keeps a surprise
            // from stalling the app forever; the race in purgeIfMarked is the second net under the same wire.
            request.onsuccess = () => resolve();
            request.addEventListener(`error`, () => resolve());
            request.onblocked = () => resolve();
        } catch {
            resolve();
        }
    });

const deleteAllDatabases = async (): Promise<void> => {
    const names = await indexedDB
        .databases()
        .then((databases) => databases.map((database) => database.name).filter((name): name is string => name !== undefined && name !== ``))
        .catch(() => KNOWN_DATABASES);
    await Promise.all(names.map(deleteDatabase));
};

/** The reload's half of the wipe — awaited at the very top of main.ts, before any module opens a mirror, so
 *  every delete runs against a database nothing holds open. A no-op (one storage read) on every normal boot. */
export const purgeIfMarked = async (): Promise<void> => {
    try {
        if (localStorage.getItem(WIPE_KEY) === null) {
            return;
        }
        localStorage.removeItem(WIPE_KEY);
    } catch {
        return;
    }
    // Bounded so a pathological delete can never brick the boot it exists to save.
    await Promise.race([deleteAllDatabases(), new Promise((resolve) => setTimeout(resolve, 3000))]);
};
