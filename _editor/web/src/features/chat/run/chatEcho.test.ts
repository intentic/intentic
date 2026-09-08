// @vitest-environment jsdom
import { effectScope, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEnvelope } from "./chatChannel";
import type { Strip, TabFacts } from "../tabs/tabFacts";

// Sandbox id is pinned, since every case here turns on which sandbox a strip is believed to name; useSandbox reaches
// window.env through useApi, which no node suite has.
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

const posted: ChatEnvelope[] = [];

// Mimics BroadcastChannel's structured-clone copy, not just a kept reference.
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

const { drawsChat, elsewhereStrip, publishStrip } = await import("./chatEcho");
const { receiveChatNote } = await import("./chatChannel");
const { EMPTY_STRIP } = await import("../tabs/tabFacts");
const { claimFloating, receiveFloatingNote } = await import("../../../shell/window/floating");
const { useSandbox } = await import("../../sandbox/client/useSandbox");

// One heartbeat from the floating window is what flips this window from drawing the panel to believing what it's told
// about the strip.
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// A draft tab holding the given words, as the drawing window's tabFacts would describe it.
const draftTab = (id: string, preview?: string): TabFacts => ({
    id,
    registered: false,
    standing: `draft`,
    peek: false,
    standIn: false,
    provider: `claude`,
    harness: `native`,
    model: ``,
    unsent: preview !== undefined,
    ...(preview === undefined ? {} : { preview }),
});
const strip = (...tabs: TabFacts[]): Strip => ({ active: tabs[0]?.id, panes: tabs.slice(0, 1).map((tab) => tab.id), tabs });

// Only the strips this window posted; the roll-call note is a separate case.
const postedStrips = (): Strip[] => posted.flatMap((envelope) => (envelope.note.kind === `strip` ? [envelope.note.strip] : []));

const hear = (heard: Strip, sandbox = `sb1`): void => receiveChatNote({ sandbox, note: { kind: `strip`, strip: heard } });

beforeEach(() => {
    posted.length = 0;
});

afterEach(() => {
    dock();
    hear(EMPTY_STRIP);
    publishStrip(EMPTY_STRIP);
});

// What the board is told about a strip it can't see: with the chat popped out, this is the window hearing what the
// drawing window says it's showing.
describe(`elsewhereStrip`, () => {
    it(`is empty while this window draws the chat itself: its own strip is the answer`, () => {
        hear(strip(draftTab(`c1`, `hello`)));

        expect(drawsChat.value).toBe(true);
        expect(elsewhereStrip.value).toBe(EMPTY_STRIP);
    });

    it(`carries the popped-out window's strip whole: its tabs, its focus and its panes`, () => {
        popOut();
        hear({ active: `c2`, panes: [`c1`, `c2`], tabs: [draftTab(`c1`, `fix the login redirect`), draftTab(`c2`)] });

        expect(drawsChat.value).toBe(false);
        expect(elsewhereStrip.value.active).toBe(`c2`);
        expect(elsewhereStrip.value.panes).toEqual([`c1`, `c2`]);
        expect(elsewhereStrip.value.tabs.map((tab) => ({ id: tab.id, unsent: tab.unsent, preview: tab.preview }))).toEqual([
            { id: `c1`, unsent: true, preview: `fix the login redirect` },
            { id: `c2`, unsent: false, preview: undefined },
        ]);
    });

    it(`retires a tab the next strip no longer names`, () => {
        popOut();
        hear(strip(draftTab(`c1`, `about to send`)));
        hear(strip());

        expect(elsewhereStrip.value.tabs).toEqual([]);
    });

    it(`ignores a window looking at another sandbox, whose chats are none of this board's business`, () => {
        popOut();
        hear(strip(draftTab(`c1`, `someone else's work`)), `sb2`);

        expect(elsewhereStrip.value.tabs).toEqual([]);
    });

    // A sandbox switch drops the old strip and re-asks, rather than letting a stale one from the previous box linger.
    it(`forgets the heard strip on a sandbox switch and asks again`, async () => {
        popOut();
        hear(strip(draftTab(`c1`, `on the first box`)));
        posted.length = 0;

        useSandbox().activeSandboxId.value = `sb2`;
        await nextTick();

        expect(elsewhereStrip.value.tabs).toEqual([]);
        expect(posted).toEqual([{ sandbox: `sb2`, note: { kind: `roll` } }]);
        useSandbox().activeSandboxId.value = `sb1`;
        await nextTick();
    });
});

// `showsPanel` is optimistic during boot, so every window briefly reads as drawing the chat until a holder's first beat
// arrives; holder identity also lets a reloaded holder retire its predecessor's strip.
describe(`strip publisher ownership`, () => {
    it(`does not let a docked or booting window overwrite the floating chat's strip`, () => {
        publishStrip(strip(draftTab(`c1`, `a stale local copy`)));
        receiveChatNote({ sandbox: `sb1`, note: { kind: `roll` } });

        expect(postedStrips()).toEqual([]);
    });

    it(`publishes an empty first strip when a reloaded floating chat takes ownership`, async () => {
        popOut();
        hear(strip(draftTab(`c1`, `already sent`)));
        // Simulates the replacement realm restoring with an empty strip before its route claims the panel.
        publishStrip(EMPTY_STRIP);

        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, vi.fn()));
        await nextTick();

        expect(postedStrips().at(-1)).toEqual(EMPTY_STRIP);
        scope.stop();
    });

    it(`answers a roll-call with its current strip once it holds the chat`, async () => {
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, vi.fn()));
        await nextTick();
        publishStrip(strip(draftTab(`c1`, `what the holder shows`)));
        posted.length = 0;

        receiveChatNote({ sandbox: `sb1`, note: { kind: `roll` } });

        expect(postedStrips()).toEqual([strip(draftTab(`c1`, `what the holder shows`))]);
        scope.stop();
    });
});
