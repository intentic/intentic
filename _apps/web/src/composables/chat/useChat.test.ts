import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn() }));
// The real router pulls the auth/environment chain, which needs window.env; the plan-preview watch only pushes.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
// Same window.env chain via analytics; send() only fires a milestone event through track.
vi.mock("../analytics", () => ({ track: vi.fn() }));
// Same window.env chain via useApi; the tab persistence only reads activeSandboxId + reachable.
vi.mock("../sandbox/useSandbox", async () => {
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

const { sandboxJson, sandboxRequest } = await import("../sandbox/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const sandboxJsonMock = vi.mocked(sandboxJson);
const { loadAccountStatus, openAgentConversation, resetChat, useChat } = await import("./useChat");
const { usageStatusByAccount } = await import("./usageStatus");

afterEach(() => {
    vi.clearAllMocks();
});

describe(`useChat provider reconciliation`, () => {
    it(`points a GPT-only user's chat at Codex (served by the translator subscription) instead of gating on Claude`, async () => {
        const chat = useChat();
        // A fresh conversation defaults to Claude and reads as disconnected (the gate would show).
        expect(chat.provider.value).toBe(`claude`);
        expect(chat.connected.value).toBe(false);

        // No native accounts anywhere; only the ChatGPT subscription is connected in the translator.
        sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [] }) } as Response));
        sandboxJsonMock.mockResolvedValue({ codex: true, grok: false, gemini: false });
        await loadAccountStatus();
        await nextTick();

        // The untouched fresh conversation follows Codex (subscription-connected), so the composer is reachable —
        // no Claude wall, and no separate ChatGPT account was ever needed.
        expect(chat.provider.value).toBe(`codex`);
        expect(chat.connected.value).toBe(true);
    });

    it(`gates a routed (claude-code harness) chat on the translator subscription, not the native account`, async () => {
        storage.clear();
        resetChat();
        const chat = useChat();
        // Grok's native account is connected, but the translator holds no SuperGrok subscription yet.
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ accounts: path.startsWith(`/grok`) ? [{ id: `xai`, label: `Grok`, connectedAt: 0 }] : [] }),
            } as Response),
        );
        sandboxJsonMock.mockResolvedValue({ codex: false, grok: false, gemini: false });
        await loadAccountStatus();
        await nextTick();

        chat.selectProvider(`grok`);
        expect(chat.connected.value).toBe(true); // the native harness is served by the account
        chat.active.value.selectHarness(`claude-code`);
        expect(chat.connected.value).toBe(false); // routed: only the translator subscription serves the turn

        // The subscription connects (via the Agent tab's "Under Claude Code" row) — the same gate opens.
        sandboxJsonMock.mockResolvedValue({ codex: false, grok: true, gemini: false });
        await loadAccountStatus();
        expect(chat.connected.value).toBe(true);
    });
});

describe(`account usage hydration`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        usageStatusByAccount.value = {};
        sandboxJsonMock.mockResolvedValue({ codex: false, grok: false, gemini: false });
    });

    // The daemon persists each account's usage window; without this the picker stays blank on a fresh load
    // until that account happens to run a turn — which is exactly the turn the user wanted to spend wisely.
    it(`seeds the usage map from the persisted snapshots on the account list`, async () => {
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        accounts: path.startsWith(`/claude`)
                            ? [
                                  {
                                      id: `a1`,
                                      label: `Personal`,
                                      connectedAt: 0,
                                      usage: { windows: [{ kind: `seven_day`, utilization: 12 }], measuredAt: 500 },
                                  },
                                  { id: `a2`, label: `Work`, connectedAt: 1 },
                              ]
                            : [],
                    }),
            } as Response),
        );
        await loadAccountStatus();

        expect(usageStatusByAccount.value[`a1`]).toMatchObject({ windows: [{ kind: `seven_day`, utilization: 12 }], measuredAt: 500 });
        // An account the daemon has no reading for stays absent — unknown, not 0%.
        expect(usageStatusByAccount.value[`a2`]).toBeUndefined();
    });

    it(`keeps a live streamed reading when the persisted one is older`, async () => {
        usageStatusByAccount.value = { a1: { windows: [{ kind: `seven_day`, utilization: 80 }], measuredAt: 9_000 } };
        sandboxRequestMock.mockImplementation((path: string) =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        accounts: path.startsWith(`/claude`)
                            ? [
                                  {
                                      id: `a1`,
                                      label: `Personal`,
                                      connectedAt: 0,
                                      usage: { windows: [{ kind: `seven_day`, utilization: 30 }], measuredAt: 500 },
                                  },
                              ]
                            : [],
                    }),
            } as Response),
        );
        await loadAccountStatus();

        // The daemon's write is fire-and-forget, so a refresh can land between a frame and its persist —
        // the newer reading must win, or the chip would flicker backwards mid-session.
        expect(usageStatusByAccount.value[`a1`]).toMatchObject({ windows: [{ kind: `seven_day`, utilization: 80 }], measuredAt: 9_000 });
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

    // A queued message is text the user wrote and nobody has answered yet — a refresh mid-turn must not eat it.
    it(`restores messages queued behind a running turn, with their attachments`, async () => {
        const chat = useChat();
        chat.active.value.queued.value = [
            { id: `q1`, text: `also update the tests`, attachments: [{ name: `spec.md`, path: `.intentic/attachments/u1/spec.md` }] },
        ];
        await nextTick();

        resetChat();
        expect(chat.queued.value).toMatchObject([
            { text: `also update the tests`, attachments: [{ name: `spec.md`, path: `.intentic/attachments/u1/spec.md` }] },
        ]);
    });

    it(`degrades a corrupt snapshot to a single fresh tab`, () => {
        storage.set(`intentic.chatTabs.sb1`, `not json`);
        resetChat();
        expect(useChat().conversations.value).toHaveLength(1);
        expect(useChat().draft.value).toBe(``);
    });
});

/* Opening a card on the fleet board replays the agent's transcript from /sessions/:id — the Claude Code Agent
 * SDK's own session store, which holds every session that loop minted. Gating the replay on `provider ===
 * 'claude'` opened a finished Gemini (or Kimi) agent as an empty "start a conversation with Google" panel while
 * its whole transcript sat readable on the daemon: neither provider has a native runtime, so both ALWAYS run the
 * Claude Code loop whatever harness the registry recorded. */
describe(`opening a fleet agent`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
        // Nothing is running for the agent, so the attach probe stands down and the stored transcript is what
        // paints — the finished-lane case the board's cards are mostly made of.
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path.startsWith(`/sessions/`)) {
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            messages: [
                                { role: `user`, text: `What model are you?` },
                                { role: `assistant`, text: `Gemini.` },
                            ],
                        }),
                } as Response);
            }
            return Promise.resolve({ ok: false, status: 404 } as Response);
        });
    });

    it(`replays a finished Gemini agent's transcript — no native runtime means its session is the SDK store's`, async () => {
        // `native` is what the registry recorded: it persists the harness the CLIENT sent, and that is the
        // default for a provider with no harness to choose. Gemini runs the Claude Code loop either way, which
        // is exactly the drift a provider check tripped over.
        const conversation = openAgentConversation({ id: `a1`, sessionId: `sess-g`, provider: `gemini`, harness: `native` });

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(sandboxRequestMock).toHaveBeenCalledWith(`/sessions/sess-g`);
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `Gemini.` });
    });

    it(`replays a Codex agent routed under the Claude Code harness`, async () => {
        const conversation = openAgentConversation({ id: `a2`, sessionId: `sess-c`, provider: `codex`, harness: `claude-code` });

        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(2));
        expect(sandboxRequestMock).toHaveBeenCalledWith(`/sessions/sess-c`);
    });

    it(`leaves a NATIVE Codex agent alone — its thread lives in Codex's own rollout store, not the SDK's`, async () => {
        const conversation = openAgentConversation({ id: `a3`, sessionId: `sess-n`, provider: `codex`, harness: `native` });

        await vi.waitFor(() => expect(sandboxRequestMock).toHaveBeenCalledWith(`/agent/attach`, expect.anything()));
        expect(sandboxRequestMock).not.toHaveBeenCalledWith(`/sessions/sess-n`);
        expect(conversation.messages.value).toHaveLength(0);
    });
});

/* Claude's API rejects effort 'max' with extended thinking disabled — a 400 that kills the turn before the
 * model sees the prompt, and reaches the user only as the SDK's opaque `unknown` error category. Both halves
 * persist into turnDefaults, so an unclamped pair would poison every NEW conversation too, not just the tab it
 * was set on. The toggle is the only user-facing write path for thinking, so it is where the pair is repaired. */
describe(`effort/thinking pairing`, () => {
    beforeEach(() => {
        storage.clear();
        resetChat();
    });

    it(`clamps a 'max' effort down when extended thinking is switched off, and persists the clamp`, () => {
        const chat = useChat();
        chat.effort.value = `max`;

        chat.thinking.value = false;
        expect(chat.effort.value).toBe(`xhigh`);

        // The next new conversation seeds from turnDefaults; it must not inherit the pair the API rejects.
        chat.newChat();
        expect(chat.effort.value).toBe(`xhigh`);
    });

    it(`leaves 'max' alone while thinking stays on`, () => {
        const chat = useChat();
        chat.effort.value = `max`;
        chat.thinking.value = true;
        expect(chat.effort.value).toBe(`max`);
    });
});
