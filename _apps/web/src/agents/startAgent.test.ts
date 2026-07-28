// @vitest-environment jsdom
//
// "New agent" is offered on three surfaces (the fleet board's header, the chat strip's "+", the mobile
// header's "+") and means one thing on all of them, so the guarantee under test is a cross-surface one: a
// press ANYWHERE opens a chat tab, focuses it, and asks for the composer caret. Each surface used to assemble
// its own half of that (the board skipped the caret, the strip skipped the mobile route), which is exactly the
// drift a store-level unit test cannot see — so this one presses the real buttons and reads the real strip.
import { beforeAll, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";

// Same import-time globals the other mounted-component tests stand up (see ChatToolCard.test.ts): ui's
// useDevice reads window.matchMedia at module scope, environment.ts reads window.env. matches:false keeps the
// device DESKTOP — the form factor where the docked chat is the whole point of the action. jsdom ships no
// ResizeObserver at all, and the board measures itself with one to choose its layout — a stub that never
// reports leaves it on its unmeasured default (three columns), which is the desktop case anyway.
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
    };
});

let ChatTabs: unknown;
let AgentsView: unknown;
let useChat: typeof import("../composables/chat/useChat").useChat;
let router: typeof import("../router").router;

beforeAll(async () => {
    ChatTabs = (await import(`../chat/ChatTabs.vue`)).default;
    AgentsView = (await import(`./AgentsView.vue`)).default;
    useChat = (await import(`../composables/chat/useChat`)).useChat;
    router = (await import(`../router`)).router;
});

// A bare mount with the two app-level registrations the real app makes (the global Icon component and
// PrimeVue's v-tooltip) plus the router, which both surfaces inject.
const mount = (component: unknown): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.mount(el);
    return el;
};

const tabs = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[data-chat-tab]`)];
// The "New agent" control on a surface — the board's labelled-by-its-text header button, the strip's
// aria-labelled "+". Tabs are excluded by construction: an untitled draft tab reads "New agent" too.
const newAgentButton = (el: HTMLElement): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find(
        (button) =>
            button.dataset[`chatTab`] === undefined &&
            (button.getAttribute(`aria-label`) === `New agent` || button.textContent?.trim() === `New agent`),
    )!;

it(`opens, focuses and hands the composer a tab from the fleet board and from the chat strip alike`, async () => {
    const strip = mount(ChatTabs);
    const board = mount(AgentsView);
    await nextTick();

    const { conversations, activeId, composerFocus } = useChat();
    const before = tabs(strip).length;
    const focusRequests = composerFocus.value;

    // The board's header button — the surface that used to open a conversation the chat never showed.
    newAgentButton(board).click();
    await nextTick();
    expect(tabs(strip)).toHaveLength(before + 1);
    expect(activeId.value).toBe(conversations.value[before]!.conversationId);
    expect(tabs(strip)[before]!.className).toContain(`chat-tab-on`);
    expect(composerFocus.value).toBe(focusRequests + 1);

    // The strip's "+" — the same action, so the same three effects.
    newAgentButton(strip).click();
    await nextTick();
    expect(tabs(strip)).toHaveLength(before + 2);
    expect(activeId.value).toBe(conversations.value[before + 1]!.conversationId);
    expect(composerFocus.value).toBe(focusRequests + 2);

    // Both tabs are ISOLATED conversations: a "New agent" that opened a main-tree chat would be the same
    // press meaning two different things.
    expect(conversations.value.slice(before).every((conversation) => conversation.isolated.value)).toBe(true);
});
