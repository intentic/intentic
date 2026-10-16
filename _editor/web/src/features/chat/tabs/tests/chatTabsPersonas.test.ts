// Pins how personas meet the chat list: they don't. A persona is a posture a chat takes on, picked in its composer (the
// Acts as pill, `@persona:`) or matched from its first message, not someone to talk to, so the list holds no grid of
// persona tiles, scopes nothing to one, and lists every open chat whatever persona it wears.
// Replaced (2026-10-13) the suite that pinned the persona grid (ChatPersonaGrid, usePersonaScope), removed with it.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { useChat } from "../../../../models/conversations/run/useChat";
import { openAgentConversation } from "../../../../models/conversations/panel/useChat-reveal";
import { queryClient } from "../../../../lib/queryPersistence";
import { rpcKey } from "../../../../lib/queryKeys";
import { router } from "../../../../router/index";
import ChatTabList from "../ChatTabList.vue";

(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

let app: App | undefined;

// jsdom reports no transition duration, so a hidden menu is torn down on a timer; the macrotask wait covers it.
const settle = async (): Promise<void> => {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    await nextTick();
};

// Wired like ChatPanel: the list emits verbs, the host performs them.
const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({
        render: () =>
            h(ChatTabList, {
                onSelect: (id: string) => useChat().setActive(id),
                onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids),
            }),
    });
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    installUi(app);
    app.mount(el);
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear();
    resetSandboxScope();
    queryClient.setQueryData(rpcKey(`personas.list`), {
        personas: [
            { id: `work`, label: `Work`, capabilities: [`reddit-work`] },
            { id: `inbox`, label: `Inbox Manager`, capabilities: [`gmail-inbox`] },
        ],
        connected: [],
    });
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    queryClient.clear();
    document.body.replaceChildren();
});

const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-chat-tab]`)].map((row) => row.getAttribute(`data-chat-tab`) ?? ``);
const allOpen = (): string[] =>
    useChat()
        .conversations.value.map((conversation) => conversation.conversationId)
        .toSorted();

// Opens conversations the way the board does, each carrying the persona its record names; the last one ends up focused.
const openAs = async (persona: string | undefined, ids: string[]): Promise<void> => {
    for (const id of ids) {
        openAgentConversation({ id, provider: `claude`, harness: `native`, ...(persona === undefined ? {} : { actsAs: persona }) });
    }
    await settle();
};

// Finished the way the rail reads it with no roster entry: a settled plain chat that has said something.
const finish = (id: string): void => {
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id)!;
    conversation.isolated.value = false;
    conversation.registered.value = true;
    conversation.transcript.restoreMessages([
        { role: `user`, text: `do the thing` },
        { role: `assistant`, text: `done` },
    ]);
};

it(`draws no persona tiles above the list, even with personas on file`, async () => {
    const el = await mountList();
    await openAs(`work`, [`as-work`]);
    expect(el.querySelector(`[role="tablist"]`)).toBeNull();
    expect(el.querySelector(`[role="tabpanel"]`)).toBeNull();
    expect(el.textContent).not.toContain(`Inbox Manager`);
    expect(el.textContent).not.toContain(`Anyone`);
});

it(`lists every open chat whatever persona it wears, and keeps listing one whose composer switches it`, async () => {
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    await openAs(`work`, [`as-work`]);
    await openAs(`inbox`, [`as-inbox`]);
    expect(rows(el).toSorted()).toEqual(allOpen());

    useChat().setActive(`plain`);
    useChat().active.value.selection.apply({ kind: `set`, picks: { actsAs: `inbox` } });
    await settle();
    expect(rows(el).toSorted()).toEqual([`as-inbox`, `as-work`, `plain`]);
});

it(`sweeps every persona's finished chats from the Finished lane's Clear`, async () => {
    const el = await mountList();
    await openAs(`work`, [`done-a`]);
    await openAs(`inbox`, [`inbox-done`, `live`]);
    for (const id of [`done-a`, `inbox-done`]) {
        finish(id);
    }
    await settle();

    el.querySelector<HTMLElement>(`[aria-label="Close all 2 finished chats"]`)!.click();
    await settle();
    expect(allOpen()).toEqual([`live`]);
});
