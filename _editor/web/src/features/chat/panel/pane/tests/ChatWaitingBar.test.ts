import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, h, nextTick } from "vue";
import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { AgentStanding } from "../../../../../models/agent-status/agentStatus-standing";

// What waits on the reader, pinned over the composer: a message held for memory, worded as held. Every ask the agent
// made of the reader stands in the dock beside it, which has its own suite (asks/tests/ChatAskDock.test.ts).

const { Conversation } = await import("../../../../../models/conversations/session/conversation");
const { conversationView, PANE_VIEW } = await import("../../../../../models/conversations/panel/useChat-view");
const { default: ChatWaitingBar } = await import("../ChatWaitingBar.vue");
type Chat = InstanceType<typeof Conversation>;

let unmount: (() => void) | undefined;
const mountBar = (chat: Chat, card?: AgentStanding, inside?: HTMLElement, canDrive = true) => {
    const view = conversationView(
        computed(() => chat),
        () => card,
    );
    const element = document.createElement(`div`);
    inside?.append(element);
    const app = createApp({ render: () => h(ChatWaitingBar, { canDrive }) });
    app.provide(PANE_VIEW, view);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    unmount = () => app.unmount();
    // Each pinned row as its line, then its presses.
    const squash = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/gu, ` `).trim() ?? ``;
    const rows = (): string[][] =>
        [...element.querySelectorAll(`[role="status"]`)].map((row) => [
            squash(row.querySelector(`.flex-1`)),
            ...[...row.querySelectorAll(`button`)].map(squash),
        ]);
    const press = (label: string): void => [...element.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)?.click();
    return { view, element, rows, press };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    resetSandboxScope();
});

// The held message sat at the transcript's foot, out of view, and the board called it an error: here it is held, with
// the figures, and the two ways on.
describe(`a message held for low memory`, () => {
    const SENTENCE = `Sandbox memory is low: 4.9 GiB resident + 2.4 GiB swapped, against 8.0 GiB. Starting another agent now can slow the running ones down.`;
    // The card as the sandbox derives it where its answer is to send once memory frees (`next`), the one reading the bar,
    // the lane and the card's corner take.
    const sending: AgentStanding = { status: `error`, attention: NO_ATTENTION, failureCode: `sandbox-memory-low`, failure: SENTENCE, next: { kind: `room` } };

    it(`says held with the figures, sends on Send anyway, and folds away on Wait`, async () => {
        const chat = new Conversation(`c1`);
        chat.queue.value = {
            items: [{ id: `m-1`, text: `make it pass antivirus`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 1,
            paused: `refused`,
        };
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const bar = mountBar(chat, sending);
        await nextTick();

        expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB) · sends once memory frees up`, `Wait`, `Send anyway`]]);
        bar.press(`Send anyway`);
        // Only what the hold kept, as the held line's own press: a booking beside it stays on its time.
        expect(resume.mock.calls).toEqual([[[`m-1`]]]);

        bar.press(`Wait`);
        await nextTick();
        expect(bar.rows()).toEqual([]);
    });

    // Where nothing carries it on (its answer is to wait for a press), the bar promises nothing goes by itself.
    it(`says only held where the chat waits for a press`, async () => {
        const chat = new Conversation(`c1`);
        chat.queue.value = {
            items: [{ id: `m-1`, text: `make it pass antivirus`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 1,
            paused: `refused`,
        };
        const bar = mountBar(chat, { status: `error`, attention: NO_ATTENTION, failureCode: `sandbox-memory-low`, failure: SENTENCE });
        await nextTick();

        expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB)`, `Wait`, `Send anyway`]]);
    });

    // The held message's own line under it says the same hold with the same press: on screen, it is the one, and the bar
    // only stands in for it once it is scrolled away.
    it(`stays away while the held line is on screen, and stands in for it once it is scrolled out of view`, async () => {
        const chat = new Conversation(`c1`);
        chat.queue.value = {
            items: [{ id: `m-1`, text: `make it pass antivirus`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 1,
            paused: `refused`,
        };
        const box = (top: number, bottom: number) => () =>
            ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
        const scroller = document.createElement(`div`);
        scroller.className = `chat-scroller`;
        const line = document.createElement(`div`);
        line.setAttribute(`data-held-press`, ``);
        const footer = document.createElement(`div`);
        footer.className = `chat-footer`;
        scroller.append(line, footer);
        document.body.append(scroller);
        scroller.getBoundingClientRect = box(0, 800);
        footer.getBoundingClientRect = box(600, 800);
        line.getBoundingClientRect = box(560, 580);
        try {
            const bar = mountBar(chat, sending, footer);
            await nextTick();
            await nextTick();
            expect(bar.rows()).toEqual([]);

            line.getBoundingClientRect = box(900, 920);
            scroller.dispatchEvent(new Event(`scroll`));
            await new Promise((done) => requestAnimationFrame(() => done(undefined)));
            await nextTick();
            expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB) · sends once memory frees up`, `Wait`, `Send anyway`]]);
        } finally {
            scroller.remove();
        }
    });
});
