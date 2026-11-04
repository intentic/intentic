import { z } from "zod";

// THE PERSON'S OWN PREFERENCES, kept with their account: how the app looks (scheme, skin, wallpaper, accent, text size,
// motion, language) and how they like the technical screens to read. A preference is named as the editor stores it
// (`ui-color-scheme`) and holds the editor's own string for it; the platform checks only the shape and the size, and
// each preference's own reader in the editor validates the value, so a preference the editor adds needs no platform
// release. How a sandbox runs is the sandbox's (its settings `mode`), never one of these.
export const ACCOUNT_PREFERENCE_NAME = /^ui-[a-z0-9][a-z0-9-]{0,47}$/u;
export const ACCOUNT_PREFERENCES_MAX = 48;
const AccountPreferenceNameSchema = z.string().regex(ACCOUNT_PREFERENCE_NAME);
const AccountPreferenceValueSchema = z.string().max(512);
const fewEnough = (values: Readonly<Record<string, string | null>>): boolean => Object.keys(values).length <= ACCOUNT_PREFERENCES_MAX;
export const AccountPreferencesSchema = z.object({
    values: z
        .record(AccountPreferenceNameSchema, AccountPreferenceValueSchema)
        .refine(fewEnough, { message: `at most ${ACCOUNT_PREFERENCES_MAX} preferences` }),
});
export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;
// null removes a preference, so the account forgets it and each device falls back to its own.
export const AccountPreferencesPatchSchema = z.object({
    values: z
        .record(AccountPreferenceNameSchema, AccountPreferenceValueSchema.nullable())
        .refine(fewEnough, { message: `at most ${ACCOUNT_PREFERENCES_MAX} preferences` }),
});
export type AccountPreferencesPatch = z.infer<typeof AccountPreferencesPatchSchema>;
