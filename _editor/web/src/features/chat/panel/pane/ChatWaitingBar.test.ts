import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, h, nextTick } from "vue";
import { type AgentStanding, NO_ATTENTION } from "../../../agents/fleet/agentStatus";
import * as sessionsOriginal from "../../run/useChat-sessions";

// What waits on the reader, pinned over the composer: the card the agent is parked on, before and after this window drew
// it, the plan's answers there, and a message held for memory, worded as held.

const retryHydrate = jest.fn();
jest.mock("../../run/useChat-sessions", () => ({ ...sessionsOriginal, retryHydrate }));

const { Conversation } = await import("../../session/conversation");
const { conversationView, PANE_VIEW } = await import("../useChat-view");
const { default: ChatWaitingBar } = await import("./ChatWaitingBar.vue");
type Chat = InstanceType<typeof Conversation>;

let unmount: (() => void) | undefined;
const mountBar = (chat: Chat, card?: AgentStanding) => {
    const view = conversationView(
        computed(() => chat),
        () => card,
    );
    const element = document.createElement(`div`);
    const approve = jest.fn();
    const keepPlanning = jest.fn();
    const app = createApp({ render: () => h(ChatWaitingBar, { canDrive: true, onApprove: approve, onKeepPlanning: keepPlanning }) });
    app.provide(PANE_VIEW, view);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    unmount = () => app.unmount();
    // Each pinned row as its line, then its presses.
    const squash = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/gu, ` `).trim() ?? ``;
    const rows = (): string[][] =>
        [...element.querySelectorAll(`[role="status"]`)].map((row) => [squash(row.querySelector(`.flex-1`)), ...[...row.querySelectorAll(`button`)].map(squash)]);
    const press = (label: string): void => [...element.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)?.click();
    return { view, element, approve, keepPlanning, rows, press };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    retryHydrate.mockClear();
    resetSandboxScope();
});

describe(`a card the agent is parked on`, () => {
    it(`stands on the agents list's word before the card is drawn, and asks for the card on Show`, async () => {
        const chat = new Conversation(`c1`);
        const bar = mountBar(chat, { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } });
        await nextTick();

        expect(bar.rows()).toEqual([[`Question for you · getting it from your sandbox…`, `Show it`]]);
        bar.press(`Show it`);
        expect(retryHydrate.mock.calls.map(([called]) => called === chat)).toEqual([true]);
    });

    it(`names a drawn plan and offers its answers, approving with the notes in the box`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt([
            { id: 1, role: `user`, text: `plan it` },
            { id: 2, role: `assistant`, text: ``, plan: { requestId: `d1`, text: `# Ship the importer\n\nSteps.`, status: `pending` } },
        ]);
        const bar = mountBar(chat);
        await nextTick();

        expect(bar.rows()).toEqual([[`Plan waiting for your approval · Ship the importer`, `Approve`, `Keep planning`, `Read plan`]]);
        chat.draft.value = `use the v2 endpoint`;
        await nextTick();
        bar.press(`Approve with these notes`);
        bar.press(`Keep planning`);

        expect(bar.approve).toHaveBeenCalledTimes(1);
        expect(bar.keepPlanning).toHaveBeenCalledTimes(1);
    });

    // "Read plan" goes to the card where it is drawn, the newest one live in this pane.
    it(`scrolls to the drawn card on Read plan`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt([
            { id: 1, role: `user`, text: `plan it` },
            { id: 2, role: `assistant`, text: ``, plan: { requestId: `d1`, text: `# Ship the importer\n\nSteps.`, status: `pending` } },
        ]);
        const bar = mountBar(chat);
        const pane = document.createElement(`div`);
        pane.className = `chat-pane`;
        const card = document.createElement(`div`);
        card.dataset[`cardLive`] = ``;
        const scrolled = jest.fn();
        card.scrollIntoView = scrolled;
        pane.append(card, bar.element);
        document.body.append(pane);
        await nextTick();

        bar.press(`Read plan`);
        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(retryHydrate).not.toHaveBeenCalled();
        pane.remove();
    });

    it(`says nothing for a chat that waits on nobody`, async () => {
        const bar = mountBar(new Conversation(`c1`), { status: `idle`, attention: NO_ATTENTION });
        await nextTick();

        expect(bar.rows()).toEqual([]);
    });
});

// The held message sat at the transcript's foot, out of view, and the board called it an error: here it is held, with
// the figures, and the two ways on.
describe(`a message held for low memory`, () => {
    const SENTENCE = `Sandbox memory is low: 4.9 GiB resident + 2.4 GiB swapped, against 8.0 GiB. Starting another agent now can slow the running ones down.`;

    it(`says held with the figures, sends on Send anyway, and folds away on Wait`, async () => {
        const chat = new Conversation(`c1`);
        chat.queue.value = { items: [{ id: `m-1`, text: `make it pass antivirus`, voice: `person`, queuedAt: 1_000, revision: 1 }], revision: 1, paused: `refused` };
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const bar = mountBar(chat, { status: `error`, attention: NO_ATTENTION, failureCode: `sandbox-memory-low`, failure: SENTENCE });
        await nextTick();

        expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB)`, `Send anyway`, `Wait`]]);
        bar.press(`Send anyway`);
        expect(resume).toHaveBeenCalledTimes(1);

        bar.press(`Wait`);
        await nextTick();
        expect(bar.rows()).toEqual([]);
    });
});
