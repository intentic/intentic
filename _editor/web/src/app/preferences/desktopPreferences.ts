import { adoptPreference, choosePreference, onPreferenceChange, onPreferenceWrite, storedPreference } from "@intentic/ui/preference";
import { storedValue, storeValue } from "@intentic/ui/storage";
import { z } from "zod";
import { ACCOUNT_PREFERENCE_KEYS } from "../accountPreferenceKeys";
import { desktopVersion, openDesktopLink } from "../environments/desktop";
import { localFace, sandboxFace } from "../environments/local";

// THE ACCOUNT'S LOOK ON BOTH FACES OF THE DESKTOP APP (2026-11-11). The workspace and This computer are two pages of one
// window, each its own origin with a storage of its own, and only the workspace reaches the account
// (accountPreferences.ts). Until this, This computer kept whatever its own storage held: a rail a size larger and text a
// rung larger than the workspace beside it, so every switch between a sandbox and This computer resized the rail's logos.
// Now the workspace tells the app every preference that follows the account, whenever one changes (the account's copy
// included), and the app hands them to every page on this computer before it paints (desktop-app local.html) and to the
// ones already open as they change; a choice made on This computer (its zoom keys, its Settings) goes the other way, to
// the workspace, which takes it as its own so the account keeps it (windows/prefs.rs).
//
// Each handover carries the app's version of what it holds, which only grows (the app mints it from the clock). The
// pages of an origin remember the latest they took, so a page reloading, or one loaded a while ago, is never handed back
// as news what its origin has since moved past.

const CARRIED: ReadonlySet<string> = new Set(ACCOUNT_PREFERENCE_KEYS);

/** What the app hands a page: its version of the carried preferences, and the values, `null` for one nobody chose. */
const CarriedSchema = z.object({
    version: z.number().int().nonnegative(),
    values: z.record(z.string(), z.string().nullable()),
});
type Carried = z.infer<typeof CarriedSchema>;

declare global {
    interface Window {
        /** Set by the app before any script runs: on a local page, what the workspace holds; on the workspace, what was chosen on This computer while it was not up. */
        __INTENTIC_PREFS__?: unknown;
        /** What the app calls on a page already up with what changed elsewhere. */
        __INTENTIC_PREFS_IN__?: (carried: Parameters<typeof CarriedSchema.safeParse>[0]) => void;
    }
}

/** The version of the app's handover this page took last; read by desktop-app local.html before it paints, too. */
const PREFS_VERSION_KEY = `intentic.prefs-version`;

// Whatever the app handed, as the schema reads it; nothing for a shape this page does not know.
const read = (given: Parameters<typeof CarriedSchema.safeParse>[0]): Carried | undefined => {
    const parsed = CarriedSchema.safeParse(given);
    return parsed.success ? parsed.data : undefined;
};

const takenVersion = (): number => Number(storedValue(PREFS_VERSION_KEY)) || 0;

// Every value that differs from what this device stores, worn here by `wear`, and the version remembered.
const take = (carried: Carried, wear: (key: string, raw: string | null) => void): void => {
    for (const [key, raw] of Object.entries(carried.values)) {
        if (CARRIED.has(key) && storedPreference(key) !== raw) {
            wear(key, raw);
        }
    }
    storeValue(PREFS_VERSION_KEY, String(Math.max(carried.version, takenVersion())));
};

// What the app handed this page before it ran, when no page of this origin has taken it or a later one yet.
const handedOver = (): Carried | undefined => {
    const given = read(window.__INTENTIC_PREFS__);
    return given !== undefined && given.version > takenVersion() ? given : undefined;
};

// What the app is told: a JSON object of preference key to stored string (`null` for none).
const tellApp = (values: Readonly<Record<string, string | null>>): void => {
    openDesktopLink(`intentic://window?do=prefs&values=${encodeURIComponent(JSON.stringify(values))}`);
};

// The workspace's whole set, said once whatever changed with it has settled, and only when it differs from the last said.
let lastSaid: string | undefined;
let saying: ReturnType<typeof setTimeout> | undefined;
const SETTLE_MS = 50;
const sayAll = (): void => {
    clearTimeout(saying);
    saying = setTimeout(() => {
        saying = undefined;
        const values = Object.fromEntries(ACCOUNT_PREFERENCE_KEYS.map((key) => [key, storedPreference(key)]));
        const said = JSON.stringify(values);
        if (said !== lastSaid) {
            lastSaid = said;
            tellApp(values);
        }
    }, SETTLE_MS);
};

/**
 * Started once per page (main.ts), inside the desktop app only; the app's offline copy of the editor takes no part.
 * Returns the stop: the page no longer heard by the app nor speaking to it.
 */
export const startDesktopPreferences = (): (() => void) => {
    if (desktopVersion() === undefined || sandboxFace()) {
        return () => undefined;
    }
    const stop = (unsubscribe: () => void) => (): void => {
        unsubscribe();
        clearTimeout(saying);
        Reflect.deleteProperty(window, `__INTENTIC_PREFS_IN__`);
    };
    if (localFace() === undefined) {
        // THE WORKSPACE: the account's word. A choice made on This computer while this page was not up is taken as made
        // here, then the whole set is said, and again whenever any of it changes, from wherever.
        const given = handedOver();
        if (given !== undefined) {
            take(given, choosePreference);
        }
        window.__INTENTIC_PREFS_IN__ = (carried) => {
            const chosen = read(carried);
            if (chosen !== undefined) {
                take(chosen, choosePreference);
            }
        };
        const unsubscribe = onPreferenceChange((key) => {
            if (CARRIED.has(key)) {
                sayAll();
            }
        });
        sayAll();
        return stop(unsubscribe);
    }
    // THIS COMPUTER: the workspace's word, worn as it changes, and each choice made here said to the app for the workspace
    // to keep. local.html took the handover before it painted; a page without that step (a dev server's) takes it here.
    const given = handedOver();
    if (given !== undefined) {
        take(given, adoptPreference);
    }
    window.__INTENTIC_PREFS_IN__ = (carried) => {
        const worn = read(carried);
        if (worn !== undefined) {
            take(worn, adoptPreference);
        }
    };
    return stop(
        onPreferenceWrite((key, raw) => {
            if (CARRIED.has(key)) {
                tellApp({ [key]: raw });
            }
        }),
    );
};
