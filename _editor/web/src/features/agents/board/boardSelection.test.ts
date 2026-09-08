// @vitest-environment jsdom
// The card the docked chat points at stays visible even when the Finished window would drop it, or the ring has nowhere
// to land. Driven through real surfaces (a tab click, a history row, a link) since they all land on the same write. The
// board's other selection (multi-pane splits) is tested at the foot of the file.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetChat, useChat } from "../../chat/run/useChat";
import { openAgentConversation } from "../../chat/panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { resetAgents } from "../fleet/useAgents";
import { FINISHED_WINDOW } from "../fleet/useAgents-fleet";
import { setAgents } from "../fleet/useAgents-registry";
import { router } from "../../../router";
import AgentsView from "./AgentsView.vue";
import { IconStub } from "@intentic/ui/testing";

// Same import-time globals as startAgent.test.ts; scrollIntoView is jsdom's biggest gap and this file's subject,
// recorded here for the assertions.
const { reveals } = vi.hoisted(() => {
    const recorded: { card: string | undefined; block: string | undefined }[] = [];
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: boolean | ScrollIntoViewOptions): void {
        recorded.push({
            card: this.getAttribute(`aria-label`) ?? undefined,
            block: typeof options === `object` ? options.block : undefined,
        });
    };
    return { reveals: recorded };
});

let app: App | undefined;
// Mounted per test with main.ts's app-level registrations; unmounted between tests since the board claims global
// commands (Mod+Z, the filter accelerator) that refuse a second claim.
const mountBoard = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(AgentsView) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

// The board reveals a tick after the selection, so the card it scrolls to is already in the DOM.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetChat();
    resetAgents();
    reveals.length = 0;
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
});

// Ten finished agents, newest first, matching the board's own sort; built fresh per call since the store stamps entries
// in place. Seeded at a high revision so the board's own no-op refresh() can't be mistaken for a newer roster.
const ROSTER_SIZE = 10;
// The titles a full Finished window shows, derived from the window itself: these were spelled out as a literal
// seven-title array, so changing the window broke this file with a diff about `agent 6` rather than about pinning,
// which is the only thing these two tests are actually asserting.
const windowTitles = Array.from({ length: FINISHED_WINDOW }, (_unused, at) => `agent ${at}`);
const roster = (): AgentSummary[] =>
    Array.from({ length: ROSTER_SIZE }, (_unused, at): AgentSummary => ({
        id: `a${at}`,
        title: `agent ${at}`,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 10_000 - at,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    }));
const seed = (): void => setAgents(roster(), 100);

// Reading a chat the board did not open: a tab click, a history row, a link. All land here.
const openFromOutside = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native`, title: `agent ${id.slice(1)}` });
};

// The Finished lane is the board's third section; a card is its only focusable item. Cards mid-leave-transition are
// excluded, since jsdom never fires transitionend.
const finishedCards = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)[2]!.querySelectorAll(`[aria-label^="Focus agent:"]:not(.lane-leave-active)`)].map((card) =>
        card.getAttribute(`aria-label`)!.replace(`Focus agent: `, ``),
    );
// The lane's tail row: a direct child of the section, unlike the header's own buttons.
const tailRow = (el: HTMLElement): string => el.querySelectorAll(`section`)[2]!.querySelector(`:scope > button`)!.textContent!.trim();

it(`keeps the card the docked chat is reading, however far down the lane it is`, async () => {
    seed();
    const board = await mountBoard();
    // Without the pin, this is the whole failure: a window's worth of cards and no ring on any of them.
    expect(finishedCards(board)).toEqual(windowTitles);

    openFromOutside(`a8`);
    await settle();

    // Pinned at the tail, so the lane's own recency order is otherwise untouched.
    expect(finishedCards(board)).toEqual([...windowTitles, `agent 8`]);
    // Counted out of the row that collapses the rest: the window plus the pin are on screen, so the row may only
    // claim what is left of the roster.
    expect(tailRow(board)).toBe(`${ROSTER_SIZE - FINISHED_WINDOW - 1} earlier`);
});

it(`lets the card go again when the chat moves on`, async () => {
    seed();
    const board = await mountBoard();
    openFromOutside(`a8`);
    await settle();

    openFromOutside(`a0`);
    await settle();

    expect(finishedCards(board)).toEqual(windowTitles);
    expect(tailRow(board)).toBe(`${ROSTER_SIZE - FINISHED_WINDOW} earlier`);
});

it(`scrolls to a card selected off the board: a ring drawn outside the scrollport is a board ignoring the click`, async () => {
    seed();
    const board = await mountBoard();
    reveals.length = 0;

    openFromOutside(`a8`);
    await settle();

    expect(reveals.at(-1)).toEqual({ card: `Focus agent: agent 8`, block: `nearest` });
    expect(board.isConnected).toBe(true);
});

it(`stays put when the selection was made ON the board: the card is already under the cursor`, async () => {
    seed();
    const board = await mountBoard();
    openFromOutside(`a8`);
    await settle();
    reveals.length = 0;

    // Clicking down the lane to skim is the board's cheapest gesture; scrolling under each press would fight it.
    board.querySelector<HTMLElement>(`[aria-label="Focus agent: agent 0"]`)!.click();
    await settle();

    expect(reveals).toEqual([]);
});

it(`scrolls again to a card the board once selected itself: the mark is one selection, not a claim forever`, async () => {
    seed();
    const board = await mountBoard();
    board.querySelector<HTMLElement>(`[aria-label="Focus agent: agent 0"]`)!.click();
    await settle();
    openFromOutside(`a3`);
    await settle();
    reveals.length = 0;

    // Back to the card clicked at the start, this time from the tab strip.
    openFromOutside(`a0`);
    await settle();

    expect(reveals.at(-1)).toEqual({ card: `Focus agent: agent 0`, block: `nearest` });
});

// A roster frame update must not insert transient probe nodes into the DOM for an unchanged lane.
it(`does not insert probe cards when a roster frame updates an unchanged lane`, async () => {
    seed();
    const board = await mountBoard();
    const inserted: Element[] = [];
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element && node.classList.contains(`session-card`)) {
                    inserted.push(node);
                }
            }
        }
    });
    observer.observe(board, { childList: true, subtree: true });

    const next = roster();
    next[0] = { ...next[0]!, updatedAt: next[0]!.updatedAt + 1 };
    setAgents(next, 101);
    await settle();
    observer.disconnect();

    expect(inserted).toEqual([]);
});

// Alt/Ctrl/Shift-click builds a multi-pane selection; a plain click on a card collapses it back to one pane. Asserted
// on the pane set, since the rings are drawn from it.
const cardEl = (board: HTMLElement, at: number): HTMLElement => board.querySelector<HTMLElement>(`[aria-label="Focus agent: agent ${at}"]`)!;

it(`collapses a split back to the one card clicked without a modifier`, async () => {
    seed();
    const board = await mountBoard();

    cardEl(board, 0).dispatchEvent(new MouseEvent(`click`, { bubbles: true, altKey: true }));
    await settle();
    cardEl(board, 1).dispatchEvent(new MouseEvent(`click`, { bubbles: true, altKey: true }));
    await settle();
    expect(useChat().panes.value).toEqual([`a0`, `a1`]);

    cardEl(board, 2).click();
    await settle();

    expect(useChat().panes.value).toEqual([`a2`]);
    // The two cards that left the screen stay open; one click in the rail brings either back.
    expect(useChat().conversations.value.map((c) => c.conversationId)).toEqual(expect.arrayContaining([`a0`, `a1`, `a2`]));
});

it(`still adds a column when the modifier says so`, async () => {
    seed();
    const board = await mountBoard();
    cardEl(board, 2).click();
    await settle();

    cardEl(board, 0).dispatchEvent(new MouseEvent(`click`, { bubbles: true, altKey: true }));
    await settle();

    expect(useChat().panes.value).toEqual([`a2`, `a0`]);
});
