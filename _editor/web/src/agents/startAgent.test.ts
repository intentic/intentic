// @vitest-environment jsdom
//
// "New agent" is offered on three surfaces (the fleet board's header, the chat strip's "+", the mobile
// header's "+") and means one thing on all of them, so the guarantee under test is a cross-surface one: a
// press ANYWHERE opens a chat tab, focuses it, and asks for the composer caret. Each surface used to assemble
// its own half of that (the board skipped the caret, the strip skipped the mobile route), which is exactly the
// drift a store-level unit test cannot see, so this one presses the real buttons and reads the real strip.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import ChatTabs from "../chat/ChatTabs.vue";
import { useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// Same import-time globals the other mounted-component tests stand up (see ChatToolCard.test.ts): ui's
// useDevice reads window.matchMedia at module scope, environment.ts reads window.env. matches:false keeps the
// device DESKTOP: the form factor where the docked chat is the whole point of the action. jsdom ships no
// ResizeObserver at all, and the board measures itself with one to choose its layout: a stub that never
// reports leaves it on its unmeasured default (three columns), which is the desktop case anyway.
vi.hoisted(() => {
    // Focusing a tab makes the strip scroll it into view, which jsdom does not implement.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

// A bare mount with the app-level registrations the real app makes (the global Icon component and PrimeVue's
// v-tooltip), the router, and vue-query: both surfaces carry the agents filter, whose daemon tier is a
// useQuery and so needs the client the real app provides in main.ts.
const mount = (component: unknown): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    return el;
};

// The chat's open sessions are cards in the sheet its header drops, so the strip is asked to show them first.
// Idempotent, because a press must not toggle the sheet shut halfway through the run.
const openSheet = async (el: HTMLElement): Promise<void> => {
    if (el.querySelector(`[data-chat-tab]`) === null) {
        el.querySelector<HTMLElement>(`[data-chat-switcher]`)!.click();
        await nextTick();
    }
};
const tabs = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[data-chat-tab]`)];
// The "New agent" control on a surface: the board's labelled-by-its-text header button, the strip's
// aria-labelled "+". Everything that merely SAYS "New agent" is excluded by construction, and after the first
// press that is most of the strip: an untitled draft is called "New agent" on its card AND in the header line
// naming it, so both the cards and the switcher have to be ruled out or the press lands on one of them.
const newAgentButton = (el: HTMLElement): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find(
        (button) =>
            button.dataset[`chatTab`] === undefined &&
            button.dataset[`chatSwitcher`] === undefined &&
            (button.getAttribute(`aria-label`) === `New agent` || button.textContent?.trim() === `New agent`),
    )!;

it(`opens, focuses and hands the composer a tab from the fleet board and from the chat strip alike`, async () => {
    const strip = mount(ChatTabs);
    const board = mount(AgentsView);
    await nextTick();
    await openSheet(strip);

    const { conversations, activeId, composerFocus, draft } = useChat();
    // The tab a press moves focus OFF has to hold something, or the one-untouched-draft invariant (an empty New
    // agent tab exists only while it holds the focus) makes the press hand that same tab back instead of adding.
    draft.value = `work in progress`;
    const before = tabs(strip).length;
    const focusRequests = composerFocus.value;

    // The board's header button: the surface that used to open a conversation the chat never showed.
    newAgentButton(board).click();
    await nextTick();
    expect(tabs(strip)).toHaveLength(before + 1);
    expect(activeId.value).toBe(conversations.value[before]!.conversationId);
    expect(tabs(strip)[before]!.className).toContain(`session-card-on`);
    expect(composerFocus.value).toBe(focusRequests + 1);

    // The strip's "+": the same action, so the same three effects.
    draft.value = `typed into the first new agent`;
    newAgentButton(strip).click();
    await nextTick();
    expect(tabs(strip)).toHaveLength(before + 2);
    expect(activeId.value).toBe(conversations.value[before + 1]!.conversationId);
    expect(composerFocus.value).toBe(focusRequests + 2);

    // Both tabs are ISOLATED conversations: a "New agent" that opened a main-tree chat would be the same
    // press meaning two different things.
    expect(conversations.value.slice(before).every((conversation) => conversation.isolated.value)).toBe(true);
});
