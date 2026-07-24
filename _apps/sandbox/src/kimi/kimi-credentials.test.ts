import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import { type KimiStore, newKimiAccount, resolveKimiKey, type StoredKimiAccount } from "./kimi-credentials.js";

// One in-memory account keyed by id, matching the file store's account-keyed surface.
const memoryStore = (initial?: StoredKimiAccount): KimiStore => {
    let account = initial;
    return {
        read: async (id) => (account?.id === id ? account : undefined),
        write: async (next) => {
            account = next;
        },
        clear: async (id) => {
            if (account?.id === id) {
                account = undefined;
            }
        },
        list: async () => (account !== undefined ? [{ id: account.id, label: account.label, connectedAt: account.connectedAt }] : []),
    };
};

const configWith = (moonshotApiKey: string): Config => ({ moonshotApiKey }) as unknown as Config;

test("newKimiAccount trims the key and falls back to a default label", () => {
    expect(newKimiAccount("  sk-abc  ", "").apiKey).toBe("sk-abc");
    expect(newKimiAccount("sk-abc", "").label).toBe("Kimi");
    expect(newKimiAccount("sk-abc", "  Work  ").label).toBe("Work");
});

test("resolveKimiKey prefers a stored account over the container env fallback", async () => {
    const store = memoryStore({ id: "a", label: "Kimi", apiKey: "sk-stored", connectedAt: 0 });
    expect(await resolveKimiKey(store, configWith("sk-env"))).toEqual({ apiKey: "sk-stored", accountId: "a" });
});

test("resolveKimiKey falls back to MOONSHOT_API_KEY when no account is stored", async () => {
    expect(await resolveKimiKey(memoryStore(), configWith("sk-env"))).toEqual({ apiKey: "sk-env" });
});

test("resolveKimiKey returns undefined when there is neither an account nor an env key", async () => {
    expect(await resolveKimiKey(memoryStore(), configWith(""))).toBeUndefined();
});
