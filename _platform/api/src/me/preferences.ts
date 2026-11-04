import { ACCOUNT_PREFERENCES_MAX, type AccountPreferences, type AccountPreferencesPatch, AccountPreferencesSchema } from "@intentic/api-contract";
import type { Prisma } from "@intentic/prisma";
import { z } from "zod";

// THE PERSON'S OWN PREFERENCES as the account keeps them (User.preferences): the editor's preference names to the
// strings it stores, read and patched here and nowhere else. The platform never interprets a value; the contract says
// which names and sizes it takes, and each preference's own reader in the editor says what a value means.

type Preferences = AccountPreferences["values"];

// What a stored value is before each entry is judged: an object of anything. Anything else (an array, a string, a
// column nobody wrote) holds no preferences.
const StoredSchema = z.record(z.string(), z.unknown()).catch({});

/**
 * What the account holds, as the contract reads it. Each entry is judged on its own, so one that no longer reads (a
 * release with other limits, a hand edit) is dropped rather than costing the rest, and past the cap the earliest kept
 * win: a read never fails on what is stored.
 */
export const storedPreferences = (stored: Prisma.JsonValue | null | undefined): Preferences => {
    const kept = new Map<string, string>();
    for (const [name, value] of Object.entries(StoredSchema.parse(stored ?? {}))) {
        const entry = AccountPreferencesSchema.safeParse({ values: { [name]: value } });
        if (entry.success && kept.size < ACCOUNT_PREFERENCES_MAX) {
            // The one entry it was handed, now as the contract reads it.
            for (const [read, text] of Object.entries(entry.data.values)) {
                kept.set(read, text);
            }
        }
    }
    return Object.fromEntries(kept);
};

/** A patch over what is held: a string sets its preference, null removes it, and every one it does not name stands. */
export const patchedPreferences = (held: Readonly<Preferences>, patch: AccountPreferencesPatch["values"]): Preferences => {
    const next = new Map(Object.entries(held));
    for (const [name, value] of Object.entries(patch)) {
        if (value === null) {
            next.delete(name);
        } else {
            next.set(name, value);
        }
    }
    return Object.fromEntries(next);
};
