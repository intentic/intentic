import type { AgentProvider } from "@intentic/sandbox-contract";
// The preference subpath, not the barrel: see turnDefaults.ts's note on the same import.
import { definePreference } from "@intentic/ui/preference";
import { ref, type Ref } from "vue";
import { perProvider } from "./providerCatalog";

/* Which account of each provider the user last picked for a turn, per sandbox, what a new conversation's
 * account selection seeds from, and what a reloaded window comes back wearing. Without it the pick lived in
 * memory only, so every refresh resolved the selection to "the provider's first account" and silently undid a
 * choice the user had made deliberately (headroom left on one account, a different organization on another).
 *
 * SANDBOX-SCOPED, because an account id is not a global name: it is the key of a credential file in one
 * sandbox's own store (<workspace>/.intentic/<provider>/<id>.json), so carrying it to another sandbox would pin
 * a chat to an account that does not exist there. The tab snapshot is keyed this way for the same reason, and
 * the id stays IN the storage key so a replaced workspace's sweep still finds it (sandbox/systemEventRouting).
 *
 * A `definePreference` per sandbox, declared the first time that sandbox is scoped to, rather than a read into a
 * private ref. This is a PREFERENCE in that primitive's exact sense, one answer per account and not per window,
 * and the app runs a full copy per browser window (chat/summon.ts). Read once at load, it was a different COPY
 * per window: an account picked in the popped-out chat was invisible to the fleet board's window, so "New agent"
 * pressed on the board built the conversation on whatever account THAT window had loaded with and broadcast it
 * to everyone. The primitive tells the other windows (a BroadcastChannel plus the browser's own `storage`
 * event), so the last pick made anywhere is the one every window's next chat opens on, at once.
 *
 * What a window is CURRENTLY showing never comes from here; a conversation holds its own account, and this is
 * read only when one is seeded.
 *
 * A pick is remembered whether or not the account still exists, because only the daemon's account list can say,
 * so validating it belongs to the reader (rememberedAccountFor) and to the moment that list lands
 * (refreshAccounts), not here. */

export type AccountPicks = Record<AgentProvider, string | undefined>;

const blank = (): AccountPicks => perProvider<string | undefined>(() => undefined);

// The last pick per provider, parsed. Any provider is a candidate key, the vocabulary is open (native ids plus
// installed ACP agents), and a value is usable only as a non-empty id. Anything else is dropped to the blank
// slate's `undefined`, which every reader already handles as "no pick yet".
const readPicks = (raw: string | null): AccountPicks => {
    if (raw === null) {
        return blank();
    }
    let stored: unknown;
    try {
        stored = JSON.parse(raw);
    } catch {
        return blank();
    }
    const entries = typeof stored === `object` && stored !== null ? (stored as Record<string, unknown>) : {};
    const picks = Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === `string` && entry[1] !== ``);
    return { ...blank(), ...Object.fromEntries(picks) };
};

/* The picks of a sandbox this window has not scoped to yet, and the picks of NO sandbox. One ref rather than a
 * fresh blank each read, so an unbound window's selection still holds in memory for its own life, which is what
 * it did when the write was merely skipped. Reset when the scope moves, since one unbound sandbox's picks are
 * not an answer about the next. */
const unbound = ref<AccountPicks>(blank());

// One preference per sandbox, kept so a second scoping to the same sandbox re-uses the declaration rather than
// registering a second holder for its key (the primitive dispatches an incoming change by key, one holder each).
const held = new Map<string, Ref<AccountPicks>>();

const preferenceFor = (sandboxId: string): Ref<AccountPicks> => {
    const existing = held.get(sandboxId);
    if (existing !== undefined) {
        return existing;
    }
    const preference = definePreference<AccountPicks>({
        // Providers with no pick drop out (JSON.stringify omits undefined), which is exactly how readPicks
        // takes them back.
        key: `ui-chat-accounts-${sandboxId}`,
        read: readPicks,
        write: (picks) => JSON.stringify(picks),
    });
    held.set(sandboxId, preference);
    return preference;
};

// The picks ref the app reads and writes right now: the scoped sandbox's own preference, or the unbound slate.
// Rebound by scopeAccountPreference, which useChat calls with the tabs (the ids name credentials in THIS
// sandbox's store, so the incoming sandbox's picks replace the outgoing one's rather than being cleared).
const scoped = ref<string | undefined>();

export const scopeAccountPreference = (sandboxId: string | undefined): void => {
    if (sandboxId === undefined) {
        unbound.value = blank();
    }
    scoped.value = sandboxId;
};

export const accountPicks = (): Ref<AccountPicks> => (scoped.value === undefined ? unbound : preferenceFor(scoped.value));
