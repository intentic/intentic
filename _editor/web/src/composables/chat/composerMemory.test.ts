import { beforeEach, describe, expect, it, vi } from "vitest";

/* THE COMPOSER'S PICKS ARE ONE ANSWER PER ACCOUNT, NOT PER WINDOW, and this suite is the two-window proof.
 *
 * The app runs a full copy per browser window (chat/summon.ts), and the chat panel routinely sits in one of its
 * own (composables/floating.ts) while the fleet board sits in another. Read once at load into a private ref, the
 * remembered model/effort/account were a different COPY per window: a pick made in the popped-out chat was
 * invisible to the board's window, so "New agent" pressed on the board built the conversation from whatever that
 * window had loaded with and broadcast it to everyone. Both stores are `definePreference`s now, so the pick
 * travels.
 *
 * The other half is the rule those preferences share with rememberedAccountFor: a catalog read is not a verdict
 * on the user's choice. A provider whose models answer thinly must cost one substitution, not the pick. */

vi.mock("../sandbox/sandboxClient", () => ({
    sandboxRequest: vi.fn(),
    sandboxJson: vi.fn(),
    sandboxError: vi.fn(async () => new Error(`failed`)),
}));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

/* ONE STORAGE PAIR SHARED BY EVERY "WINDOW", which is what makes this two windows rather than two runs, plus the
 * browser's own cross-window notification over it. A `storage` event fires in every other same-origin window the
 * moment localStorage changes, and `definePreference` listens for it; delivering to the writer as well is the
 * superset the primitive already tolerates (adopting a value a window holds changes nothing there). */
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

const { sandboxJson, sandboxRequest } = await import("../sandbox/sandboxClient");
const sandboxJsonMock = vi.mocked(sandboxJson);
const sandboxRequestMock = vi.mocked(sandboxRequest);

const TWO = [
    { id: `first`, label: `Claude one`, connectedAt: 1 },
    { id: `second`, label: `Claude two`, connectedAt: 2 },
];

// The daemon this suite talks to: two Claude accounts, a Cursor one (so a pick on a SECOND provider is one the
// sandbox could actually run — an unrunnable pick resolves to a connected provider at read, by design, which
// would hide whether the pick was remembered at all), and a Claude catalog carrying the model the user picks.
const mockDaemon = (claudeModels = [`claude-fable-5`, `claude-opus-4-6`]): void => {
    sandboxJsonMock.mockImplementation((path: string) =>
        Promise.resolve(
            path === `/translator/accounts`
                ? { codex: [], grok: [], kimi: [], gemini: [] }
                : { accounts: path.startsWith(`/claude`) ? TWO : path.startsWith(`/cursor`) ? [{ id: `cur`, label: `Cursor`, connectedAt: 1 }] : [] },
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

// One browser window's copy of the app: a fresh module graph over the SAME storage, listening for the changes
// the others make to it.
const openWindow = async () => {
    vi.resetModules();
    const { receivePreferenceChange } = await import("@intentic/ui/preference");
    windows.push(receivePreferenceChange);
    const chat = await import("./useChat");
    const { Conversation } = await import("./conversation");
    await chat.loadAccountStatus();
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

        // "New agent", pressed on the board: the conversation is built THERE and broadcast, so the board's copy
        // of the picks is what every window's composer ends up wearing.
        const fresh = new board.Conversation();
        expect(fresh.model.value).toBe(`claude-opus-4-6`);
        expect(fresh.effortPick.value).toBe(`high`);
        expect(fresh.account.value).toBe(`second`);
    });

    /* A PICK IS A PAIR — this provider, this model — and both halves travel. The provider used to be recorded
     * only by a pick that MOVED the chat off another one, so choosing a second model from the provider a chat
     * already sat on recorded the model and left the pointer where some other tab had put it: the next New agent
     * opened on that provider, wearing a model nobody had chosen. */
    it(`carries the provider of the pick, not only its model`, async () => {
        const board = await openWindow();
        const floating = await openWindow();

        floating.chat.useChat().selectModel({ provider: `cursor`, value: `composer-2.5` });
        // The second pick keeps the provider, which is the ordinary case and the one that used to be lost.
        floating.chat.useChat().selectModel({ provider: `cursor`, value: `composer-2.5-fast` });

        const fresh = new board.Conversation();
        expect([fresh.provider.value, fresh.model.value]).toEqual([`cursor`, `composer-2.5-fast`]);
    });

    it(`keeps a pick a thin catalog read does not carry, and honours it when the catalog does`, async () => {
        const window = await openWindow();
        window.chat.useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });

        /* The catalog comes back without it, which is what a provider serves while its own model discovery is
         * still coming up. Rewriting the preference from that answer is how a deliberate pick used to be spent
         * for good: every chat afterwards opened on the daemon's default with nothing left to say otherwise. */
        mockDaemon([`claude-fable-5`]);
        const thin = await openWindow();
        // The chat cannot send on a model this list does not offer, so it opens on the default...
        expect(new thin.Conversation().model.value).toBe(`claude-fable-5`);

        // ...and the pick behind it is untouched, so the full catalog restores it.
        mockDaemon();
        const full = await openWindow();
        expect(new full.Conversation().model.value).toBe(`claude-opus-4-6`);
    });
});
