// Last line of defence against poisoned local state: a crash in the app's first moments is almost always a
// persisted blob whose shape an update outgrew. Known causes get a targeted guard elsewhere (buildEpoch's cache
// buster, systemEventRouting's hello identities); this catches the rest, whose alternative is a workspace stuck
// broken until someone finds "clear site data".
//
// A script or render error inside the startup window wipes this origin's storage and reloads once, marked in
// sessionStorage so a crash that survives the clean slate (a real bug) surfaces instead of looping. The wipe is
// split across the reload: storage clears synchronously here, but a database delete blocks on live connections, so
// this page only marks the intent and the next boot (purgeIfMarked, awaited in main.ts before any mirror opens)
// performs the deletes while it's the only party at the table.
//
// Unhandled rejections are deliberately not a trigger: the first seconds of a session legitimately reject promises
// (a sleeping daemon, a lost loopback probe), none of it storage's fault.

import { sleep } from "@intentic/base/async";
import { describeError, flushClientDiagnostics, reportClient } from "./clientDiagnostics";
import { noteReload } from "@intentic/ui/reload-reason";
import { storedValue, storeValue } from "@intentic/ui/storage";
import { TURN_DEFAULT_KEYS } from "./turnDefaultKeys";

// How long after boot an error still counts as a failed start rather than an ordinary bug; generous, since a false
// positive only costs one wipe and reload.
const STARTUP_WINDOW_MS = 15_000;

// sessionStorage: survives the recovery reload but dies with the tab, matching the scope of a "we already tried"
// claim.
const HEALED_MARKER = `intentic.selfHealed`;
// localStorage: the key that marks the reload that acts on it; besides it only the turn defaults (KEPT_KEYS) remain.
const WIPE_KEY = `intentic.wipeOnBoot`;

// Fallback list when `indexedDB.databases()` is unavailable: the vue-query mirror's default store, the transcript
// mirror, and the loading placeholders' imprints (lib/skeletonPersistence.ts), which a render reads at boot too.
const KNOWN_DATABASES = [`keyval-store`, `intentic.chat`, `intentic.skeletons`];

// What a new chat runs on outlives the wipe (turnDefaultKeys.ts says why): one heal on 2026-10-13 reset the model
// map, and the next four new chats all opened on an older Claude model without anyone choosing it.
const KEPT_KEYS: readonly string[] = Object.values(TURN_DEFAULT_KEYS);

const startedAt = performance.now();
let healing = false;

// The kept keys' values as they stand, to be written back once the storage is clear.
const keptValues = (): readonly (readonly [string, string])[] =>
    KEPT_KEYS.flatMap((key) => {
        const value = storedValue(key);
        return value === undefined ? [] : [[key, value] as const];
    });

const marked = (): boolean => {
    try {
        return sessionStorage.getItem(HEALED_MARKER) !== null;
    } catch {
        return true; // No storage means nothing persisted to heal: never wipe-reload.
    }
};

const heal = (error: unknown): void => {
    healing = true;
    console.error(`[self-heal] startup crashed, wiping this origin's stored state and reloading once:`, error);
    // Reported and flushed before the wipe, since the reload would otherwise destroy the only evidence of what
    // crashed. `keepalive` outlives the navigation; best-effort, since a failed report must cost a diagnostic, not the
    // recovery.
    const { message, fields } = describeError(error);
    reportClient(`self-heal.wipe`, message, { fields });
    flushClientDiagnostics();
    try {
        const kept = keptValues();
        localStorage.clear();
        sessionStorage.clear();
        for (const [key, value] of kept) {
            storeValue(key, value);
        }
        sessionStorage.setItem(HEALED_MARKER, `1`);
        localStorage.setItem(WIPE_KEY, `1`);
    } catch {
        // Storage unavailable means storage isn't what crashed us; fall through to the reload, which at worst repeats
        // and
        // surfaces the crash.
    }
    noteReload(`self-heal`);
    location.reload();
};

/** Routes an error that may mean this browser's stored state is poisoned; called by the handlers below and by Vue's errorHandler (main.ts). */
export const reportStartupError = (error: unknown): void => {
    if (healing || performance.now() - startedAt > STARTUP_WINDOW_MS) {
        return;
    }
    if (marked()) {
        // The clean slate did not fix it, a real bug, so let it surface instead of looping the wipe.
        console.error(`[self-heal] crashed again after a wipe, not storage, leaving the error to surface.`);
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
    // A healthy startup retires the marker, so a later crash in this tab may heal again; while the window stays open,
    // the marker enforces once-per-attempt.
    setTimeout(() => {
        try {
            sessionStorage.removeItem(HEALED_MARKER);
        } catch {
            // Unavailable, marked() already treats that as "never heal".
        }
    }, STARTUP_WINDOW_MS);
};

const deleteDatabase = (name: string): Promise<void> =>
    new Promise((resolve) => {
        try {
            const request = indexedDB.deleteDatabase(name);
            // `blocked` shouldn't happen on a boot that's opened nothing, but resolving on it anyway avoids stalling
            // forever;
            // purgeIfMarked's race is the second safety net.
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

/** The reload's half of the wipe; awaited at the top of main.ts before any mirror opens, so every delete runs against a database nothing holds open. */
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
    await Promise.race([deleteAllDatabases(), sleep(3000)]);
};
