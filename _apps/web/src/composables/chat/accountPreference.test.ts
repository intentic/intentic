import { expect, it, vi } from "vitest";

/* A REAL page refresh, which no amount of resetChat() quite models: the module graph is new, so useChat's
 * restore runs at module scope against nothing but what is on disk — before any daemon has answered, before
 * `accountsLoaded` is anything but false. That is the exact window the account pick used to be lost in, and the
 * only way to sit in it is to seed the stores and then import the singleton fresh. */

vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    // Already bound when the module graph loads — the ordinary case for a refresh of an open sandbox.
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }) };
});

// The node test environment has neither storage; a refresh reads both (sessionStorage holds this window's tabs,
// localStorage the account preference).
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

// What the window wrote before it was closed: two chats, each on its own Claude account, and "second" as the
// last pick — the preference a brand-new tab should open on.
session.set(
    `intentic.chatTabs.sb1`,
    JSON.stringify({
        active: `tab-b`,
        tabs: [
            {
                conversationId: `tab-a`,
                isolated: true,
                registered: false,
                draft: `left mid-sentence`,
                provider: `claude`,
                account: `first`,
                harness: `native`,
                session: { id: `sess-a`, provider: `claude`, account: `first` },
                attachments: [],
                queued: [],
            },
            {
                conversationId: `tab-b`,
                isolated: true,
                registered: false,
                draft: `and this one`,
                provider: `claude`,
                account: `second`,
                harness: `native`,
                attachments: [],
                queued: [],
            },
        ],
    }),
);
local.set(`intentic.chatAccounts.sb1`, JSON.stringify({ claude: `second` }));

const { sandboxJson, sandboxRequest } = await import("../sandbox/sandboxClient");
vi.mocked(sandboxRequest).mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
vi.mocked(sandboxJson).mockImplementation((path: string) =>
    Promise.resolve(
        path === `/translator/accounts`
            ? { codex: [], grok: [], kimi: [], gemini: [] }
            : {
                  accounts: path.startsWith(`/claude`)
                      ? [
                            { id: `first`, label: `Claude`, connectedAt: 1 },
                            { id: `second`, label: `Claude`, connectedAt: 2 },
                        ]
                      : [],
              },
    ),
);

// Imported last, so the seeded stores are what its module-scope restore reads.
const { loadAccountStatus, useChat } = await import("./useChat");

it(`comes back from a refresh on the accounts the tabs were using, and opens a new chat on the last pick`, async () => {
    const chat = useChat();
    const accountOf = (id: string): string | undefined =>
        chat.conversations.value.find((conversation) => conversation.conversationId === id)?.account.value;

    // Before the daemon has said a word — the frame the user actually looks at first, and the one that used to
    // show every chat reset to the provider's first account.
    expect(accountOf(`tab-a`)).toBe(`first`);
    expect(accountOf(`tab-b`)).toBe(`second`);
    // The session keeps its own, so the next send resumes it instead of retiring it over a forged mismatch.
    expect(chat.conversations.value.find((c) => c.conversationId === `tab-a`)?.session.value?.account).toBe(`first`);

    // ...and the list agreeing changes nothing, because it agreed with the user all along.
    await loadAccountStatus();
    expect(accountOf(`tab-a`)).toBe(`first`);
    expect(accountOf(`tab-b`)).toBe(`second`);

    // A chat started after the refresh inherits the remembered pick, not the first account.
    chat.newChat();
    expect(chat.account.value).toBe(`second`);
});
