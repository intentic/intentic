// @vitest-environment jsdom
//
// THE FIRST SCREEN, MOUNTED. On a fresh workspace the desktop lands here (router/index.ts) straight out of
// setup, so what the empty board renders is the whole of somebody's first impression — and the three things
// that make it work are easy to break silently: that it offers the way in rather than a composer it cannot
// send from, that the docked chat then drops its copy of that offer, and that once something CAN send a
// starter fills the chat's composer rather than dispatching an agent. All three are asserted against the real
// component.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { offerOnBoard } from "../composables/chat/connectOffer";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../composables/chat/providerAccounts";
import { useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// The same import-time globals the other mounted-component tests stand up (see startAgent.test.ts).
// matches:false keeps the device DESKTOP, which is the form factor this landing is about.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
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
});

// Unmounted after each test: the board registers its Mod+Z / filter commands in a MODULE-level registry and
// disposes them on unmount, so a second mount in the same file throws "already registered" without this.
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
});

// The connection picture is the axis this screen turns on, so every test states it outright rather than
// inheriting whatever the previous one left. Read: the daemon has answered, and the answer is "nothing".
beforeEach(() => {
    accountsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [], grok: [] };
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
});

const mount = (component: unknown): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    mounted.push(app);
    return el;
};

const starterNamed = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label);

it(`offers the way in rather than a box it cannot send from, and the docked chat stands down`, async () => {
    const board = mount(AgentsView);
    await nextTick();

    // The free channel, in the middle of the board — the same card the chat's gate shows (ConnectOffer).
    expect(board.textContent).toContain(`Try free with Google`);
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Continue with Google`))).toBe(true);
    // And the subscriptions under it, for a user who already pays for one.
    expect(starterNamed(board, `Claude`)).toBeDefined();

    // THE COMPOSER IS GONE. There is one composer in this product and it is the chat's; a second one here could
    // not even send, because a fresh sandbox has nothing connected yet.
    expect(board.querySelector(`textarea`)).toBeNull();
    expect([...board.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Start agent`))).toBe(false);

    // The claim the docked gate reads, so the same offer is never argued twice on one screen.
    expect(offerOnBoard.value).toBe(true);
});

it(`waits for the daemon before claiming nothing is connected`, async () => {
    accountsLoaded.value = false;
    const board = mount(AgentsView);
    await nextTick();

    // "You have nothing connected" is a claim, and until the read lands it is one this screen may not make —
    // but the wait belongs to it too, or the chat would spin beside it saying the same thing.
    expect(board.textContent).toContain(`Checking your AI accounts…`);
    expect(board.textContent).not.toContain(`Try free with Google`);
    expect(offerOnBoard.value).toBe(true);
});

it(`suggests getting code in once something can send, and a starter fills the chat rather than sending`, async () => {
    // A connected Claude subscription: the offer is answered, so the screen goes back to asking for the task.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1` }] as never };
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).not.toContain(`Try free with Google`);
    expect(offerOnBoard.value).toBe(false);
    // No repos and no changes in this mount, so the suggestions are the get-your-code-in pair.
    const starter = starterNamed(board, `Bring in my code`);
    expect(starter).toBeDefined();
    expect(starterNamed(board, `Start a new project`)).toBeDefined();

    const before = useChat().conversations.value.length;
    starter!.click();
    await nextTick();

    // FILLED, NOT SENT: the prompt is in the chat's own composer, no agent was started, and no second tab was
    // opened to hold it.
    expect(useChat().active.value.draft.value).toContain(`Clone my repository into this workspace`);
    expect(useChat().active.value.messages.value).toHaveLength(0);
    expect(useChat().conversations.value).toHaveLength(Math.max(before, 1));
    // Still the first-run screen — filling the composer is not starting anything.
    expect(board.textContent).toContain(`Start your first agent`);
});
