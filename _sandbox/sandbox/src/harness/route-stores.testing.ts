import type { Capability, Persona } from "@intentic/sandbox-contract";
import type { AutomationRecord, AutomationsStore } from "../automations/automations-store.js";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { DismissalsStore, DismissedRecommendation } from "../capabilities/dismissals-store.js";
import type { SecretVault } from "../capabilities/secret-vault.js";
import { type MintedStore, type StoredKeyAccount, toMintedAccount } from "../runtimes/minted/minted-credentials.js";
import type { PersonasStore } from "../personas/personas-store.js";
import type { ThreadSession, ThreadSessionsStore } from "../sessions/thread-sessions.js";

/* The route harness's in-memory stores: one real implementation per persistence seam the routes and the turn
 * read, so a suite can seed state and read back what a route wrote without touching the filesystem. `services`
 * (route-services.testing.ts) composes an empty one of each; a suite that seeds one passes its own. Not part of
 * the build (tsconfig excludes `*.testing.ts`), type-checked with the tests (tsconfig.test.json). */

// An in-memory capabilities store so the capability routes + turn merge are testable without the fs.
export const memoryCapabilitiesStore = (initial: Capability[] = []): CapabilitiesStore => {
    let capabilities = [...initial];
    return {
        list: async () => capabilities,
        get: async (id) => capabilities.find((capability) => capability.id === id),
        upsert: async (capability) => {
            capabilities = [...capabilities.filter((existing) => existing.id !== capability.id), capability];
        },
        remove: async (id) => {
            const next = capabilities.filter((capability) => capability.id !== id);
            const existed = next.length !== capabilities.length;
            capabilities = next;
            return existed;
        },
    };
};

/* An in-memory credential vault. In-memory rather than `unstubbed` for the reason the capability store above is:
 * it sits on a path every TURN takes, not just the routes that are about it. An extension setting declared
 * `secret` lives here now, `env` is how such a value reaches the agent's shell, and so composing a turn's
 * environment reads the vault, a fake that threw its own name there failed the agent suites on a seam none of
 * them are testing. */
export const memorySecretVault = (initial: Record<string, Record<string, string>> = {}): SecretVault => {
    const rows = new Map(Object.entries(initial));
    return {
        get: async (id) => rows.get(id) ?? {},
        all: async () => Object.fromEntries(rows),
        // An empty map drops the row, like the file vault: the store stays a list of what actually holds a secret.
        set: async (id, values) => {
            if (Object.keys(values).length === 0) {
                rows.delete(id);
            } else {
                rows.set(id, values);
            }
        },
        remove: async (id) => {
            rows.delete(id);
        },
        values: async () => [...rows.values()].flatMap((row) => Object.values(row)),
    };
};

// An in-memory personas store, the sandbox's named personas, without the fs.
export const memoryPersonasStore = (initial: Persona[] = []): PersonasStore => {
    let personas = [...initial];
    return {
        list: async () => personas,
        get: async (id) => personas.find((persona) => persona.id === id),
        upsert: async (persona) => {
            personas = [...personas.filter((existing) => existing.id !== persona.id), persona];
        },
        remove: async (id) => {
            const next = personas.filter((persona) => persona.id !== id);
            const existed = next.length !== personas.length;
            personas = next;
            return existed;
        },
    };
};

// An in-memory dismissals store, what the catalog's "not needed" writes to, without the fs.
export const memoryDismissalsStore = (initial: DismissedRecommendation[] = []): DismissalsStore => {
    let dismissed = [...initial];
    return {
        list: async () => dismissed,
        dismiss: async (entry) => {
            dismissed = [...dismissed.filter((existing) => existing.card !== entry.card), entry];
        },
    };
};

// An in-memory automations store so the fire route is testable without the fs.
export const memoryAutomationsStore = (initial: AutomationRecord[] = []): AutomationsStore => {
    let automations = [...initial];
    return {
        list: async () => automations,
        get: async (id) => automations.find((automation) => automation.id === id),
        upsert: async (automation) => {
            const runs = automations.find((existing) => existing.id === automation.id)?.runs ?? [];
            automations = [...automations.filter((existing) => existing.id !== automation.id), { ...automation, runs }];
        },
        setEnabled: async (id, enabled) => {
            const existing = automations.find((automation) => automation.id === id);
            if (existing === undefined) {
                return false;
            }
            existing.enabled = enabled;
            return true;
        },
        remove: async (id) => {
            const next = automations.filter((automation) => automation.id !== id);
            const existed = next.length !== automations.length;
            automations = next;
            return existed;
        },
        recordRun: async (id, run) => {
            const record = automations.find((automation) => automation.id === id);
            if (record !== undefined) {
                record.runs = [run, ...record.runs];
            }
        },
    };
};

// An in-memory thread-session store, so the routes that turn an inbound message into a CONVERSATION (the
// Front Desk, a listener gateway's dispatch) are testable without the fs. Honours the TTL, because "a quiet
// thread starts over" is behaviour and not bookkeeping.
export const memoryThreadSessionsStore = (): ThreadSessionsStore => {
    const sessions = new Map<string, ThreadSession>();
    const live = (key: string, ttlMs: number, now: number): ThreadSession | undefined => {
        const record = sessions.get(key);
        return record !== undefined && now - record.lastAt <= ttlMs ? record : undefined;
    };
    return {
        get: async (key, ttlMs, now) => live(key, ttlMs, now),
        open: async (key, mintConversationId, ttlMs, now) => {
            const existing = live(key, ttlMs, now);
            const record: ThreadSession = existing
                ? { ...existing, lastAt: now, messages: existing.messages + 1 }
                : { conversationId: mintConversationId(), startedAt: now, lastAt: now, messages: 1 };
            sessions.set(key, record);
            return record;
        },
        settle: async (key, sessionId, now) => {
            const existing = sessions.get(key);
            if (existing !== undefined) {
                sessions.set(key, { ...existing, lastAt: now, ...(sessionId !== undefined ? { sessionId } : {}) });
            }
        },
    };
};

/* One minted provider's store, in memory, starting empty. A REAL implementation of the seam rather than a stub
 * that throws, because the thing a suite most often wants from it is to record a connected plan and then ask
 * what a turn resolves — and a double that refuses the first half forces every such test to hand-build a store,
 * which is how doubles drift from the contract they stand in for.
 *
 * Empty is still the default state, which matters: no guard depends on these providers, so the honest starting
 * point is a sandbox where nobody has signed in.
 *
 * `variant` is required, exactly as it is on the real store: a test that connects an account has to say which
 * estate minted it, because that is what the turn dials.
 */
export const memoryMintedStore = (providerName: string): MintedStore => {
    let accounts: StoredKeyAccount[] = [];
    const row = (stored: StoredKeyAccount) => toMintedAccount(stored, providerName);
    return {
        list: async () => accounts.map(row),
        credentials: async () => accounts,
        connect: async ({ apiKey, variant, email }) => {
            const stored: StoredKeyAccount = {
                id: `${providerName}-${accounts.length + 1}`,
                apiKey,
                variant,
                connectedAt: accounts.length + 1,
                ...(email !== undefined && email.trim() !== "" ? { email: email.trim() } : {}),
            };
            accounts = [...accounts, stored];
            return row(stored);
        },
        rename: async (id, label) => {
            const stored = accounts.find((account) => account.id === id);
            if (stored === undefined) {
                return undefined;
            }
            const { label: _dropped, ...rest } = stored;
            const renamed = label.trim() === "" ? rest : { ...rest, label: label.trim() };
            accounts = accounts.map((account) => (account.id === id ? renamed : account));
            return row(renamed);
        },
        disconnect: async (id) => {
            accounts = accounts.filter((account) => account.id !== id);
        },
    };
};
