import "@intentic/testing/dom";
import { STATE_DIR } from "@intentic/constants";
import type { ConversationQueue, QueuedMessage } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, type Directive, h, nextTick, ref } from "vue";
import { type AgentStanding, NO_ATTENTION } from "../../../agents/fleet/agentStatus";
import { conversationView, PANE_VIEW } from "../../panel/useChat-view";
import { Conversation } from "../../session/conversation";
import type { ChatMessage } from "../transcript";
import * as useSandboxOriginal from "../../../../client/sandbox/useSandbox";

// A message the sandbox held is drawn where the reader looks for what they just sent: their own prompt, with its
// picture, over ONE line that says it did not go out, why, and the one press that sends it. The notice, the bar and
// the card that each said a part of this are gone, so what is under test is that exactly one of each is on screen.

const SHOT = `${STATE_DIR}/records/artifacts/attachments/7f1c/image.png`;
const NOTES = `notes/plan.md`;

// Pictures resolve the way a sent prompt's do; a file that is not one has no picture to draw.
jest.mock("../../drafts/attachmentPreviews", () => ({
    attachmentPreview: (path: string) => (path.endsWith(`.png`) ? `blob:${path}` : undefined),
    attachmentKind: (path: string) => (path.endsWith(`.png`) ? `image` : undefined),
    attachmentAudio: () => undefined,
}));
jest.mock("../../drafts/attachmentQuickLooks", () => ({ attachmentQuickLook: () => undefined }));

// A 16 GiB box a connected device can reshape, on a 64 GiB engine: room for the raise's 4 GiB step.
jest.mock("../../../sandbox/devices/useSelfResources", () => ({
    useSelfResources: () => ({
        slug: computed(() => `box`),
        current: computed(() => ({ memoryBytes: 16 * 1024 ** 3 })),
        engine: computed(() => ({ memoryBytes: 64 * 1024 ** 3, cpus: 8 })),
        reshapable: computed(() => true),
        applying: ref(false),
        apply: async () => undefined,
    }),
}));

// This conversation's own answer to the memory wall, as the roster carries it, and the writer its question calls. The
// sandbox's settings are not loaded, so the wall's own default answers for it (turnBreak.ts).
const memoryOverride = ref<`wait` | `resend` | undefined>();
const setBreakPolicy = jest.fn(async () => undefined);
jest.mock("../../../agents/fleet/useAgents", () => ({
    useAgents: () => ({ agentById: () => (memoryOverride.value === undefined ? undefined : { memoryPolicy: memoryOverride.value }), setBreakPolicy }),
}));
jest.mock("../../../sandbox/overview/useSandboxSettings", () => ({ useSandboxSettings: () => ({ settings: computed(() => undefined) }) }));
// Reachable, so the question can be answered: the state the press and the answer are both about.
const realUseSandbox = useSandboxOriginal.useSandbox;
jest.mock("../../../../client/sandbox/useSandbox", () => ({
    ...useSandboxOriginal,
    useSandbox: () => ({ ...realUseSandbox(), reachable: computed(() => true) }),
}));

const { default: ChatHeldMessages } = await import("./ChatHeldMessages.vue");

// What the sandbox writes when it turns a person's message away for memory (transcript-fold's heldRow).
const MEMORY_TEXT =
    `Sandbox memory is low: 12.4 GiB resident + 3.6 GiB swapped, against 18.0 GiB, and 1.0 GiB held for work that just started. ` +
    `Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it. ` +
    `Your message is held: send it again to start anyway.`;
const memoryRow = (noticeAction: `sendAnyway` | `sandboxMemory` = `sandboxMemory`): ChatMessage => ({
    id: 3,
    role: `notice`,
    text: MEMORY_TEXT,
    noticeAction,
});
const SENT: ChatMessage[] = [
    { id: 1, role: `user`, text: `Give the sweep a summary card` },
    { id: 2, role: `assistant`, text: `Added the card.` },
];
const held = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: `m1`,
    text: `We should be consistent and always use the same icon for "attention".`,
    attachments: [SHOT],
    voice: `person`,
    queuedAt: 1_000,
    revision: 2,
    ...overrides,
});

// The reason's hover for MEMORY_TEXT: the sandbox's figures, as a card, not its sentence.
const READING_TIP = {
    title: `Memory low`,
    tone: `warning`,
    rows: [
        { label: `In RAM`, value: `12.4 GiB` },
        { label: `Swapped`, value: `3.6 GiB` },
        { label: `Limit`, value: `18.0 GiB` },
        { label: `Reserved`, value: `1.0 GiB` },
    ],
};

// Every hover label a mount asks for, by the element it hangs on: what a reader gets without pressing anything.
const tips = new WeakMap<Element, unknown>();
const tooltip: Directive = {
    mounted: (element, binding) => void tips.set(element, binding.value),
    updated: (element, binding) => void tips.set(element, binding.value),
};

let app: App | undefined;
// The board's card for the chat, where a test says what it reports about the last turn.
// `spentReopensAt` stands for the account the chat runs on reading spent, with that reopen (epoch s).
const mount = (
    chat: Conversation,
    props: Record<string, unknown> = {},
    card?: Pick<AgentStanding, `failureCode` | `failure`>,
    spentReopensAt?: number,
): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatHeldMessages, props) });
    const view = conversationView(
        computed(() => chat),
        card === undefined ? undefined : () => ({ status: `error`, attention: NO_ATTENTION, ...card }),
    );
    app.provide(PANE_VIEW, spentReopensAt === undefined ? view : { ...view, spentReopensAt: computed(() => spentReopensAt) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, tooltip);
    app.mount(element);
    return element;
};

const chatHolding = (queue: Omit<ConversationQueue, `revision`>, rows: ChatMessage[] = [...SENT, memoryRow()]): Conversation => {
    const chat = new Conversation(`c1`);
    chat.transcript.adopt(rows);
    chat.queue.value = { revision: 2, ...queue };
    return chat;
};

const buttons = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button`)];
const pressNamed = (element: HTMLElement, text: string): HTMLButtonElement[] => buttons(element).filter((button) => button.textContent?.trim() === text);
// The line as it reads: its parts stand apart by the row's gap, not by spaces in the text.
const statusLine = (element: HTMLElement): string =>
    [...(element.querySelector(`[role="status"]`)?.children ?? [])].map((part) => part.textContent?.trim() ?? ``).join(` `);
// A press that awaits the daemon settles a tick after it lands, and the row redraws on the one after.
const settled = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

afterEach(() => {
    memoryOverride.value = undefined;
    setBreakPolicy.mockClear();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`a message the sandbox held for low memory`, () => {
    it(`stands as the prompt it was, picture and all, over one line saying it did not go out and why`, async () => {
        const element = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();

        expect(element.querySelector(`.chat-surface-held`)?.textContent?.trim()).toBe(`We should be consistent and always use the same icon for "attention".`);
        expect(element.querySelector<HTMLImageElement>(`img`)?.getAttribute(`src`)).toBe(`blob:${SHOT}`);
        expect(element.querySelector(`img`)?.getAttribute(`alt`)).toBe(`image.png`);
        expect(statusLine(element)).toBe(`Not sent · Sandbox memory is low`);
    });

    it(`offers one press to send it, which lets the queue go and asks nothing else`, async () => {
        const chat = chatHolding({ items: [held()], paused: `refused` });
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat);
        await nextTick();

        expect(pressNamed(element, `Send anyway`)).toHaveLength(1);
        expect(pressNamed(element, `Resume`)).toHaveLength(0);
        pressNamed(element, `Send anyway`)[0]!.click();

        expect(resume).toHaveBeenCalledTimes(1);
    });

    // The numbers and the stakes are still there, a hover away, on the words each belongs to.
    it(`keeps the sandbox's figures on the reason and the stakes on the press`, async () => {
        const element = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();

        const reason = [...element.querySelectorAll(`[role="status"] span`)].find((span) => span.textContent?.trim() === `Sandbox memory is low`)!;
        expect(tips.get(reason)).toEqual(READING_TIP);
        expect(tips.get(pressNamed(element, `Send anyway`)[0]!)).toEqual({ title: `Starts now`, tone: `warning`, note: `Risk: slowdown, killed processes` });
    });

    it(`offers the raise beside the send only on a hold that named its ceiling`, async () => {
        const named = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();
        // 16 GiB now plus the 4 GiB step, well under the engine's 64.
        expect(pressNamed(named, `Raise memory to 20 GiB`)).toHaveLength(1);
        app?.unmount();

        const unnamed = mount(chatHolding({ items: [held()], paused: `refused` }, [...SENT, memoryRow(`sendAnyway`)]));
        await nextTick();
        expect(buttons(unnamed).some((button) => button.textContent?.includes(`Raise memory`) === true)).toBe(false);
        expect(pressNamed(unnamed, `Send anyway`)).toHaveLength(1);
    });

    it(`gives each held message its own doors: reword it in place, or take it back`, async () => {
        const chat = chatHolding({ items: [held()], paused: `refused` });
        const reword = jest.spyOn(chat.turn, `reword`).mockResolvedValue(true);
        const unqueue = jest.spyOn(chat.turn, `unqueue`).mockResolvedValue(true);
        const element = mount(chat);
        await nextTick();

        element.querySelector<HTMLButtonElement>(`button[aria-label="Reword waiting message"]`)!.click();
        await nextTick();
        const box = element.querySelector(`textarea`)!;
        expect(box.value).toBe(`We should be consistent and always use the same icon for "attention".`);
        // The picture stays on screen while the words change: a reword keeps the files.
        expect(element.querySelector(`img`)?.getAttribute(`src`)).toBe(`blob:${SHOT}`);
        box.value = `Use the circle for attention, everywhere.`;
        box.dispatchEvent(new Event(`input`));
        element.querySelector(`form`)!.dispatchEvent(new Event(`submit`));
        await settled();
        expect(reword.mock.calls).toEqual([[held(), `Use the circle for attention, everywhere.`]]);
        expect(element.querySelector(`textarea`)).toBeNull();

        element.querySelector<HTMLButtonElement>(`button[aria-label="Take back waiting message"]`)!.click();
        expect(unqueue.mock.calls).toEqual([[held()]]);
    });

    // The refusal's row lasts a minute (a turn that ran nothing is never recorded): opened later, the chat still says
    // why, from the board's card, and still offers the one press. The raise needs the row's ceiling, so it waits for one.
    it(`still says it was memory when the chat is opened after the refusal's row is gone`, async () => {
        const chat = chatHolding({ items: [held()], paused: `refused` }, SENT);
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat, {}, { failureCode: `sandbox-memory-low`, failure: MEMORY_TEXT });
        await nextTick();

        expect(statusLine(element)).toBe(`Not sent · Sandbox memory is low`);
        const reason = [...element.querySelectorAll(`[role="status"] span`)].find((span) => span.textContent?.trim() === `Sandbox memory is low`)!;
        expect(tips.get(reason)).toEqual(READING_TIP);
        expect(buttons(element).some((button) => button.textContent?.includes(`Raise memory`) === true)).toBe(false);
        pressNamed(element, `Send anyway`)[0]!.click();
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it(`names a file that is not a picture by its name, on the quick bar's one-line row`, async () => {
        const element = mount(chatHolding({ items: [held({ attachments: [SHOT, NOTES] })], paused: `refused` }), { compact: true });
        await nextTick();

        expect(element.querySelectorAll(`img`)).toHaveLength(1);
        expect(element.textContent).toContain(`plan.md`);
        expect(statusLine(element)).toBe(`Not sent · Sandbox memory is low`);
    });
});

// The answers to the memory wall, as the segmented control draws them: role="tab", one selected at a time.
const answerPills = (element: HTMLElement): HTMLButtonElement[] => [...element.querySelectorAll<HTMLButtonElement>(`button[role="tab"]`)];
const armedAnswer = (element: HTMLElement): string | undefined =>
    answerPills(element)
        .find((pill) => pill.getAttribute(`aria-selected`) === `true`)
        ?.textContent?.trim();

// What happens next, asked under the held line as a spent allowance's card asks it: the same control, the same words.
describe(`what happens next to a message held for low memory`, () => {
    it(`asks it under the line, sending once memory frees up unless the chat said to wait`, async () => {
        const element = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();

        expect(answerPills(element).map((pill) => pill.textContent?.trim())).toEqual([`Wait for me`, `Send when memory frees`]);
        expect(armedAnswer(element)).toBe(`Send when memory frees`);
        expect(element.textContent).toContain(`Goes by itself once memory frees up`);
        app?.unmount();

        memoryOverride.value = `wait`;
        const waiting = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();
        expect(armedAnswer(waiting)).toBe(`Wait for me`);
        expect(waiting.textContent).not.toContain(`Goes by itself`);
    });

    // The sandbox's own answer is no override: writing it clears the chat's, so the chat keeps following the sandbox.
    it(`writes this chat's own answer, and clears it when it is the sandbox's`, async () => {
        const element = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();

        answerPills(element)
            .find((pill) => pill.textContent?.trim() === `Wait for me`)!
            .click();
        await settled();
        expect(setBreakPolicy).toHaveBeenLastCalledWith(`c1`, `memory`, `wait`);

        answerPills(element)
            .find((pill) => pill.textContent?.trim() === `Send when memory frees`)!
            .click();
        await settled();
        expect(setBreakPolicy).toHaveBeenLastCalledWith(`c1`, `memory`, null);
    });

    it(`asks nothing under a hold memory did not make`, async () => {
        const stopped = mount(chatHolding({ items: [held({ attachments: [] })], paused: `stopped` }, [...SENT, { id: 3, role: `notice`, text: `Stopped.` }]));
        await nextTick();
        expect(answerPills(stopped)).toHaveLength(0);
    });
});

describe(`the other holds, drawn the same way`, () => {
    it(`says a stop held it, and sends it now`, async () => {
        const chat = chatHolding({ items: [held({ attachments: [] })], paused: `stopped` }, [...SENT, { id: 3, role: `notice`, text: `Stopped.` }]);
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat);
        await nextTick();

        expect(statusLine(element)).toBe(`Not sent · The turn was stopped`);
        pressNamed(element, `Send now`)[0]!.click();
        expect(resume).toHaveBeenCalledTimes(1);
        expect(pressNamed(element, `Send anyway`)).toHaveLength(0);
    });

    // The refusal's own row stays above with its specific reason; the held message's line only says it did not go.
    it(`says another refusal held it, and sends it again`, async () => {
        const refusal: ChatMessage = {
            id: 3,
            role: `notice`,
            text: `Today's free trial allowance is spent. Your message was not delivered: it is held for you to send again.`,
        };
        const element = mount(chatHolding({ items: [held()], paused: `refused` }, [...SENT, refusal]));
        await nextTick();

        expect(statusLine(element)).toBe(`Not sent · Refused before it ran`);
        expect(pressNamed(element, `Send again`)).toHaveLength(1);
        expect(buttons(element).some((button) => button.textContent?.includes(`Raise memory`) === true)).toBe(false);
    });

    it(`draws nothing while what waits will go by itself, or nothing waits`, async () => {
        const going = mount(chatHolding({ items: [held()] }));
        await nextTick();
        expect(going.textContent?.trim()).toBe(``);
        app?.unmount();

        const empty = mount(chatHolding({ items: [], paused: `refused` }));
        await nextTick();
        expect(empty.textContent?.trim()).toBe(``);
    });

    it(`marks a message nobody typed by who sent it, and offers it no reword`, async () => {
        const element = mount(chatHolding({ items: [held({ voice: `agent`, attachments: [] })], paused: `stopped` }));
        await nextTick();

        expect(element.textContent).toContain(`From another agent`);
        expect(element.querySelector(`button[aria-label="Reword waiting message"]`)).toBeNull();
        expect(element.querySelector(`button[aria-label="Take back waiting message"]`)?.tagName).toBe(`BUTTON`);
    });
});

// The composer's scheduled send, booked for when a spent allowance reopens: the reader's own choice, so it reads as a
// booking with its time, not as a message that failed, and its one press sends it sooner. These queues are booked as a
// whole, the queue's `until` or `after` and none on the message, as a sandbox older than per-message bookings keeps them:
// drawn exactly as before, every message under the queue's one booking.
describe(`a scheduled send`, () => {
    it(`reads as scheduled with the time it goes, with no warning and nothing about a refusal`, async () => {
        const until = Date.now() + 40 * 60 * 1_000 + 30_000;
        const element = mount(chatHolding({ items: [held({ attachments: [] })], paused: `scheduled`, until }, SENT));
        await nextTick();

        expect(element.querySelector(`.chat-surface-held`)?.textContent?.trim()).toBe(`We should be consistent and always use the same icon for "attention".`);
        expect(statusLine(element)).toMatch(/^Scheduled · sends in about 4[01] min$/u);
        expect(element.querySelector(`.text-warning`)).toBeNull();
    });

    it(`draws every message of a queue booked as a whole under its one line, with one Change and one Send now`, async () => {
        const until = Date.now() + 40 * 60 * 1_000 + 30_000;
        const chat = chatHolding({ items: [held({ attachments: [] }), held({ id: `m2`, text: `and the docs`, attachments: [] })], paused: `scheduled`, until }, SENT);
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat);
        await nextTick();

        expect(element.querySelectorAll(`.chat-surface-held`)).toHaveLength(2);
        expect(element.querySelectorAll(`[role="status"]`)).toHaveLength(1);
        expect(statusLine(element)).toMatch(/^Scheduled · sends in about 4[01] min$/u);
        expect(pressNamed(element, `Change`)).toHaveLength(1);
        pressNamed(element, `Send now`)[0]!.click();
        // Both named; the client sends an older sandbox no ids (turnClient.test.ts), and it lets its whole queue go.
        expect(resume.mock.calls).toEqual([[[`m1`, `m2`]]]);
    });

    it(`offers Send now, which lets it go before its time, saying the allowance may still refuse it`, async () => {
        const chat = chatHolding({ items: [held({ attachments: [] })], paused: `scheduled`, until: Date.now() + 60_000 }, SENT);
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat, {}, undefined, Math.round(Date.now() / 1_000) + 60);
        await nextTick();

        const [press] = pressNamed(element, `Send now`);
        expect(tips.get(press!)).toEqual({ title: `Send it now instead`, note: `The allowance may still be spent, and refuse it` });
        press!.click();
        expect(resume).toHaveBeenCalledTimes(1);
    });

    // A time the reader picked rather than an allowance's reopen: going sooner costs nothing to say, and it can be re-timed.
    it(`offers Send now and Change for a time the reader picked, saying only that it goes now`, async () => {
        const element = mount(chatHolding({ items: [held({ attachments: [] })], paused: `scheduled`, until: Date.now() + 60_000 }, SENT));
        await nextTick();

        const [press] = pressNamed(element, `Send now`);
        expect(tips.get(press!)).toEqual({ title: `Send it now instead`, note: `It goes now rather than at its time.` });
        expect(pressNamed(element, `Change`)).toHaveLength(1);
    });

    it(`says it waits for another agent's land, and that it goes without that work if sent now`, async () => {
        const element = mount(chatHolding({ items: [held({ attachments: [] })], paused: `scheduled`, after: `gone-fox` }, SENT));
        await nextTick();

        // No card names that agent any more: it is gone, and nothing of it will land by itself.
        expect(statusLine(element)).toBe(`Scheduled · waits for an agent that is gone`);
        const [press] = pressNamed(element, `Send now`);
        expect(tips.get(press!)).toEqual({ title: `Send it now instead`, note: `It goes without waiting for that agent's work.` });
    });

    it(`says it is going once its time has come, while the sandbox lets it go`, async () => {
        const element = mount(chatHolding({ items: [held({ attachments: [] })], paused: `scheduled`, until: Date.now() - 1 }, SENT));
        await nextTick();

        expect(statusLine(element)).toBe(`Scheduled · sends in a moment`);
    });
});

// Each message carries its own booking (2026-10-06): the queue once held one for all of them, so booking a second
// message re-timed the first and both bubbles said the second's time. Each booked message now reads its own time,
// with its own Change and Send now, and a Stop's hold beside them keeps its one line and its one press.
describe(`messages booked each on its own`, () => {
    const HOUR = 60 * 60 * 1_000;
    const lines = (element: HTMLElement): string[] =>
        [...element.querySelectorAll(`[role="status"]`)].map((line) => [...line.children].map((part) => part.textContent?.trim() ?? ``).join(` `));

    it(`reads each booked message's own time, with its own Change and Send now`, async () => {
        const soon = Date.now() + 40 * 60 * 1_000 + 30_000;
        const late = Date.now() + 24 * HOUR;
        const chat = chatHolding(
            {
                items: [held({ id: `m1`, text: `do the thing`, attachments: [], until: soon }), held({ id: `m2`, text: `second thing`, attachments: [], until: late })],
                paused: `scheduled`,
                until: soon,
            },
            SENT,
        );
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat);
        await nextTick();

        const [first, second] = lines(element);
        expect(first).toMatch(/^Scheduled · sends in about 4[01] min$/u);
        expect(second).toMatch(/^Scheduled · sends .+$/u);
        expect(second).not.toBe(first);
        expect(pressNamed(element, `Change`)).toHaveLength(2);
        expect(pressNamed(element, `Send now`)).toHaveLength(2);
        pressNamed(element, `Send now`)[1]!.click();
        expect(resume.mock.calls).toEqual([[[`m2`]]]);
    });

    it(`holds a stopped message on its own line beside a booked one, and Resume lets only the stopped one go`, async () => {
        const chat = chatHolding(
            {
                items: [held({ id: `m1`, text: `and the docs`, attachments: [] }), held({ id: `m2`, text: `then tag it`, attachments: [], until: Date.now() + HOUR })],
                paused: `stopped`,
            },
            [...SENT, { id: 3, role: `notice`, text: `Stopped.` }],
        );
        const resume = jest.spyOn(chat.turn, `resume`).mockResolvedValue(undefined);
        const element = mount(chat);
        await nextTick();

        expect(lines(element)).toEqual([`Not sent · The turn was stopped`, expect.stringMatching(/^Scheduled · sends in about (59|60) min$/u)]);
        expect([...element.querySelectorAll(`.chat-surface-held`)].map((bubble) => bubble.textContent?.trim())).toEqual([`and the docs`, `then tag it`]);
        pressNamed(element, `Send now`)[0]!.click();
        expect(resume.mock.calls).toEqual([[[`m1`]]]);
    });
});
