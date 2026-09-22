import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ref } from "vue";
import { freshImport } from "@intentic/testing/bun";

// The composer's picks are one answer per account, not per browser window; this suite proves it by making the
// picks here and opening a second window's copy of the modules that hold them over the same storage. Shares a
// rule with rememberedAccountFor: a thin catalog read costs one substitution, never the pick itself.

// Declared outside the factory with a plain path-only signature: the daemon's generic `sandboxJson<T>` cannot
// take an implementation that returns one concrete shape.
const sandboxJsonMock = mock(async (_path: string): Promise<unknown> => ({}));
const sandboxRequestMock = mock(async (_path: string): Promise<Response> => new Response());
mock.module("../../sandbox/client/sandboxClient", () => ({
    sandboxRequest: (path: string) => sandboxRequestMock(path),
    sandboxJson: (path: string) => sandboxJsonMock(path),
    sandboxError: mock(async () => new Error(`failed`)),
    // Named by the graph but never called here; bun links an ESM import against exactly what this factory returns.
    sandboxRequestVia: mock(),
    SandboxHttpError: class SandboxHttpError extends Error {},
}));
mock.module("../../../app/analytics", () => ({ track: mock() }));
mock.module("../../sandbox/client/useSandbox", () => {
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const TWO = [
    { id: `first`, label: `Claude one`, connectedAt: 1 },
    { id: `second`, label: `Claude two`, connectedAt: 2 },
];

// Two Claude accounts, a Cursor one so a second-provider pick is actually runnable (an unrunnable
// pick would resolve elsewhere and hide whether it was remembered), and a Claude catalog.
const mockDaemon = (claudeModels = [`claude-fable-5`, `claude-opus-4-6`]): void => {
    sandboxJsonMock.mockImplementation((path: string) =>
        Promise.resolve(
            path === `/translator/accounts`
                ? { codex: [], grok: [], kimi: [], gemini: [] }
                : {
                      accounts: path.startsWith(`/accounts/claude`)
                          ? TWO
                          : path.startsWith(`/accounts/cursor`)
                            ? [{ id: `cur`, label: `Cursor`, connectedAt: 1 }]
                            : [],
                  },
        ),
    );
    sandboxRequestMock.mockImplementation((path: string) =>
        Promise.resolve(
            path === `/providers/claude/models`
                ? ({
                      ok: true,
                      status: 200,
                      json: () =>
                          Promise.resolve({
                              models: claudeModels.map((id) => ({ id, label: id })),
                              default: `claude-fable-5`,
                          }),
                  } as Response)
                : ({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response),
        ),
    );
};

mockDaemon();
const { useChat } = await import("../run/useChat");
const { loadAccountStatus } = await import("../accounts/useChat-accounts");
const { loadProviderModels } = await import("../models/useChat-catalog");

// A window that opens now: the two modules holding the picks, evaluated again over the same storage, which is
// what a second copy of the app reads at load. bun has no module-registry reset, so the whole graph cannot be
// forked; these two are where every persisted pick lives, and Conversation seeds from exactly them.
const openWindow = async () => {
    const turn = await freshImport<typeof import("../run/turnDefaults")>("../run/turnDefaults", import.meta.url);
    const accounts = await freshImport<typeof import("../accounts/accountPreference")>("../accounts/accountPreference", import.meta.url);
    accounts.scopeAccountPreference(`sb1`);
    return { turn, accounts };
};

describe(`the composer's remembered picks`, () => {
    beforeEach(async () => {
        local.clear();
        session.clear();
        mockDaemon();
        await loadAccountStatus();
    });

    it(`seeds a new chat from the pick made in ANOTHER window`, async () => {
        // The chat, popped out into a window of its own, where the user makes their picks.
        useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });
        useChat().effort.value = `high`;
        useChat().selectAccount(`second`);

        // The fleet board's window, opening on the same account: "New agent" there starts on those picks.
        const board = await openWindow();
        expect(board.turn.rememberedModelFor(`claude`)).toBe(`claude-opus-4-6`);
        expect(board.turn.turnDefaults.effort.value).toBe(`high`);
        expect(board.accounts.accountPicks().value[`claude`]).toBe(`second`);
    });

    // A pick is a pair, provider and model, and both halves travel; picking a second model on the same
    // provider must still record the provider.
    it(`carries the provider of the pick, not only its model`, async () => {
        useChat().selectModel({ provider: `cursor`, value: `composer-2.5` });
        // The second pick keeps the provider, the ordinary case.
        useChat().selectModel({ provider: `cursor`, value: `composer-2.5-fast` });

        const board = await openWindow();
        expect([board.turn.rememberedProviderFor(), board.turn.rememberedModelFor(`cursor`)]).toEqual([`cursor`, `composer-2.5-fast`]);
    });

    it(`keeps a pick a thin catalog read does not carry, and honours it when the catalog does`, async () => {
        useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });
        // A pick fires its own catalog read; it has to land before the thin one replaces it, or the reads collapse.
        await loadProviderModels(`claude`);

        // A thin catalog is what a provider serves while its own model discovery is still coming up.
        mockDaemon([`claude-fable-5`]);
        await loadProviderModels(`claude`);
        // The chat cannot send on a model this list doesn't offer, so it opens on the default.
        expect((await openWindow()).turn.rememberedModelFor(`claude`)).toBe(`claude-fable-5`);

        // The pick behind it is untouched, so the full catalog restores it.
        mockDaemon();
        await loadProviderModels(`claude`);
        expect((await openWindow()).turn.rememberedModelFor(`claude`)).toBe(`claude-opus-4-6`);
    });
});
