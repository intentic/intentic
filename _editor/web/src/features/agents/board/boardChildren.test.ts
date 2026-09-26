// The children an agent started, through the real board: they hang under its card as rows instead of standing as
// cards, working ones in sight and settled ones behind a count, while a child that asks something keeps its card and
// says whose it is. The fold's rules are view/childFold.test.ts; this pins the board's wiring of them.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { useChat } from "../../chat/run/useChat";
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

it(`hangs the children under their parent's card, working ones in sight and settled ones behind a count`, async () => {
    setAgents(family, 100);
    const board = await mountBoard();

    expect(cards(board).toSorted()).toEqual([`Focus agent: rotate the keys`, `Focus agent: ship the release`]);
    expect(rows(board)).toHaveLength(1);
    expect(rows(board)[0]).toContain(`port the parser`);
    expect(fold(board)?.textContent?.trim()).toBe(t(`agents.childRows.finished`, { count: 2 }));
    expect(fold(board)?.getAttribute(`aria-expanded`)).toBe(`false`);
});

it(`says whose a child asking something is, on the card it keeps`, async () => {
    setAgents(family, 100);
    const board = await mountBoard();

    const asking = board.querySelector(`[aria-label="Focus agent: rotate the keys"]`);
    const mark = asking?.querySelector(`a[aria-label="${t(`agents.parentMark.startedBy`, { title: `ship the release` })}"]`);
    expect(mark?.textContent?.trim()).toBe(`ship the release`);
});

it(`unfolds the settled children on the count, and points the chat at a child from its row`, async () => {
    setAgents(family, 100);
    const board = await mountBoard();

    fold(board)?.click();
    await settle();
    expect(fold(board)?.getAttribute(`aria-expanded`)).toBe(`true`);
    // Each row is its title, then how long it worked or when it settled.
    expect(rows(board)).toEqual([expect.stringMatching(/^port the parser/), expect.stringMatching(/^write the notes/), expect.stringMatching(/^audit the deps/)]);

    [...(tray(board)?.querySelectorAll<HTMLButtonElement>(`button:not([aria-expanded])`) ?? [])].find((row) => row.textContent?.includes(`audit the deps`))?.click();
    await settle();
    expect(useChat().activeId.value).toBe(`audit`);
});

it(`draws no tray for a card that started nothing`, async () => {
    setAgents([agent(`alone`)], 100);
    const board = await mountBoard();

    expect(cards(board)).toEqual([`Focus agent: agent alone`]);
    expect(board.querySelector(`[role="group"]`)).toBeNull();
});
