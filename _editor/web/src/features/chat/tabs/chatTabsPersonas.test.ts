// Pins the rail's Personas cut (ChatPersonaRail): everyone the sandbox can speak as in one list that holds still, and the
// open chats of the one picked, with every row verb the Agents cut has. Mounted via ChatTabList, since the cut switch is
// part of what's tested.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type AgentSummary, SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { installUi } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { useChatGrouping } from "../transcript/chatGrouping";
import { useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { setDaemonRoutes } from "../../sandbox/overview/useDaemonRoutes";
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
    queryClient.removeQueries({ queryKey: rpcKey(`system.subagents`) });
    document.body.replaceChildren();
});

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

// The persona list is the vertical tab list; the cut switch above it is a tab list of its own.
const personaList = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(`[role="tablist"][aria-label="${t(`shared.personas`)}"]`);
const personaTabs = (el: HTMLElement): HTMLElement[] => [...(personaList(el)?.querySelectorAll<HTMLElement>(`[role="tab"]`) ?? [])];
// A row is named by its persona alone (aria-labelledby) and described by what it holds (aria-describedby).
const nameOf = (tab: HTMLElement): string => document.getElementById(tab.getAttribute(`aria-labelledby`) ?? ``)?.textContent?.trim() ?? ``;
const names = (el: HTMLElement): string[] => personaTabs(el).map(nameOf);
const tab = (el: HTMLElement, label: string): HTMLElement => {
    const found = personaTabs(el).find((candidate) => nameOf(candidate) === label);
    expect(found, `persona row "${label}" among [${names(el)}]`).toEqual(expect.any(HTMLElement));
    return found!;
};
const facts = (el: HTMLElement, label: string): string =>
    document.getElementById(tab(el, label).getAttribute(`aria-describedby`) ?? ``)?.textContent?.trim() ?? ``;
const picked = (el: HTMLElement): string[] => personaTabs(el).filter((candidate) => candidate.getAttribute(`aria-selected`) === `true`).map(nameOf);
const pick = async (el: HTMLElement, label: string): Promise<void> => {
    tab(el, label).click();
    await settle();
};
// The row's own "+", which starts a chat as that persona without picking it first.
const startFromRow = async (el: HTMLElement, label: string): Promise<void> => {
    tab(el, label).querySelector<HTMLElement>(`[role="button"]`)!.click();
    await settle();
};
const panel = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(`[role="tabpanel"]`)!;
const heading = (el: HTMLElement): string => document.getElementById(panel(el).getAttribute(`aria-labelledby`) ?? ``)?.textContent?.trim() ?? ``;
const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-chat-tab]`)].map((row) => row.getAttribute(`data-chat-tab`) ?? ``);
const row = (el: HTMLElement, id: string): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${id}"]`)!;
const pressKey = async (el: HTMLElement, key: string): Promise<void> => {
    personaList(el)!.dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true, cancelable: true }));
    await settle();
};

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

it(`lists Anyone and then every persona in personas.json's order, before anything is open`, async () => {
    const el = await mountList();
    expect(names(el)).toEqual([`Anyone`, `Work`, `Inbox Manager`]);
});

// The first half of the complaint this cut was rebuilt for: a persona used to jump from a line at the foot to a card up
// top when it got a chat, and back down when the chat went.
it(`holds every persona's row in place as chats start and end under it`, async () => {
    const el = await mountList();
    await openAs(`inbox`, [`mail`]);
    expect(names(el)).toEqual([`Anyone`, `Work`, `Inbox Manager`]);

    useChat().closeTabs(new Set([`mail`]));
    await settle();
    expect(names(el)).toEqual([`Anyone`, `Work`, `Inbox Manager`]);
});

it(`picks the persona of the chat on screen, and lists that persona's chats alone`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`]);
    await openAs(`inbox`, [`mail`]);
    expect(picked(el)).toEqual([`Inbox Manager`]);
    expect(heading(el)).toBe(`Inbox Manager`);
    expect(rows(el)).toEqual([`mail`]);

    useChat().setActive(`first`);
    await settle();
    expect(picked(el)).toEqual([`Work`]);
    expect(rows(el).toSorted()).toEqual([`first`, `second`]);
    expect(row(el, `first`).classList.contains(`session-card-on`)).toBe(true);
});

it(`reads another persona's chats on a press, leaving the chat on screen where it is`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`]);
    await openAs(`inbox`, [`mail`]);
    selected = [];

    await pick(el, `Work`);
    expect(picked(el)).toEqual([`Work`]);
    expect(rows(el)).toEqual([`first`]);
    expect(useChat().activeId.value).toBe(`mail`);
    expect(selected).toEqual([]);
});

// The second half: the reader in one persona's new chat still found another persona's chats opened above it.
it(`lands on the persona a chat was started as, with the new chat ringed and no other persona's chats drawn`, async () => {
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    expect(picked(el)).toEqual([`Anyone`]);

    await startFromRow(el, `Work`);
    const started = useChat().active.value;
    expect(started.selection.actsAs.value).toBe(`work`);
    expect(picked(el)).toEqual([`Work`]);
    expect(rows(el)).toEqual([started.conversationId]);
    expect(row(el, started.conversationId).classList.contains(`session-card-on`)).toBe(true);
});

it(`follows a New agent press to Anyone, where its blank chat is listed rather than hidden`, async () => {
    const el = await mountList();
    await openAs(`work`, [`as-work`]);
    expect(picked(el)).toEqual([`Work`]);

    startAgent();
    await settle();
    const blank = useChat().activeId.value;
    expect(picked(el)).toEqual([`Anyone`]);
    expect(rows(el)).toEqual([blank]);
    expect(row(el, blank).classList.contains(`session-card-on`)).toBe(true);
});

it(`follows the chat on screen to the persona the composer switches it to`, async () => {
    const el = await mountList();
    await startFromRow(el, `Work`);
    const draft = useChat().activeId.value;

    useChat().active.value.selection.apply({ kind: `set`, picks: { actsAs: `inbox` } });
    await settle();
    expect(picked(el)).toEqual([`Inbox Manager`]);
    expect(rows(el)).toEqual([draft]);
});

it(`offers a persona with nothing open its one next step, and starts the chat from it as that persona`, async () => {
    const el = await mountList();
    await pick(el, `Inbox Manager`);
    expect(rows(el)).toEqual([]);

    const tile = [...panel(el).querySelectorAll<HTMLButtonElement>(`button:not([aria-label])`)].find(
        (button) => button.textContent?.trim() === `New chat as Inbox Manager`,
    );
    tile!.click();
    await settle();
    expect(useChat().active.value.selection.actsAs.value).toBe(`inbox`);
    expect(picked(el)).toEqual([`Inbox Manager`]);
    expect(rows(el)).toEqual([useChat().activeId.value]);
});

it(`closes the picked persona's finished chats from the one button above its list, passing pinned ones by`, async () => {
    const el = await mountList();
    await openAs(`work`, [`done-a`, `kept`, `live`]);
    await openAs(`inbox`, [`inbox-done`]);
    for (const id of [`done-a`, `kept`, `inbox-done`]) {
        finish(id);
    }
    useChat().setPinned(`kept`, true);
    await pick(el, `Work`);

    panel(el).querySelector<HTMLElement>(`[aria-label="Close 1 finished chat"]`)!.click();
    await settle();

    const open = useChat().conversations.value.map((conversation) => conversation.conversationId);
    expect(open).toEqual(expect.arrayContaining([`kept`, `live`, `inbox-done`]));
    expect(open).not.toContain(`done-a`);
    // Nothing left to sweep: the button goes rather than offering a press that closes nothing.
    expect(panel(el).querySelector(`[aria-label^="Close "][aria-label*="finished"]`)).toBeNull();
});

it(`moves the pick with the arrow keys, Home and End, wrapping at either end`, async () => {
    const el = await mountList();
    expect(picked(el)).toEqual([`Anyone`]);
    await pressKey(el, `ArrowDown`);
    expect(picked(el)).toEqual([`Work`]);
    await pressKey(el, `End`);
    expect(picked(el)).toEqual([`Inbox Manager`]);
    await pressKey(el, `ArrowDown`);
    expect(picked(el)).toEqual([`Anyone`]);
    await pressKey(el, `ArrowUp`);
    expect(picked(el)).toEqual([`Inbox Manager`]);
    await pressKey(el, `Home`);
    expect(picked(el)).toEqual([`Anyone`]);
    await pressKey(el, `ArrowRight`);
    expect(picked(el)).toEqual([`Work`]);
    await pressKey(el, `ArrowLeft`);
    expect(picked(el)).toEqual([`Anyone`]);
    // Only the picked tile is a stop on the Tab key's way through the column.
    expect(personaTabs(el).map((candidate) => candidate.getAttribute(`tabindex`))).toEqual([`0`, `-1`, `-1`]);
});

it(`picks afresh on a remount: the persona of the chat on screen, not the one last read`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`]);
    await pick(el, `Inbox Manager`);

    app?.unmount();
    document.body.replaceChildren();
    const again = await mountList();
    expect(picked(again)).toEqual([`Work`]);
});

it(`offers to set one up when the workspace has no personas`, async () => {
    withPersonas([]);
    const el = await mountList();
    expect(el.textContent).toContain(`Set up a persona`);
    expect(names(el)).toEqual([`Anyone`]);
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
    expect(picked(el)).toEqual([`Work`]);
    expect(rows(el)).toEqual([`from-board`]);
});

// A cut that hid some open chats would leave the reader asking where their chat went.
it(`holds every open chat under exactly one persona, the ones that act as none under Anyone`, async () => {
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    await openAs(`work`, [`as-work`]);
    await openAs(`inbox`, [`as-inbox`]);

    const listed: string[] = [];
    for (const label of names(el)) {
        await pick(el, label);
        listed.push(...rows(el));
    }
    expect(listed.toSorted()).toEqual(useChat().conversations.value.map((conversation) => conversation.conversationId).toSorted());
    await pick(el, `Anyone`);
    expect(rows(el)).toEqual([`plain`]);
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

// The complaint the cut before this one was rebuilt for: a chat under a persona could not be closed on its own.
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

it(`folds finished chats past the board's window, keeping pinned ones, and lifts the fold on a press`, async () => {
    const el = await mountList();
    const ids = [`w1`, `w2`, `w3`, `w4`, `w5`, `w6`, `w7`, `w8`];
    await openAs(`work`, ids);
    for (const id of ids) {
        finish(id);
    }
    useChat().setPinned(`w8`, true);
    useChat().setActive(`w8`);
    await settle();

    // Seven unpinned past a window of six: one folds; the pinned one stands outside the window.
    expect(rows(el)).toHaveLength(7);
    expect(rows(el)[0]).toBe(`w8`);
    const fold = [...panel(el).querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent?.trim() === `1 earlier`);
    fold!.click();
    await settle();
    expect(rows(el).toSorted()).toEqual(ids.toSorted());
    expect(panel(el).textContent).toContain(`Show fewer`);
});

it(`sweeps only its own persona's finished chats from the persona's menu, passing pinned ones by`, async () => {
    const el = await mountList();
    await openAs(`work`, [`done-a`, `done-b`, `kept`]);
    await openAs(`inbox`, [`inbox-done`]);
    for (const id of [`done-a`, `done-b`, `kept`, `inbox-done`]) {
        finish(id);
    }
    useChat().setPinned(`kept`, true);
    await settle();

    await rightClick(tab(el, `Work`));
    await clickMenu(`Close Work's finished chats`);

    const open = useChat().conversations.value.map((conversation) => conversation.conversationId);
    expect(open).toContain(`kept`);
    expect(open).toContain(`inbox-done`);
    expect(open).not.toContain(`done-a`);
    expect(open).not.toContain(`done-b`);
});

it(`offers a new chat, the sweeps and the persona's own page from its tile's menu`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`]);

    await rightClick(tab(el, `Work`));
    expect(menuLabels()).toEqual([
        `New chat as Work`,
        `Close Work's finished chats`,
        `Close all of Work's chats`,
        `Archive Work's finished agents`,
        `Edit persona…`,
        `Manage personas`,
    ]);
});

it(`says what each persona holds: what needs you and what works, open here or not`, async () => {
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
    expect(facts(el, `Work`)).toBe(`1 needs you, 1 working, 2 chats`);
    expect(facts(el, `Inbox Manager`)).toBe(``);
    // Waiting on the reader is never folded away, open here or not.
    await pick(el, `Work`);
    expect(panel(el).textContent).toContain(`answer the question`);
    expect(panel(el).textContent).toContain(`1 not open`);
});

// The Agents cut hangs every agent a chat started under its card; here the reader is asking who a chat speaks as.
it(`draws a chat without the tray of agents it started, which the Agents cut still hangs under it`, async () => {
    const lead: AgentSummary = {
        id: `lead`,
        title: `ship the release`,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        actsAs: `work`,
        lastActsAs: `work`,
        updatedAt: 1_000,
        startedAt: 1,
        attention: NO_ATTENTION,
    };
    setAgents([lead, { ...lead, id: `port`, title: `port the parser`, startedBy: `agent:lead`, startedAt: 2 }], 100);
    const el = await mountList();
    await openAs(`work`, [`lead`]);
    const tray = (): Element | null => el.querySelector(`[role="group"][aria-label="${t(`agents.childRows.startedBy`, { title: `ship the release` })}"]`);

    expect(rows(el)).toEqual([`lead`]);
    expect(tray()).toBeNull();

    useChatGrouping().set(`lane`);
    await settle();
    expect(tray()?.textContent).toContain(`port the parser`);
});

it(`leaves the Agents cut on the chat it was reading`, async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    openAgentConversation({ id: `working-on-this`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    await startFromRow(el, `Work`);

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
    expect(names(el)).toEqual([`Anyone`, `Work`, `Inbox Manager`]);
    useChatGrouping().set(`lane`);
    await settle();
    expect(personaList(el)).toBeNull();
    expect(el.querySelector(`[aria-label="Filter chats by your messages or id"]`)).not.toBeNull();
});

// A SANDBOX FROM BEFORE 2026-09-25 (v1.312 and older) says only who a conversation's first turn acted as (`actsAs`),
// never who it speaks as now (`lastActsAs`), and its daemon advertises no `agent.switchAccount`, which arrived with the
// field. Nothing is guessed from the first turn: the rail says the sandbox needs an update, and a current sandbox's rail
// says nothing of the kind.
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
    const advertise = (current: boolean): void =>
        setDaemonRoutes(current ? SANDBOX_ROUTE_NAMES : SANDBOX_ROUTE_NAMES.filter((name) => name !== `agent.switchAccount`));
    const note = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(`[data-outdated]`);

    it(`sorts nothing under a persona from the first turn alone, and says the sandbox needs an update`, async () => {
        advertise(false);
        setAgents([busyAsWork(false)], 100);
        const el = await mountList();
        expect(facts(el, `Work`)).toBe(``);
        expect(note(el)?.textContent).toContain(`This sandbox runs an older version`);
        expect(note(el)?.textContent).toContain(`chats can't be sorted under the persona they speak as`);
        expect(note(el)?.querySelector(`a[data-update]`)?.getAttribute(`href`)).toBe(`/sandbox/overview`);
    });

    it(`says nothing of the kind on a current sandbox, which sorts by who the conversation speaks as now`, async () => {
        advertise(true);
        setAgents([busyAsWork(true)], 100);
        const el = await mountList();
        expect(facts(el, `Work`)).toBe(`1 working, 1 chat`);
        expect(note(el)).toBeNull();
    });
});
