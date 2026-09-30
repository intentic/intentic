// Needs jsdom: what this pins is which lines a pending plan draws under itself, which only a render shows.
import "@intentic/testing/dom";
import { type AgentEvent, type Need, NeedSchema } from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, h, ref } from "vue";
import type { ChatMessage } from "../transcript";

// The pane this card is drawn in, the markdown it renders (not what this suite is about) and the needs store.
const open = ref<readonly Need[]>([]);
jest.mock("../../panel/useChat-view", () => ({ usePaneView: () => ({ conversation: ref({ conversationId: `conv-plan`, scope: ref(undefined) }) }) }));
jest.mock("../../../../lib/markdown/useMarkdown", () => ({ useMarkdown: () => ref([]) }));
jest.mock("../../../needs/useNeeds", () => ({ useNeeds: () => ({ openFor: () => computed(() => open.value) }) }));

const { default: ChatPlanCard } = await import("./ChatPlanCard.vue");

const needOf = (id: string, title: string, subject: Need["subject"]): Need =>
    NeedSchema.parse({ id, conversationId: `conv-plan`, subject, title, status: `open`, createdAt: 1, updatedAt: 1 });

// A plan as the daemon's own fold leaves it: pending, or answered.
const planRow = (answered: boolean): ChatMessage => {
    const fold = new TranscriptFold([userRow(`add checkout`, 1, [])]);
    const frames: AgentEvent[] = [
        { kind: `plan`, requestId: `p1`, text: `# Add Stripe checkout\n\n1. Create the session route.\n2. Wire the button.` },
        ...(answered ? [{ kind: `resolved` as const, requestId: `p1`, reply: { kind: `plan` as const, requestId: `p1`, approve: true } }] : []),
    ];
    for (const frame of frames) {
        fold.apply(frame);
    }
    const row = fold.rows.find((candidate) => candidate.plan !== undefined);
    if (row === undefined) {
        throw new Error(`the fold drew no plan card`);
    }
    return { ...row, id: 2 };
};

let app: App | undefined;
const render = (message: ChatMessage): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    // Mounted as ChatMessageView mounts every card, with the shared answer props this one leaves to the bar.
    app = createApp({ render: () => h(ChatPlanCard, { message, settling: false, reply: async () => {} }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};
// The needs line's own sentences, in order: the heading, one per need, the hint.
const needsLine = (element: HTMLElement): readonly string[] =>
    [...element.querySelectorAll(`.chat-card-row > span`)].map((span) => span.textContent?.trim() ?? ``);

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    open.value = [];
});

it(`a pending plan names what the conversation still waits on people for, so both are answered in one sitting`, () => {
    open.value = [
        needOf(`need-1`, `The STRIPE_SECRET_KEY secret`, { kind: `secret`, name: `STRIPE_SECRET_KEY` }),
        needOf(`need-2`, `Add ffmpeg to the sandbox image`, { kind: `environment`, tool: `ffmpeg`, steps: `RUN true` }),
    ];
    expect(needsLine(render(planRow(false)))).toEqual([
        `This plan also needs 2 things from you:`,
        `The STRIPE_SECRET_KEY secret`,
        `Add ffmpeg to the sandbox image`,
        `Answer them on their cards, pinned above the message box: the steps that need them wait, the rest can start now.`,
    ]);
});

it(`one need reads in the singular`, () => {
    open.value = [needOf(`need-1`, `The STRIPE_SECRET_KEY secret`, { kind: `secret`, name: `STRIPE_SECRET_KEY` })];
    expect(needsLine(render(planRow(false)))[0]).toBe(`This plan also needs one thing from you:`);
});

it(`says nothing when nothing is waiting, or once the plan is answered`, () => {
    expect(needsLine(render(planRow(false)))).toEqual([]);
    app?.unmount();
    open.value = [needOf(`need-1`, `The STRIPE_SECRET_KEY secret`, { kind: `secret`, name: `STRIPE_SECRET_KEY` })];
    expect(needsLine(render(planRow(true)))).toEqual([]);
});

// Its answers are the bar's over the composer (ChatWaitingBar), where they carry the box's notes: the card has none, and
// the shared props it is handed do not land on it as attributes.
it(`a pending plan draws no answers of its own`, () => {
    const element = render(planRow(false));
    expect(element.querySelectorAll(`button`)).toHaveLength(0);
    expect(element.querySelector(`[reply], [settling]`)).toBeNull();
    expect(element.querySelector(`[data-card-live]`)).not.toBeNull();
});
