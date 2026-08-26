// @vitest-environment jsdom
import { effectScope, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sandbox id is the note's own scope (a summons keeps the same one), so it is pinned rather than left as a
// fresh ref per call: every case below is about whether a note is BELIEVED, and half of that is which sandbox
// it names. useSandbox itself reaches window.env through useApi, which no node-environment suite has.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(false) }) };
});

interface PostedNote {
    readonly kind: string;
    readonly sandbox?: string;
    readonly drafts?: readonly { readonly id: string; readonly preview: string }[];
}

const posted: PostedNote[] = [];

class FakeChannel {
    constructor(private readonly name: string) {}
    postMessage(note: PostedNote): void {
        if (this.name === `intentic.chat-drafts`) {
            posted.push(note);
        }
    }
    addEventListener(): void {
        // Notes arrive through receiveDraftNote, the same door the channel listener uses.
    }
}

vi.stubGlobal(`BroadcastChannel`, FakeChannel);

const { draftPreview, elsewhereDrafts, publishDrafts, receiveDraftNote } = await import("./draftEcho");
const { claimFloating, receiveFloatingNote } = await import("../floating");

/* THE CHAT IS IN A WINDOW OF ITS OWN, as the rest of the app hears it: one heartbeat from that window
 * (floating.ts's own seam), which is the whole of what makes this window stop drawing the panel and start
 * believing what it is told about the composers out there. */
const popOut = (): void => receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
const dock = (): void => receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });

beforeEach(() => {
    posted.length = 0;
});

afterEach(() => {
    dock();
    receiveDraftNote({ kind: `drafts`, sandbox: `sb1`, drafts: [] });
    publishDrafts([]);
});

/* The name a card wears while nothing else has named it. Short enough for a lane, long enough to tell two
 * drafts apart, and one line whatever was pasted into the box. */
describe(`draftPreview`, () => {
    it(`is nothing at all for an empty composer, so the card keeps its "New agent"`, () => {
        expect(draftPreview(``)).toBeUndefined();
        expect(draftPreview(`   \n  `)).toBeUndefined();
    });

    it(`hands back a short message whole`, () => {
        expect(draftPreview(`  fix the login redirect  `)).toBe(`fix the login redirect`);
    });

    it(`folds a pasted paragraph onto one line`, () => {
        expect(draftPreview(`fix the\n\n  login   redirect`)).toBe(`fix the login redirect`);
    });

    it(`cuts a long message at a word, so the title reads as words rather than as a slice`, () => {
        const preview = draftPreview(`refactor the whole authentication layer and then write the tests for it`);

        expect(preview).toBe(`refactor the whole authentication layer and…`);
    });

    // The word-boundary rule yields to a word longer than the cut: half a title is still a title, two letters
    // of one is not.
    it(`clips a single enormous word rather than leaving two letters of it`, () => {
        expect(draftPreview(`a${`x`.repeat(80)}`)).toBe(`${`a${`x`.repeat(47)}`}…`);
    });
});

/* WHAT THE BOARD IS TOLD ABOUT THE COMPOSER IT CANNOT SEE. The report: with the chat popped out, a draft being
 * typed there was invisible over here, so the board swept its card on the next click and the words went with
 * it. */
describe(`elsewhereDrafts`, () => {
    it(`is empty while this window draws the chat itself: its own composers are the answer`, () => {
        receiveDraftNote({ kind: `drafts`, sandbox: `sb1`, drafts: [{ id: `c1`, preview: `hello` }] });

        expect(elsewhereDrafts.value.size).toBe(0);
    });

    it(`carries the popped-out window's drafts, with the words that name them`, () => {
        popOut();
        receiveDraftNote({ kind: `drafts`, sandbox: `sb1`, drafts: [{ id: `c1`, preview: `fix the login redirect` }] });

        expect(elsewhereDrafts.value.get(`c1`)).toBe(`fix the login redirect`);
    });

    // A snapshot, never a patch: the note that arrives IS the list, so a message that has been sent (or cleared)
    // stops being reported by the next note rather than needing a retraction of its own.
    it(`retires a draft the next note no longer names`, () => {
        popOut();
        receiveDraftNote({ kind: `drafts`, sandbox: `sb1`, drafts: [{ id: `c1`, preview: `about to send` }] });
        receiveDraftNote({ kind: `drafts`, sandbox: `sb1`, drafts: [] });

        expect(elsewhereDrafts.value.size).toBe(0);
    });

    it(`ignores a window looking at another sandbox, whose chats are none of this board's business`, () => {
        popOut();
        receiveDraftNote({ kind: `drafts`, sandbox: `sb2`, drafts: [{ id: `c1`, preview: `someone else's work` }] });

        expect(elsewhereDrafts.value.size).toBe(0);
    });
});

/* WHO MAY SPEAK FOR A COMPOSER. `showsPanel` is optimistic during boot: until a floating holder's first beat
 * arrives, every ordinary window briefly reads as though it draws the chat. The holder identity is the proof;
 * it also distinguishes a reloaded holder, whose empty restored snapshot must retire its predecessor's note. */
describe(`draft publisher ownership`, () => {
    it(`does not let a docked or booting window overwrite the floating chat's snapshot`, () => {
        publishDrafts([{ id: `c1`, preview: `a stale local copy` }]);
        receiveDraftNote({ kind: `roll` });

        expect(posted).toEqual([]);
    });

    it(`publishes an empty first snapshot when a reloaded floating chat takes ownership`, async () => {
        popOut();
        receiveDraftNote({ kind: `drafts`, sandbox: `sb1`, drafts: [{ id: `c1`, preview: `already sent` }] });
        // The replacement realm restored the authoritative chat with an empty composer before its route
        // claimed the panel. This was suppressed, leaving the note above alive on the dashboard.
        publishDrafts([]);

        const scope = effectScope();
        scope.run(() => claimFloating(`chat`, vi.fn()));
        await nextTick();

        expect(posted.at(-1)).toEqual({ kind: `drafts`, sandbox: `sb1`, drafts: [] });
        scope.stop();
    });
});
