// Pins lane visibility as on-screen state (display, not just rendered), for a rail mounted once and never
// remounted. Regression: `v-show` on a `v-for` over a constant list applies once at mount and freezes.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { setAgents } from "../../../../models/fleet/useAgents-registry";
import { useChat } from "../../../../models/conversations/run/useChat";
import { openAgentConversation } from "../../../../models/conversations/panel/useChat-reveal";
import { queryClient } from "../../../../lib/queryPersistence";
import { router } from "../../../../router/index";
import ChatTabList from "../ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// Globals a mounted chat needs that jsdom lacks: matchMedia, window.env, ResizeObserver, scrollIntoView.
(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
})();

let app: App | undefined;

// Mounted once per test, mirroring the floating window's own lifetime; every assertion below assumes this.
const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    // Wired like ChatPanel: the list emits verbs, the host performs them (here, useChat().closeTabs).
    app = createApp({ render: () => h(ChatTabList, { onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetSandboxScope();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// One agent per lane. Seeded at a high revision so the roster read isn't mistaken for one from a live daemon.
const seed = (): void =>
    setAgents(
        [
            {
                id: `waiting`,
                title: `answer the question`,
                status: `awaiting`,
                provider: `claude`,
                harness: `native`,
                updatedAt: 2_000,
                attention: { plan: false, question: true, permission: false, capability: false, credential: false, conflict: false },
            },
            {
                id: `busy`,
                title: `writing the patch`,
                status: `running`,
                provider: `claude`,
                harness: `native`,
                updatedAt: 1_500,
                attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            },
            {
                id: `done`,
                title: `landed the refactor`,
                status: `landed`,
                provider: `claude`,
                harness: `native`,
                updatedAt: 1_000,
                attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            },
        ] satisfies AgentSummary[],
        100,
    );

// Same call the board's own card click makes.
const openFromBoard = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native` });
};

// Lanes actually visible: rendered and not `display:none`. A section left in the DOM but hidden counts as absent.
const lanesOnScreen = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)]
        .filter((section) => section instanceof HTMLElement && section.style.display !== `none`)
        .map((section) => section.querySelector(`header span`)?.textContent?.trim() ?? ``);

// Chats visible under those lanes, to check a clicked card actually appears.
const cardsOnScreen = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)]
        .filter((section) => section instanceof HTMLElement && section.style.display !== `none`)
        .flatMap((section) => [...section.querySelectorAll(`[data-chat-tab]`)].map((card) => card.getAttribute(`data-chat-tab`) ?? ``));

it(`shows a chat opened from the board in a lane the rail was not drawing`, async () => {
    seed();
    const el = await mountList();
    // A fresh mount starts with one untouched draft, the only chat in Active.
    expect(lanesOnScreen(el)).toEqual([`Active`]);

    openFromBoard(`waiting`);

    await settle();
    expect(lanesOnScreen(el)).toEqual([`Attention`]);
    expect(cardsOnScreen(el)).toEqual([`waiting`]);
});

it(`grows a second lane as the board opens a second kind of agent`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`waiting`);
    await settle();

    openFromBoard(`done`);

    await settle();
    expect(lanesOnScreen(el)).toEqual([`Attention`, `Finished`]);
    expect(cardsOnScreen(el)).toEqual([`waiting`, `done`]);
});

it(`drops a lane the last chat left, so no empty header is left standing`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`waiting`);
    openFromBoard(`done`);
    await settle();
    expect(lanesOnScreen(el)).toEqual([`Attention`, `Finished`]);

    useChat().closeTabs(new Set([`done`]));

    await settle();
    expect(lanesOnScreen(el)).toEqual([`Attention`]);
    expect(cardsOnScreen(el)).toEqual([`waiting`]);
});

// Finished never empties itself the way Active/Attention do, so the rail folds what it is done with (doneFold.ts): read,
// landed, owing nothing. `owes` gives a chat something still owed: news not read yet, or work not landed.
const seedFinished = (count: number, owes: Readonly<Record<string, `unread` | `unlanded`>> = {}): void =>
    setAgents(
        Array.from({ length: count }, (_, at) => ({
            id: `done${at}`,
            title: `landed run ${at}`,
            status: owes[`done${at}`] === `unlanded` ? (`ready` as const) : (`landed` as const),
            provider: `claude`,
            harness: `native`,
            // Newest first, so `done0` leads and `done${count - 1}` is the oldest.
            updatedAt: 2_000 - at,
            // Read after it finished, save where it is owed news: last opened before it did.
            seenAt: owes[`done${at}`] === `unread` ? 1 : 5_000,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        })) satisfies AgentSummary[],
        100,
    );

// Opens oldest first, leaving the newest as the focused chat: these cases test the cap, not the pin.
const openFinished = (count: number): void => {
    for (let at = count - 1; at >= 0; at--) {
        openFromBoard(`done${at}`);
    }
};

const tailRow = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => (button.textContent?.trim() ?? ``).endsWith(` done`));
// Clear inside one named lane: every lane carries one, so matching on the word alone would hit whichever lane
// happened to draw first rather than the one under test.
const clearButton = (el: HTMLElement, lane: string): HTMLButtonElement | undefined => {
    const section = [...el.querySelectorAll(`section`)].find((held) => held.querySelector(`header span`)?.textContent?.trim() === lane);
    return [...(section?.querySelectorAll(`button`) ?? [])].find((button) => button.textContent?.trim() === `Clear`);
};

it(`folds the finished chats it is done with, and says how many`, async () => {
    seedFinished(10);
    const el = await mountList();

    openFinished(10);

    await settle();
    // done0 is the one being read, so it stays out of the fold.
    expect(cardsOnScreen(el)).toEqual([`done0`]);
    expect(tailRow(el)?.textContent?.trim()).toBe(`9 done`);
});

it(`keeps above the fold a finished chat that still owes something: news not read, work not landed`, async () => {
    seedFinished(10, { done4: `unread`, done7: `unlanded` });
    const el = await mountList();

    openFinished(10);

    await settle();
    expect(cardsOnScreen(el)).toEqual([`done0`, `done4`, `done7`]);
    expect(tailRow(el)?.textContent?.trim()).toBe(`7 done`);
});

it(`opens the done ones in place under the fold, and folds them back`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();

    tailRow(el)?.click();

    await settle();
    expect(cardsOnScreen(el)).toHaveLength(10);
    expect(tailRow(el)?.getAttribute(`aria-expanded`)).toBe(`true`);

    tailRow(el)?.click();

    await settle();
    expect(cardsOnScreen(el)).toEqual([`done0`]);
});

it(`folds the chat the reader left, and keeps the one they moved to`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();

    openFromBoard(`done9`); // The oldest, from under the fold.

    await settle();
    expect(cardsOnScreen(el)).toEqual([`done9`]);
    expect(tailRow(el)?.textContent?.trim()).toBe(`9 done`);
});

it(`clears the whole lane from its header, whatever the window is showing, but keeps the focused chat`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();
    // done0 is the focused chat, so Clear names the other nine.
    expect(clearButton(el, `Finished`)?.getAttribute(`aria-label`)).toBe(`Close all 9 finished chats`);

    clearButton(el, `Finished`)?.click();

    await settle();
    // Closes every other finished chat, not just the five others on screen.
    expect(lanesOnScreen(el)).toEqual([`Finished`]);
    expect(cardsOnScreen(el)).toEqual([`done0`]);
    // With only the focused chat left, the lane has nothing to clear.
    expect(clearButton(el, `Finished`)).toBeUndefined();
});

// Clear is on every lane, not just Finished: Active and Attention fill up over a long session too, and a
// close is the same lossless act in all three (the turn detaches, the chat stays on the board).
const openEveryLane = async (el: HTMLElement): Promise<void> => {
    // The blank a window opens on is swept the moment focus leaves it, so Active has nothing to clear yet.
    expect(clearButton(el, `Active`)).toBeUndefined();
    openFromBoard(`waiting`);
    openFromBoard(`busy`);
    openFromBoard(`done`);
    await settle();
    expect(lanesOnScreen(el)).toEqual([`Attention`, `Active`, `Finished`]);
};

it(`clears the Attention lane from its header, leaving the other lanes standing`, async () => {
    seed();
    const el = await mountList();
    await openEveryLane(el);
    expect(clearButton(el, `Attention`)?.getAttribute(`aria-label`)).toBe(`Close 1 waiting chat`);

    clearButton(el, `Attention`)?.click();

    await settle();
    expect(lanesOnScreen(el)).toEqual([`Active`, `Finished`]);
    expect(cardsOnScreen(el)).toEqual([`busy`, `done`]);
});

it(`clears the Active lane from its header, leaving the other lanes standing`, async () => {
    seed();
    const el = await mountList();
    await openEveryLane(el);
    expect(clearButton(el, `Active`)?.getAttribute(`aria-label`)).toBe(`Close 1 working chat`);

    clearButton(el, `Active`)?.click();

    await settle();
    expect(lanesOnScreen(el)).toEqual([`Attention`, `Finished`]);
    expect(cardsOnScreen(el)).toEqual([`waiting`, `done`]);
});
