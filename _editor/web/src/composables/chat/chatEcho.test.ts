// @vitest-environment jsdom
import { effectScope, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEnvelope } from "./chatChannel";
import type { Strip, TabFacts } from "./tabFacts";

// The sandbox id is the envelope's own scope (chatChannel), so it is pinned rather than left as a fresh ref per
// call: every case below is about whether a strip is BELIEVED, and half of that is which sandbox it names.
// useSandbox itself reaches window.env through useApi, which no node-environment suite has.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

const posted: ChatEnvelope[] = [];

// The chat's channel, and only that one: floating.ts opens a channel of its own under the same global. Copied by
// structured clone as the browser does it (chatChannel.test.ts says why that matters).
class FakeChannel {
    constructor(private readonly name: string) {}
    postMessage(envelope: ChatEnvelope): void {
        if (this.name === `intentic.chat`) {
            posted.push(structuredClone(envelope));
        }
    }
    addEventListener(): void {
        // Notes arrive through receiveChatNote, the same door the channel listener uses.
    }
}

vi.stubGlobal(`BroadcastChannel`, FakeChannel);

const { drawsChat, elsewhereStrip, publishStrip } = await import("./chatEcho");
const { receiveChatNote } = await import("./chatChannel");
const { EMPTY_STRIP } = await import("./tabFacts");
const { claimFloating, receiveFloatingNote } = await import("../floating");
const { useSandbox } = await import("../sandbox/useSandbox");

/* THE CHAT IS IN A WINDOW OF ITS OWN, as the rest of the app hears it: one heartbeat from that window
 * (floating.ts's own seam), which is the whole of what makes this window stop drawing the panel and start
 * believing what it is told about the strip out there. */
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

// One published tab: a draft holding the given words, as the drawing window's tabFacts would describe it.
const draftTab = (id: string, preview?: string): TabFacts => ({
    id,
    registered: false,
    standing: `draft`,
    provider: `claude`,
    harness: `native`,
    model: ``,
    unsent: preview !== undefined,
    ...(preview === undefined ? {} : { preview }),
});
const strip = (...tabs: TabFacts[]): Strip => ({ active: tabs[0]?.id, panes: tabs.slice(0, 1).map((tab) => tab.id), tabs });

// The strips this window has posted, and nothing else it said (the roll-call is a separate case).
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

/* WHAT THE BOARD IS TOLD ABOUT THE STRIP IT CANNOT SEE. The report: with the chat popped out, a draft being
 * typed out there had no card, no name and no mark over here, and a card closed out there lingered. The
 * window drawing the chat now says what it is showing, and this is the window hearing it. */
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

    // A snapshot, never a patch: what the last note does not name is gone.
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

    /* A SANDBOX SWITCH forgets the strip heard for the old box and asks the holder for the new one's: the
     * chats of one daemon have no business on another's board, and a strip that survived the switch used to sit
     * there until the holder happened to type. */
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

/* WHO MAY SPEAK FOR THE STRIP. `showsPanel` is optimistic during boot: until a floating holder's first beat
 * arrives, every ordinary window briefly reads as though it draws the chat. The holder identity is the proof;
 * it also distinguishes a reloaded holder, whose empty restored strip must retire its predecessor's. */
describe(`strip publisher ownership`, () => {
    it(`does not let a docked or booting window overwrite the floating chat's strip`, () => {
        publishStrip(strip(draftTab(`c1`, `a stale local copy`)));
        receiveChatNote({ sandbox: `sb1`, note: { kind: `roll` } });

        expect(postedStrips()).toEqual([]);
    });

    it(`publishes an empty first strip when a reloaded floating chat takes ownership`, async () => {
        popOut();
        hear(strip(draftTab(`c1`, `already sent`)));
        // The replacement realm restored the authoritative chat with an empty strip before its route claimed
        // the panel. Suppressed, this left the strip above alive on every dashboard.
        publishStrip(EMPTY_STRIP);

        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, vi.fn()));
        await nextTick();

        expect(postedStrips().at(-1)).toEqual(EMPTY_STRIP);
        scope.stop();
    });

    // A board that boots while the chat is already floating asks, and the holder answers with what it has.
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
