// Pins where past chats are reached from on the docked bar: under the open chats in the switcher's sheet (as the phone's
// sheet has them), not behind a header button of their own, and without a second row for a chat already open above.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { createApp, h, nextTick } from "vue";
import * as actualSandboxRpc from "../../../../client/sandbox/sandboxRpc";
import type { ProcedureInput } from "../../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

// The one daemon call here: the stored sessions the sheet re-reads each time it opens.
const STORED = [
    { id: `s-open`, title: `Already open here`, updatedAt: 1_700_000_000_000 },
    { id: `s-past`, title: `Release notes draft`, updatedAt: 1_700_000_000_000 },
];
const list = jest.fn(async (_input: ProcedureInput<`sessions.list`>) => ({ sessions: STORED }));
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ sessions: { list } }) }));

const { default: ChatTabs } = await import("../ChatTabs.vue");
const { installUi } = await import("@intentic/ui");
const { VueQueryPlugin } = await import("@tanstack/vue-query");
const { useChat } = await import("../../../../models/conversations/run/useChat");
const { queryClient } = await import("../../../../lib/queryPersistence");
const { router } = await import("../../../../router/index");

// scrollIntoView runs on every focus write and jsdom has none.
globalThis.Element.prototype.scrollIntoView ??= (): void => {};

const opened = jest.fn<(id: string) => void>();
let strip: HTMLElement;

beforeAll(() => {
    strip = document.createElement(`div`);
    document.body.appendChild(strip);
    const app = createApp({ render: () => h(ChatTabs, { onOpen: opened }) });
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    installUi(app);
    app.mount(strip);
});

beforeEach(() => {
    localStorage.clear();
    resetSandboxScope();
    opened.mockClear();
    list.mockClear();
});

const flush = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

const switcher = (): HTMLElement => strip.querySelector<HTMLElement>(`[data-chat-switcher]`)!;
const text = (): string => strip.textContent ?? ``;

it(`keeps no history button on the bar: past chats are a press on the title away`, async () => {
    await flush();
    expect(strip.querySelector(`[aria-label="Chat history"]`)).toBeNull();
    expect(text()).not.toContain(`Past chats`);
});

it(`lists past chats under the open ones, re-read as the sheet opens, without a chat already open above`, async () => {
    const chat = useChat();
    chat.active.value.session.value = { id: `s-open`, provider: `claude`, account: undefined, harness: `native` };
    await nextTick();

    switcher().click();
    await flush();

    expect(list).toHaveBeenCalledTimes(1);
    expect(text()).toContain(`Past chats`);
    expect(text()).toContain(`Release notes draft`);
    expect(text()).not.toContain(`Already open here`);
});

it(`opens a past chat from the sheet and closes the sheet behind it`, async () => {
    // Opened fresh: the scope reset between cases cleared the sessions an earlier case's sheet had read.
    if (strip.querySelector(`[data-chat-tab]`) !== null) {
        switcher().click();
        await flush();
    }
    switcher().click();
    await flush();
    const row = [...strip.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.includes(`Release notes draft`));
    expect(row, `a past-chat row among the sheet's buttons`).toEqual(expect.any(HTMLButtonElement));
    row!.click();
    await flush();

    expect(opened).toHaveBeenCalledWith(`s-past`);
    expect(strip.querySelector(`[data-chat-tab]`)).toBeNull();
});
