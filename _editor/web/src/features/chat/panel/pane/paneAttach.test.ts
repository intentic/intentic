import "@intentic/testing/dom";
import { hoisted } from "@intentic/testing/bun";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { createApp, h, nextTick, ref, shallowRef } from "vue";
import * as useAgentsOriginal from "../../../agents/fleet/useAgents";
import * as sessionsOriginal from "../../run/useChat-sessions";

// Pins what keeps a pane on the chat it shows: the typewriter runs in the focused pane alone, and a chat this pane is
// not streaming hydrates on the roster's transitions, never on the turn it streamed itself.

// The fleet roster as agentById answers it, by conversation id; a status and the running turn's start are all a turn's
// standing is read from here.
const { roster, hydrateOnce } = await hoisted(async () => {
    const { ref: vueRef } = await import(`vue`);
    return { roster: vueRef<Record<string, { readonly status: string; readonly startedAt?: number }>>({}), hydrateOnce: mock() };
});
// Held before the mock replaces the module's binding, which would otherwise answer with the mock itself.
const { useAgents } = useAgentsOriginal;
mock.module("../../../agents/fleet/useAgents", () => ({
    ...useAgentsOriginal,
    useAgents: () => ({ ...useAgents(), agentById: (id: string) => roster.value[id] }),
}));
mock.module("../../run/useChat-sessions", () => ({ ...sessionsOriginal, hydrateOnce }));

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
        roster.value = { a: { status: `running`, startedAt: 1_000 } };
        await nextTick();

        // The streamed turn fails with a rung booked: in flight still, and nothing new to attach to.
        pane.streaming.value = false;
        roster.value = { a: { status: `resuming` } };
        await nextTick();
        expect(hydrateOnce).not.toHaveBeenCalled();

        // The rung fires: a run this pane is not streaming.
        roster.value = { a: { status: `running`, startedAt: 2_000 } };
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
