import "@intentic/testing/dom";
import type { AgentAttention, ConversationQueue } from "@intentic/sandbox-contract";
import { NO_ATTENTION } from "../../../../agents/fleet/agentStatus";
import { createApp, h, nextTick, ref, shallowRef } from "vue";
import * as useAgentsOriginal from "../../../../agents/fleet/useAgents";
import * as sessionsOriginal from "../../../run/useChat-sessions";

// Pins what keeps a pane on the chat it shows: the typewriter runs in the focused pane alone, and a chat this pane is
// not streaming hydrates on the roster's transitions, never on the turn it streamed itself.

// The fleet roster as agentById answers it, by conversation id; a status, the run it names and its queue are all a turn's
// standing is read from here.
const { roster, hydrateOnce, refreshAfterSleep, onScreen } = await (async () => {
    const { ref: vueRef } = await import(`vue`);
    return {
        // Whether this window's page is in view; the real one follows the document's visibilitychange.
        onScreen: vueRef(true),
        roster: vueRef<
            Record<
                string,
                { readonly status: string; readonly run?: string; readonly queue?: ConversationQueue; readonly attention?: Partial<AgentAttention> }
            >
        >({}),
        hydrateOnce: jest.fn(),
        refreshAfterSleep: jest.fn(),
    };
})();
// Held before the mock replaces the module's binding, which would otherwise answer with the mock itself.
const { useAgents } = useAgentsOriginal;
jest.mock("../../../../agents/fleet/useAgents", () => ({
    ...useAgentsOriginal,
    // Every card the daemon sends carries its attention block; a row here names only the waits it is about.
    useAgents: () => ({
        ...useAgents(),
        agentById: (id: string) => {
            const row = roster.value[id];
            return row === undefined ? undefined : { ...row, attention: { ...NO_ATTENTION, ...row.attention } };
        },
    }),
}));
jest.mock("../../../run/useChat-sessions", () => ({ ...sessionsOriginal, hydrateOnce, refreshAfterSleep }));
jest.mock("../../../../../shell/window/onScreen", () => ({ onScreen }));

const { usePaneAttach } = await import("../paneAttach");
const { Conversation } = await import("../../../session/conversation");
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
    refreshAfterSleep.mockClear();
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

// A tab open for hours whose attach stream is gone: the turn parked on a question, and nothing drew the card until a send
// forced a reattach (M1 waited 3 h 36 min). Showing the chat is what fetches it now.
describe(`a chat that waits on a person`, () => {
    const setVisibility = (state: `visible` | `hidden`): void => {
        onScreen.value = state === `visible`;
    };
    afterEach(() => setVisibility(`visible`));
    // Which calls were for this chat, compared as booleans: a failed match would otherwise print whole conversations.
    const hydrated = (chat: Chat): boolean[] => hydrateOnce.mock.calls.map(([called]) => called === chat);

    it(`attaches as soon as a pane shows it, though the tab was hydrated long ago`, () => {
        const chat = new Conversation(`a`);
        roster.value = { a: { status: `awaiting`, attention: { question: true } } };

        attach(chat);

        expect(hydrated(chat)).toEqual([true]);
        expect(chat.registered.value).toBe(true);
    });

    it(`attaches when a pane switches to it, and when the page comes back into view`, async () => {
        const other = new Conversation(`b`);
        const chat = new Conversation(`a`);
        // Both chats are on the roster, so the switch itself is no roster transition.
        roster.value = { a: { status: `awaiting`, attention: { plan: true } }, b: { status: `idle` } };
        const pane = attach(other);
        expect(hydrateOnce).not.toHaveBeenCalled();

        pane.conversation.value = chat;
        await nextTick();
        expect(hydrated(chat)).toEqual([true]);

        setVisibility(`hidden`);
        await nextTick();
        setVisibility(`visible`);
        await nextTick();
        expect(hydrated(chat)).toEqual([true, true]);
    });

    it(`fetches nothing while its stream is live or the card is already on screen`, async () => {
        const chat = new Conversation(`a`);
        const pane = attach(chat);
        pane.streaming.value = true;
        roster.value = { a: { status: `awaiting`, attention: { plan: true } } };
        await nextTick();
        expect(hydrateOnce).not.toHaveBeenCalled();

        pane.streaming.value = false;
        chat.transcript.restoreMessages([{ role: `assistant`, text: ``, plan: { requestId: `r1`, text: `# Plan`, status: `pending` } }]);
        expect(chat.transcript.awaitingDecision.value).toBe(true);
        // A tick between, or the watcher sees the page as it was and the return proves nothing.
        setVisibility(`hidden`);
        await nextTick();
        setVisibility(`visible`);
        await nextTick();
        expect(hydrateOnce).not.toHaveBeenCalled();
    });

    it(`leaves a chat that waits on nobody alone`, () => {
        const chat = new Conversation(`a`);
        roster.value = { a: { status: `idle` } };

        attach(chat);

        expect(hydrateOnce).not.toHaveBeenCalled();
    });
});

// A frozen page drops its streams: a phone woke on two running agents whose chats opened empty until the app was
// relaunched, and a PC woke on chats that would not open for minutes. Coming back into view is what asks again.
describe(`a page coming back into view`, () => {
    const setShown = async (shown: boolean): Promise<void> => {
        onScreen.value = shown;
        await nextTick();
    };
    afterEach(() => {
        onScreen.value = true;
    });
    const called = (mock: typeof hydrateOnce, chat: Chat): boolean[] => mock.mock.calls.map(([asked]) => asked === chat);

    it(`attaches again to a turn the card says is running, which the sleep cut this pane off from`, async () => {
        const chat = new Conversation(`a`);
        roster.value = { a: { status: `running`, run: `r1` } };
        attach(chat);
        hydrateOnce.mockClear();

        await setShown(false);
        await setShown(true);

        expect(called(hydrateOnce, chat)).toEqual([true]);
        expect(refreshAfterSleep).not.toHaveBeenCalled();
    });

    it(`leaves a settled chat alone after a short hide, and a chat whose own stream is live`, async () => {
        const settled = new Conversation(`a`);
        roster.value = { a: { status: `idle` }, b: { status: `running`, run: `r1` } };
        const pane = attach(settled);
        await setShown(false);
        await setShown(true);
        expect(hydrateOnce).not.toHaveBeenCalled();

        pane.conversation.value = new Conversation(`b`);
        pane.streaming.value = true;
        await nextTick();
        hydrateOnce.mockClear();
        await setShown(false);
        await setShown(true);
        expect(hydrateOnce).not.toHaveBeenCalled();
    });

    it(`asks for the whole chat again after a long sleep, whatever its card says`, async () => {
        const clock = jest.spyOn(Date, `now`).mockReturnValue(1_000_000);
        try {
            const chat = new Conversation(`a`);
            roster.value = { a: { status: `idle` } };
            attach(chat);
            await setShown(false);
            clock.mockReturnValue(1_000_000 + 5 * 60_000);
            await setShown(true);

            expect(called(refreshAfterSleep, chat)).toEqual([true]);
            expect(hydrateOnce).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
        }
    });

    // A PC left open overnight woke with the page on screen the whole time: no visibility change, only a clock that jumped.
    it(`asks for the whole chat again when its clock jumped a long sleep while on screen, and not for time that passed awake`, () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(1_000_000);
            const chat = new Conversation(`a`);
            roster.value = { a: { status: `idle` } };
            attach(chat);

            // Ten minutes awake: every beat on time.
            jest.advanceTimersByTime(10 * 60_000);
            expect(refreshAfterSleep).not.toHaveBeenCalled();

            // Asleep: the clock moves and no timer runs until the machine wakes.
            jest.setSystemTime(Date.now() + 6 * 60_000);
            jest.advanceTimersByTime(30_000);
            expect(called(refreshAfterSleep, chat)).toEqual([true]);
            expect(hydrateOnce).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it(`counts a page the back-forward cache restored as coming back, and a fresh page load as nothing`, async () => {
        const chat = new Conversation(`a`);
        roster.value = { a: { status: `running`, run: `r1` } };
        attach(chat);
        hydrateOnce.mockClear();
        const pageshow = (persisted: boolean): Event => Object.defineProperty(new Event(`pageshow`), `persisted`, { value: persisted });

        window.dispatchEvent(pageshow(false));
        expect(hydrateOnce).not.toHaveBeenCalled();
        window.dispatchEvent(pageshow(true));
        expect(called(hydrateOnce, chat)).toEqual([true]);
    });
});
