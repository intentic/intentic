// Why this page is about to load again, left for the load that follows. A reload the app starts itself (an update, a dead
// chunk, a storage wipe) is indistinguishable afterwards from the reader pressing F5 except by the navigation type, and
// analytics wants to tell a page that loaded because the app asked it to from one the reader did. The note rides in
// sessionStorage, which survives a reload of the same tab and nothing else, and carries the time it was written so a
// reload that never happened cannot label some later, unrelated load.

import { deviceKey, removeStoredValue, storedValue, storeValue } from "./browserStorage";

const REASONS = [`update`, `stale-chunk`, `self-heal`, `opener-fallback`, `sign-out`] as const;
export type ReloadReason = (typeof REASONS)[number];

// A device-scope key: the note is about this tab's next load, not about whoever is signed in.
const KEY = deviceKey(`intentic.reloadReason`);
// A reload follows its note within moments; one that has not by now is not coming.
const FRESH_MS = 60_000;

/** Leaves `reason` for the next load of this tab to find. A page without storage just loses the label. */
export const noteReload = (reason: ReloadReason): void => {
    storeValue(KEY, `${reason}|${Date.now()}`, `session`);
};

/** The reason the app left for this load, once: reading it clears it, so a later load by hand is not mislabelled. */
export const takeReloadReason = (): ReloadReason | undefined => {
    const note = storedValue(KEY, `session`);
    if (note === undefined) {
        return undefined;
    }
    removeStoredValue(KEY, `session`);
    const [reason, at] = note.split(`|`);
    return Date.now() - Number(at) < FRESH_MS ? REASONS.find((known) => known === reason) : undefined;
};
