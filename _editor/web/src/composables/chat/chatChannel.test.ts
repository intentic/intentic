// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEnvelope, ChatNote } from "./chatChannel";

// The sandbox id is the envelope's own scope: every case below is about whether a note is BELIEVED, and half
// of that is which sandbox it names. useSandbox itself reaches window.env through useApi, which no test has.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

const posted: ChatEnvelope[] = [];

// The chat's channel, and only that one: floating.ts opens a channel of its own under the same global.
class FakeChannel {
    constructor(private readonly name: string) {}
    postMessage(envelope: ChatEnvelope): void {
        if (this.name === `intentic.chat`) {
            posted.push(envelope);
        }
    }
    addEventListener(): void {
        // Notes arrive through receiveChatNote, the same door the channel listener uses.
    }
}

vi.stubGlobal(`BroadcastChannel`, FakeChannel);

const { onChatNote, postChatNote, receiveChatNote } = await import("./chatChannel");

beforeEach(() => {
    posted.length = 0;
});

/* ONE CHANNEL FOR EVERYTHING THE CHAT SAYS ACROSS WINDOWS, so what is pinned here is the envelope: every note
 * goes out stamped with this window's sandbox, and a note about another sandbox's chats is dropped before any
 * reader sees it, whatever kind it is. */
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

    // A window that has not resolved its sandbox yet matches only another such window: `undefined` is a
    // value here, not a wildcard, or a booting window would take the first note from any box at all.
    it(`treats an unresolved sandbox as its own scope rather than as a wildcard`, () => {
        const heard: ChatNote[] = [];
        onChatNote(`roll`, (note) => heard.push(note));

        receiveChatNote({ sandbox: undefined, note: { kind: `roll` } });

        expect(heard).toEqual([]);
    });
});
