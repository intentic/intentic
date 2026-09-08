import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTab } from "../tabs/tabSnapshot";

vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

// No storage in the node test env; stubs localStorage since drafts persist per-browser, not per-window.
const entries = new Map<string, string>();
Object.defineProperty(globalThis, `localStorage`, {
    configurable: true,
    value: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => void entries.set(key, value),
        removeItem: (key: string) => void entries.delete(key),
        clear: () => entries.clear(),
    },
});

const { claimClosedDrafts, closedDrafts, forgetClosedDraft, keepClosedDraft } = await import("./closedDrafts");
const { receiveChatNote } = await import("../run/chatChannel");

const tab = (conversationId: string, draft: string): StoredTab => ({
    conversationId,
    isolated: true,
    registered: false,
    provider: `claude`,
    harness: `native`,
    draft,
    draftAt: 1_700,
    attachments: [],
    queued: [],
});

beforeEach(() => {
    for (const entry of closedDrafts.value) {
        forgetClosedDraft(entry.conversationId);
    }
    entries.clear();
});

describe(`closedDrafts`, () => {
    it(`keeps a closed chat's whole tab, newest first`, () => {
        keepClosedDraft(tab(`c1`, `first`));
        keepClosedDraft(tab(`c2`, `second`));

        expect(closedDrafts.value.map((entry) => entry.conversationId)).toEqual([`c2`, `c1`]);
    });

    // Closing the same chat twice keeps one entry: the latest words, not a second stale card on the board.
    it(`replaces the entry for a chat closed a second time`, () => {
        keepClosedDraft(tab(`c1`, `first thought`));
        keepClosedDraft(tab(`c1`, `what I actually meant`));

        expect(closedDrafts.value.map((entry) => entry.draft)).toEqual([`what I actually meant`]);
    });

    it(`hands an entry back exactly once: claiming it is what puts the words in a composer`, () => {
        keepClosedDraft(tab(`c1`, `half a thought`));

        expect(claimClosedDrafts([`c1`]).map((entry) => entry.draft)).toEqual([`half a thought`]);
        expect(claimClosedDrafts([`c1`])).toEqual([]);
        expect(closedDrafts.value).toEqual([]);
    });

    // One claim covers a whole reveal and only the chats it names; other set-aside cards are untouched.
    it(`claims several at once and leaves the chats the reveal didn't name`, () => {
        keepClosedDraft(tab(`c1`, `first`));
        keepClosedDraft(tab(`c2`, `second`));
        keepClosedDraft(tab(`c3`, `third`));

        expect(claimClosedDrafts([`c1`, `c3`]).map((entry) => entry.conversationId)).toEqual([`c3`, `c1`]);
        expect(closedDrafts.value.map((entry) => entry.conversationId)).toEqual([`c2`]);
    });

    it(`survives the window that wrote it`, async () => {
        keepClosedDraft(tab(`c1`, `still here tomorrow`));
        vi.resetModules();

        // A fresh realm, a reload or another window opening, reading the same origin's storage.
        const { closedDrafts: reloaded } = await import("./closedDrafts");

        expect(reloaded.value.map((entry) => entry.draft)).toEqual([`still here tomorrow`]);
    });

    // Cross-window note: the × is pressed in the popped-out window, the board keeping the card is here.
    // A snapshot, never a patch; the last note wins.
    it(`takes the whole set from another window's note`, () => {
        keepClosedDraft(tab(`c1`, `mine`));

        receiveChatNote({ sandbox: `sb1`, note: { kind: `closed-drafts`, tabs: [tab(`c2`, `closed in the popped-out window`)] } });

        expect(closedDrafts.value.map((entry) => entry.conversationId)).toEqual([`c2`]);
    });

    // The channel's own guard filters another sandbox's notes before they reach this store.
    it(`ignores a note about another sandbox's chats`, () => {
        keepClosedDraft(tab(`c1`, `mine`));

        receiveChatNote({ sandbox: `sb2`, note: { kind: `closed-drafts`, tabs: [] } });

        expect(closedDrafts.value.map((entry) => entry.conversationId)).toEqual([`c1`]);
    });
});
