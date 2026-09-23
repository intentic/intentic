// Pins the floating composer's two contracts: it draws exactly where no composer is already on screen, and what the
// pill grows into is the chat's own composer rather than a second one. The hover rules are here because both
// directions were wrong at first — an opening that stole the caret could never close again.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { hoisted } from "@intentic/testing/bun";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { useChat } from "../run/useChat";
import { focusComposer } from "../tabs/useChat-tabs";
import { chatBarPeek } from "./chatPanelLayout";
import { draftConversation, reveal } from "./useChat-reveal";

import { queryClient } from "../../../lib/queryPersistence";
import { chatBarDock, chatFullDock } from "../../../shell/window/dockSlots";
import { useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "./ChatPanel.vue";
import ChatQuickBar from "./ChatQuickBar.vue";
import { IconStub } from "@intentic/ui/testing";
import * as useWorkflowRunsOriginal from "../../agents/fleet/useWorkflowRuns";

// jsdom has neither, and both the pane's pinned-prompt observer and its reveal reach for them.
hoisted(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

// An empty roster and an empty ledger: neither the fleet nor a workflow run is what these tests are about.
mock.module(`../../agents/fleet/useAgents`, () => {
    return { useAgents: () => ({ fleet: computed(() => []), agentById: () => undefined }) };
});
mock.module(`../../agents/fleet/useWorkflowRuns`, () => ({
    ...useWorkflowRunsOriginal,
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

const bar = (): HTMLElement | null => document.querySelector(`.chat-quick-float`);
// The resting pill is itself the control: the one that grows the composer or, while a card waits, opens the chat.
const press = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`.chat-quick-pill`)!;
const line = (): string => press().textContent?.trim() ?? ``;
const opened = (): boolean => bar()?.classList.contains(`chat-quick-open`) === true;

const hoverIn = (): void => void bar()?.dispatchEvent(new Event(`pointerenter`));
const hoverOut = (): void => void bar()?.dispatchEvent(new Event(`pointerleave`));
// The transcript's only affordance: the eye in the corner of the box it looks into.
const handle = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`.chat-quick-eye`);
const hoverHandle = (): void => void handle()?.dispatchEvent(new Event(`pointerenter`));
const escape = (): void => void bar()?.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true }));
// Past both delays the pill uses, so a test never has to restate either one.
const waitOutHover = async (): Promise<void> => {
    jest.advanceTimersByTime(1_000);
    await settle();
};

beforeEach(async () => {
    jest.useFakeTimers();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    localStorage.clear();
    chatFullDock.value = null;
    chatBarPeek.value = false;
    resetSandboxScope();
    // The home this whole surface exists for; `side` keeps its column, and then there is nothing to park.
    useLayout().setChatHome(`rail`);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    jest.useRealTimers();
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

// The faded form is held out of reach by `inert`, an attribute that flips in the render. A transitioned `visibility`
// did the same job to the eye and kept the composer unfocusable for the whole fade, so the caret arriving with a
// summons landed nowhere.
it(`hands reach to whichever form is showing, in the frame it opens`, async () => {
    await mount(ChatQuickBar);
    const pill = document.querySelector(`.chat-quick-pill`)!;
    const host = document.querySelector(`.chat-quick-host`)!;
    expect([pill.hasAttribute(`inert`), host.hasAttribute(`inert`)]).toEqual([false, true]);

    focusComposer();
    await settle();

    expect([pill.hasAttribute(`inert`), host.hasAttribute(`inert`)]).toEqual([true, false]);
});

// The box is the size of what is in it: the form that isn't showing leaves the flow, so no height is ever measured,
// declared or guessed. Measuring it is what left a box standing open at full width with nothing in it, having read
// the composer's height while the panel was still parked offscreen.
it(`sizes itself by whichever form is in flow, never by a measured height`, async () => {
    await mount(ChatQuickBar);
    // The pill's own wrapper is what leaves the flow, so the transform stays free for the pill to be animated by.
    const rest = document.querySelector(`.chat-quick-rest`)!;
    const host = document.querySelector(`.chat-quick-host`)!;
    expect([rest.classList.contains(`absolute`), host.classList.contains(`absolute`)]).toEqual([false, true]);
    expect(bar()!.style.height).toBe(``);

    press().click();
    await settle();

    expect([rest.classList.contains(`absolute`), host.classList.contains(`absolute`)]).toEqual([true, false]);
    expect(bar()!.style.height).toBe(``);
});

// Which of two utilities for the same property wins is the STYLESHEET's order, never the class attribute's. A static
// `relative` beside a conditional `absolute` kept the hidden composer in flow, stacked under the pill — so opening the
// box moved it out from under the pointer that opened it, which left, which closed it, which put the pill back under
// the pointer: an enter/leave oscillation every 670ms, measured.
it(`never carries two positions at once, since the class attribute's order settles nothing`, async () => {
    await mount(ChatQuickBar);
    const host = document.querySelector(`.chat-quick-host`)!;
    expect(host.classList.contains(`relative`)).toBe(false);

    press().click();
    await settle();

    expect(host.classList.contains(`absolute`)).toBe(false);
});

// The pill is the whole resting form: a second control on it was one more thing to mean, in the one place the reader
// came to write a sentence.
it(`rests as one control and nothing else, so its only press is the composer`, async () => {
    await mount(ChatQuickBar);

    expect(document.querySelectorAll(`.chat-quick-float button`)).toHaveLength(1);
});

// The card holding the turn is drawn in the transcript, and the pill grows into a composer with none: offering one
// here would read as the way to answer, and the answer is not a message.
it(`turns into a door while a card waits for an answer, rather than a box that cannot send one`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `pending` } }]);
    await mount(ChatQuickBar);

    expect(line()).toContain(`waiting for you`);
    expect(press().hasAttribute(`aria-expanded`)).toBe(false);

    hoverIn();
    await waitOutHover();

    expect(opened()).toBe(false);
});

it(`says what is running while it rests, since the pill is the only sign a parked turn leaves`, async () => {
    const chat = useChat();
    chat.active.value.title.value = `Add Stripe checkout`;
    await mount(ChatQuickBar);

    expect(line()).toBe(`Add Stripe checkout`);
});

it(`invites when there is nothing to report`, async () => {
    await mount(ChatQuickBar);

    expect(line()).toBe(`Ask anything…`);
});

// Escape means four things in the composer (stop the turn, abandon an edit, quit hands-free, dismiss a list), and
// closing the pill is last in that queue.
it(`closes on Escape, unless the composer claimed that press`, async () => {
    await mount(ChatQuickBar);
    press().click();
    await settle();

    const claimed = new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true });
    claimed.preventDefault();
    bar()?.dispatchEvent(claimed);
    await settle();
    expect(opened()).toBe(true);

    escape();
    await settle();
    expect(opened()).toBe(false);
});

// The box can say what is being written but not what was said, and the transcript is the one thing it has no room
// for — so the way to it is an affordance, not a navigation, offered only where there is something to read.
it(`offers the transcript only on the open box, and only once something has been said`, async () => {
    const chat = useChat();
    await mount(ChatQuickBar);
    press().click();
    await settle();
    expect(handle()).toBeNull();

    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await settle();
    expect(handle()).not.toBeNull();

    // Resting, the pill is the whole form: its own line already carries what the chat is up to.
    press().click();
    await settle();
    expect(handle()).toBeNull();
});

// Two things end with one pointer, and they must not end together: the transcript is what the pointer asked for, so it
// goes the moment the pointer does, while the box keeps the grace that lets an overshot edge be crossed back.
it(`folds the transcript away with the pointer, before the box itself goes`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await mount(ChatQuickBar);
    press().click();
    await settle();

    hoverHandle();
    jest.advanceTimersByTime(200);
    await settle();
    expect(chatBarPeek.value).toBe(true);

    // The turns stay mounted just long enough to fade with the card behind them — they are the panel's, so they cannot
    // fade after the flag that draws them has dropped — and the box is still standing when they are gone.
    hoverOut();
    jest.advanceTimersByTime(130);
    await settle();
    expect([chatBarPeek.value, opened()]).toEqual([false, true]);

    await waitOutHover();
    expect(opened()).toBe(false);
});

// A press keeps what a hover only borrows — the transcript's only door for a keyboard or a touch, neither of which can
// hover — and then one Escape undoes one thing, in the order they were opened.
it(`keeps the transcript on a press, and gives it back one Escape before the box`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await mount(ChatQuickBar);
    press().click();
    await settle();

    handle()!.click();
    await settle();
    expect(chatBarPeek.value).toBe(true);

    escape();
    jest.advanceTimersByTime(130);
    await settle();
    expect([chatBarPeek.value, opened()]).toEqual([false, true]);

    escape();
    await settle();
    expect(opened()).toBe(false);
});

// The other half of the contract: what the pill grows into is the panel, wearing one presentation.
it(`the panel's floating presentation is the composer alone: no list, no transcript, one chat`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    const beside = draftConversation();
    reveal({ verb: `beside`, entries: [beside], focus: beside.conversationId, caret: false });
    // Room for two columns docked, so a split is what the panel would draw if this presentation let it.
    useLayout().setChatWidth(1_200);
    await mount(ChatPanel, { bar: true });

    // The footer is the composer's own row, drawn whether or not a daemon is answering; the turns are what `bare` withholds.
    expect(document.querySelectorAll(`.chat-footer`)).toHaveLength(1);
    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(0);
    expect(document.querySelectorAll(`.chat-pane`)).toHaveLength(1);
});

// The composer draws its own edge, so a panel surface behind it is a second one around the same box — and the padding
// that surface needed is what made it read as a tray the message box was sitting in.
it(`the strip paints no surface of its own: the composer is the whole of it`, async () => {
    await mount(ChatPanel, { bar: true });

    expect(document.querySelector(`.chat-panel`)!.classList.contains(`bg-card`)).toBe(false);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(true);
});

// A peek is this pane's turns arriving, not a transcript built beside the one /chat draws. The card they need is the
// strip's own, so the panel only clips to it — and the composer keeps the one class that holds its rect still, which
// is what stops it jumping 13px up and 38px narrower as the transcript lands above it.
it(`a peek lifts the withheld turns without moving the composer they arrive over`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    chatBarPeek.value = true;
    await mount(ChatPanel, { bar: true });

    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(1);
    expect(document.body.textContent).toContain(`an earlier turn`);
    expect(document.querySelector(`.chat-panel`)!.classList.contains(`chat-peeking`)).toBe(true);
    expect(document.querySelector(`.chat-panel`)!.classList.contains(`bg-card`)).toBe(false);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(true);
});

it(`the same panel drawn anywhere else still has its transcript, on its own surface`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await mount(ChatPanel);

    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(1);
    expect(document.body.textContent).toContain(`an earlier turn`);
    expect(document.querySelector(`.chat-panel`)!.classList.contains(`bg-card`)).toBe(true);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(false);
});
