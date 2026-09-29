// The children an agent started, through the real board: they hang under its card as rows instead of standing as
// cards, working ones in sight and settled ones behind a count, and a child asking what only the reader can give moves
// its parent's card to Attention, wearing the ask there and on its own row. The subagents its runtime ran in-process
// ride in the same tray, from the roster. The fold's rules are view/childFold.test.ts; this pins the board's wiring.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type AgentSummary, providerLabel, type SubagentSession } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { useChat } from "../../chat/run/useChat";
import { closeSubagent, subagentOnScreen } from "../../chat/panel/subagent/subagentView";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { setAgents } from "../fleet/useAgents-registry";
import { router } from "../../../router";
import AgentsView from "./AgentsView.vue";
import { IconStub } from "@intentic/ui/testing";

// Same import-time globals boardSelection.test.ts installs: jsdom has no scrollIntoView.
(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

let app: App | undefined;
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};
const mountBoard = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(AgentsView) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.use(PrimeVue);
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
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    ...over,
});
const lead = agent(`lead`, { title: `ship the release`, status: `running`, startedAt: 1 });
const helper = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => agent(id, { startedBy: `agent:lead`, ...over });
const family = [
    lead,
    helper(`port`, { title: `port the parser`, status: `running`, startedAt: 2 }),
    helper(`notes`, { title: `write the notes`, updatedAt: 900 }),
    helper(`audit`, { title: `audit the deps`, updatedAt: 800 }),
    helper(`keys`, { title: `rotate the keys`, status: `awaiting`, attention: { ...NO_ATTENTION, permission: true } }),
];

// Every card on the board, by the name its focus press carries.
const cards = (board: HTMLElement): string[] =>
    [...board.querySelectorAll(`[role="button"][aria-label^="Focus agent: "]`)].map((card) => card.getAttribute(`aria-label`) ?? ``);
const tray = (board: HTMLElement): HTMLElement | null =>
    board.querySelector(`[role="group"][aria-label="${t(`agents.childRows.startedBy`, { title: `ship the release` })}"]`);
const rows = (board: HTMLElement): string[] =>
    [...(tray(board)?.querySelectorAll(`button:not([aria-expanded])`) ?? [])].map((row) => row.textContent?.replace(/\s+/g, ` `).trim() ?? ``);
const fold = (board: HTMLElement): HTMLButtonElement | null => tray(board)?.querySelector<HTMLButtonElement>(`button[aria-expanded]`) ?? null;

it(`hangs the children under their parent's card, the asking and working ones in sight and settled ones behind a count`, async () => {
    setAgents(family, 100);
    const board = await mountBoard();

    expect(cards(board)).toEqual([`Focus agent: ship the release`]);
    expect(rows(board)).toEqual([expect.stringMatching(/^rotate the keys/), expect.stringMatching(/^port the parser/)]);
    expect(fold(board)?.textContent?.trim()).toBe(t(`agents.childRows.finished`, { count: 2 }));
    expect(fold(board)?.getAttribute(`aria-expanded`)).toBe(`false`);
});

it(`carries a child's ask to Attention on its parent's card, and names the ask on the child's own row`, async () => {
    setAgents(family, 100);
    const board = await mountBoard();

    const attention = board.querySelector(`[data-lane="attention"]`);
    const parent = attention?.querySelector(`[aria-label="Focus agent: ship the release"]`);
    expect(parent?.textContent).toContain(t(`agents.agentStatus.permission`));
    expect(board.querySelector(`[data-lane="active"] [aria-label="Focus agent: ship the release"]`)).toBeNull();
    expect(rows(board)[0]).toContain(t(`agents.agentStatus.permission`));
});

it(`keeps Attention empty for children stopped under a parent still at work, one row per thing they stopped on`, async () => {
    const spent = (id: string): AgentSummary => helper(id, { title: `batch ${id}`, status: `error`, failureCode: `rate_limit`, provider: `codex` });
    setAgents([lead, ...[`b1`, `b2`, `b3`].map(spent), helper(`port`, { title: `port the parser`, status: `running`, startedAt: 2 })], 100);
    const board = await mountBoard();

    expect(board.querySelector(`[data-lane="attention"] [role="button"]`)).toBeNull();
    const groups = [...(tray(board)?.querySelectorAll(`button[aria-expanded]`) ?? [])].map((row) => row.textContent?.replace(/\s+/g, ` `).trim());
    expect(groups).toEqual([t(`agents.childRows.limitGroup`, { count: 3, provider: providerLabel(`codex`) })]);
    expect(rows(board)).toEqual([expect.stringMatching(/^port the parser/)]);
});

it(`unfolds the settled children on the count, and points the chat at a child from its row`, async () => {
    setAgents(family, 100);
    const board = await mountBoard();

    fold(board)?.click();
    await settle();
    expect(fold(board)?.getAttribute(`aria-expanded`)).toBe(`true`);
    // Each row is its title, then its ask, how long it worked or when it settled.
    expect(rows(board)).toEqual([
        expect.stringMatching(/^rotate the keys/),
        expect.stringMatching(/^port the parser/),
        expect.stringMatching(/^write the notes/),
        expect.stringMatching(/^audit the deps/),
    ]);

    [...(tray(board)?.querySelectorAll<HTMLButtonElement>(`button:not([aria-expanded])`) ?? [])].find((row) => row.textContent?.includes(`audit the deps`))?.click();
    await settle();
    expect(useChat().activeId.value).toBe(`audit`);
});

// The roster as the daemon answers it: what each conversation's runtime ran in-process, and the spawned ones filed too.
const roster = (sessions: SubagentSession[]): void => {
    queryClient.setQueryData(rpcKey(`system.subagents`), { sessions });
};
const inProcess = (id: string, over: Partial<SubagentSession> = {}): SubagentSession => ({
    id,
    kind: `subagent`,
    conversationId: `lead`,
    agentType: `Explore`,
    status: `running`,
    startedAt: 1,
    activityAt: 1,
    ...over,
});

it(`carries the subagents its runtime ran in-process in the same tray, and a spawned one the roster files too only once`, async () => {
    setAgents(family, 100);
    roster([
        inProcess(`call-map`, { description: `map the UI` }),
        inProcess(`call-scan`, { description: `scan the logs`, status: `completed`, endedAt: 950, activityAt: 950 }),
        { id: `port`, kind: `spawned`, conversationId: `lead`, agentType: `Codex`, status: `running`, startedAt: 2, activityAt: 2 },
    ]);
    const board = await mountBoard();

    expect(cards(board)).toEqual([`Focus agent: ship the release`]);
    expect(rows(board)).toEqual([
        expect.stringMatching(/^rotate the keys/),
        expect.stringMatching(/^map the UI.*Explore/),
        expect.stringMatching(/^port the parser/),
    ]);
    expect(fold(board)?.textContent?.trim()).toBe(t(`agents.childRows.finished`, { count: 3 }));

    fold(board)?.click();
    await settle();
    expect(rows(board).slice(3)).toEqual([
        expect.stringMatching(/^scan the logsExplore/),
        expect.stringMatching(/^write the notes/),
        expect.stringMatching(/^audit the deps/),
    ]);
});

// It has no chat of its own, so the row's press shows its transcript in its parent's, in the parent's column, and the
// row wears the ring while it is on screen there.
it(`shows an in-process subagent's transcript in its parent's chat from its row`, async () => {
    setAgents([lead], 100);
    roster([inProcess(`call-map`, { description: `map the UI`, model: `claude-opus-x`, effort: `low` })]);
    const board = await mountBoard();

    // Its kind and what it runs on, in words on the row's second line: the model it was served and the tier's word.
    // The kind now sits beside the clock on the title row (ChildRow), so the facts line follows the clock.
    expect(rows(board)).toEqual([expect.stringMatching(/^map the UIExplore.*Claude Opus XLow$/)]);
    const row = tray(board)?.querySelector<HTMLButtonElement>(`button`);
    row?.click();
    await settle();
    expect(useChat().activeId.value).toBe(`lead`);
    expect(subagentOnScreen.value).toEqual({ parentId: `lead`, id: `call-map` });
    expect(row?.classList.contains(`ui-row-select-on`)).toBe(true);
});

// The view is held per window and only the chat panel prunes it, so a board whose chat is popped out keeps a stale copy
// once the reader moves on: the ring follows what the chat shows, not that copy, and never lands on row and card both.
it(`rings the subagent's row alone, and lets it go when the chat moves to another card`, async () => {
    setAgents([lead, agent(`other`, { title: `other work`, startedAt: 3 })], 100);
    roster([inProcess(`call-map`, { description: `map the UI` })]);
    const board = await mountBoard();
    const card = (title: string): HTMLElement => board.querySelector<HTMLElement>(`[aria-label="Focus agent: ${title}"]`)!;
    const row = (): HTMLButtonElement => tray(board)!.querySelector<HTMLButtonElement>(`button`)!;

    row().click();
    await settle();
    expect(row().classList.contains(`ui-row-select-on`)).toBe(true);
    expect(card(`ship the release`).closest(`.session-card-on`)).toBeNull();

    card(`other work`).click();
    await settle();
    expect(useChat().activeId.value).toBe(`other`);
    expect(row().classList.contains(`ui-row-select-on`)).toBe(false);
    expect(card(`other work`).closest(`.session-card-on`)).not.toBeNull();
});

it(`draws no tray for a card that started nothing`, async () => {
    setAgents([agent(`alone`)], 100);
    const board = await mountBoard();

    expect(cards(board)).toEqual([`Focus agent: agent alone`]);
    expect(board.querySelector(`[role="group"]`)).toBeNull();
});
