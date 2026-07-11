import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sandboxClient", () => ({ sandboxRequest: vi.fn() }));
// The real router pulls the auth/environment chain, which needs window.env; the plan-preview watch only pushes.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
// Same window.env chain via analytics; send() only fires a milestone event through track.
vi.mock("../analytics", () => ({ track: vi.fn() }));
// Same window.env chain via useApi; the tab persistence only reads activeSandboxId + reachable.
vi.mock("../useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }) };
});

// The node test environment has no localStorage; the tab snapshot round-trips need one.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, `localStorage`, {
    configurable: true,
    value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
        clear: () => storage.clear(),
    },
});

const { sandboxRequest } = await import("../sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const { loadAccountStatus, resetChat, useChat } = await import("./useChat");

afterEach(() => {
    vi.clearAllMocks();
});

describe(`useChat provider reconciliation`, () => {
    it(`points a GPT-only user's chat at Codex instead of gating on Claude`, async () => {
        const chat = useChat();
        // A fresh conversation defaults to Claude and reads as disconnected (the gate would show).
        expect(chat.provider.value).toBe(`claude`);
        expect(chat.connected.value).toBe(false);

        // The sandbox reports only ChatGPT/codex has an account.
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ accounts: path.startsWith(`/codex`) ? [{ id: `c1`, label: `ChatGPT`, connectedAt: 0 }] : [] }),
            } as Response),
        );
        await loadAccountStatus();
        await nextTick();

        // The untouched fresh conversation follows the connected provider, so the composer is reachable — no
        // Claude wall.
        expect(chat.provider.value).toBe(`codex`);
        expect(chat.connected.value).toBe(true);
    });
});

describe(`per-tab drafts`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`keeps each tab's draft through new-tab and switching back`, () => {
        const chat = useChat();
        const first = chat.active.value.id;
        chat.draft.value = `hello A`;

        chat.newChat();
        expect(chat.draft.value).toBe(``);

        chat.setActive(first);
        expect(chat.draft.value).toBe(`hello A`);
    });

    it(`restores tabs, drafts, attachment metadata, and the active tab from the persisted snapshot`, async () => {
        const chat = useChat();
        chat.draft.value = `draft one`;
        chat.attachments.value = [{ id: `a1`, name: `pic.png`, path: `.intentic/attachments/u1/pic.png`, status: `done`, progress: 1 }];
        chat.newChat();
        chat.draft.value = `draft two`;
        await nextTick(); // flush the persistence watch

        resetChat(); // same restore path as a page refresh / sandbox switch-back
        const tabs = chat.conversations.value;
        expect(tabs).toHaveLength(2);
        expect(tabs[0]!.draft.value).toBe(`draft one`);
        expect(tabs[0]!.attachments.value).toMatchObject([{ name: `pic.png`, path: `.intentic/attachments/u1/pic.png`, status: `done` }]);
        expect(tabs[1]!.draft.value).toBe(`draft two`);
        expect(chat.active.value).toBe(tabs[1]); // the second tab was active when persisted
    });

    it(`degrades a corrupt snapshot to a single fresh tab`, () => {
        storage.set(`intentic.chatTabs.sb1`, `not json`);
        resetChat();
        expect(useChat().conversations.value).toHaveLength(1);
        expect(useChat().draft.value).toBe(``);
    });
});
