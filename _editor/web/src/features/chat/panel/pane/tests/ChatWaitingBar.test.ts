import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, h, nextTick, ref } from "vue";
import { type AgentStanding, NO_ATTENTION } from "../../../../agents/fleet/agentStatus";
import * as agentsOriginal from "../../../../agents/fleet/useAgents";
import * as sessionsOriginal from "../../../run/useChat-sessions";

// What waits on the reader, pinned over the composer: the card the agent is parked on, before and after this window drew
// it, the plan's answers there, and a message held for memory, worded as held.

const retryHydrate = jest.fn();
jest.mock("../../../run/useChat-sessions", () => ({ ...sessionsOriginal, retryHydrate }));

// This conversation's own answer to the memory wall, as the roster carries it; absent, the wall's default (send once
// memory frees up) answers, since the sandbox's settings are not loaded here.
const memoryOverride = ref<`wait` | `resend` | undefined>();
const realUseAgents = agentsOriginal.useAgents;
jest.mock("../../../../agents/fleet/useAgents", () => ({
    ...agentsOriginal,
    useAgents: () => ({ ...realUseAgents(), agentById: () => (memoryOverride.value === undefined ? undefined : { memoryPolicy: memoryOverride.value }) }),
}));

const { Conversation } = await import("../../../session/conversation");
const { conversationView, PANE_VIEW } = await import("../../useChat-view");
const { default: ChatWaitingBar } = await import("../ChatWaitingBar.vue");
type Chat = InstanceType<typeof Conversation>;

let unmount: (() => void) | undefined;
const mountBar = (chat: Chat, card?: AgentStanding, inside?: HTMLElement) => {
    const view = conversationView(
        computed(() => chat),
        () => card,
    );
    const element = document.createElement(`div`);
    inside?.append(element);
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
        [...element.querySelectorAll(`[role="status"]`)].map((row) => [
            squash(row.querySelector(`.flex-1`)),
            ...[...row.querySelectorAll(`button`)].map(squash),
        ]);
    const press = (label: string): void => [...element.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)?.click();
    return { view, element, approve, keepPlanning, rows, press };
};

afterEach(() => {
    memoryOverride.value = undefined;
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

    // "Read plan" goes to this plan's own card, wherever it is drawn: not the newest card live in the pane (an offer pinned
    // under it), and not by scrolling alone, which moved nothing for a card already on screen.
    it(`goes to the plan's own card on Read plan, and gives it the keyboard`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt([
            { id: 1, role: `user`, text: `plan it` },
            { id: 2, role: `assistant`, text: ``, plan: { requestId: `d1`, text: `# Ship the importer\n\nSteps.`, status: `pending` } },
        ]);
        const bar = mountBar(chat);
        const pane = document.createElement(`div`);
        pane.className = `chat-pane`;
        // Each card in its row, as ChatMessageView draws it, the plan's first and a newer one under it.
        const cardIn = (requestId: string) => {
            const row = document.createElement(`div`);
            row.dataset[`cardRequest`] = requestId;
            const card = document.createElement(`div`);
            card.dataset[`cardLive`] = ``;
            const scrolled = jest.fn();
            card.scrollIntoView = scrolled;
            row.append(card);
            pane.append(row);
            return { card, scrolled };
        };
        const plan = cardIn(`d1`);
        const newer = cardIn(`offer-2`);
        pane.append(bar.element);
        document.body.append(pane);
        await nextTick();

        bar.press(`Read plan`);
        expect(plan.scrolled).toHaveBeenCalledTimes(1);
        expect(newer.scrolled).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(plan.card);
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
        chat.queue.value = {
            items: [{ id: `m-1`, text: `make it pass antivirus`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 1,
            paused: `refused`,
        };
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const bar = mountBar(chat, { status: `error`, attention: NO_ATTENTION, failureCode: `sandbox-memory-low`, failure: SENTENCE });
        await nextTick();

        expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB) · sends once memory frees up`, `Send anyway`, `Wait`]]);
        bar.press(`Send anyway`);
        // Only what the hold kept, as the held line's own press: a booking beside it stays on its time.
        expect(resume.mock.calls).toEqual([[[`m-1`]]]);

        bar.press(`Wait`);
        await nextTick();
        expect(bar.rows()).toEqual([]);
    });

    // Where the chat's answer is to wait for a press, the bar promises nothing goes by itself.
    it(`says only held where the chat waits for a press`, async () => {
        memoryOverride.value = `wait`;
        const chat = new Conversation(`c1`);
        chat.queue.value = {
            items: [{ id: `m-1`, text: `make it pass antivirus`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 1,
            paused: `refused`,
        };
        const bar = mountBar(chat, { status: `error`, attention: NO_ATTENTION, failureCode: `sandbox-memory-low`, failure: SENTENCE });
        await nextTick();

        expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB)`, `Send anyway`, `Wait`]]);
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
            const bar = mountBar(chat, { status: `error`, attention: NO_ATTENTION, failureCode: `sandbox-memory-low`, failure: SENTENCE }, footer);
            await nextTick();
            await nextTick();
            expect(bar.rows()).toEqual([]);

            line.getBoundingClientRect = box(900, 920);
            scroller.dispatchEvent(new Event(`scroll`));
            await new Promise((done) => requestAnimationFrame(() => done(undefined)));
            await nextTick();
            expect(bar.rows()).toEqual([[`Held: sandbox memory is low (4.9/8.0 GiB) · sends once memory frees up`, `Send anyway`, `Wait`]]);
        } finally {
            scroller.remove();
        }
    });
});
