import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { IconStub } from "@intentic/ui/testing";
import { computed, createApp, defineComponent, h, inject, nextTick, ref } from "vue";
import { CARD_HEADER_TAIL, CARD_TITLE_PRESS } from "../../../../../components/ChatCard.vue";
import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { AgentStanding } from "../../../../../models/agent-status/agentStatus-standing";
import type { ChatMessage } from "../../../../../models/conversations/transcript/transcript";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import * as sessionsOriginal from "../../../../../models/conversations/run/useChat-sessions";

// The asks in the dock above the composer: a line each in the order asked, the open one answered in place, a plan's
// answers at the end of its line. The cards themselves are their own suites'; here each stands in as its request id and
// one answer, and says what the dock hands its head: the word for what it is, the press to where it was asked, the fold.

const retryHydrate = jest.fn();
jest.mock("../../../../../models/conversations/run/useChat-sessions", () => ({ ...sessionsOriginal, retryHydrate }));
jest.mock("../../../../../models/needs/useNeeds", () => ({ useNeeds: () => ({ openFor: () => computed(() => []), byId: () => undefined }) }));
const fleet = ref<FleetAgent[]>([]);
jest.mock("../../../../../models/fleet/useAgents", () => ({
    useAgents: () => ({ fleet, agentById: (id: string) => fleet.value.find((agent) => agent.id === id) }),
}));
const StandIn = defineComponent({
    props: { message: { type: Object, required: true }, reply: { type: Function, required: true } },
    setup: (props) => {
        const head = inject(CARD_TITLE_PRESS, undefined);
        const tail = inject(CARD_HEADER_TAIL, undefined);
        return () => {
            const message: Partial<ChatMessage> = props.message;
            const requestId = message.question?.requestId ?? message.permission?.requestId ?? ``;
            const opens = head?.value;
            return h(`div`, { "data-card": requestId, "data-kind": opens?.kind }, [
                opens === undefined ? null : h(`button`, { "aria-label": opens.label, onClick: opens.press }),
                h(`button`, { onClick: () => props.reply({ kind: `permission`, decision: `once` }) }, `Answer ${requestId}`),
                tail?.value === undefined ? null : h(tail.value),
            ]);
        };
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
    // The row the ask was made in, for the press that brings it on screen.
    const askedIn = (key: string): HTMLElement => {
        const row = document.createElement(`div`);
        row.dataset[`askRow`] = key;
        const scroller = document.createElement(`div`);
        scroller.className = `chat-scroller`;
        scroller.append(row);
        pane.prepend(scroller);
        scroller.scrollBy = jest.fn();
        row.animate = jest.fn();
        return row;
    };
    return {
        pane,
        pin,
        approve,
        keepPlanning,
        askedIn,
        dock: (): Dock => dock!,
        // What a screen reader names the dock by.
        label: (): string => root()?.getAttribute(`aria-label`) ?? ``,
        // Every line the dock draws, in order, as a reader sees it: what it is, its words, its presses.
        lines: (): string[] => [...(root()?.querySelectorAll(`[data-ask-line]`) ?? [])].map(squash),
        body: (): string => squash(element.querySelector(`[data-ask-body]`)),
        // What the dock hands the open card's head: the word for what it is, and the presses it ends on.
        head: () => {
            const open = element.querySelector<HTMLElement>(`[data-ask-body] [data-card]`);
            return {
                kind: open?.dataset[`kind`],
                presses: [...(open?.querySelectorAll(`button[aria-label]`) ?? [])].map((button) => button.getAttribute(`aria-label`) ?? ``),
            };
        },
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
    it(`are a line each, oldest first, the oldest open and answered in place, and the turn followed after`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS);
        const reply = jest.spyOn(chat.requests, `reply`).mockResolvedValue(true);
        const dock = mountDock(chat);
        await nextTick();

        expect(dock.label()).toBe(`Waiting on you`);
        expect(dock.lines()).toEqual([`Answer r1`, `Question Which licence?`]);
        // Its card is drawn here, so the row it was asked in draws only a stub.
        expect(dock.dock().holds(`card:r1`)).toBe(true);

        dock.press(`Answer r1`);
        await Promise.resolve();
        await Promise.resolve();
        expect(reply.mock.calls.map(([requestId]) => requestId)).toEqual([`r1`]);
        expect(dock.pin).toHaveBeenCalledTimes(1);
    });

    it(`open the one whose title is pressed, folding the one that was open to its line, and fold that one in turn`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS);
        const dock = mountDock(chat);
        await nextTick();

        dock.press(`Which licence?`);
        await nextTick();
        expect(dock.lines()).toEqual([`Permission Run a command`, `Answer q1`]);

        dock.press(`Fold`);
        await nextTick();
        expect(dock.body()).toBe(``);
        expect(dock.lines()).toEqual([`Permission Run a command`, `Question Which licence?`]);
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
        expect(dock.lines()).toEqual([`Permission Run a command`, `Answer r2`]);
    });

    it(`stand on the agents list's word before the card is drawn, and ask for the card on Show it`, async () => {
        const chat = new Conversation(`c1`);
        const dock = mountDock(chat, { card: { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } } });
        await nextTick();

        expect(dock.lines()).toEqual([`Question Getting it from your sandbox… Show it`]);
        dock.press(`Show it`);
        expect(retryHydrate.mock.calls.map(([called]) => called === chat)).toEqual([true]);
    });

    it(`say nothing for a chat that waits on nobody`, async () => {
        const dock = mountDock(new Conversation(`c1`), { card: { status: `idle`, attention: NO_ATTENTION } });
        await nextTick();
        expect(dock.label()).toBe(``);
        expect(dock.lines()).toEqual([]);
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

        expect(dock.lines()).toEqual([`Answer r1`, `Permission Child k1 Open chat`]);
    });
});

describe(`a plan`, () => {
    it(`is answered at the end of its line, with the notes in the box, and read where it was asked from its title`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(PLAN);
        const dock = mountDock(chat);
        const row = dock.askedIn(`card:d1`);
        await nextTick();

        // Its body stays in the transcript, where it is read: the dock carries its answers, the bright one last.
        expect(dock.dock().holds(`card:d1`)).toBe(false);
        chat.draft.value = `use the v2 endpoint`;
        await nextTick();
        expect(dock.lines()).toEqual([`Plan Ship the importer Keep planning Approve with these notes`]);
        dock.press(`Approve with these notes`);
        dock.press(`Keep planning`);
        expect(dock.approve).toHaveBeenCalledTimes(1);
        expect(dock.keepPlanning).toHaveBeenCalledTimes(1);

        dock.press(`Ship the importer`);
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

        expect(dock.label()).toBe(`Waiting on someone who runs agents`);
        expect(dock.lines()).toEqual([`Plan Ship the importer Waiting on someone who runs agents to answer.`]);
    });
});

describe(`the open card's head`, () => {
    // Opening a line moves nothing on it: the card heads itself with the line's own word, its title, and its fold.
    it(`is its line's: the same word for what it is, its title going to where it was asked, and the fold that closes it`, async () => {
        const chat = new Conversation(`c1`);
        chat.transcript.adopt(ROWS);
        const dock = mountDock(chat);
        const row = dock.askedIn(`card:r1`);
        await nextTick();

        expect(dock.head()).toEqual({ kind: `Permission`, presses: [`Show in chat`, `Fold`] });
        dock.press(`Show in chat`);
        await nextTick();
        expect(row.animate).toHaveBeenCalledTimes(2);
    });
});
