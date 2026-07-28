import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import { fileKimiStore, type KimiStore, newKimiAccount, renameKimiAccount, resolveKimiKey, type StoredKimiAccount } from "./kimi-credentials.js";

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

// A pasted key carries no identity, so renaming is the ONLY way two Kimi rows stop reading the same.
test("renameKimiAccount renames, and a blank name restores the default", () => {
    const account: StoredKimiAccount = { id: "a", label: "Kimi", apiKey: "sk-abc", connectedAt: 0 };
    expect(renameKimiAccount(account, " Work ").label).toBe("Work");
    expect(renameKimiAccount({ ...account, label: "Work" }, "").label).toBe("Kimi");
    expect(renameKimiAccount(account, "Work").apiKey).toBe("sk-abc");
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

// Same defect as the Claude store: the Kimi catalog writes models.json into the account dir, and an unparsed
// read turned it into a blank account row. `resolveKimiKey` reads `list()[0]` too, so a phantom sorting first
// would have resolved a key-less account.
test("fileKimiStore ignores non-account json in the store dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-store-"));
    const store = fileKimiStore(dir);
    await store.write({ id: "acct-1", label: "Personal", apiKey: "sk-a", connectedAt: 1 });
    await writeFile(join(dir, "models.json"), JSON.stringify([{ id: "kimi-k2", label: "K2" }]));
    expect(await store.list()).toEqual([{ id: "acct-1", label: "Personal", connectedAt: 1 }]);
});
