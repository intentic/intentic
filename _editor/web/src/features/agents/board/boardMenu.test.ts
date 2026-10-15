// The one card menu, through the real board: a right-click opens it on the card pressed, with that card's rows, and its
// Open row points the chat at that card. Unit-level rows are view/cardMenu.test.ts; this pins the board's wiring.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick } from "vue";
import { useChat } from "../../chat/run/useChat";
import { reviewAction } from "../fleet/agentStatus";
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
    // The menu is a PrimeVue overlay; without its config it throws on first paint.
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

const landed = (id: string): AgentSummary => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    branch: `agent/${id}`,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
});

// The menu's rows, wherever PrimeVue drew its overlay; a row's press sits on its link.
const menuRows = (): string[] => [...document.querySelectorAll(`[role="menuitem"]`)].map((row) => row.getAttribute(`aria-label`) ?? ``);
const pressRow = (label: string): void => document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${label}"] a`)!.click();

it(`opens on the card right-clicked, with that card's rows, and points the chat at it from Open`, async () => {
    setAgents([landed(`a1`), landed(`a2`)], 100);
    const board = await mountBoard();

    board.querySelector(`[aria-label="Focus agent: agent a2"]`)!.dispatchEvent(new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true }));
    await settle();

    expect(menuRows()).toEqual([
        t(`ui.action.open`),
        reviewAction(landed(`a2`))!,
        t(`ui.action.rename`),
        t(`agents.agentReactions.addReaction`),
        t(`agents.agentsView.copySessionName`),
        t(`agents.agentsView.archive`),
    ]);
    pressRow(t(`ui.action.open`));
    await settle();
    expect(useChat().activeId.value).toBe(`a2`);
});

// The header keeps the filing press and one ⋯ (AgentCard's headerActions), not a seat per press: the ⋯ opens this same
// menu, and what only the card can do, renaming its title in place, is done from there.
it(`opens from the card's ⋯ as well, and renames the card in place from it`, async () => {
    setAgents([landed(`a1`)], 100);
    const board = await mountBoard();
    const card = board.querySelector<HTMLElement>(`[aria-label="Focus agent: agent a1"]`)!;
    const header = card.firstElementChild!;
    expect([...header.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`))).toEqual([
        t(`agents.agentCard.archiveAgent`),
        t(`ui.action.moreActions`),
    ]);

    header.querySelector<HTMLElement>(`button[aria-label="${t(`ui.action.moreActions`)}"]`)!.click();
    await settle();
    expect(menuRows()).toContain(t(`ui.action.rename`));
    pressRow(t(`ui.action.rename`));
    await settle();
    expect(card.querySelector<HTMLInputElement>(`input[aria-label="${t(`agents.words.agentTitle`)}"]`)?.value).toBe(`agent a1`);
});
