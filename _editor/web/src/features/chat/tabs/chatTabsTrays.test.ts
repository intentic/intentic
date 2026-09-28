// The board's trays under the chat list's cards: every agent a chat's conversation started rides under that chat's card,
// spawned conversations and in-process subagents alike; a child's own chat, once open, rides there instead of standing as
// a card of its own; and a row's press shows the child in this chat, an in-process one in its parent's column.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary, SubagentSession } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import { closeSubagent, subagentOnScreen } from "../panel/subagent/subagentView";
import { openAgentConversation } from "../panel/useChat-reveal";
import { useChat } from "../run/useChat";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
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
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear();
    resetSandboxScope();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    queryClient.removeQueries({ queryKey: rpcKey(`system.subagents`) });
    closeSubagent();
});

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const agent = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    title: `agent ${id}`,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    startedAt: 1,
    attention: NO_ATTENTION,
    ...over,
});
const lead = agent(`lead`, { title: `ship the release` });
const port = agent(`port`, { title: `port the parser`, startedBy: `agent:lead`, startedAt: 2 });

const roster = (sessions: SubagentSession[]): void => {
    queryClient.setQueryData(rpcKey(`system.subagents`), { sessions });
};
const mapUi: SubagentSession = {
    id: `call-map`,
    kind: `subagent`,
    conversationId: `lead`,
    agentType: `Explore`,
    description: `map the UI`,
    status: `running`,
    startedAt: 3,
    activityAt: 3,
};

const open = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native` });
};
const cards = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-chat-tab]`)].map((card) => card.getAttribute(`data-chat-tab`) ?? ``);
const tray = (el: HTMLElement): HTMLElement | null =>
    el.querySelector(`[role="group"][aria-label="${t(`agents.childRows.startedBy`, { title: `ship the release` })}"]`);
const rows = (el: HTMLElement): HTMLButtonElement[] => [...(tray(el)?.querySelectorAll<HTMLButtonElement>(`button:not([aria-expanded])`) ?? [])];
const rowOf = (el: HTMLElement, title: string): HTMLButtonElement | undefined => rows(el).find((row) => row.textContent?.includes(title));

it(`hangs what a chat's conversation started under its card, spawned and in-process alike`, async () => {
    setAgents([lead, port], 100);
    roster([mapUi]);
    const el = await mountList();
    open(`lead`);
    await settle();

    expect(cards(el)).toContain(`lead`);
    expect(rows(el).map((row) => row.textContent?.replace(/\s+/g, ` `).trim())).toEqual([
        expect.stringMatching(/^port the parser/),
        expect.stringMatching(/^map the UI/),
    ]);
});

it(`opens a spawned child's own chat from its row, riding in the tray rather than standing as a card`, async () => {
    setAgents([lead, port], 100);
    const el = await mountList();
    open(`lead`);
    await settle();

    rowOf(el, `port the parser`)?.click();
    await settle();
    expect(useChat().activeId.value).toBe(`port`);
    expect(cards(el)).not.toContain(`port`);
    expect(rowOf(el, `port the parser`)?.classList.contains(`ui-row-select-on`)).toBe(true);
});

it(`shows an in-process subagent in its parent's column, and the parent's card steps back out of it`, async () => {
    setAgents([lead], 100);
    roster([mapUi]);
    const el = await mountList();
    open(`lead`);
    await settle();

    rowOf(el, `map the UI`)?.click();
    await settle();
    expect(useChat().activeId.value).toBe(`lead`);
    expect(subagentOnScreen.value).toEqual({ parentId: `lead`, id: `call-map` });
    expect(rowOf(el, `map the UI`)?.classList.contains(`ui-row-select-on`)).toBe(true);

    el.querySelector<HTMLElement>(`[data-chat-tab="lead"]`)?.click();
    await settle();
    expect(subagentOnScreen.value).toBeUndefined();
});
