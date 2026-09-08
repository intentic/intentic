import type { Automation, Capability, Persona } from "@intentic/sandbox-contract";
import type { AutomationRecord, AutomationsStore } from "../automations/automations-store.js";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { DismissalsStore, DismissedRecommendation } from "../capabilities/dismissals-store.js";
import type { SecretVault } from "../capabilities/secret-vault.js";
import { type MintedStore, type StoredKeyAccount, toMintedAccount } from "../runtimes/minted/minted-credentials.js";
import type { PersonasStore } from "../personas/personas-store.js";
import type { ThreadSession, ThreadSessionsStore } from "../sessions/thread-sessions.js";

// In-memory stores, one real implementation per persistence seam the routes and the turn read, so a suite can seed
// state and read back what a route wrote without touching the filesystem. `services` composes an empty one of each.

// In-memory capabilities store so the capability routes and turn merge are testable without the fs.
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

// In-memory, not unstubbed, for the same reason as the capability store: it sits on every turn's path, not just the
// routes about it (a `secret` extension setting reaches the shell's env through here).
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

/* One automation as the store is handed it, every required field answered, so a case names only what it is about.
 * The record's shape is the contract's to grow: when `models` became required, the same literal was rewritten by
 * hand in eight suites, and the next required field would have been too. Here it lands once. */
export const automationConfig = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "schedule", cron: "* * * * *" },
    prompt: `wake:${id}`,
    models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    enabled: true,
    ...extra,
});

// The same automation as the store hands it BACK: with its run history, empty until something fires it.
export const automationRecord = (id: string, extra: Partial<AutomationRecord> = {}): AutomationRecord => ({
    ...automationConfig(id),
    runs: [],
    ...extra,
});

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

// In-memory thread-session store, so routes turning an inbound message into a conversation are testable without the fs.
// Honours the TTL: a quiet thread starting over is behaviour, not bookkeeping.
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

// Real implementation, not a throwing stub: a suite usually wants to connect an account and then see what a turn
// resolves. Starts empty (no guard depends on these providers); `variant` is required, as on the real store.
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
