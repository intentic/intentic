// Pins the chat list's persona scope (ChatPersonaGrid, usePersonaScope): Anyone and everyone the sandbox can speak as in
// a grid that holds still over the one list of lanes, which a picked persona narrows to the chats that speak as them.
// Mounted via ChatTabList, since the grid and the lanes it scopes are one component's to draw together.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type AgentSummary, SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { installUi } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { setDaemonRoutes } from "../../sandbox/overview/useDaemonRoutes";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcKey } from "../../../lib/queryKeys";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { railPersona } from "../personas/railPersona";

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
    railPersona.value = undefined;
    withPersonas([
        { id: `work`, label: `Work`, capabilities: [`reddit-work`] },
        { id: `inbox`, label: `Inbox Manager`, capabilities: [`gmail-inbox`] },
    ]);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    railPersona.value = undefined;
    queryClient.clear();
    queryClient.removeQueries({ queryKey: rpcKey(`system.subagents`) });
    document.body.replaceChildren();
});

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

// The persona grid is a tab list over the lanes, which are its panel.
const personaList = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(`[role="tablist"][aria-label="${t(`shared.personas`)}"]`);
const personaTabs = (el: HTMLElement): HTMLElement[] => [...(personaList(el)?.querySelectorAll<HTMLElement>(`[role="tab"]`) ?? [])];
// A tile is named by its persona alone (aria-labelledby) and described by what it holds (aria-describedby).
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
// The tile's own "+", which starts a chat as that persona and scopes the list to them.
const startFromRow = async (el: HTMLElement, label: string): Promise<void> => {
    tab(el, label).querySelector<HTMLElement>(`[role="button"]`)!.click();
    await settle();
};
const panel = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(`[role="tabpanel"]`)!;
const allOpen = (): string[] => useChat().conversations.value.map((conversation) => conversation.conversationId).toSorted();
const heading = (el: HTMLElement): string => document.getElementById(panel(el).getAttribute(`aria-labelledby`) ?? ``)?.textContent?.trim() ?? ``;
const rows = (el: HTMLElement): string[] => [...el.querySelectorAll(`[data-chat-tab]`)].map((row) => row.getAttribute(`data-chat-tab`) ?? ``);
const row = (el: HTMLElement, id: string): HTMLElement => el.querySelector<HTMLElement>(`[data-chat-tab="${id}"]`)!;
// A lane's drawn text, found by its heading, as the lanes suite reads one.
const laneText = (el: HTMLElement, lane: string): string =>
    [...el.querySelectorAll(`section`)].find((section) => section.querySelector(`header span`)?.textContent?.trim() === lane)?.textContent ?? ``;
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

it(`starts on Anyone, which lists every open chat, and stays put as focus moves among them`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`]);
    await openAs(`inbox`, [`mail`]);
    expect(picked(el)).toEqual([`Anyone`]);
    expect(heading(el)).toBe(`Anyone`);
    expect(rows(el).toSorted()).toEqual([`first`, `mail`, `second`]);

    useChat().setActive(`first`);
    await settle();
    expect(picked(el)).toEqual([`Anyone`]);
    expect(row(el, `first`).classList.contains(`session-card-on`)).toBe(true);
});

it(`lists a picked persona's chats alone, and moves to the persona of a chat focused outside it`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`]);
    await openAs(`inbox`, [`mail`]);
    await pick(el, `Work`);
    expect(heading(el)).toBe(`Work`);
    expect(rows(el).toSorted()).toEqual([`first`, `second`]);

    useChat().setActive(`mail`);
    await settle();
    expect(picked(el)).toEqual([`Inbox Manager`]);
    expect(rows(el)).toEqual([`mail`]);
    expect(row(el, `mail`).classList.contains(`session-card-on`)).toBe(true);
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

it(`follows a New agent press out of a persona to Anyone, where its blank chat is listed rather than hidden`, async () => {
    const el = await mountList();
    await openAs(`work`, [`as-work`]);
    await pick(el, `Work`);

    startAgent();
    await settle();
    const blank = useChat().activeId.value;
    expect(picked(el)).toEqual([`Anyone`]);
    expect(rows(el).toSorted()).toEqual([`as-work`, blank].toSorted());
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

it(`closes only the picked persona's finished chats from the Finished lane's Clear, passing pinned ones by`, async () => {
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

    expect(allOpen()).toEqual([`inbox-done`, `kept`, `live`]);
    // Nothing of Work's left to sweep: the button goes rather than offering a press that closes nothing.
    expect(panel(el).querySelector(`[aria-label^="Close "][aria-label*="finished"]`)).toBeNull();
});

it(`sweeps every chat's finished ones from Anyone's Clear`, async () => {
    const el = await mountList();
    await openAs(`work`, [`done-a`]);
    await openAs(`inbox`, [`inbox-done`, `live`]);
    for (const id of [`done-a`, `inbox-done`]) {
        finish(id);
    }
    await settle();

    panel(el).querySelector<HTMLElement>(`[aria-label="Close all 2 finished chats"]`)!.click();
    await settle();
    expect(allOpen()).toEqual([`live`]);
});

it(`tells the rail's foot who is picked, so its New agent press starts as them`, async () => {
    const el = await mountList();
    expect(railPersona.value).toBeUndefined();
    await pick(el, `Inbox Manager`);
    expect(railPersona.value).toEqual({ id: `inbox`, label: `Inbox Manager` });
    await pick(el, `Anyone`);
    expect(railPersona.value).toBeUndefined();
});

it(`reads a pick whose persona was deleted as Anyone, and keeps a renamed one's new name`, async () => {
    const el = await mountList();
    await pick(el, `Work`);
    withPersonas([
        { id: `work`, label: `Office`, capabilities: [] },
        { id: `inbox`, label: `Inbox Manager`, capabilities: [] },
    ]);
    await settle();
    expect(railPersona.value).toEqual({ id: `work`, label: `Office` });

    withPersonas([{ id: `inbox`, label: `Inbox Manager`, capabilities: [] }]);
    await settle();
    expect(railPersona.value).toBeUndefined();
    expect(picked(el)).toEqual([`Anyone`]);
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

it(`keeps the pick across a remount, moving it only when the chat on screen is outside it`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`]);
    await pick(el, `Work`);
    app?.unmount();
    document.body.replaceChildren();
    expect(picked(await mountList())).toEqual([`Work`]);

    app?.unmount();
    document.body.replaceChildren();
    railPersona.value = { id: `inbox`, label: `Inbox Manager` };
    expect(picked(await mountList())).toEqual([`Work`]);
});

it(`draws no grid when the workspace has no personas, only the lanes of every open chat`, async () => {
    withPersonas([]);
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    expect(personaList(el)).toBeNull();
    expect(el.querySelector(`[role="tabpanel"]`)).toBeNull();
    expect(rows(el)).toEqual([`plain`]);
});

// The list used to switch between an Agents cut and a Personas cut, and the Agents cut carried a filter of its own.
it(`draws no cut switch and no filter above the list: finding a chat by its words is Past chats' search`, async () => {
    const el = await mountList();
    expect([...el.querySelectorAll(`[role="tablist"]`)].map((list) => list.getAttribute(`aria-label`))).toEqual([t(`shared.personas`)]);
    expect(el.querySelectorAll(`input`)).toHaveLength(0);
});

it(`spells no capability ids or account counts beside a persona's name`, async () => {
    withPersonas([{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }], [`reddit-work`]);
    const el = await mountList();
    expect(el.textContent).not.toContain(`reddit-work`);
    expect(el.textContent).not.toContain(`account`);
});

it(`moves to the persona a chat opened from the board names, when the pick leaves it out`, async () => {
    const el = await mountList();
    await pick(el, `Inbox Manager`);
    await openAs(`work`, [`from-board`]);
    expect(picked(el)).toEqual([`Work`]);
    expect(rows(el)).toEqual([`from-board`]);
});

// A scope that hid some open chats from every tile would leave the reader asking where their chat went.
it(`lists every open chat under Anyone, and each under exactly the persona it speaks as`, async () => {
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    await openAs(`work`, [`as-work`]);
    await openAs(`inbox`, [`as-inbox`]);

    await pick(el, `Anyone`);
    expect(rows(el).toSorted()).toEqual(allOpen());
    await pick(el, `Work`);
    expect(rows(el)).toEqual([`as-work`]);
    await pick(el, `Inbox Manager`);
    expect(rows(el)).toEqual([`as-inbox`]);
});

it(`switches to the chat you pick under a persona`, async () => {
    const el = await mountList();
    await openAs(`work`, [`first`, `second`]);
    await pick(el, `Work`);
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

it(`counts every open chat on Anyone's tile and each persona's own on theirs, whoever is picked`, async () => {
    const el = await mountList();
    await openAs(undefined, [`plain`]);
    await openAs(`work`, [`as-work`, `as-work-too`]);
    await openAs(`inbox`, [`as-inbox`]);
    const counts = (): string[] => [`Anyone`, `Work`, `Inbox Manager`].map((label) => facts(el, label).replace(/^.*?(\d+ chats?)$/, `$1`));

    expect(counts()).toEqual([`4 chats`, `2 chats`, `1 chat`]);
    await pick(el, `Work`);
    expect(counts()).toEqual([`4 chats`, `2 chats`, `1 chat`]);
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
    // Scoped to Work, its work not open here stands in the lanes it belongs to.
    await pick(el, `Work`);
    expect(laneText(el, `Attention`)).toContain(`answer the question`);
    expect(laneText(el, `Active`)).toContain(`writing the patch`);
    // Anyone is this window's chats: another window's work is its persona's to show.
    await pick(el, `Anyone`);
    expect(panel(el).textContent).not.toContain(`answer the question`);
});

it(`hangs every agent a chat started under its card, scoped to a persona or not`, async () => {
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

    expect(tray()?.textContent).toContain(`port the parser`);
    await pick(el, `Work`);
    expect(rows(el)).toEqual([`lead`]);
    expect(tray()?.textContent).toContain(`port the parser`);
    // Riding in its parent's tray, the child isn't drawn a second time as Work's work not open here.
    expect(laneText(el, `Active`).match(/port the parser/g)).toHaveLength(1);
});

it(`stands a child on its own under a persona its parent doesn't speak as`, async () => {
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
    setAgents([lead, { ...lead, id: `port`, title: `port the parser`, actsAs: `inbox`, lastActsAs: `inbox`, startedBy: `agent:lead`, startedAt: 2 }], 100);
    const el = await mountList();
    await openAs(`work`, [`lead`]);
    await openAs(`inbox`, [`port`]);

    expect(picked(el)).toEqual([`Anyone`]);
    expect(rows(el)).not.toContain(`port`);
    await pick(el, `Inbox Manager`);
    expect(rows(el)).toEqual([`port`]);
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
