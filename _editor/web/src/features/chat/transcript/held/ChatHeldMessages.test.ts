import "@intentic/testing/dom";
import { STATE_DIR } from "@intentic/constants";
import type { ConversationQueue, QueuedMessage } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, type Directive, h, nextTick, ref } from "vue";
import { type AgentStanding, NO_ATTENTION } from "../../../agents/fleet/agentStatus";
import { conversationView, PANE_VIEW } from "../../panel/useChat-view";
import { Conversation } from "../../session/conversation";
import type { ChatMessage } from "../transcript";

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

// Every hover label a mount asks for, by the element it hangs on: what a reader gets without pressing anything.
const tips = new WeakMap<Element, unknown>();
const tooltip: Directive = {
    mounted: (element, binding) => void tips.set(element, binding.value),
    updated: (element, binding) => void tips.set(element, binding.value),
};

let app: App | undefined;
// The board's card for the chat, where a test says what it reports about the last turn.
const mount = (chat: Conversation, props: Record<string, unknown> = {}, card?: Pick<AgentStanding, `failureCode` | `failure`>): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatHeldMessages, props) });
    app.provide(
        PANE_VIEW,
        conversationView(
            computed(() => chat),
            card === undefined ? undefined : () => ({ status: `error`, attention: NO_ATTENTION, ...card }),
        ),
    );
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
    it(`keeps the sandbox's reading on the reason and the stakes on the press`, async () => {
        const element = mount(chatHolding({ items: [held()], paused: `refused` }));
        await nextTick();

        const reason = [...element.querySelectorAll(`[role="status"] span`)].find((span) => span.textContent?.trim() === `Sandbox memory is low`)!;
        expect(tips.get(reason)).toBe(`Sandbox memory is low: 12.4 GiB resident + 3.6 GiB swapped, against 18.0 GiB, and 1.0 GiB held for work that just started.`);
        expect(tips.get(pressNamed(element, `Send anyway`)[0]!)).toBe(
            `Starts it now: the agents already running may slow down, and if memory runs out, the system kills processes to free it`,
        );
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
        expect(tips.get(reason)).toBe(`Sandbox memory is low: 12.4 GiB resident + 3.6 GiB swapped, against 18.0 GiB, and 1.0 GiB held for work that just started.`);
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
