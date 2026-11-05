import type { AccountPreferences, AccountPreferencesPatch, User } from "@intentic/api-contract";
import { adoptPreference, onPreferenceWrite, storedPreference } from "@intentic/ui/preference";
import { storedJson, storedValue, storeJson, storeValue } from "@intentic/ui/storage";
import { z } from "zod";
import { PREFERENCES_OFFERED_KEY, PREFERENCES_WORN_FOR_KEY } from "./storage/browserStorage";
import { ACCOUNT_PREFERENCE_KEYS } from "./accountPreferenceKeys";
import { ORPCError } from "@orpc/client";
import { effectScope, type Ref, watch } from "vue";
import { localFace, sandboxFace } from "./environments/local";
import { embedded } from "./environments/nativeApp";

// A PERSON'S LOOK AND READING PREFERENCES FOLLOW THEIR ACCOUNT onto every browser and device they sign in on. Each is
// still this device's own (`ui-*` in localStorage, @intentic/ui/preference); the platform keeps a copy with the account
// (`me.preferences`), and this window wears the copy wherever it differs: once the platform has said who is signed in,
// and again when the reader comes back to the window after a while. A choice made here goes to the account as it is
// made. A device meeting an account for the first time offers it what it holds and the account lacks, so the device
// a person used first sets the look the others take. Started once per window (main.ts).
//
// ONE BROWSER, SEVERAL ACCOUNTS: the device holds one copy of each preference, so it remembers whose choice each one is
// (`PREFERENCES_WORN_FOR_KEY`). An account coming in wears its own; a preference it never chose that the device holds as
// another account's goes back to the default rather than staying on screen, and is never offered to it: one account
// picking Polski must not turn the next one Polish, here or, through the offer, on every device it signs in on. A
// choice made signed out (the sign-in page's language) is nobody's, and the next account in takes it as before.
//
// Nothing happens without a platform account: signed out, in a desktop window on a folder, in the desktop app's own
// copy of the editor for when the internet is out, or on a sandbox opened while the platform was down (main.ts hands in
// no account then). Nothing waits on it either: a read or a patch that fails leaves this device's preferences as they
// are, and is said once in the console.

const SYNCED: ReadonlySet<string> = new Set(ACCOUNT_PREFERENCE_KEYS);

// Inside the Android app the look is the app's own, handed to this page and never stored over (nativeApp.ts): there the
// scheme and the skin are neither taken from the account nor given to it.
const APP_LOOK: ReadonlySet<string> = new Set([`ui-color-scheme`, `ui-skin`]);

const synced = (key: string): boolean => SYNCED.has(key) && !(APP_LOOK.has(key) && embedded());

// `system` is how both halves of the look say nobody chose one (skins/themeRow.ts), and a profile link left it in many a
// browser before 2026-11. Offered, it would undo a look the person did choose, on whichever device meets the account next.
const UNCHOSEN: ReadonlyMap<string, string> = new Map([
    [`ui-color-scheme`, `system`],
    [`ui-skin`, `system`],
]);

// Whether this device has offered the account what it holds (`offer`). The account's, so signing out forgets it.
const OFFERED_KEY = PREFERENCES_OFFERED_KEY;

// Whose choice each preference this device holds is, by key; a key it does not name is nobody's (chosen signed out, or
// from before this was kept). Unreadable reads as nobody's anywhere, which is how every browser began.
const WornForSchema = z.record(z.string(), z.string());
const wornFor = () => ({ ...storedJson(PREFERENCES_WORN_FOR_KEY, WornForSchema) });

// `key` as `id`'s choice now, or nobody's.
const claim = (key: string, id: string | undefined): void => {
    const { [key]: _was, ...rest } = wornFor();
    storeJson(PREFERENCES_WORN_FOR_KEY, id === undefined ? rest : { ...rest, [key]: id });
};

// Choices made together (the Theme row stores a skin and a scheme) leave as one patch.
const SETTLE_MS = 500;
// Coming back to the window reads the account again, at most this often: a change made on another device shows here
// without a reload, and a reader moving between windows costs one read in this long.
const REREAD_MS = 5 * 60_000;

/**
 * The platform's two calls this needs (`apiClient.me`). Handed in by main.ts: lib/useApi.ts imports app/, and importing
 * it back from here would close a loop between the two that _tools/checks/editor-boundaries.mjs holds at none.
 */
export interface AccountPreferencesPlatform {
    readonly preferences: () => Promise<AccountPreferences>;
    readonly setPreferences: (patch: AccountPreferencesPatch) => Promise<AccountPreferences>;
}

type Values = AccountPreferences[`values`];

interface Sync {
    readonly account: Readonly<Ref<Pick<User, `id`> | null>>;
    readonly platform: AccountPreferencesPlatform;
}

// allow(module-state): the window's one sync, once main.ts has started it
let sync: Sync | undefined;
// allow(module-state): choices made here the account has not taken yet, by key, each as the string it was stored as
const unsent = new Map<string, string | null>();
let settling: ReturnType<typeof setTimeout> | undefined;
// allow(module-state): one call at a time, so an answer read before a patch went out never lands after it
let line: Promise<void> = Promise.resolve();
let lastRead = Number.NEGATIVE_INFINITY;
let warned = false;
// allow(module-state): cleared by a platform from before account preferences, which is asked nothing more
let kept = true;

const signedIn = (): string | undefined => sync?.account.value?.id;

// The account's word wherever this device holds another, except over a choice made here that is still on its way up.
const wear = (values: Values): void => {
    for (const key of ACCOUNT_PREFERENCE_KEYS) {
        const raw = values[key];
        if (raw !== undefined && synced(key) && !unsent.has(key) && raw !== storedPreference(key)) {
            adoptPreference(key, raw);
        }
    }
};

// Another account's choices this device still holds where this one has none of its own: back to the default.
const shed = (id: string, values: Values): void => {
    const whose = wornFor();
    for (const key of ACCOUNT_PREFERENCE_KEYS) {
        const owner = whose[key];
        if (owner !== undefined && owner !== id && values[key] === undefined && synced(key) && !unsent.has(key) && storedPreference(key) !== null) {
            adoptPreference(key, null);
        }
    }
};

// Everything this device now holds of what follows the account is `id`'s: worn from it, offered to it, or kept as its own.
const settle = (id: string): void => {
    const whose = wornFor();
    for (const key of ACCOUNT_PREFERENCE_KEYS) {
        if (!synced(key)) {
            continue;
        }
        if (storedPreference(key) === null) {
            delete whose[key];
        } else {
            whose[key] = id;
        }
    }
    storeJson(PREFERENCES_WORN_FOR_KEY, whose);
};

// What this device holds and the account lacks.
const unoffered = (values: Values) => {
    const missing: Record<string, string> = {};
    for (const key of ACCOUNT_PREFERENCE_KEYS) {
        const raw = storedPreference(key);
        if (raw !== null && values[key] === undefined && synced(key) && UNCHOSEN.get(key) !== raw) {
            missing[key] = raw;
        }
    }
    return missing;
};

const inLine = (task: () => Promise<void>): Promise<void> => {
    line = line.then(task).catch((error) => {
        if (error instanceof ORPCError && error.status === 404) {
            kept = false;
        }
        if (!warned) {
            warned = true;
            console.warn(`[preferences] the account's copy could not be reached; this device keeps its own:`, error);
        }
    });
    return line;
};

// Every choice still unsent, as one patch; one that changed again on its way stays for the next.
const send = async (id: string): Promise<void> => {
    if (sync === undefined || unsent.size === 0 || !kept) {
        return;
    }
    const patch = Object.fromEntries(unsent);
    const { values } = await sync.platform.setPreferences({ values: patch });
    for (const [key, raw] of Object.entries(patch)) {
        if (unsent.get(key) === raw) {
            unsent.delete(key);
        }
    }
    if (signedIn() === id) {
        wear(values);
    }
};

// Only the first meeting offers: a preference the account has forgotten since (one set back to `null`, as `ui-motion`
// is on `system`) stays forgotten, rather than coming back from whichever device still holds it.
const offer = async (id: string, values: Values): Promise<void> => {
    if (sync === undefined || storedValue(OFFERED_KEY) !== undefined) {
        return;
    }
    const missing = unoffered(values);
    if (Object.keys(missing).length > 0) {
        const answer = await sync.platform.setPreferences({ values: missing });
        if (signedIn() !== id) {
            return;
        }
        wear(answer.values);
    }
    storeValue(OFFERED_KEY, `1`);
};

const read = (id: string): Promise<void> => {
    lastRead = Date.now();
    return inLine(async () => {
        await send(id);
        if (sync === undefined || !kept) {
            return;
        }
        const { values } = await sync.platform.preferences();
        if (signedIn() !== id) {
            return;
        }
        wear(values);
        shed(id, values);
        await offer(id, values);
        if (signedIn() === id) {
            settle(id);
        }
    });
};

// A choice made here: held for the account, and sent once whatever was chosen with it has settled.
const heard = (key: string, raw: string | null): void => {
    if (!synced(key)) {
        return;
    }
    const id = signedIn();
    claim(key, raw === null ? undefined : id);
    if (id === undefined || !kept) {
        return;
    }
    unsent.set(key, raw);
    clearTimeout(settling);
    settling = setTimeout(() => {
        settling = undefined;
        void inLine(() => send(id));
    }, SETTLE_MS);
};

const comeBack = (): void => {
    const id = signedIn();
    if (id !== undefined && kept && Date.now() - lastRead >= REREAD_MS) {
        void read(id);
    }
};

// A page is drawn for one account (lib/accounts/accountBoundary.ts), so a change here is a sign-in, or the account going.
const follow = (id: string | undefined): void => {
    if (id === undefined) {
        unsent.clear();
        clearTimeout(settling);
        return;
    }
    if (kept) {
        void read(id);
    }
};

export const startAccountPreferences = (account: Readonly<Ref<Pick<User, `id`> | null>>, platform: AccountPreferencesPlatform): void => {
    // A desktop window on a folder and the desktop app's offline copy have no platform behind them, whoever they show.
    if (sync !== undefined || localFace() !== undefined || sandboxFace()) {
        return;
    }
    sync = { account, platform };
    onPreferenceWrite(heard);
    globalThis.addEventListener?.(`focus`, comeBack);
    globalThis.document?.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `visible`) {
            comeBack();
        }
    });
    // Detached: the read lives as long as the window, not as long as whatever scope first started it.
    effectScope(true).run(() => watch(() => account.value?.id, follow, { immediate: true }));
};
