// @vitest-environment jsdom
//
// THE SELECTED CARD, when the board's own Finished window would have dropped it. The ring the board draws is a
// cross-reference between two panes — this card is what the docked chat is pointing at — so a lane that culls
// it leaves the ring nowhere, and the board reads as "this chat is not an agent" rather than "that card is
// further down". Neither half of the fix can be seen from the store: whether the card is in the DOM at all, and
// whether the board scrolls to a selection it did not make itself.
//
// Driven through the real surfaces, like the chat strip's own reveal test (chatTabsReveal.test.ts): a chat
// opened from outside stands for a tab click, a history row and a deep link alike, since all three land on the
// same write. jsdom lays nothing out, so the scroll is asserted as the CALL — which card, and the cheapest
// scroll (`nearest`, a no-op on a card already on screen).
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { openAgentConversation, resetChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { resetAgents, setAgents } from "../composables/agents/useAgents";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// The import-time globals a mounted board needs (see startAgent.test.ts, which mounts this same view):
// useDevice reads matchMedia at module scope — matches:false keeps the device DESKTOP, the only form factor
// with a dock for "selected" to be about — and environment.ts reads window.env. The unreported ResizeObserver
// leaves the board on its unmeasured default of three columns. scrollIntoView is jsdom's biggest hole and this
// file's subject, so it is installed as the recorder the assertions read.
const { reveals } = vi.hoisted(() => {
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
    };
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
// Mounted per test, with the app-level registrations main.ts makes: the global Icon component, PrimeVue's
// v-tooltip, the router, and vue-query for the filter field's daemon tier. Unmounted between tests because the
// board CLAIMS COMMANDS on mount (Mod+Z, the filter accelerator) and the registry refuses a second claim.
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

// The board reveals on the tick AFTER the selection, so the card it scrolls to is one the DOM already holds.
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

// A lane of ten finished agents, newest first — the order the board itself sorts them into, so `a0` heads the
// lane and `a8` sits two below the window's edge. Built per call: the store stamps its entries in place (seenAt
// on open), so a shared fixture would carry one test's reads into the next.
//
// Seeded at a high revision, so the board's own refresh() at mount — which reaches a daemon that is not there
// and answers nothing — cannot be mistaken for a newer roster.
const seed = (): void =>
    setAgents(
        Array.from({ length: 10 }, (_unused, at): AgentSummary => ({
            id: `a${at}`,
            title: `agent ${at}`,
            status: `landed`,
            provider: `claude`,
            harness: `native`,
            updatedAt: 10_000 - at,
            attention: { plan: false, question: false, permission: false, conflict: false },
        })),
        100,
    );

// Reading a chat the board did not open: a tab click, a History row, a link. All of them land here.
const openFromOutside = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native`, title: `agent ${id.slice(1)}` });
};

// The Finished lane is the board's third section, and a card is the only thing in it that offers a focus. Cards
// on their way OUT are excluded: the lane animates a departure (TransitionGroup), and jsdom fires no
// transitionend, so a card the board has already dropped would otherwise sit in the DOM for the rest of the run.
const finishedCards = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)[2]!.querySelectorAll(`[aria-label^="Focus agent:"]:not(.lane-leave-active)`)].map((card) =>
        card.getAttribute(`aria-label`)!.replace(`Focus agent: `, ``),
    );
// The lane's tail row — a direct child of the section, unlike the header's own buttons.
const tailRow = (el: HTMLElement): string => el.querySelectorAll(`section`)[2]!.querySelector(`:scope > button`)!.textContent!.trim();

it(`keeps the card the docked chat is reading, however far down the lane it is`, async () => {
    seed();
    const board = await mountBoard();
    // Without the pin this is the whole failure: six cards, and the ring on none of them.
    expect(finishedCards(board)).toEqual([`agent 0`, `agent 1`, `agent 2`, `agent 3`, `agent 4`, `agent 5`]);

    openFromOutside(`a8`);
    await settle();

    // Pinned at the TAIL, so the lane's own recency order is otherwise untouched.
    expect(finishedCards(board)).toEqual([`agent 0`, `agent 1`, `agent 2`, `agent 3`, `agent 4`, `agent 5`, `agent 8`]);
    // And counted OUT of the row that collapses the rest: seven cards on screen out of ten leaves three behind.
    expect(tailRow(board)).toBe(`3 earlier`);
});

it(`lets the card go again when the chat moves on`, async () => {
    seed();
    const board = await mountBoard();
    openFromOutside(`a8`);
    await settle();

    openFromOutside(`a0`);
    await settle();

    expect(finishedCards(board)).toEqual([`agent 0`, `agent 1`, `agent 2`, `agent 3`, `agent 4`, `agent 5`]);
    expect(tailRow(board)).toBe(`4 earlier`);
});

it(`scrolls to a card selected off the board — a ring drawn outside the scrollport is a board ignoring the click`, async () => {
    seed();
    const board = await mountBoard();
    reveals.length = 0;

    openFromOutside(`a8`);
    await settle();

    expect(reveals.at(-1)).toEqual({ card: `Focus agent: agent 8`, block: `nearest` });
    expect(board.isConnected).toBe(true);
});

it(`stays put when the selection was made ON the board — the card is already under the cursor`, async () => {
    seed();
    const board = await mountBoard();
    openFromOutside(`a8`);
    await settle();
    reveals.length = 0;

    // Clicking down the lane to skim is the board's cheapest gesture; scrolling the grid under each press
    // would fight it.
    board.querySelector<HTMLElement>(`[aria-label="Focus agent: agent 0"]`)!.click();
    await settle();

    expect(reveals).toEqual([]);
});

it(`scrolls again to a card the board once selected itself — the mark is one selection, not a claim forever`, async () => {
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
