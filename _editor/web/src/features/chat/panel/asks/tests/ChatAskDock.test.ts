import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { AgentStanding } from "../../../../../models/agent-status/agentStatus-standing";
import type { ChatMessage } from "../../../../../models/conversations/transcript/transcript";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import * as sessionsOriginal from "../../../../../models/conversations/run/useChat-sessions";

// The dock above the composer: every ask this chat waits on, how many, one chip each in the order asked, and the open one
// answered in place. The cards themselves are their own suites'; here each stands in as its request id and one answer.

const retryHydrate = jest.fn();
jest.mock("../../../../../models/conversations/run/useChat-sessions", () => ({ ...sessionsOriginal, retryHydrate }));
jest.mock("../../../../../models/needs/useNeeds", () => ({ useNeeds: () => ({ openFor: () => computed(() => []), byId: () => undefined }) }));
const fleet = ref<FleetAgent[]>([]);
jest.mock("../../../../../models/fleet/useAgents", () => ({
    useAgents: () => ({ fleet, agentById: (id: string) => fleet.value.find((agent) => agent.id === id) }),
}));
const StandIn = defineComponent({
    props: { message: { type: Object, required: true }, reply: { type: Function, required: true } },
    setup: (props) => () => {
        const message: Partial<ChatMessage> = props.message;
        const requestId = message.question?.requestId ?? message.permission?.requestId ?? ``;
        return h(`div`, { "data-card": requestId }, [h(`button`, { onClick: () => props.reply({ kind: `permission`, decision: `once` }) }, `Answer ${requestId}`)]);
    },
});
jest.mock("../../../transcript/cards/cardComponents", () => ({ CARDS: { question: StandIn, permission: StandIn } }));

const { Conversation } = await import("../../../../../models/conversations/session/conversation");
const { conversationView, PANE_VIEW } = await import("../../../../../models/conversations/panel/useChat-view");
const { provideAskDock } = await import("../askDock");
const { default: ChatAskDock } = await import("../ChatAskDock.vue");
type Chat = InstanceType<typeof Conversation>;
type Dock = ReturnType<typeof provideAskDock>;

const QUESTION = { header: ``, multiSelect: false, options: [{ label: `MIT`, description: `` }] };
const ROWS: ChatMessage[] = [
    { id: 1, role: `user`, text: `ship it` },
    { id: 2, role: `assistant`, text: ``, permission: { requestId: `r1`, toolName: `Bash`, displayName: `Run a command`, status: `pending` } },
    { id: 3, role: `assistant`, text: ``, question: { requestId: `q1`, questions: [{ ...QUESTION, question: `Which licence?` }], status: `pending` } },
];
const PLAN: ChatMessage[] = [
    { id: 1, role: `user`, text: `plan it` },
    { id: 2, role: `assistant`, text: ``, plan: { requestId: `d1`, text: `# Ship the importer\n\nSteps.`, status: `pending` } },
];

let unmount: (() => void) | undefined;
const mountDock = (chat: Chat, { card, canDrive = true }: { card?: AgentStanding; canDrive?: boolean } = {}) => {
    const view = conversationView(
        computed(() => chat),
        () => card,
    );
    const pin = jest.fn();
    const approve = jest.fn();
    const keepPlanning = jest.fn();
    let dock: Dock | undefined;
    const pane = document.createElement(`div`);
    pane.className = `chat-pane`;
    const element = document.createElement(`div`);
    pane.append(element);
    document.body.append(pane);
    const Host = defineComponent({
        setup: () => {
            dock = provideAskDock({ view, canDrive: () => canDrive, pin });
            return () => h(ChatAskDock, { onApprove: approve, onKeepPlanning: keepPlanning });
        },
    });
    const app = createApp(Host);
    app.provide(PANE_VIEW, view);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    unmount = () => {
        app.unmount();
        pane.remove();
    };
    // Each piece of text a reader sees, a space between: the template sets none between elements.
    const squash = (node: Element | null | undefined): string => {
        if (node === null || node === undefined) {
            return ``;
        }
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const words: string[] = [];
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
            words.push(text.textContent ?? ``);
        }
        return words.join(` `).replace(/\s+/gu, ` `).trim();
    };
    const root = (): Element | null => element.querySelector(`[data-ask-dock]`);
    return {
        pane,
        pin,
        approve,
        keepPlanning,
        dock: (): Dock => dock!,
        // The header's words, the count with them.
        headline: (): string => squash(root()?.querySelector(`.chat-card-header`)),
        // What a screen reader names the dock by.
        label: (): string => root()?.getAttribute(`aria-label`) ?? ``,
        // Every header drawn in the dock, the dock's own and the card's, and the presses each one ends on.
        headers: (): string[] => [...(root()?.querySelectorAll(`.chat-card-header`) ?? [])].map(squash),
        headerPresses: (): string[][] =>
            [...(root()?.querySelectorAll(`.chat-card-header`) ?? [])].map((header) => [...header.querySelectorAll(`button[aria-label]`)].map((button) => button.getAttribute(`aria-label`) ?? ``)),
        chips: (): string[] => [...element.querySelectorAll(`[data-ask-chip]`)].map((chip) => `${chip.getAttribute(`aria-pressed`) === `true` ? `*` : ``}${squash(chip)}`),
        body: (): string => squash(element.querySelector(`[data-ask-body]`)),
        press: (label: string): void => [...element.querySelectorAll(`button`)].find((button) => squash(button) === label || button.getAttribute(`aria-label`) === label)?.click(),
    };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    retryHydrate.mockClear();
    fleet.value = [];
    resetSandboxScope();
});

describe(`the asks a chat waits on`, () => {
    it(`are counted and listed oldest first, the oldest open and answered in place, and the turn followed after`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS);
        const reply = jest.spyOn(chat.requests, `reply`).mockResolvedValue(true);
        const dock = mountDock(chat);
        await nextTick();

        expect(dock.headline()).toBe(`Waiting on you 2`);
        expect(dock.chips()).toEqual([`*Run a command`, `Which licence?`]);
        expect(dock.body()).toBe(`Answer r1`);
        // Its card is drawn here, so the row it was asked in draws only a stub.
        expect(dock.dock().holds(`card:r1`)).toBe(true);

        dock.press(`Answer r1`);
        await Promise.resolve();
        await Promise.resolve();
        expect(reply.mock.calls.map(([requestId]) => requestId)).toEqual([`r1`]);
        expect(dock.pin).toHaveBeenCalledTimes(1);
    });

    it(`open the one whose chip is pressed, and fold on the open one's own chip`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS);
        const dock = mountDock(chat);
        await nextTick();

        dock.press(`Which licence?`);
        await nextTick();
        expect(dock.chips()).toEqual([`Run a command`, `*Which licence?`]);
        expect(dock.body()).toBe(`Answer q1`);

        dock.press(`Which licence?`);
        await nextTick();
        expect(dock.body()).toBe(``);
        expect(dock.chips()).toEqual([`Run a command`, `Which licence?`]);
    });

    // The one picked, answered, gives way to the one after it rather than jumping back to the top.
    it(`move on from an answered pick to the ask after it`, async () => {
        const chat = new Conversation(`c1`);
        const third: ChatMessage = { id: 4, role: `assistant`, text: ``, permission: { requestId: `r2`, toolName: `Edit`, displayName: `Edit a file`, status: `pending` } };
        chat.transcript.adopt([...ROWS, third]);
        const dock = mountDock(chat);
        await nextTick();
        dock.press(`Which licence?`);
        await nextTick();

        chat.transcript.adopt([ROWS[0]!, ROWS[1]!, { ...ROWS[2]!, question: { ...ROWS[2]!.question!, status: `answered` } }, third]);
        await nextTick();
        await nextTick();
        expect(dock.chips()).toEqual([`Run a command`, `*Edit a file`]);
    });

    it(`stand on the agents list's word before the card is drawn, and ask for the card on Show it`, async () => {
        const chat = new Conversation(`c1`);
        const dock = mountDock(chat, { card: { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } } });
        await nextTick();

        expect(dock.body()).toBe(`Question Getting it from your sandbox… Show it`);
        dock.press(`Show it`);
        expect(retryHydrate.mock.calls.map(([called]) => called === chat)).toEqual([true]);
    });

    it(`say nothing for a chat that waits on nobody`, async () => {
        const dock = mountDock(new Conversation(`c1`), { card: { status: `idle`, attention: NO_ATTENTION } });
        await nextTick();
        expect(dock.headline()).toBe(``);
    });

    // A child's question is its parent agent's to answer; its permission is the reader's, and is listed after the chat's own.
    it(`include a child's ask only a person can answer, after the chat's own`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS.slice(0, 2));
        // SAFETY: the dock reads a child's id, title, standing and starter alone; the rest of a card is never touched here.
        const child = (id: string, attention: Partial<FleetAgent[`attention`]>): FleetAgent =>
            ({ id, title: `Child ${id}`, status: `awaiting`, attention: { ...NO_ATTENTION, ...attention }, startedBy: `agent:c1` }) as FleetAgent;
        fleet.value = [child(`k1`, { permission: true }), child(`k2`, { question: true })];
        const dock = mountDock(chat);
        await nextTick();

        expect(dock.chips()).toEqual([`*Run a command`, `Child k1`]);
    });
});

describe(`a plan`, () => {
    it(`is answered from the dock, with the notes in the box, and read where it was asked`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(PLAN);
        const dock = mountDock(chat);
        const row = document.createElement(`div`);
        row.dataset[`askRow`] = `card:d1`;
        const scroller = document.createElement(`div`);
        scroller.className = `chat-scroller`;
        scroller.append(row);
        dock.pane.prepend(scroller);
        scroller.scrollBy = jest.fn();
        row.animate = jest.fn();
        await nextTick();

        // Its body stays in the transcript, where it is read: the dock carries its answers.
        expect(dock.dock().holds(`card:d1`)).toBe(false);
        chat.draft.value = `use the v2 endpoint`;
        await nextTick();
        dock.press(`Approve with these notes`);
        dock.press(`Keep planning`);
        expect(dock.approve).toHaveBeenCalledTimes(1);
        expect(dock.keepPlanning).toHaveBeenCalledTimes(1);

        dock.press(`Read plan`);
        await nextTick();
        // Rung where it was asked: the edge and the wash, once each.
        expect(row.animate).toHaveBeenCalledTimes(2);
    });

    // A viewer, or a writer with agents off, reads the plan but cannot answer it: told who it waits on, no answers to press.
    it(`tells a reader who cannot answer who it waits on, with no answers to press`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(PLAN);
        const dock = mountDock(chat, { canDrive: false });
        await nextTick();

        // One ask open: its own header is the dock's head, and the dock's name stays for a screen reader.
        expect(dock.headline()).toBe(`Ship the importer`);
        expect(dock.label()).toBe(`Waiting on someone who runs agents`);
        expect(dock.body()).toBe(`Ship the importer Waiting on someone who runs agents to answer. Read plan`);
    });
});

describe(`the dock's head`, () => {
    // A header of the dock's own over the one card it holds read as a box in a box: two headings over one question.
    it(`is the card's own header while it holds one ask open, with the dock's presses at its end`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(PLAN);
        const dock = mountDock(chat);
        await nextTick();

        expect(dock.headers()).toEqual([`Ship the importer`]);
        expect(dock.headerPresses()).toEqual([[`Show in chat`, `Fold`]]);
    });

    it(`is the dock's own, over the chips, while there is a choice of asks`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS);
        const dock = mountDock(chat);
        await nextTick();

        expect(dock.headers()).toEqual([`Waiting on you 2`]);
        expect(dock.headerPresses()).toEqual([[`Show in chat`, `Fold`]]);
    });

    it(`is the dock's own once folded, the one ask a chip under it`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(PLAN);
        const dock = mountDock(chat);
        await nextTick();
        dock.press(`Fold`);
        await nextTick();

        expect(dock.headers()).toEqual([`Waiting on you`]);
        expect(dock.headerPresses()).toEqual([[`Unfold`]]);
        expect(dock.chips()).toEqual([`Ship the importer`]);
    });
});
