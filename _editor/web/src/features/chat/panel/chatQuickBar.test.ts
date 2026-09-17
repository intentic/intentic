// @vitest-environment jsdom
// Pins the bottom strip's two contracts: it draws exactly where no composer is already on screen, and what it grows
// into is the chat's own composer rather than a second one. The hover rules are here because both directions were
// wrong at first — an opening that stole the caret could never close again.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { resetChat, useChat } from "../run/useChat";
import { focusComposer } from "../tabs/useChat-tabs";
import { draftConversation, reveal } from "./useChat-reveal";

import { queryClient } from "../../../lib/queryPersistence";
import { chatBarDock, chatFullDock } from "../../../shell/window/dockSlots";
import { useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "./ChatPanel.vue";
import ChatQuickBar from "./ChatQuickBar.vue";
import { IconStub } from "@intentic/ui/testing";

// jsdom has neither, and both the pane's pinned-prompt observer and its reveal reach for them.
vi.hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// An empty roster and an empty ledger: neither the fleet nor a workflow run is what these tests are about.
vi.mock(`../../agents/fleet/useAgents`, async () => {
    const { computed } = await import(`vue`);
    return { useAgents: () => ({ fleet: computed(() => []), agentById: () => undefined }) };
});
vi.mock(`../../agents/fleet/useWorkflowRuns`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkflowRuns: () => ({ runs: ref([]), designs: ref([]), start: () => undefined, stop: () => undefined }),
}));

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

const mount = async (component: Parameters<typeof h>[0], props?: Record<string, unknown>): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(component, props) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
};

const bar = (): HTMLElement | null => document.querySelector(`.chat-quick-bar`);
// The strip's own control: the one that discloses or, while a card waits, opens the chat.
const press = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`.chat-quick-bar button`)!;
const line = (): string => press().textContent?.trim() ?? ``;
const opened = (): boolean => document.querySelector(`.chat-quick-host`)?.classList.contains(`chat-quick-open`) === true;

const hoverIn = (): void => void bar()?.dispatchEvent(new Event(`pointerenter`));
const hoverOut = (): void => void bar()?.dispatchEvent(new Event(`pointerleave`));
// Past both delays the strip uses, so a test never has to restate either one.
const waitOutHover = async (): Promise<void> => {
    vi.advanceTimersByTime(1_000);
    await settle();
};

beforeEach(async () => {
    vi.useFakeTimers();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    localStorage.clear();
    chatFullDock.value = null;
    resetChat();
    // The home this whole surface exists for; `side` keeps its column, and then there is nothing to park.
    useLayout().setChatHome(`rail`);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.useRealTimers();
});

it(`draws where no composer is already on screen, and nowhere else`, async () => {
    await mount(ChatQuickBar);
    expect(bar()).not.toBeNull();

    // The /chat area publishes its slot: the whole panel is on that screen, composer included.
    chatFullDock.value = document.createElement(`div`);
    await settle();
    expect(bar()).toBeNull();

    chatFullDock.value = null;
    useLayout().setChatHome(`side`);
    await settle();
    expect(bar()).toBeNull();
});

it(`publishes its slot only while it draws, so the panel parks when it doesn't`, async () => {
    await mount(ChatQuickBar);
    expect(chatBarDock.value).toBe(document.querySelector(`.chat-quick-host .contents`) ?? chatBarDock.value);
    expect(chatBarDock.value?.isConnected).toBe(true);

    useLayout().setChatHome(`side`);
    await settle();
    expect(chatBarDock.value).toBeNull();
});

it(`hovering takes the box and never the caret, so a passing pointer can't capture the keyboard`, async () => {
    const chat = useChat();
    await mount(ChatQuickBar);
    const caretRequests = chat.composerFocus.value;

    hoverIn();
    await waitOutHover();

    expect(opened()).toBe(true);
    expect(chat.composerFocus.value).toBe(caretRequests);
});

it(`closes again when the pointer leaves an empty box`, async () => {
    await mount(ChatQuickBar);
    hoverIn();
    await waitOutHover();

    hoverOut();
    await waitOutHover();

    expect(opened()).toBe(false);
});

it(`keeps words on screen: a box with a draft in it stays open when the pointer goes`, async () => {
    const chat = useChat();
    await mount(ChatQuickBar);
    hoverIn();
    await waitOutHover();
    chat.active.value.draft.value = `half a thought`;
    await settle();

    hoverOut();
    await waitOutHover();

    expect(opened()).toBe(true);
});

it(`a press takes the caret, since it is the one gesture that means to type`, async () => {
    const chat = useChat();
    await mount(ChatQuickBar);
    const caretRequests = chat.composerFocus.value;

    press().click();
    await settle();

    expect(opened()).toBe(true);
    expect(chat.composerFocus.value).toBe(caretRequests + 1);
});

it(`rises for a caret summoned anywhere: "New agent" pressed on a board is typed into here`, async () => {
    await mount(ChatQuickBar);
    expect(opened()).toBe(false);

    focusComposer();
    await settle();

    expect(opened()).toBe(true);
});

// The card holding the turn is drawn in the transcript, and a strip has none: offering a composer here would read as
// the way to answer, and the answer is not a message.
it(`turns into a door while a card waits for an answer, rather than a box that cannot send one`, async () => {
    const chat = useChat();
    chat.active.value.restoreMessages([
        { role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `pending` } },
    ]);
    await mount(ChatQuickBar);

    expect(line()).toContain(`waiting for you`);
    expect(press().hasAttribute(`aria-expanded`)).toBe(false);

    hoverIn();
    await waitOutHover();

    expect(opened()).toBe(false);
});

it(`says what is running while it rests, since the strip is the only sign a parked turn leaves`, async () => {
    const chat = useChat();
    chat.active.value.title.value = `Add Stripe checkout`;
    await mount(ChatQuickBar);

    expect(line()).toBe(`Add Stripe checkout`);
});

it(`invites when there is nothing to report`, async () => {
    await mount(ChatQuickBar);

    expect(line()).toBe(`Ask anything…`);
});

// Escape means four things in the composer (stop the turn, abandon an edit, quit hands-free, dismiss a list), and the
// strip is last in that queue.
it(`closes on Escape, unless the composer claimed that press`, async () => {
    await mount(ChatQuickBar);
    press().click();
    await settle();

    const claimed = new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true });
    claimed.preventDefault();
    bar()?.dispatchEvent(claimed);
    await settle();
    expect(opened()).toBe(true);

    bar()?.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true }));
    await settle();
    expect(opened()).toBe(false);
});

// The other half of the contract: what the strip hosts is the panel, wearing one presentation.
it(`the panel's strip presentation is the composer alone: no list, no transcript, one chat`, async () => {
    const chat = useChat();
    chat.active.value.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    const beside = draftConversation();
    reveal({ verb: `beside`, entries: [beside], focus: beside.conversationId, caret: false });
    // Room for two columns docked, so a split is what the panel would draw if the strip let it.
    useLayout().setChatWidth(1_200);
    await mount(ChatPanel, { bar: true });

    // The footer is the composer's own row, drawn whether or not a daemon is answering; the turns are what `bare` withholds.
    expect(document.querySelectorAll(`.chat-footer`)).toHaveLength(1);
    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(0);
    expect(document.querySelectorAll(`.chat-pane`)).toHaveLength(1);
});

it(`the same panel drawn anywhere else still has its transcript`, async () => {
    const chat = useChat();
    chat.active.value.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await mount(ChatPanel);

    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(1);
    expect(document.body.textContent).toContain(`an earlier turn`);
});
