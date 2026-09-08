// @vitest-environment jsdom
import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEnvelope, ChatNote } from "./chatChannel";
import type { StoredTab } from "../tabs/tabSnapshot";

// The sandbox id scopes every note here; useSandbox reaches window.env through useApi, which no test has.
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

const posted: ChatEnvelope[] = [];

// Mimics BroadcastChannel's structured clone: a Vue reactive proxy in a note is a DataCloneError there, but not with a
// fake that just kept the reference.
class FakeChannel {
    constructor(private readonly name: string) {}
    postMessage(envelope: ChatEnvelope): void {
        if (this.name === `intentic.chat`) {
            posted.push(structuredClone(envelope));
        }
    }
    addEventListener(): void {
        // Real notes arrive through receiveChatNote instead, not this listener.
    }
}

vi.stubGlobal(`BroadcastChannel`, FakeChannel);

const { onChatNote, postChatNote, receiveChatNote } = await import("./chatChannel");

beforeEach(() => {
    posted.length = 0;
});

// One channel for everything the chat says across windows: every note is stamped with this window's sandbox, and one
// for another sandbox is dropped before any reader sees it.
describe(`the chat channel`, () => {
    it(`stamps every note with the sandbox this window is pointed at`, () => {
        postChatNote({ kind: `roll` });

        expect(posted).toEqual([{ sandbox: `sb1`, note: { kind: `roll` } }]);
    });

    it(`hands a note to the reader of its kind, and to that reader alone`, () => {
        const heard: ChatNote[] = [];
        onChatNote(`closed-drafts`, (note) => heard.push(note));
        onChatNote(`roll`, () => heard.push({ kind: `roll` }));

        receiveChatNote({ sandbox: `sb1`, note: { kind: `closed-drafts`, tabs: [] } });

        expect(heard).toEqual([{ kind: `closed-drafts`, tabs: [] }]);
    });

    it(`drops a note about another sandbox's chats before any reader hears it`, () => {
        const heard: ChatNote[] = [];
        onChatNote(`roll`, (note) => heard.push(note));

        receiveChatNote({ sandbox: `sb2`, note: { kind: `roll` } });

        expect(heard).toEqual([]);
    });

    it(`treats an unresolved sandbox as its own scope rather than as a wildcard`, () => {
        const heard: ChatNote[] = [];
        onChatNote(`roll`, (note) => heard.push(note));

        receiveChatNote({ sandbox: undefined, note: { kind: `roll` } });

        expect(heard).toEqual([]);
    });

    // JSON drops undefined fields; that's why `title` doesn't appear in the posted note below.
    it(`carries a note holding Vue-reactive state as the plain data a structured clone will take`, () => {
        const tab: StoredTab = reactive({
            conversationId: `cnv-1`,
            isolated: true,
            registered: true,
            provider: `claude`,
            harness: `native`,
            session: { id: `sess-1`, provider: `claude`, harness: `native`, account: `acct-1` },
            movedFrom: { provider: `codex`, value: `gpt-5-codex` },
            title: undefined,
            draft: ``,
            attachments: [],
            queued: [],
        });

        expect(() => postChatNote({ kind: `closed-drafts`, tabs: [tab] })).not.toThrow();

        expect(posted[0]?.note).toStrictEqual({
            kind: `closed-drafts`,
            tabs: [
                {
                    conversationId: `cnv-1`,
                    isolated: true,
                    registered: true,
                    provider: `claude`,
                    harness: `native`,
                    session: { id: `sess-1`, provider: `claude`, harness: `native`, account: `acct-1` },
                    movedFrom: { provider: `codex`, value: `gpt-5-codex` },
                    draft: ``,
                    attachments: [],
                    queued: [],
                },
            ],
        });
    });
});
