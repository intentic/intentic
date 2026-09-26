// Pins the rail's Personas cut (ChatPersonaRail): the same open chats as the Agents cut, grouped by who they act as,
// with every row verb the Agents cut has. Mounted via ChatTabList, since the cut switch is part of what's tested.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary, MainlineStatus } from "@intentic/sandbox-contract";
import { installUi } from "@intentic/ui";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { useChatGrouping } from "../transcript/chatGrouping";
import { useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcKey } from "../../../lib/queryKeys";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";

(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

let app: App | undefined;
let selected: string[] = [];

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
                onSelect: (id: string) => {
                    selected.push(id);
                    useChat().setActive(id);
                },
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

const withPersonas = (personas: { id: string; label?: string; capabilities: string[] }[], connected: string[] = []): void => {
    queryClient.setQueryData(rpcKey(`personas.list`), { personas, connected });
};

beforeEach(async () => {
    localStorage.clear();
    selected = [];
    resetSandboxScope();
    useChatGrouping().set(`persona`);
    withPersonas([
        { id: `work`, label: `Work`, capabilities: [`reddit-work`] },
        { id: `inbox`, label: `Inbox Manager`, capabilities: [`gmail-inbox`] },
    ]);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    useChatGrouping().set(`lane`);
    queryClient.clear();
    document.body.replaceChildren();
});

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

// Group headers: the cards that are not chat rows.
const headers = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`.session-card:not([data-chat-tab])`)].map((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() ?? ``);
const header = (el: HTMLElement, label: string): HTMLElement =>
    [...el.querySelectorAll<HTMLElement>(`.session-card:not([data-chat-tab])`)].find(
        (card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() === label,
    )!;
const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-chat-tab]`)].map((row) => row.getAttribute(`data-chat-tab`) ?? ``);
const row = (el: HTMLElement, id: string): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${id}"]`)!;
const tile = (el: HTMLElement, label: string): HTMLElement | null => el.querySelector<HTMLElement>(`[aria-label="Start a chat as ${label}"]`);

// Menus teleport out of the list, so they are read off the document.
const menuLabels = (): string[] =>
    [...document.querySelectorAll<HTMLElement>(`.p-contextmenu-item`)].map((item) => item.querySelector(`a > span.flex-1`)?.textContent?.trim() ?? ``);
const clickMenu = async (label: string): Promise<void> => {
    const item = [...document.querySelectorAll<HTMLElement>(`.p-contextmenu-item`)].find(
        (entry) => entry.querySelector(`a > span.flex-1`)?.textContent?.trim() === label,
    );
    expect(item, `menu row "${label}" among [${menuLabels()}]`).toEqual(expect.any(Object));
    item!.querySelector(`a`)!.click();
    await settle();
};
const rightClick = async (target: HTMLElement): Promise<void> => {
    target.dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true }));
    await settle();
};

// Opens conversations the way the board does, each carrying the persona its record names.
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

it(`shows personas with nothing going on as start tiles, not as groups`, async () => {
    const el = await mountList();
    expect(headers(el)).toEqual([]);
    expect(tile(el, `Work`)).not.toBeNull();
    expect(tile(el, `Inbox Manager`)).not.toBeNull();
});

it(`starts a chat acting as the persona from its tile`, async () => {
    const el = await mountList();
    tile(el, `Work`)!.click();
    await settle();
    expect(useChat().conversations.value.filter((conversation) => conversation.selection.actsAs.value === `work`)).toHaveLength(1);
    expect(headers(el)).toEqual([`Work`]);
});

it(`offers to set one up when the workspace has no personas`, async () => {
    withPersonas([]);
    const el = await mountList();
    expect(el.textContent).toContain(`Set up a persona`);
    expect(headers(el)).toEqual([]);
});

it(`spells no capability ids or account counts beside a persona's name`, async () => {
    withPersonas([{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }], [`reddit-work`]);
    const el = await mountList();
    expect(el.textContent).not.toContain(`reddit-work`);
    expect(el.textContent).not.toContain(`account`);
});

it(`lands a chat opened from the board under the persona its record names`, async () => {
    const el = await mountList();
    await openAs(`work`, [`from-board`]);
    expect(headers(el)).toEqual([`Work`]);
    expect(rows(el)).toEqual([`from-board`]);
});

it(`toggles a persona's chats from its header, and remembers the choice across a remount`, async () => {
    const el = await mountList();
    await openAs(`inbox`, [`mail`]);
    await openAs(`work`, [`first`, `second`]);
    expect(rows(el).toSorted()).toEqual([`first`, `mail`, `second`]);

    header(el, `Inbox Manager`).click();
    await settle();
    expect(rows(el).toSorted()).toEqual([`first`, `second`]);
    expect(header(el, `Inbox Manager`).getAttribute(`aria-expanded`)).toBe(`false`);

    app?.unmount();
    document.body.replaceChildren();
    const again = await mountList();
    expect(rows(again).toSorted()).toEqual([`first`, `second`]);
    header(again, `Inbox Manager`).click();
    await settle();
    expect(rows(again).toSorted()).toEqual([`first`, `mail`, `second`]);
});

it(`switches to the chat you pick under a persona`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`]);
    selected = [];
    row(el, `first`).click();
    await settle();
    expect(selected).toEqual([`first`]);
    expect(useChat().activeId.value).toBe(`first`);
});

// The complaint this cut was rebuilt for: a chat under a persona could not be closed on its own.
it(`closes one chat under a persona from its own menu, leaving its siblings`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`]);

    await rightClick(row(el, `first`));
    expect(menuLabels()).toEqual(expect.arrayContaining([`Pin`, `Rename`, `Close`, `Close Others`, `Close Finished`, `Close All`]));
    await clickMenu(`Close`);

    expect(useChat().conversations.value.map((conversation) => conversation.conversationId)).not.toContain(`first`);
    expect(rows(el)).toEqual([`second`]);
});

it(`closes a chat under a persona from its × and from a middle-click`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`, `third`]);

    row(el, `first`).querySelector<HTMLElement>(`[aria-label="Close chat"]`)!.click();
    await settle();
    row(el, `second`).dispatchEvent(new MouseEvent(`auxclick`, { bubbles: true, cancelable: true, button: 1 }));
    await settle();

    expect(rows(el)).toEqual([`third`]);
});

it(`sweeps only its own persona's finished chats from the header, passing pinned ones by`, async () => {
    const el = await mountList();
    await openAs(`work`, [`done-a`, `done-b`, `kept`]);
    await openAs(`inbox`, [`inbox-done`]);
    for (const id of [`done-a`, `done-b`, `kept`, `inbox-done`]) {
        finish(id);
    }
    useChat().setPinned(`kept`, true);
    await settle();

    await rightClick(header(el, `Work`));
    await clickMenu(`Close Work's finished chats`);

    const open = useChat().conversations.value.map((conversation) => conversation.conversationId);
    expect(open).toContain(`kept`);
    expect(open).toContain(`inbox-done`);
    expect(open).not.toContain(`done-a`);
    expect(open).not.toContain(`done-b`);
});

it(`offers a new chat, the sweeps and the persona's own page from the header menu`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`]);
    await rightClick(header(el, `Work`));
    expect(menuLabels()).toEqual([
        `New chat as Work`,
        `Close Work's finished chats`,
        `Close all of Work's chats`,
        `Archive Work's finished agents`,
        `Edit persona…`,
    ]);
});

// A cut that hid some open chats would leave the reader asking where their chat went.
it(`keeps chats that act as no persona under Anyone, so the cut holds every open chat`, async () => {
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    await openAs(`work`, [`as-work`]);
    expect(headers(el)).toEqual([`Work`, `Anyone`]);
    expect(rows(el).toSorted()).toEqual(useChat().conversations.value.map((conversation) => conversation.conversationId).toSorted());
});

it(`opens the group of the chat you walk in from, with that chat ringed`, async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    await openAs(`work`, [`talking-as-work`]);

    useChatGrouping().set(`persona`);
    await settle();
    expect(header(el, `Work`).getAttribute(`aria-expanded`)).toBe(`true`);
    expect(row(el, `talking-as-work`).classList.contains(`session-card-on`)).toBe(true);
});

it(`rings a folded header that holds the focused chat`, async () => {
    const el = await mountList();
    await openAs(`work`, [`talking-as-work`]);
    header(el, `Work`).click();
    await settle();
    expect(header(el, `Work`).classList.contains(`session-card-on`)).toBe(true);
});

it(`counts what needs you and what works across the persona's chats, open or not`, async () => {
    setAgents(
        [
            {
                id: `asking`,
                title: `answer the question`,
                status: `awaiting`,
                provider: `claude`,
                harness: `native`,
                actsAs: `work`,
                lastActsAs: `work`,
                updatedAt: 2_000,
                attention: { ...NO_ATTENTION, question: true },
            },
            {
                id: `busy`,
                title: `writing the patch`,
                status: `running`,
                provider: `claude`,
                harness: `native`,
                actsAs: `work`,
                lastActsAs: `work`,
                updatedAt: 1_500,
                attention: NO_ATTENTION,
            },
        ] satisfies AgentSummary[],
        100,
    );
    const el = await mountList();
    const meta = header(el, `Work`).textContent ?? ``;
    expect(meta).toContain(`1 needs you`);
    expect(meta).toContain(`1 working`);
    // Waiting on the reader is never folded away, open here or not.
    header(el, `Work`).click();
    await settle();
    expect(el.textContent).toContain(`answer the question`);
    expect(el.textContent).toContain(`1 not open`);
});

it(`leaves the Agents cut on the chat it was reading`, async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    openAgentConversation({ id: `working-on-this`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    tile(el, `Work`)!.click();
    await settle();

    selected = [];
    useChatGrouping().set(`lane`);
    await settle();
    expect(selected).toEqual([`working-on-this`]);
});

it(`reveals nothing when the visit changed no chat`, async () => {
    useChatGrouping().set(`lane`);
    await mountList();
    openAgentConversation({ id: `working-on-this`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    selected = [];
    useChatGrouping().set(`lane`);
    await settle();
    expect(selected).toEqual([]);
});

it(`hands the column back to the lanes when the switch is flipped`, async () => {
    const el = await mountList();
    expect(tile(el, `Work`)).not.toBeNull();
    useChatGrouping().set(`lane`);
    await settle();
    expect(tile(el, `Work`)).toBeNull();
    expect(el.querySelector(`[aria-label="Filter chats by your messages"]`)).not.toBeNull();
});

// A SANDBOX FROM BEFORE 2026-09-25 says only who a conversation's first turn acted as (`actsAs`), never who it speaks as
// now (`lastActsAs`), and its main line serves no `reds`. Nothing is guessed from the first turn: the rail says the sandbox
// needs an update, and a current sandbox's rail says nothing of the kind.
describe(`on a sandbox too old to say who a conversation speaks as`, () => {
    // What an older sandbox says of a conversation working as Work: its first turn's persona, and nothing about now.
    const olderBusy: AgentSummary = {
        id: `busy`,
        title: `writing the patch`,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        actsAs: `work`,
        updatedAt: 1_500,
        attention: NO_ATTENTION,
    };
    const busyAsWork = (current: boolean): AgentSummary => (current ? { ...olderBusy, lastActsAs: `work` } : olderBusy);
    const mainline = (current: boolean): MainlineStatus => (current ? { projects: [], recent: [], reds: [] } : { projects: [], recent: [] });
    const note = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(`[data-outdated]`);

    it(`groups nothing under a persona from the first turn alone, and says the sandbox needs an update`, async () => {
        queryClient.setQueryData(rpcKey(`workspace.mainline`), mainline(false));
        setAgents([busyAsWork(false)], 100);
        const el = await mountList();
        expect(headers(el)).toEqual([]);
        expect(note(el)?.textContent).toContain(`This sandbox runs an older version`);
        expect(note(el)?.textContent).toContain(`chats can't be sorted under the persona they speak as`);
        expect(note(el)?.querySelector(`a[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
    });

    it(`says nothing of the kind on a current sandbox, which groups by who the conversation speaks as now`, async () => {
        queryClient.setQueryData(rpcKey(`workspace.mainline`), mainline(true));
        setAgents([busyAsWork(true)], 100);
        const el = await mountList();
        expect(headers(el)).toEqual([`Work`]);
        expect(note(el)).toBeNull();
    });
});
