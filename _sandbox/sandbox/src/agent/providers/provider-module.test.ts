import type { TranslatorAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { testConfig } from "../../testing.js";
import { authStateRelPath, type SharedProviderReads, translatorAccountEntries, translatorReady } from "./provider-module.js";

// Two answers every translator-backed provider gives the same way: its routed readiness and its secrets-inventory rows.

const GOOGLE: TranslatorAccount = { name: "antigravity-me.json", label: "me@example.com" };

const holding = (gemini: readonly TranslatorAccount[]): SharedProviderReads => ({
    translatorAccounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [...gemini] }) satisfies TranslatorAccounts,
});

const translatorAt = (url: string) => ({ config: { ...testConfig, translator: { url, token: "local" } } });

test("a translator-backed provider is ready only with a translator here and an account on it", async () => {
    const ready = translatorReady("gemini");

    expect(await ready(translatorAt(""), holding([GOOGLE]))).toBe(false);
    expect(await ready(translatorAt("http://127.0.0.1:8788"), holding([]))).toBe(false);
    expect(await ready(translatorAt("http://127.0.0.1:8788"), holding([GOOGLE]))).toBe(true);
});

test("a translator-backed provider's inventory rows are its auth files, keyed by file name", async () => {
    const entries = await translatorAccountEntries("gemini", "Gemini")(undefined, holding([GOOGLE]));

    expect(entries).toEqual([
        {
            key: "gemini:antigravity-me.json",
            kind: "provider",
            label: "Gemini · me@example.com",
            status: "connected",
            requiredBy: [],
            storedAt: authStateRelPath("cliproxy"),
            revealable: false,
        },
    ]);
});
