import { beforeEach, describe, expect, it, vi } from "vitest";

// The composer's picks are one answer per account, not per browser window; this suite proves it
// across two window copies of the app via `definePreference`. Shares a rule with
// rememberedAccountFor: a thin catalog read costs one substitution, never the pick itself.

vi.mock("../../sandbox/client/sandboxClient", () => ({
    sandboxRequest: vi.fn(),
    sandboxJson: vi.fn(),
    sandboxError: vi.fn(async () => new Error(`failed`)),
}));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

// One storage pair shared by every mocked window, plus the `storage` event `definePreference`
// listens for.
const windows: ((note: { key: string | null; raw: string | null }) => void)[] = [];

const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => {
                entries.set(key, value);
                if (name === `localStorage`) {
                    for (const receive of windows) {
                        receive({ key, raw: value });
                    }
                }
            },
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const { sandboxJson, sandboxRequest } = await import("../../sandbox/client/sandboxClient");
const sandboxJsonMock = vi.mocked(sandboxJson);
const sandboxRequestMock = vi.mocked(sandboxRequest);

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
                : { accounts: path.startsWith(`/accounts/claude`) ? TWO : path.startsWith(`/accounts/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 1 }] : [] },
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

// One browser window's copy of the app: a fresh module graph over the same storage, listening for
// changes others make to it.
const openWindow = async () => {
    vi.resetModules();
    const { receivePreferenceChange } = await import("@intentic/ui/preference");
    windows.push(receivePreferenceChange);
    const chat = await import("../run/useChat");
    const { loadAccountStatus } = await import("../accounts/useChat-accounts");
    const { Conversation } = await import("../session/conversation");
    await loadAccountStatus();
    return { chat, Conversation };
};

describe(`the composer's remembered picks`, () => {
    beforeEach(() => {
        local.clear();
        session.clear();
        windows.length = 0;
        mockDaemon();
    });

    it(`seeds a new chat from the pick made in ANOTHER window`, async () => {
        // The fleet board's window, open all along.
        const board = await openWindow();
        // The chat, popped out into a window of its own, where the user makes their picks.
        const floating = await openWindow();

        floating.chat.useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });
        floating.chat.useChat().effort.value = `high`;
        floating.chat.useChat().selectAccount(`second`);

        // "New agent" builds the conversation on the board and broadcasts it, so its copy of the picks wins
        // everywhere.
        const fresh = new board.Conversation();
        expect(fresh.model.value).toBe(`claude-opus-4-6`);
        expect(fresh.effortPick.value).toBe(`high`);
        expect(fresh.account.value).toBe(`second`);
    });

    // A pick is a pair, provider and model, and both halves travel; picking a second model on the same
    // provider must still record the provider.
    it(`carries the provider of the pick, not only its model`, async () => {
        const board = await openWindow();
        const floating = await openWindow();

        floating.chat.useChat().selectModel({ provider: `cursor`, value: `composer-2.5` });
        // The second pick keeps the provider, the ordinary case.
        floating.chat.useChat().selectModel({ provider: `cursor`, value: `composer-2.5-fast` });

        const fresh = new board.Conversation();
        expect([fresh.provider.value, fresh.model.value]).toEqual([`cursor`, `composer-2.5-fast`]);
    });

    it(`keeps a pick a thin catalog read does not carry, and honours it when the catalog does`, async () => {
        const window = await openWindow();
        window.chat.useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });

        // A thin catalog is what a provider serves while its own model discovery is still coming up.
        mockDaemon([`claude-fable-5`]);
        const thin = await openWindow();
        // The chat cannot send on a model this list doesn't offer, so it opens on the default.
        expect(new thin.Conversation().model.value).toBe(`claude-fable-5`);

        // The pick behind it is untouched, so the full catalog restores it.
        mockDaemon();
        const full = await openWindow();
        expect(new full.Conversation().model.value).toBe(`claude-opus-4-6`);
    });
});
