// @vitest-environment jsdom
//
// HOW MUCH OF THE ARCHIVE THE BOARD DRAWS WHEN THE DOOR OPENS.
//
// The live lanes are bounded by what the user is working on, and the Finished lane windows itself on top of
// that. The archive is bounded by nothing — it is every session the workspace has ever finished — and it used
// to be drawn whole: one full card per row, each with its own slot in the lane's TransitionGroup. So on a
// workspace with a thousand sessions behind the door, the press that opened it built a thousand cards in a
// single frame and the app looked hung, at the one moment the archive is meant to prove that filing things
// away is cheap.
//
// Asserted through the real board rather than on the paging expression, because the count that matters is how
// many CARDS exist in the DOM — and because the two halves that keep the page honest are only visible here:
// the tail row that adds the next page, and the header count, which must go on reporting the pile rather than
// the page (a search answered "30 of 1030" is the pager talking over the search).
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { resetAgents, resetArchive, setAgents, useAgents } from "../composables/agents/useAgents";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// The import-time globals a mounted board needs — the same set boardSelection.test.ts installs, and for the
// same reasons: matchMedia keeps the device desktop, the unreported ResizeObserver leaves the board on three
// columns, environment.ts reads window.env, and jsdom has no scrollIntoView at all.
vi.hoisted(() => {
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
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
    app.component(`Icon`, { render: () => null });
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

/* A pile of filed-away sessions, newest first — written straight onto the store's archive half, which is where
 * the daemon's own answer lands (loadArchived). The board still asks for it on opening the door; that request
 * reaches no daemon here and leaves what is already listed, which is exactly the failure mode the list is
 * written to survive. */
const fileAway = (count: number): void => {
    useAgents().archived.value = Array.from({ length: count }, (_unused, at) => ({
        id: `old${at}`,
        title: `old ${at}`,
        status: `landed` as const,
        provider: `claude` as const,
        harness: `native` as const,
        updatedAt: 10_000 - at,
        archivedAt: 20_000 - at,
        attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
        open: false,
        unread: false,
        unsent: false,
    }));
};

// One live agent, so the Finished lane has a door to open in the first place (the archive counter is drawn in
// its header) and the board is not on its first-run screen.
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
                attention: { plan: false, question: false, permission: false, service: false, capability: false, conflict: false },
            } satisfies AgentSummary,
        ],
        100,
    );

// The Finished lane is the board's third section, and the archive opens INTO it. Cards on their way out are
// excluded for boardSelection.test.ts's reason: jsdom fires no transitionend, so a departing card would
// otherwise sit in the DOM for the rest of the run.
const archiveCards = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)[2]!.querySelectorAll(`[aria-label^="Focus agent:"]:not(.lane-leave-active)`)].map((card) =>
        card.getAttribute(`aria-label`)!.replace(`Focus agent: `, ``),
    );
// The lane's tail — a direct child of the section, unlike the header's own buttons. Absent once the whole pile
// is drawn, which is itself an assertion: a row offering nothing is a row that lies.
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
    // Newest-archived first, and from the top: the page is the head of the list, not a sample of it.
    expect(archiveCards(board).slice(0, 3)).toEqual([`old 0`, `old 1`, `old 2`]);
    // The header goes on counting the PILE — the page is a drawing decision, not a claim about what is filed.
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

// Reopening is the same press as opening: a reader who paged four deep last time and came back to look
// something else up should not pay for those four pages again.
it(`starts from one page again each time the door is opened`, async () => {
    live();
    fileAway(70);
    const board = await mountBoard();
    await openArchive(board);
    tailRow(board)!.click();
    await settle();
    expect(archiveCards(board)).toHaveLength(60);

    // Closed…
    board.querySelector<HTMLElement>(`[aria-label="Back to finished agents"]`)!.click();
    await settle();
    await openArchive(board);

    expect(archiveCards(board)).toHaveLength(30);
});
