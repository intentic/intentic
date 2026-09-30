import "@intentic/testing/dom";
import type { ConversationQueue } from "@intentic/sandbox-contract";
import { type App, computed, createApp, defineComponent, h } from "vue";
import { type AgentStanding, NO_ATTENTION } from "../../../agents/fleet/agentStatus";
import { conversationView, PANE_VIEW } from "../../panel/useChat-view";
import { Conversation } from "../../session/conversation";
import type { ChatMessage } from "../transcript";
import { isMemoryHold, memoryReading, useHeldQueue } from "./heldQueue";

// Which row the held message's own line stands in for: the transcript leaves exactly that one out (ChatPaneTurns), so
// a wrong answer either draws the refusal twice or hides a row nothing else says.

const MEMORY: ChatMessage = {
    id: 3,
    role: `notice`,
    text: `Sandbox memory is low: 9.5 GiB of 10.0 GiB used. Starting another agent now can slow the running ones down. Your message is held: send it again to start anyway.`,
    noticeAction: `sendAnyway`,
};
const WAITING = { id: `m1`, text: `fix the flaky test`, voice: `person`, queuedAt: 1, revision: 1 } as const;

// Mounted for as long as a test reads them: a view's readings stop with the component that made them.
const mounted: App[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
});

// The pane's reading of a conversation holding these rows and this queue, as a mounted view would read it, with the
// board's card for it when a test says what that card reports.
const readHold = (
    rows: readonly ChatMessage[],
    queue: Omit<ConversationQueue, `revision`> | undefined,
    card?: Pick<AgentStanding, `failureCode` | `failure`>,
): ReturnType<typeof useHeldQueue> => {
    const chat = new Conversation(`c1`);
    chat.transcript.adopt([{ id: 1, role: `user`, text: `start` }, ...rows]);
    chat.queue.value = queue === undefined ? undefined : { revision: 1, ...queue };
    let hold: ReturnType<typeof useHeldQueue> | undefined;
    const app = createApp(
        defineComponent({
            setup: () => {
                hold = useHeldQueue();
                return () => h(`div`);
            },
        }),
    );
    app.provide(
        PANE_VIEW,
        conversationView(
            computed(() => chat),
            card === undefined ? undefined : () => ({ status: `error`, attention: NO_ATTENTION, ...card }),
        ),
    );
    app.mount(document.createElement(`div`));
    mounted.push(app);
    return hold!;
};

describe(`the row a held message's line stands in for`, () => {
    it(`is the low-memory row, while the queue it refused still holds its words`, () => {
        const hold = readHold([MEMORY], { items: [WAITING], paused: `refused` });

        expect(hold.held.value).toBe(true);
        expect(hold.notice.value?.id).toBe(3);
        expect(hold.reason.value).toBe(`memory`);
        expect(hold.detail.value).toBe(`Sandbox memory is low: 9.5 GiB of 10.0 GiB used.`);
    });

    it(`is no row once something followed it, and the reason falls back to the refusal itself`, () => {
        const hold = readHold([MEMORY, { id: 4, role: `notice`, text: `Changes landed in your workspace.` }], { items: [WAITING], paused: `refused` });

        expect(hold.notice.value).toBeUndefined();
        expect(hold.reason.value).toBe(`refused`);
    });

    // This window's own notice (the divider an account pick draws) is not the conversation moving past the refusal.
    it(`is still the low-memory row under a notice this window drew itself`, () => {
        const divider: ChatMessage = { id: 4, role: `notice`, text: `Switched to Claude: your next message starts a fresh session.`, local: true };
        const hold = readHold([MEMORY, divider], { items: [WAITING], paused: `refused` });

        expect(hold.notice.value?.id).toBe(3);
        expect(hold.reason.value).toBe(`memory`);
    });

    it(`is no row for a turn the sandbox kept, whose row carries its own press`, () => {
        const hold = readHold([{ ...MEMORY, sandboxHeld: true }], { items: [WAITING], paused: `refused` });

        expect(hold.notice.value).toBeUndefined();
    });

    it(`is no row when nothing is held, whatever the transcript ends on`, () => {
        expect(readHold([MEMORY], { items: [WAITING] }).held.value).toBe(false);
        expect(readHold([MEMORY], { items: [WAITING] }).notice.value).toBeUndefined();
        expect(readHold([MEMORY], { items: [], paused: `refused` }).notice.value).toBeUndefined();
        expect(readHold([MEMORY], undefined).held.value).toBe(false);
    });

    // A turn that ran nothing is never recorded and is attachable for a minute: a chat opened after that has no row,
    // and the board's card is the one word left on why.
    it(`says it was memory from the board's card once the refusal's row is gone, with the card's reading`, () => {
        const card = { failureCode: `sandbox-memory-low`, failure: `Sandbox memory is low: 15.0 GiB of 16.0 GiB used. Starting another agent now can slow the running ones down.` };
        const hold = readHold([{ id: 2, role: `assistant`, text: `Done.` }], { items: [WAITING], paused: `refused` }, card);

        expect(hold.reason.value).toBe(`memory`);
        expect(hold.detail.value).toBe(`Sandbox memory is low: 15.0 GiB of 16.0 GiB used.`);
        // No row stands in for it, so none is left out.
        expect(hold.notice.value).toBeUndefined();
    });

    it(`takes the card's word only for a refusal, and only for memory`, () => {
        const memory = { failureCode: `sandbox-memory-low`, failure: `Sandbox memory is low.` };
        expect(readHold([], { items: [WAITING], paused: `stopped` }, memory).reason.value).toBe(`stopped`);
        expect(readHold([], { items: [WAITING], paused: `refused` }, { failureCode: `trial-exhausted`, failure: `Spent.` }).reason.value).toBe(`refused`);
        expect(readHold([], { items: [WAITING], paused: `refused` }, { failureCode: `trial-exhausted`, failure: `Spent.` }).detail.value).toBeUndefined();
    });

    it(`says a stop held it when the queue says so`, () => {
        const hold = readHold([{ id: 3, role: `notice`, text: `Stopped.` }], { items: [WAITING], paused: `stopped` });

        expect(hold.reason.value).toBe(`stopped`);
        expect(hold.notice.value).toBeUndefined();
    });
});

describe(`a low-memory row`, () => {
    it(`is one only by the press the sandbox gave it`, () => {
        expect(isMemoryHold(MEMORY)).toBe(true);
        expect(isMemoryHold({ ...MEMORY, noticeAction: `sandboxMemory` })).toBe(true);
        expect(isMemoryHold({ ...MEMORY, noticeAction: `sendAgain` })).toBe(false);
        expect(isMemoryHold({ id: 5, role: `user`, text: `Sandbox memory is low` })).toBe(false);
    });

    // A hover label is a few lines long: the reading is what it has room for, and the press carries the stakes.
    it(`reads as what was short, up to its first full stop`, () => {
        expect(memoryReading(MEMORY.text)).toBe(`Sandbox memory is low: 9.5 GiB of 10.0 GiB used.`);
        expect(memoryReading(`The sandbox is short of memory: for 45% of the last ten seconds, everything in it was waiting on memory`)).toBe(
            `The sandbox is short of memory: for 45% of the last ten seconds, everything in it was waiting on memory`,
        );
    });
});
