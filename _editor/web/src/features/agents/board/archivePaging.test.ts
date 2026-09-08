// @vitest-environment jsdom
// How much of the archive the board draws when the door opens: drawn whole, a thousand-session archive built a thousand
// cards in one frame. Asserted through the real board, since what matters is DOM card count, the tail row, and the
// header count reporting the pile rather than the page.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetChat } from "../../chat/run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { resetAgents, useAgents } from "../fleet/useAgents";
import { resetArchive, setAgents } from "../fleet/useAgents-registry";
import { router } from "../../../router";
import AgentsView from "./AgentsView.vue";
import { IconStub } from "@intentic/ui/testing";

// Same import-time globals boardSelection.test.ts installs: matchMedia keeps desktop, the unreported ResizeObserver
// keeps three columns, and jsdom has no scrollIntoView.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

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
    app.mount(el);
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear();
    resetChat();
    resetAgents();
    resetArchive();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
});

// A pile of filed-away sessions, newest first, written straight onto the store's archive half, like the daemon's own
// answer (loadArchived); the board's own request for it reaches no daemon here.
const fileAway = (count: number): void => {
    useAgents().archived.value = Array.from({ length: count }, (_unused, at) => ({
        id: `old${at}`,
        title: `old ${at}`,
        status: `landed` as const,
        provider: `claude` as const,
        harness: `native` as const,
        updatedAt: 10_000 - at,
        archivedAt: 20_000 - at,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        open: false,
        unread: false,
        unsent: false,
    }));
};

// One live agent, so the Finished lane has a door to open and the board isn't on its first-run screen.
const live = (): void =>
    setAgents(
        [
            {
                id: `live`,
                title: `on the board`,
                status: `landed`,
                provider: `claude`,
                harness: `native`,
                updatedAt: 9_000,
                attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            } satisfies AgentSummary,
        ],
        100,
    );

// The Finished lane is the board's third section; cards mid-leave-transition are excluded, since jsdom never fires
// transitionend.
const archiveCards = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)[2]!.querySelectorAll(`[aria-label^="Focus agent:"]:not(.lane-leave-active)`)].map((card) =>
        card.getAttribute(`aria-label`)!.replace(`Focus agent: `, ``),
    );
// The lane's tail: a direct child of the section, unlike the header's own buttons. Absent once the whole pile is drawn.
const tailRow = (el: HTMLElement): HTMLElement | null => el.querySelectorAll(`section`)[2]!.querySelector(`:scope > button`);
const laneCount = (el: HTMLElement): string => el.querySelectorAll(`section`)[2]!.querySelector(`span.rounded-full`)!.textContent!.trim();

const openArchive = async (el: HTMLElement): Promise<void> => {
    el.querySelector<HTMLElement>(`[aria-label^="Open the archive"]`)!.click();
    await settle();
};

it(`draws one page of the archive, however deep the pile behind it`, async () => {
    live();
    fileAway(70);
    const board = await mountBoard();

    await openArchive(board);

    expect(archiveCards(board)).toHaveLength(30);
    // Newest-archived first, from the top: the page is the head of the list, not a sample of it.
    expect(archiveCards(board).slice(0, 3)).toEqual([`old 0`, `old 1`, `old 2`]);
    // The header keeps counting the whole pile: paging is a drawing decision, not a claim about what's filed.
    expect(laneCount(board)).toBe(`70`);
    expect(tailRow(board)?.textContent?.trim()).toBe(`40 more`);
});

it(`adds a page at a time, and stops offering when there is nothing left behind the row`, async () => {
    live();
    fileAway(70);
    const board = await mountBoard();
    await openArchive(board);

    tailRow(board)!.click();
    await settle();
    expect(archiveCards(board)).toHaveLength(60);
    expect(tailRow(board)?.textContent?.trim()).toBe(`10 more`);

    tailRow(board)!.click();
    await settle();
    expect(archiveCards(board)).toHaveLength(70);
    expect(tailRow(board)).toBeNull();
});

it(`draws a short archive whole, with no row under it`, async () => {
    live();
    fileAway(4);
    const board = await mountBoard();

    await openArchive(board);

    expect(archiveCards(board)).toHaveLength(4);
    expect(tailRow(board)).toBeNull();
});

// Reopening the door restarts paging: a reader who paged in last time shouldn't pay for those pages again.
it(`starts from one page again each time the door is opened`, async () => {
    live();
    fileAway(70);
    const board = await mountBoard();
    await openArchive(board);
    tailRow(board)!.click();
    await settle();
    expect(archiveCards(board)).toHaveLength(60);

    board.querySelector<HTMLElement>(`[aria-label="Back to finished agents"]`)!.click();
    await settle();
    await openArchive(board);

    expect(archiveCards(board)).toHaveLength(30);
});
