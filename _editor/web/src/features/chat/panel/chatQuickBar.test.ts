// Pins the floating scratch pad's contracts: it draws exactly where no composer is already on screen, what the pill
// opens into is the chat's own composer rather than a second one, and it is open exactly while the reader is in it.
// Reading the chat is /chat's job: nothing here draws a transcript, and every ask to see one goes there.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { useChat } from "../run/useChat";
import { focusComposer } from "../tabs/useChat-tabs";
import { quickBarShowAsk } from "./chatPanelLayout";
import { draftConversation, reveal } from "./useChat-reveal";

import { queryClient } from "../../../lib/queryPersistence";
import { chatBarSlot, chatFullSlot } from "../../../workbench/window/panelSlots";
import { useLayout } from "../../../workbench/window/useLayout";
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

// The bar floats over the section's own area; everything else is the rail and the overlays.
const mountBar = async (): Promise<void> => {
    const page = document.createElement(`main`);
    page.append(document.createElement(`button`));
    document.body.append(page);
    await mount(ChatQuickBar);
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
// The resting pill is itself the control: the one that opens the composer or, while a card waits, the chat.
const press = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`.chat-quick-pill`)!;
const line = (): string => press().textContent?.trim() ?? ``;
const opened = (): boolean => bar()?.classList.contains(`chat-quick-open`) === true;
const context = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`.chat-quick-context`)!;
const said = (): string => document.querySelector(`.chat-quick-said`)?.textContent?.replace(/\s+/gu, ` `).trim() ?? ``;
const open = async (): Promise<void> => {
    press().click();
    await settle();
};

const escape = (): KeyboardEvent => {
    const event = new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true });
    bar()?.dispatchEvent(event);
    return event;
};
const pressOn = (target: Element | null): void => void target?.dispatchEvent(new Event(`pointerdown`, { bubbles: true }));
const caretLandsOn = (target: Element | null): void => void target?.dispatchEvent(new FocusEvent(`focusin`, { bubbles: true }));

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    localStorage.clear();
    chatFullSlot.value = null;
    resetSandboxScope();
    // The home this whole surface exists for; `side` keeps its column, and then there is nothing to park.
    useLayout().setChatHome(`rail`);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
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

it(`opens on a press and takes the caret, since a press is the one gesture that means to type`, async () => {
    const chat = useChat();
    await mountBar();
    const caretRequests = chat.composerFocus.value;

    await open();

    expect(opened()).toBe(true);
    expect(chat.composerFocus.value).toBe(caretRequests + 1);
});

// A pointer crossing the bottom of the area on its way to a scrollbar or the terminal is not asking for anything.
it(`never opens for a pointer passing over it`, async () => {
    await mountBar();

    bar()?.dispatchEvent(new Event(`pointerenter`));
    press().dispatchEvent(new Event(`pointerenter`));
    await settle();

    expect(opened()).toBe(false);
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

    await open();

    expect(bar()!.style.height).toBe(``);
});

// The pill is the whole resting form, and the open pad is the composer under one header: who it writes to and where
// that conversation stands. A minimize, a transcript toggle and a full-chat button were three more things to mean over
// a page the reader came to write about; the header is the one way to the conversation, and it says so.
it(`is one control at rest, and grows one header of its own when open`, async () => {
    useChat().active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    // What a hand can reach: the form not showing is inert, and the composer's own controls are the chat's.
    const reachable = (): Element[] =>
        [...document.querySelectorAll(`.chat-quick-float button`)].filter(
            (button) => !button.closest(`[inert]`) && (!button.closest(`.chat-quick-host`) || button.classList.contains(`chat-quick-context`)),
        );
    await mountBar();
    expect(reachable()).toEqual([press()]);

    await open();

    expect(reachable()).toEqual([context()]);
});

// Open, the pill that named the chat is gone; without the header the box would be addressed to nobody.
it(`says, open, which chat it writes to and the last thing said there`, async () => {
    const chat = useChat();
    chat.active.value.title.value = `Add Stripe checkout`;
    chat.active.value.transcript.restoreMessages([
        { role: `user`, text: `wire up **checkout**` },
        { role: `assistant`, text: `## Done\n\nThe \`/pay\` route now [redirects](https://stripe.com) to Stripe.` },
    ]);
    await mountBar();
    await open();

    expect(context().textContent).toContain(`Add Stripe checkout`);
    expect(said()).toBe(`Done The /pay route now redirects to Stripe.`);
});

it(`marks the last words as the reader's own when the agent has not answered yet`, async () => {
    useChat().active.value.transcript.restoreMessages([{ role: `user`, text: `wire up checkout` }]);
    await mountBar();
    await open();

    expect(said()).toBe(`You: wire up checkout`);
});

it(`takes the reader to the conversation from the header, closing the pad`, async () => {
    const push = jest.spyOn(router, `push`).mockResolvedValue(undefined);
    await mountBar();
    await open();

    context().click();
    await settle();

    expect([opened(), push.mock.calls]).toEqual([false, [[`/chat`]]]);
    push.mockRestore();
});

// The card holding the turn is drawn in the transcript, and the pill opens a composer with none: offering one here
// would read as the way to answer, and the answer is not a message.
it(`turns into a door while a card waits for an answer, rather than a box that cannot send one`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([
        { role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `pending` } },
    ]);
    const push = jest.spyOn(router, `push`).mockResolvedValue(undefined);
    await mountBar();

    expect(line()).toContain(`waiting for you`);
    expect(press().hasAttribute(`aria-expanded`)).toBe(false);

    focusComposer();
    await settle();
    expect(opened()).toBe(false);

    await open();
    expect([opened(), push.mock.calls]).toEqual([false, [[`/chat`]]]);
    push.mockRestore();
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
// closing the pad is last in that queue. Closed from the keyboard, the caret goes back to the pill.
it(`closes on Escape unless the composer claimed that press, and hands the caret to the pill`, async () => {
    await mountBar();
    await open();

    const claimed = new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true });
    claimed.preventDefault();
    bar()?.dispatchEvent(claimed);
    await settle();
    expect(opened()).toBe(true);

    escape();
    await settle();
    expect([opened(), document.activeElement]).toEqual([false, press()]);
});

it(`closes when the reader presses anywhere else, the page and the rail alike`, async () => {
    await mountBar();
    await open();
    pressOn(onThePage());
    await settle();
    expect(opened()).toBe(false);

    await open();
    pressOn(railLink());
    await settle();
    expect(opened()).toBe(false);
});

it(`closes when the caret lands anywhere else`, async () => {
    await mountBar();
    await open();

    caretLandsOn(onThePage());
    await settle();

    expect(opened()).toBe(false);
});

it(`stays open for presses and the caret inside it`, async () => {
    await mountBar();
    await open();
    const inside = document.querySelector(`.chat-quick-host`)!;

    pressOn(inside);
    caretLandsOn(inside);
    await settle();

    expect(opened()).toBe(true);
});

// The draft is the conversation's, so closing loses nothing: the pill carries the words until they are sent.
it(`keeps a draft through closing, and wears it on the pill`, async () => {
    const chat = useChat();
    await mountBar();
    await open();
    chat.active.value.draft.value = `half a thought`;
    await settle();

    pressOn(onThePage());
    await settle();

    expect([opened(), line()]).toEqual([false, `half a thought`]);
    expect(chat.active.value.draft.value).toBe(`half a thought`);
});

// The model list, the mode menu and their kind hang off the composer but are teleported to the body.
it(`counts the menus the composer opens as part of the box`, async () => {
    await mountBar();
    await open();
    const menu = document.createElement(`div`);
    menu.className = `ui-anchored`;
    const row = document.createElement(`button`);
    menu.append(row);
    document.body.append(menu);

    pressOn(row);
    caretLandsOn(row);
    await settle();

    expect(opened()).toBe(true);
});

// A board card's click asks for the chat's turns, and the pad has none to show: before, the pill only changed its
// title and readers clicked again. Every ask goes, since the same ask twice must act twice.
it(`opens /chat when a board card asks to see the chat`, async () => {
    const push = jest.spyOn(router, `push`).mockResolvedValue(undefined);
    await mountBar();
    await open();

    quickBarShowAsk.value += 1;
    await settle();
    quickBarShowAsk.value += 1;
    await settle();

    expect([opened(), push.mock.calls]).toEqual([false, [[`/chat`], [`/chat`]]]);
    push.mockRestore();
});

// The other half of the contract: what the pill opens into is the panel, wearing one presentation.
it(`the panel's floating presentation is the composer alone: no list, no transcript, one chat`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    const beside = draftConversation();
    reveal({ verb: `beside`, entries: [beside], focus: beside.conversationId, caret: false });
    // Room for two columns docked, so a split is what the panel would draw if this presentation let it.
    useLayout().setChatWidth(1_200);
    await mount(ChatPanel, { bar: true });

    // The footer is the composer's own row, drawn whether or not a daemon is answering; the turns are what the strip withholds.
    expect(document.querySelectorAll(`.chat-footer`)).toHaveLength(1);
    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(0);
    expect(document.body.textContent).not.toContain(`an earlier turn`);
    expect(document.querySelectorAll(`.chat-pane`)).toHaveLength(1);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(true);
    expect(document.querySelector(`.chat-scroller`)!.classList.contains(`mb-3`)).toBe(false);
});

// A scratch pad sends a note: the knobs that only tune a send (the overflow, hands-free voice) are the full chat's.
it(`the pad's row drops the knobs that only tune a send`, async () => {
    await mount(ChatPanel, { bar: true });

    expect(document.querySelector(`[aria-label="More composer settings"]`)).toBeNull();
    expect(document.querySelector(`[aria-label="Talk hands-free"]`)).toBeNull();
});

it(`the same panel drawn anywhere else still has its transcript, and a composer that is not the strip's`, async () => {
    const chat = useChat();
    chat.active.value.transcript.restoreMessages([{ role: `user`, text: `an earlier turn` }]);
    await mount(ChatPanel);

    expect(document.querySelectorAll(`.chat-turns`)).toHaveLength(1);
    expect(document.body.textContent).toContain(`an earlier turn`);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`chat-footer-strip`)).toBe(false);
    // Clearance below the composer is outside the transcript's scrollport, not an opaque mask inside it.
    expect(document.querySelector(`.chat-scroller`)!.classList.contains(`mb-3`)).toBe(true);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`pt-3`)).toBe(true);
    expect(document.querySelector(`.chat-footer`)!.classList.contains(`py-3`)).toBe(false);
    expect(document.querySelector(`[aria-label="More composer settings"]`)).not.toBeNull();
});
