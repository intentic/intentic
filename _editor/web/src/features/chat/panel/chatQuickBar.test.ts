// Pins the floating composer's two contracts: it draws exactly where no composer is already on screen, and what the
// pill grows into is the chat's own composer rather than a second one. The hover rules are here because both
// directions were wrong at first — an opening that stole the caret could never close again.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { useChat } from "../run/useChat";
import { focusComposer } from "../tabs/useChat-tabs";
import { quickBarTranscript } from "./chatPanelLayout";
import { draftConversation, reveal } from "./useChat-reveal";

import { queryClient } from "../../../lib/queryPersistence";
import { chatBarSlot, chatFullSlot } from "../../../shell/window/panelSlots";
import { useLayout } from "../../../shell/window/useLayout";
import { router } from "../../../router";
import ChatPanel from "./ChatPanel.vue";
import ChatQuickBar from "./ChatQuickBar.vue";
import { IconStub } from "@intentic/ui/testing";
import * as useWorkflowRunsOriginal from "../../agents/fleet/useWorkflowRuns";

// jsdom has neither, and both the pane's pinned-prompt observer and its reveal reach for them.
(() => {
    globalThis.IntersectionObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.IntersectionObserver;
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    // jsdom's frame clock is an interval it starts once, on whichever timers are installed then, so it dies with the
    // first test's fake timers; the card's leave transition waits two frames, which ride the current clock instead.
    globalThis.requestAnimationFrame = (run: FrameRequestCallback): number => Number(setTimeout(() => run(performance.now()), 16));
})();

// An empty roster and an empty ledger: neither the fleet nor a workflow run is what these tests are about.
jest.mock(`../../agents/fleet/useAgents`, () => {
    return { useAgents: () => ({ fleet: computed(() => []), agentById: () => undefined }) };
});
jest.mock(`../../agents/fleet/useWorkflowRuns`, () => ({
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

// The bar floats over the section's own area, which the shell hands it; everything else is the rail and the overlays.
const mountBar = async (): Promise<void> => {
    const page = document.createElement(`main`);
    page.append(document.createElement(`button`));
    document.body.append(page);
    await mount(ChatQuickBar, { page });
};
const onThePage = (): Element | null => document.querySelector(`main button`);
const railLink = (): HTMLAnchorElement => {
    const rail = document.createElement(`nav`);
    const link = document.createElement(`a`);
    rail.append(link);
    document.body.append(rail);
    return link;
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
const pressOn = (target: Element | null): void => void target?.dispatchEvent(new Event(`pointerdown`, { bubbles: true }));
const caretLeavesFor = (next: Element | null): void =>
    void bar()?.dispatchEvent(new FocusEvent(`focusout`, { bubbles: true, relatedTarget: next }));
// A press on the transcript's own glass: where a selection starts.
const card = (): HTMLElement | null => document.querySelector(`.chat-quick-card`);
const openTranscriptByHover = async (): Promise<void> => {
    hoverHandle();
    jest.advanceTimersByTime(200);
    await settle();
};
const said = (): void => useChat().active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
// The transcript's card fading out, which the panel's turns wait for before they unmount: the render that starts it,
// then the frames the transition runs on.
const fadeOut = async (): Promise<void> => {
    await settle();
    jest.advanceTimersByTime(200);
    await settle();
};
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
    chatFullSlot.value = null;
    quickBarTranscript.value = false;
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
    await mountBar();
    expect(bar()).not.toBeNull();

    // The /chat area publishes its slot: the whole panel is on that screen, composer included.
    chatFullSlot.value = document.createElement(`div`);
    await settle();
    expect(bar()).toBeNull();

    chatFullSlot.value = null;
    useLayout().setChatHome(`side`);
    await settle();
    expect(bar()).toBeNull();
});

it(`publishes its slot only while it draws, so the panel parks when it doesn't`, async () => {
    await mountBar();
    expect(chatBarSlot.value?.isConnected).toBe(true);

    useLayout().setChatHome(`side`);
    await settle();
    expect(chatBarSlot.value).toBeNull();
});

it(`hovering takes the box and never the caret, so a passing pointer can't capture the keyboard`, async () => {
    const chat = useChat();
    await mountBar();
    const caretRequests = chat.composerFocus.value;

    hoverIn();
    await waitOutHover();

    expect(opened()).toBe(true);
    expect(chat.composerFocus.value).toBe(caretRequests);
});

it(`closes again when the pointer leaves an empty box`, async () => {
    await mountBar();
    hoverIn();
    await waitOutHover();

    hoverOut();
    await waitOutHover();

    expect(opened()).toBe(false);
});

it(`keeps words on screen: a box with a draft in it stays open when the pointer goes`, async () => {
    const chat = useChat();
    await mountBar();
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
    await mountBar();
    const caretRequests = chat.composerFocus.value;

    press().click();
    await settle();

    expect(opened()).toBe(true);
    expect(chat.composerFocus.value).toBe(caretRequests + 1);
});

it(`rises for a caret summoned anywhere: "New agent" pressed on a board is typed into here`, async () => {
    await mountBar();
    expect(opened()).toBe(false);

    focusComposer();
    await settle();

    expect(opened()).toBe(true);
});

// The faded form is held out of reach by `inert`, an attribute that flips in the render. A transitioned `visibility`
// did the same job to the eye and kept the composer unfocusable for the whole fade, so the caret arriving with a
// summons landed nowhere.
it(`hands reach to whichever form is showing, in the frame it opens`, async () => {
    await mountBar();
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
    await mountBar();
    expect(bar()!.style.height).toBe(``);

    press().click();
    await settle();

    expect(bar()!.style.height).toBe(``);
});

// The pill is the whole resting form: a second control on it was one more thing to mean, in the one place the reader
// came to write a sentence.
it(`rests as one control and nothing else, so its only press is the composer`, async () => {
    await mountBar();

    expect(document.querySelectorAll(`.chat-quick-float button`)).toHaveLength(1);
});

// The card holding the turn is drawn in the transcript, and the pill grows into a composer with none: offering one
// here would read as the way to answer, and the answer is not a message.
it(`turns into a door while a card waits for an answer, rather than a box that cannot send one`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([
        { role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `pending` } },
    ]);
    await mountBar();

    expect(line()).toContain(`waiting for you`);
    expect(press().hasAttribute(`aria-expanded`)).toBe(false);

    hoverIn();
    await waitOutHover();

    expect(opened()).toBe(false);
});

it(`says what is running while it rests, since the pill is the only sign a parked turn leaves`, async () => {
    const chat = useChat();
    chat.active.value.title.value = `Add Stripe checkout`;
    await mountBar();

    expect(line()).toBe(`Add Stripe checkout`);
});

it(`invites when there is nothing to report`, async () => {
    await mountBar();

    expect(line()).toBe(`Ask anything…`);
});

// Escape means four things in the composer (stop the turn, abandon an edit, quit hands-free, dismiss a list), and
// closing the pill is last in that queue.
it(`closes on Escape, unless the composer claimed that press`, async () => {
    await mountBar();
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
    await mountBar();
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

// A borrowed transcript and a borrowed box both end with the pointer, the transcript first: its grace and its fade
// together are over before the box's grace is.
it(`folds a borrowed transcript away with the pointer, before the box itself goes`, async () => {
    said();
    await mountBar();
    hoverIn();
    await waitOutHover();

    await openTranscriptByHover();
    expect(quickBarTranscript.value).toBe(true);

    hoverOut();
    jest.advanceTimersByTime(350);
    await settle();
    expect([quickBarTranscript.value, opened()]).toEqual([false, true]);

    await waitOutHover();
    expect(opened()).toBe(false);
});

it(`gives an overshot edge its transcript back when the pointer returns in time`, async () => {
    said();
    await mountBar();
    hoverIn();
    await waitOutHover();
    await openTranscriptByHover();

    hoverOut();
    jest.advanceTimersByTime(100);
    hoverIn();
    await waitOutHover();

    expect([quickBarTranscript.value, opened()]).toEqual([true, true]);
});

// Selecting a line to copy starts with a press on the transcript and often ends past its edge: neither may fold it.
it(`keeps the box and its transcript once pressed, so a selection survives the pointer leaving`, async () => {
    said();
    await mountBar();
    hoverIn();
    await waitOutHover();
    await openTranscriptByHover();

    pressOn(card());
    hoverOut();
    await waitOutHover();

    expect([quickBarTranscript.value, opened()]).toEqual([true, true]);
});

// The caret goes to nothing on a press on text, and to the page when a view it opens takes it: neither is a gesture.
it(`never folds for the caret moving, wherever it goes`, async () => {
    await mountBar();
    hoverIn();
    await waitOutHover();

    caretLeavesFor(null);
    caretLeavesFor(onThePage());
    await settle();

    expect(opened()).toBe(true);
});

it(`folds the transcript and an empty box on a press on the page`, async () => {
    said();
    await mountBar();
    press().click();
    await settle();
    handle()!.click();
    await settle();

    pressOn(onThePage());
    await settle();

    expect([quickBarTranscript.value, opened()]).toEqual([false, false]);
});

// The bar follows the reader from view to view: switching on the rail is not going back to the page under it.
it(`keeps the box and its transcript through a view switch on the rail`, async () => {
    said();
    await mountBar();
    press().click();
    await settle();
    handle()!.click();
    await settle();

    const link = railLink();
    pressOn(link);
    caretLeavesFor(link);
    await settle();

    expect([quickBarTranscript.value, opened()]).toEqual([true, true]);
});

// Words hold the composer open against the page, so copying from it into them is one press away, and the box's own
// minimize is what folds them; the pill carries them from there.
it(`keeps a box holding words through a press on the page, and folds it only on its own minimize`, async () => {
    const chat = useChat();
    await mountBar();
    press().click();
    await settle();
    chat.active.value.draft.value = `half a thought`;
    await settle();

    pressOn(onThePage());
    await settle();
    expect(opened()).toBe(true);

    document.querySelector<HTMLButtonElement>(`.chat-quick-fold`)!.click();
    await settle();
    expect([opened(), line()]).toEqual([false, `half a thought`]);
});

// The model list, the mode menu and their kind hang off the composer but are teleported to the body.
it(`counts the menus the composer opens as part of the box`, async () => {
    await mountBar();
    press().click();
    await settle();
    const menu = document.createElement(`div`);
    menu.className = `ui-anchored`;
    const row = document.createElement(`button`);
    menu.append(row);
    document.body.append(menu);

    pressOn(row);
    caretLeavesFor(row);
    await settle();

    expect(opened()).toBe(true);
});

// A press keeps what a hover only borrows — the transcript's only door for a keyboard or a touch, neither of which can
// hover — and then one Escape undoes one thing, in the order they were opened.
it(`keeps the transcript on a press, and gives it back one Escape before the box`, async () => {
    said();
    await mountBar();
    press().click();
    await settle();

    handle()!.click();
    await settle();
    expect(quickBarTranscript.value).toBe(true);

    escape();
    await fadeOut();
    expect([quickBarTranscript.value, opened()]).toEqual([false, true]);

    escape();
    await settle();
    expect(opened()).toBe(false);
});

// The eye stays on the transcript it opened: pressing a borrowed one keeps it, pressing a kept one folds it.
it(`keeps a borrowed transcript on the eye's press, and folds it on the next`, async () => {
    said();
    await mountBar();
    hoverIn();
    await waitOutHover();
    await openTranscriptByHover();

    handle()!.click();
    hoverOut();
    await waitOutHover();
    expect([quickBarTranscript.value, handle()!.getAttribute(`aria-expanded`)]).toEqual([true, `true`]);

    handle()!.click();
    await fadeOut();
    expect([quickBarTranscript.value, handle()!.getAttribute(`aria-expanded`)]).toEqual([false, `false`]);
});

// A press on transcript text leaves the caret on the body, and a view switch leaves it on the rail: the reader's
// Escape lands there, and the page keeps its own.
it(`hears an Escape that lands off the page while the box is the last thing pressed`, async () => {
    said();
    await mountBar();
    press().click();
    await settle();
    handle()!.click();
    await settle();
    const escapeOn = (target: Element | null): void =>
        void target?.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true }));

    escapeOn(onThePage());
    await settle();
    expect([quickBarTranscript.value, opened()]).toEqual([true, true]);

    escapeOn(railLink());
    await fadeOut();
    expect([quickBarTranscript.value, opened()]).toEqual([false, true]);

    escapeOn(document.body);
    await settle();
    expect(opened()).toBe(false);
});

it(`opens the full chat from the transcript's corner, folding the box behind it`, async () => {
    said();
    const push = jest.spyOn(router, `push`).mockResolvedValue(undefined);
    await mountBar();
    press().click();
    await settle();

    document.querySelector<HTMLButtonElement>(`.chat-quick-full`)!.click();
    await settle();

    expect(push.mock.calls).toEqual([[`/chat`]]);
    expect(opened()).toBe(false);
    push.mockRestore();
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

// A transcript is this pane's turns arriving, not a transcript built beside the one /chat draws. The card they need is the
// strip's own, so the panel only clips to it — and the composer keeps the one class that holds its rect still, which
// is what stops it jumping 13px up and 38px narrower as the transcript lands above it.
it(`a transcript lifts the withheld turns without moving the composer they arrive over`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    quickBarTranscript.value = true;
    await mount(ChatPanel, { bar: true });

    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(1);
    expect(document.body.textContent).toContain(`an earlier turn`);
    expect(document.querySelector(`.chat-panel`)!.classList.contains(`chat-transcript-lifted`)).toBe(true);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(true);
});

it(`the same panel drawn anywhere else still has its transcript, and a composer that is not the strip's`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await mount(ChatPanel);

    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(1);
    expect(document.body.textContent).toContain(`an earlier turn`);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(false);
});
