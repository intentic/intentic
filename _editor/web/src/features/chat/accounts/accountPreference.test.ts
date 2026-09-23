import { it, expect, mock } from "bun:test";
import { ref } from "vue";
import { TrialStatusSchema } from "@intentic/sandbox-contract";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Simulates a real page refresh, which resetSandboxScope() can't: a fresh module graph means useChat's
// restore runs at module scope before any daemon has answered. The only way to test that window is
// to seed the stores, then import the singleton fresh.

// The reads a reachable daemon answers: the two accounts behind the seeded tabs, and every other connection empty. A
// catalog is refused, as for a provider the daemon cannot list.
mock.module("../../sandbox/client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        accounts: {
            accounts: async ({ provider }) => ({
                accounts:
                    provider === `claude`
                        ? [
                              { id: `first`, label: `Claude`, connectedAt: 1 },
                              { id: `second`, label: `Claude`, connectedAt: 2 },
                          ]
                        : [],
            }),
        },
        translator: { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) },
        usage: { refreshPlanLimits: async () => ({ ok: true, held: [] }) },
        agent: { refusals: async () => ({ refusals: {} }), commands: async () => ({ commands: [] }) },
        providers: {
            list: async () => ({ native: [], agents: [], endpoints: [] }),
            models: async () => {
                throw new SandboxHttpError(404, `Not found.`);
            },
        },
        endpoints: { trial: async () => TrialStatusSchema.parse({ available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` }) },
    }),
}));
mock.module("../../../router", () => ({ router: { push: mock() } }));
mock.module("../../../app/analytics", () => ({ track: mock() }));
mock.module("../../sandbox/client/useSandbox", () => {
    // Already bound when the module graph loads, the ordinary case for a refresh of an open sandbox.
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }) };
});

// Node's test env has neither storage; a refresh reads both (sessionStorage: tabs, localStorage:
// account preference).
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

// What the window wrote before closing: two chats on different accounts, "second" as the last pick.
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
                // A session missing its runtime is dropped, not completed from the tab's own picks.
                session: { id: `sess-a`, provider: `claude`, harness: `native`, account: `first` },
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
local.set(`ui-chat-accounts-sb1`, JSON.stringify({ claude: `second` }));
// The sandbox the window was pointed at, persisted the way activeSandbox.ts reads it back at module scope.
local.set(`intentic.activeSandboxId`, `sb1`);

// Imported last, so the seeded stores are what its module-scope restore reads.
const { useChat } = await import("../run/useChat");
const { draftConversation, reveal } = await import("../panel/useChat-reveal");
const { loadAccountStatus } = await import("./useChat-accounts");
// The store half of "New agent"; the fixture these tests use to open extra tabs.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

it(`comes back from a refresh on the accounts the tabs were using, and opens a new chat on the last pick`, async () => {
    const chat = useChat();
    const accountOf = (id: string): string | undefined =>
        chat.conversations.value.find((conversation) => conversation.conversationId === id)?.selection.account.value;

    // Before the daemon has answered: the frame the user looks at first.
    expect(accountOf(`tab-a`)).toBe(`first`);
    expect(accountOf(`tab-b`)).toBe(`second`);
    // The session keeps its own, so the next send resumes it instead of retiring it over a forged mismatch.
    expect(chat.conversations.value.find((c) => c.conversationId === `tab-a`)?.session.value?.account).toBe(`first`);

    // The list agreeing changes nothing; it agreed with the user all along.
    await loadAccountStatus();
    expect(accountOf(`tab-a`)).toBe(`first`);
    expect(accountOf(`tab-b`)).toBe(`second`);

    // A chat started after the refresh inherits the remembered pick, not the first account.
    newChat();
    expect(chat.account.value).toBe(`second`);
});
