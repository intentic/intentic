import "@intentic/testing/dom";
import { effectScope, nextTick, ref } from "vue";
import { describe, it, expect, beforeEach, afterAll, afterEach, mock, jest } from "bun:test";
import { stubGlobal, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { ChatEnvelope } from "./chatChannel";
import type { Strip, TabFacts } from "../tabs/tabFacts";

// Sandbox id is pinned, since every case here turns on which sandbox a strip is believed to name; useSandbox reaches
// window.env through useApi, which no node suite has.
mock.module("../../sandbox/client/useSandbox", () => {
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

stubGlobal(`BroadcastChannel`, FakeChannel);
jest.useFakeTimers();

const { drawsChat, elsewherePreviews, elsewhereStrip, publishPreviews, publishStrip } = await import("./chatEcho");
const { receiveChatNote } = await import("./chatChannel");
const { EMPTY_STRIP } = await import("../tabs/tabFacts");
const { claimFloating, receiveFloatingNote } = await import("../../../shell/window/floating");
const { useSandbox } = await import("../../sandbox/client/useSandbox");

// One heartbeat from the floating window is what flips this window from drawing the panel to believing what it's told
// about the strip.
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// A draft tab holding the given words, as the drawing window's tabFacts would describe it. The strip says only that
// words are waiting; the words themselves travel as a `previews` note.
const draftTab = (id: string, words?: string): TabFacts => ({
    id,
    registered: false,
    standing: `draft`,
    peek: false,
    standIn: false,
    provider: `claude`,
    harness: `native`,
    model: ``,
    unsent: words !== undefined,
});
const strip = (...tabs: TabFacts[]): Strip => ({ active: tabs[0]?.id, panes: tabs.slice(0, 1).map((tab) => tab.id), tabs });

// Only the strips this window posted; the roll-call note is a separate case.
const postedStrips = (): Strip[] => posted.flatMap((envelope) => (envelope.note.kind === `strip` ? [envelope.note.strip] : []));

let revision = 0;
const hear = (heard: Strip, sandbox = `sb1`, owner = `w1`): void =>
    receiveChatNote({ sandbox, note: { kind: `strip`, owner, revision: ++revision, strip: heard } });

beforeEach(() => {
    posted.length = 0;
});

afterEach(() => {
    dock();
    hear(EMPTY_STRIP);
    publishStrip(EMPTY_STRIP, `sb1`);
});
afterAll(() => jest.useRealTimers());

// What the board is told about a strip it can't see: with the chat popped out, this is the window hearing what the
// drawing window says it's showing.
describe(`elsewhereStrip`, () => {
    it(`retries a lost roll-call without waiting for a user gesture or another edit`, async () => {
        popOut();
        await nextTick();
        posted.length = 0;

        await advanceTimersByTimeAsync(2_500);

        expect(posted).toContainEqual({ sandbox: `sb1`, note: { kind: `roll` } });
    });

    it(`rejects a competing window's state and keeps the elected owner's entire strip`, () => {
        popOut();
        const current = { ...strip(draftTab(`a`), draftTab(`b`)), panes: [`a`, `b`], run: { runId: `run-1`, mode: `pinned` as const } };
        hear(current);
        hear(strip(draftTab(`wrong`)), `sb1`, `loser`);

        expect(elsewhereStrip.value).toEqual(current);
    });

    it(`rejects an older revision from the same owner`, () => {
        popOut();
        const current = strip(draftTab(`a`, `latest words`));
        hear(current);
        receiveChatNote({ sandbox: `sb1`, note: { kind: `strip`, owner: `w1`, revision: revision - 1, strip: EMPTY_STRIP } });

        expect(elsewhereStrip.value).toEqual(current);
    });

    it(`re-asks after owner replacement and rejects the retired realm's delayed snapshot`, async () => {
        popOut();
        hear(strip(draftTab(`old`)));
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w2`, since: 2 });
        dock();
        hear(strip(draftTab(`late-old`)));
        await nextTick();

        expect(elsewhereStrip.value).toEqual(EMPTY_STRIP);
        expect(posted).toContainEqual({ sandbox: `sb1`, note: { kind: `roll` } });
        const current = strip(draftTab(`replacement`));
        hear(current, `sb1`, `w2`);
        expect(elsewhereStrip.value).toEqual(current);
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w2` });
    });
    it(`requests the current strip when a holder appears after the boot roll-call`, async () => {
        popOut();
        await nextTick();

        expect(posted).toContainEqual({ sandbox: `sb1`, note: { kind: `roll` } });
    });

    it(`repairs missed updates when the board regains focus`, () => {
        popOut();
        hear(strip(draftTab(`c1`, `old words`)));
        posted.length = 0;

        window.dispatchEvent(new Event(`focus`));

        expect(posted).toContainEqual({ sandbox: `sb1`, note: { kind: `roll` } });
    });
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
        expect(elsewhereStrip.value.tabs.map((tab) => ({ id: tab.id, unsent: tab.unsent }))).toEqual([
            { id: `c1`, unsent: true },
            { id: `c2`, unsent: false },
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
    it(`never labels the previous sandbox's cached strip with the next sandbox`, async () => {
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, mock()));
        publishStrip(strip(draftTab(`private-to-sb1`, `first box`)), `sb1`);
        await nextTick();
        useSandbox().activeSandboxId.value = `sb2`;
        await nextTick();
        posted.length = 0;

        receiveChatNote({ sandbox: `sb2`, note: { kind: `roll` } });

        expect(postedStrips()).toEqual([]);
        scope.stop();
        useSandbox().activeSandboxId.value = `sb1`;
        await nextTick();
    });
    it(`does not let a docked or booting window overwrite the floating chat's strip`, () => {
        publishStrip(strip(draftTab(`c1`, `a stale local copy`)), `sb1`);
        receiveChatNote({ sandbox: `sb1`, note: { kind: `roll` } });

        expect(postedStrips()).toEqual([]);
    });

    it(`publishes an empty first strip when a reloaded floating chat takes ownership`, async () => {
        popOut();
        hear(strip(draftTab(`c1`, `already sent`)));
        // Simulates the replacement realm restoring with an empty strip before its route claims the panel.
        publishStrip(EMPTY_STRIP, `sb1`);

        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, mock()));
        await nextTick();

        expect(postedStrips().at(-1)).toEqual(EMPTY_STRIP);
        scope.stop();
    });

    it(`answers a roll-call with its current strip once it holds the chat`, async () => {
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, mock()));
        await nextTick();
        publishStrip(strip(draftTab(`c1`, `what the holder shows`)), `sb1`);
        posted.length = 0;

        receiveChatNote({ sandbox: `sb1`, note: { kind: `roll` } });

        expect(postedStrips()).toEqual([strip(draftTab(`c1`, `what the holder shows`))]);
        scope.stop();
    });
});

// The composer's words, which move per character, kept off the strip the board rebuilds its cards from.
describe(`elsewherePreviews`, () => {
    it(`takes the words on their own note, leaving the strip the board reads identical`, () => {
        popOut();
        hear(strip(draftTab(`c1`, `fix the`)));
        const before = elsewhereStrip.value;

        receiveChatNote({ sandbox: `sb1`, note: { kind: `previews`, previews: { c1: `fix the login redirect` } } });

        expect(elsewherePreviews.value).toEqual({ c1: `fix the login redirect` });
        // Identity, not equality: this is the whole point. `useAgents-fleet.fleet` reads the strip, and every surface
        // that asks `agentById` anything reads `fleet`, so a strip that moved per keystroke rebuilt all of it.
        expect(elsewhereStrip.value).toBe(before);
    });

    it(`forgets another owner's words rather than lending them to its replacement`, async () => {
        popOut();
        receiveChatNote({ sandbox: `sb1`, note: { kind: `previews`, previews: { c1: `half a thought` } } });
        expect(elsewherePreviews.value).toEqual({ c1: `half a thought` });

        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w2`, since: 2 });
        await nextTick();

        expect(elsewherePreviews.value).toEqual({});
    });

    it(`answers a roll-call with its words as well as its strip`, async () => {
        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, mock()));
        await nextTick();
        publishStrip(strip(draftTab(`c1`, `what the holder shows`)), `sb1`);
        publishPreviews({ c1: `what the holder shows` }, `sb1`);
        posted.length = 0;

        receiveChatNote({ sandbox: `sb1`, note: { kind: `roll` } });

        expect(posted.map((envelope) => envelope.note.kind)).toEqual([`strip`, `previews`]);
        scope.stop();
    });
});
