// @vitest-environment jsdom
// Pins lane visibility as on-screen state (display, not just rendered), for a rail mounted once and never
// remounted. Regression: `v-show` on a `v-for` over a constant list applies once at mount and freezes.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../../agents/fleet/useAgents";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { resetChat, useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// Globals a mounted chat needs that jsdom lacks: matchMedia, window.env, ResizeObserver, scrollIntoView.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

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
    resetChat();
    resetAgents();
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

// Two agents, one per lane not already shown (Attention, Finished). Seeded at a high revision so the roster
// read isn't mistaken for one from a live daemon.
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
        .map((section) => section.querySelectorAll(`header span`)[1]?.textContent?.trim() ?? ``);

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

// Finished never empties itself the way Active/Attention do, so this rail needs its own cap on it, matching
// the board's windowFinished.
const seedFinished = (count: number): void =>
    setAgents(
        Array.from({ length: count }, (_, at) => ({
            id: `done${at}`,
            title: `landed run ${at}`,
            status: `landed`,
            provider: `claude`,
            harness: `native`,
            // Newest first, so `done0` leads and `done${count - 1}` is furthest behind the fold.
            updatedAt: 2_000 - at,
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
    [...el.querySelectorAll(`button`)].find((button) => /earlier|Show fewer/.test(button.textContent ?? ``));
const clearButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Clear`);

it(`caps the Finished lane and says how many it is holding back`, async () => {
    seedFinished(10);
    const el = await mountList();

    openFinished(10);

    await settle();
    expect(cardsOnScreen(el)).toEqual([`done0`, `done1`, `done2`, `done3`, `done4`, `done5`, `done6`]);
    expect(el.querySelector(`section header span:nth-of-type(3)`)?.textContent?.trim()).toBe(`10`);
    expect(tailRow(el)?.textContent?.trim()).toBe(`3 earlier`);
});

it(`opens the rest in place, and folds them back`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();

    tailRow(el)?.click();

    await settle();
    expect(cardsOnScreen(el)).toHaveLength(10);
    expect(tailRow(el)?.textContent?.trim()).toBe(`Show fewer`);

    tailRow(el)?.click();

    await settle();
    expect(cardsOnScreen(el)).toHaveLength(7);
});

it(`pins the chat being read into the window, however far down the lane it is`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();

    openFromBoard(`done9`); // done9 is the oldest finished chat, three rows behind the fold.

    await settle();
    expect(cardsOnScreen(el)).toEqual([`done0`, `done1`, `done2`, `done3`, `done4`, `done5`, `done6`, `done9`]);
    expect(tailRow(el)?.textContent?.trim()).toBe(`2 earlier`);
});

it(`clears the whole lane from its header, whatever the window is showing`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();
    expect(clearButton(el)).toEqual(expect.any(Object));

    clearButton(el)?.click();

    await settle();
    // Closes every finished chat, not just the six on screen; closeTabs leaves one fresh chat behind.
    expect(lanesOnScreen(el)).toEqual([`Active`]);
    expect(cardsOnScreen(el).filter((id) => id.startsWith(`done`))).toEqual([]);
});
