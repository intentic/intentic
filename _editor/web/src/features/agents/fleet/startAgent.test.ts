// @vitest-environment jsdom
// "New agent" is offered on three surfaces and means one thing on all of them: a press anywhere opens a chat tab,
// focuses it, and asks for the composer caret. Each used to assemble its own half, which is exactly the drift a
// store-level test can't see, so this presses the real buttons and reads the real strip.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import ChatTabs from "../../chat/tabs/ChatTabs.vue";
import { useChat } from "../../chat/run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import AgentsView from "../board/AgentsView.vue";
import { IconStub } from "@intentic/ui/testing";

// Same import-time globals as other mounted-component tests; matches:false keeps the device desktop, where the docked
// chat is the whole point.
vi.hoisted(() => {
    // Focusing a tab makes the strip scroll it into view, which jsdom does not implement.
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

// A bare mount with the app-level registrations the real app makes; both surfaces carry the agents filter, whose daemon
// tier needs the query client.
const mount = (component: unknown): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    return el;
};

// The chat's open sessions are cards in the sheet its header drops; idempotent, since a press must not toggle the sheet
// shut halfway through.
const openSheet = async (el: HTMLElement): Promise<void> => {
    if (el.querySelector(`[data-chat-tab]`) === null) {
        el.querySelector<HTMLElement>(`[data-chat-switcher]`)!.click();
        await nextTick();
    }
};
const tabs = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[data-chat-tab]`)];
// The "New agent" control on a surface, excluding anything that merely SAYS it: after the first press an untitled draft
// is called "New agent" on its own card too, so both cards and switcher must be ruled out.
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
    // The tab a press moves focus off must hold something, or the one-untouched-draft invariant hands that same tab
    // back instead of adding a new one.
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

    // Both tabs are isolated conversations: a "New agent" that opened a main-tree chat would be the same press meaning
    // two different things.
    expect(conversations.value.slice(before).every((conversation) => conversation.isolated.value)).toBe(true);
});
