import "@intentic/testing/dom";
import type { ConversationQueue } from "@intentic/sandbox-contract";
import { createApp, h, nextTick, ref, shallowRef } from "vue";
import * as useAgentsOriginal from "../../../agents/fleet/useAgents";
import * as sessionsOriginal from "../../run/useChat-sessions";

// Pins what keeps a pane on the chat it shows: the typewriter runs in the focused pane alone, and a chat this pane is
// not streaming hydrates on the roster's transitions, never on the turn it streamed itself.

// The fleet roster as agentById answers it, by conversation id; a status, the run it names and its queue are all a turn's
// standing is read from here.
const { roster, hydrateOnce } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    return {
        roster: vueRef<Record<string, { readonly status: string; readonly run?: string; readonly queue?: ConversationQueue }>>({}),
        hydrateOnce: jest.fn(),
    };
})();
// Held before the mock replaces the module's binding, which would otherwise answer with the mock itself.
const { useAgents } = useAgentsOriginal;
jest.mock("../../../agents/fleet/useAgents", () => ({
    ...useAgentsOriginal,
    useAgents: () => ({ ...useAgents(), agentById: (id: string) => roster.value[id] }),
}));
jest.mock("../../run/useChat-sessions", () => ({ ...sessionsOriginal, hydrateOnce }));

const { usePaneAttach } = await import("./paneAttach");
const { Conversation } = await import("../../session/conversation");
type Chat = InstanceType<typeof Conversation>;

let unmount: (() => void) | undefined;
const attach = (first: Chat) => {
    const conversation = shallowRef(first);
    const focused = ref(true);
    const streaming = ref(false);
    const app = createApp({
        setup: () => {
            usePaneAttach({ conversation: () => conversation.value, focused: () => focused.value, streaming });
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    return { conversation, focused, streaming };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    roster.value = {};
    hydrateOnce.mockClear();
});

describe(`the typewriter`, () => {
    it(`runs in the focused pane's chat alone, and stops in the chat the pane leaves`, async () => {
        const a = new Conversation(`a`);
        const b = new Conversation(`b`);
        const pane = attach(a);
        expect(a.transcript.watched.value).toBe(true);

        pane.conversation.value = b;
        await nextTick();
        expect(a.transcript.watched.value).toBe(false);
        expect(b.transcript.watched.value).toBe(true);

        pane.focused.value = false;
        await nextTick();
        expect(b.transcript.watched.value).toBe(false);
    });

    it(`leaves nothing watched when the pane goes away`, () => {
        const a = new Conversation(`a`);
        attach(a);

        unmount?.();
        unmount = undefined;

        expect(a.transcript.watched.value).toBe(false);
    });
});

describe(`hydration off the roster`, () => {
    it(`hydrates when the roster first carries the chat, and again when its turn settles`, async () => {
        const chat = new Conversation(`a`);
        attach(chat);
        expect(hydrateOnce).not.toHaveBeenCalled();

        roster.value = { a: { status: `running` } };
        await nextTick();
        expect(chat.registered.value).toBe(true);
        expect(hydrateOnce.mock.calls).toEqual([[chat]]);

        roster.value = { a: { status: `idle` } };
        await nextTick();
        expect(hydrateOnce).toHaveBeenCalledTimes(2);
    });

    it(`leaves a turn this pane streamed to its own stream`, async () => {
        const chat = new Conversation(`a`);
        const pane = attach(chat);
        roster.value = { a: { status: `running` } };
        await nextTick();
        hydrateOnce.mockClear();

        pane.streaming.value = true;
        await nextTick();
        pane.streaming.value = false;
        roster.value = { a: { status: `idle` } };
        await nextTick();
        expect(hydrateOnce).not.toHaveBeenCalled();

        // The next turn is one this pane did not stream, so its settle is news again.
        roster.value = { a: { status: `running` } };
        await nextTick();
        roster.value = { a: { status: `idle` } };
        await nextTick();
        expect(hydrateOnce).toHaveBeenCalledTimes(2);
    });

    it(`follows the resume pass's re-run behind a booked resume, which read as in flight all along`, async () => {
        const chat = new Conversation(`a`);
        const pane = attach(chat);
        pane.streaming.value = true;
        roster.value = { a: { status: `running`, run: `r1` } };
        await nextTick();

        // The streamed turn fails with a rung booked: in flight still, and nothing new to attach to.
        pane.streaming.value = false;
        roster.value = { a: { status: `resuming` } };
        await nextTick();
        expect(hydrateOnce).not.toHaveBeenCalled();

        // The rung fires: a run this pane is not streaming.
        roster.value = { a: { status: `running`, run: `r2` } };
        await nextTick();
        expect(hydrateOnce.mock.calls).toEqual([[chat]]);
    });

    // The queue starts the next turn the moment this one settles, and a roster read after both says running twice.
    it(`hydrates when the card names a new run even though it never read as settled in between`, async () => {
        const chat = new Conversation(`a`);
        attach(chat);
        roster.value = { a: { status: `running`, run: `r1` } };
        await nextTick();
        roster.value = { a: { status: `running`, run: `r2` } };
        await nextTick();

        expect(hydrateOnce.mock.calls).toEqual([[chat], [chat]]);
    });

    it(`follows the turn the card already names once this pane's own stream is over`, async () => {
        const chat = new Conversation(`a`);
        const pane = attach(chat);
        pane.streaming.value = true;
        await nextTick();
        roster.value = { a: { status: `running`, run: `r2` } };
        await nextTick();
        expect(hydrateOnce).not.toHaveBeenCalled();

        pane.streaming.value = false;
        await nextTick();
        expect(hydrateOnce.mock.calls).toEqual([[chat]]);
    });

    it(`reads no transition while the pane is streaming`, async () => {
        const chat = new Conversation(`a`);
        const pane = attach(chat);
        pane.streaming.value = true;
        await nextTick();

        roster.value = { a: { status: `running` } };
        await nextTick();

        expect(hydrateOnce).not.toHaveBeenCalled();
        expect(chat.registered.value).toBe(false);
    });
});

describe(`the chat's queue`, () => {
    const waiting = (revision: number, text: string): ConversationQueue => ({
        items: [{ id: `m-1`, text, voice: `person`, queuedAt: 1_000, revision }],
        revision,
    });

    it(`is read off the chat's card, the same one every window shows`, async () => {
        const chat = new Conversation(`a`);
        attach(chat);
        roster.value = { a: { status: `running`, queue: waiting(1, `and the docs`) } };
        await nextTick();

        expect(chat.queue.value).toEqual(waiting(1, `and the docs`));
    });

    // This window's own change was answered with a newer queue than the card it has yet to receive.
    it(`never goes back to an older copy than the one a change here was answered with`, async () => {
        const chat = new Conversation(`a`);
        attach(chat);
        chat.queue.value = waiting(3, `and the docs, briefly`);
        roster.value = { a: { status: `running`, queue: waiting(2, `and the docs`) } };
        await nextTick();

        expect(chat.queue.value).toEqual(waiting(3, `and the docs, briefly`));
    });
});
