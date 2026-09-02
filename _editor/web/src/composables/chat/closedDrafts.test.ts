import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTab } from "./tabSnapshot";

vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

// The node test environment has no storage, and this store is one of the two things that keep a draft past the
// window that wrote it (the other is the tab snapshot). localStorage rather than the session's, deliberately:
// the words belong to the browser, not to the window whose × dismissed them.
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

const { claimClosedDrafts, closedDrafts, forgetClosedDraft, keepClosedDraft, receiveClosedDraftNote } = await import("./closedDrafts");

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

    // The same chat closed twice (reopened, typed in, closed again) is one entry, and it is the LAST thing that
    // was in the composer: two rows for one conversation would put the same card on the board twice, one of them
    // offering to restore words the user has already replaced.
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

    // One claim for the whole reveal (a Shift-run of cards into panes), and only the chats it names: the rest of
    // the board's set-aside cards are nobody's business on that press.
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

        // A fresh realm — a reload, another window opening — reading the same origin's storage.
        const { closedDrafts: reloaded } = await import("./closedDrafts");

        expect(reloaded.value.map((entry) => entry.draft)).toEqual([`still here tomorrow`]);
    });

    /* Another window's note, which is what makes this work at all while the chat is POPPED OUT: the × is
     * pressed out there and the board that has to keep the card is in here. A snapshot, never a patch — the
     * last note wins, the presence rule every channel in this app follows. */
    it(`takes the whole set from another window's note`, () => {
        keepClosedDraft(tab(`c1`, `mine`));

        receiveClosedDraftNote({ sandbox: `sb1`, tabs: [tab(`c2`, `closed in the popped-out window`)] });

        expect(closedDrafts.value.map((entry) => entry.conversationId)).toEqual([`c2`]);
    });

    it(`ignores a note about another sandbox's chats`, () => {
        keepClosedDraft(tab(`c1`, `mine`));

        receiveClosedDraftNote({ sandbox: `sb2`, tabs: [] });

        expect(closedDrafts.value.map((entry) => entry.conversationId)).toEqual([`c1`]);
    });
});
