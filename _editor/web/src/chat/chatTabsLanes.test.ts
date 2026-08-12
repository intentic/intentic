// @vitest-environment jsdom
//
// THE RAIL IS MOUNTED ONCE AND LIVES FOR HOURS. Docked, the open-chat list is a sheet the header drops — built
// and torn down on every open — so anything it only gets right at mount time still looks right. Popped out it
// is the window's left edge for as long as that window is open, and every lane it draws has to follow the store
// with no remount to fall back on. That is what this file holds it to, by mounting the list ONCE and then
// opening chats the way the fleet board does.
//
// The bug it exists for: the lanes were hidden with `v-show` over the constant LANES list. A `v-for` over a
// compile-time constant compiles to a STABLE fragment whose <section>s carry no patch flag, so Vue patched
// their children through the block tree and never the sections themselves — `v-show` ran once at mount and
// `display` froze there. A chat opened from the board arrived in a lane still set to `display:none`, and the
// popped-out rail sat looking empty while the panel beside it had the conversation open ("I keep clicking cards
// in /agents and the popped-out window doesn't react"). Every assertion here is about what is ON SCREEN rather
// than what is rendered, because that was the whole gap: the section was in the DOM the entire time, with the
// right cards in it, invisible.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents, setAgents } from "../composables/agents/useAgents";
import { openAgentConversation, resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import ChatTabList from "./ChatTabList.vue";

// The import-time globals a mounted chat component needs (see chatTabsReveal.test.ts): useDevice reads
// matchMedia at module scope, environment.ts reads window.env, and jsdom implements neither ResizeObserver nor
// scrollIntoView (the list asks for one on every focus).
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
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

let app: App | undefined;

// Mounted ONCE per test and never again — the pop-out window's own lifetime, and the condition every assertion
// below is made under.
const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    // Wired the way ChatPanel wires it — the list emits verbs and its host performs them, so a press on a close
    // affordance here has the same consequence it does in the app.
    app = createApp({ render: () => h(ChatTabList, { onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids) }) });
    app.component(`Icon`, { render: () => null });
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

// Two agents the board could hand this list, one per lane it is not already showing: a question waiting on the
// user (Attention) and a landed run (Finished). Seeded at a high revision so the list's own roster read — which
// reaches a daemon that is not there — cannot be mistaken for a newer one.
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
                attention: { plan: false, question: true, permission: false, service: false, conflict: false },
            },
            {
                id: `done`,
                title: `landed the refactor`,
                status: `landed`,
                provider: `claude`,
                harness: `native`,
                updatedAt: 1_000,
                attention: { plan: false, question: false, permission: false, service: false, conflict: false },
            },
        ] satisfies AgentSummary[],
        100,
    );

// A card on /agents, which is the traffic this file is about — the same call the board's own click makes.
const openFromBoard = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native` });
};

// The lanes a user could actually read off the rail: rendered AND not hidden. A section left in the DOM under
// `display:none` counts as absent here, which is the whole point.
const lanesOnScreen = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)]
        .filter((section) => section instanceof HTMLElement && section.style.display !== `none`)
        .map((section) => section.querySelectorAll(`header span`)[1]?.textContent?.trim() ?? ``);

// The chats on screen under those lanes — the answer to "did the card I just clicked turn up in the list".
const cardsOnScreen = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`section`)]
        .filter((section) => section instanceof HTMLElement && section.style.display !== `none`)
        .flatMap((section) => [...section.querySelectorAll(`[data-chat-tab]`)].map((card) => card.getAttribute(`data-chat-tab`) ?? ``));

it(`shows a chat opened from the board in a lane the rail was not drawing`, async () => {
    seed();
    const el = await mountList();
    // A fresh window: one untouched draft, which is an Active chat and the only lane with anything in it.
    expect(lanesOnScreen(el)).toEqual([`Active`]);

    openFromBoard(`waiting`); // the click on /agents — the draft it leaves behind is swept by the same write

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

/* THE FINISHED LANE IS THE ONLY ONE THAT GROWS. Attention and Active empty themselves — a card leaves them the
 * moment its turn settles — so on the surface that is mounted for hours, an uncapped Finished lane is a column
 * of every agent the day produced. The board has always capped its own (windowFinished); this list drew the
 * same lane with no cap at all, which is the "my popped-out Finished lane keeps growing" report. */
const seedFinished = (count: number): void =>
    setAgents(
        Array.from({ length: count }, (_, at) => ({
            id: `done${at}`,
            title: `landed run ${at}`,
            status: `landed`,
            provider: `claude`,
            harness: `native`,
            // Newest first, so `done0` leads the lane and `done${count - 1}` is the one furthest behind the fold.
            updatedAt: 2_000 - at,
            attention: { plan: false, question: false, permission: false, service: false, conflict: false },
        })) satisfies AgentSummary[],
        100,
    );

// Opening them oldest-first leaves the NEWEST as the focused chat — inside the window, so these cases are about
// the cap alone and not about the pin.
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
    expect(cardsOnScreen(el)).toEqual([`done0`, `done1`, `done2`, `done3`, `done4`, `done5`]);
    // The header still counts the whole lane — the row below is what accounts for the difference.
    expect(el.querySelector(`section header span:nth-of-type(3)`)?.textContent?.trim()).toBe(`10`);
    expect(tailRow(el)?.textContent?.trim()).toBe(`4 earlier`);
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
    expect(cardsOnScreen(el)).toHaveLength(6);
});

// The list is the switcher for the panel beside it, so the one card it may never drop is the chat that panel is
// showing — the board's own exception, and the reason the window takes a selection at all.
it(`pins the chat being read into the window, however far down the lane it is`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();

    openFromBoard(`done9`); // the oldest finished chat, four rows behind the fold

    await settle();
    expect(cardsOnScreen(el)).toEqual([`done0`, `done1`, `done2`, `done3`, `done4`, `done5`, `done9`]);
    // Seven on screen out of ten: the row may only claim the three it actually hides.
    expect(tailRow(el)?.textContent?.trim()).toBe(`3 earlier`);
});

// The exit the lane never had. It was reachable only by right-clicking a card — a hunt for a target to perform
// an action whose target is the lane — which is what left "Close finished" being described as a manual chore.
it(`clears the whole lane from its header, whatever the window is showing`, async () => {
    seedFinished(10);
    const el = await mountList();
    openFinished(10);
    await settle();
    expect(clearButton(el)).toBeDefined();

    clearButton(el)?.click();

    await settle();
    // Every finished chat is closed, not just the six that were on screen, and the list is left with the fresh
    // chat closeTabs installs rather than nothing at all.
    expect(lanesOnScreen(el)).toEqual([`Active`]);
    expect(cardsOnScreen(el).filter((id) => id.startsWith(`done`))).toEqual([]);
});
