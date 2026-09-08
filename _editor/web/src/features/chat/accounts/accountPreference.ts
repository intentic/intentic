import type { AgentProvider } from "@intentic/sandbox-contract";
import { definePreference } from "@intentic/ui/preference";
import { ref, type Ref } from "vue";
import { perProvider } from "./providerCatalog";

// Last-picked account per provider, per sandbox, seeding new conversations and surviving reloads.
// Sandbox-scoped: an account id is a credential key valid only in that sandbox's own store. Synced
// across every browser window via `definePreference`'s BroadcastChannel, since each window runs its
// own copy of the app.

export type AccountPicks = Record<AgentProvider, string | undefined>;

const blank = (): AccountPicks => perProvider<string | undefined>(() => undefined);

// Parses the last pick per provider; any non-empty string id is kept, anything else (or unparseable
// JSON) falls back to blank/undefined.
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

// Picks held before any sandbox is scoped; kept in one ref so they persist in memory until the scope
// changes.
const unbound = ref<AccountPicks>(blank());

// One preference per sandbox id, reused rather than redeclared, since each key needs exactly one holder.
const held = new Map<string, Ref<AccountPicks>>();

const preferenceFor = (sandboxId: string): Ref<AccountPicks> => {
    const existing = held.get(sandboxId);
    if (existing !== undefined) {
        return existing;
    }
    const preference = definePreference<AccountPicks>({
        // Providers with no pick drop out via JSON.stringify, and readPicks reads that back as undefined.
        key: `ui-chat-accounts-${sandboxId}`,
        read: readPicks,
        write: (picks) => JSON.stringify(picks),
    });
    held.set(sandboxId, preference);
    return preference;
};

// The sandbox id currently scoped; switching sandboxes swaps in its own picks rather than clearing them.
const scoped = ref<string | undefined>();

export const scopeAccountPreference = (sandboxId: string | undefined): void => {
    if (sandboxId === undefined) {
        unbound.value = blank();
    }
    scoped.value = sandboxId;
};

export const accountPicks = (): Ref<AccountPicks> => (scoped.value === undefined ? unbound : preferenceFor(scoped.value));
