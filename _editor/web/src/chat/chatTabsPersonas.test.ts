// @vitest-environment jsdom
//
// THE PERSONA RAIL — the chat list's other column, where a row is a PERSON this sandbox can be rather than a
// session it is running. Mounted through ChatTabList, because the switch between the two lists is half of what
// is being asserted; the rows themselves are ChatPersonaRail's.
//
// WHY THIS FILE REPLACED ONE THAT TESTED GROUPING. The first build of this feature grouped the open chats under
// persona headings, and every one of its tests passed while the feature was useless in the app: a chat's
// persona is a composer pick that nobody makes, so a real workspace put all 56 of its chats under one "Anyone"
// heading and the switch changed a word. The tests were green because they set `actsAs` by hand — they proved
// the grouping worked and could not have caught that there was nothing to group. So the assertions here are
// about what the rail shows WITHOUT anyone having pinned anything: the cards, straight from the workspace.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../composables/agents/useAgents";
import { useChatGrouping } from "../composables/chat/chatGrouping";
import { resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { PERSONAS } from "../composables/queryKeys";
import { router } from "../router";
import ChatTabList from "./ChatTabList.vue";

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
        afterSignOut: ``,
    };
});

let app: App | undefined;
let selected: string[] = [];

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatTabList, { onSelect: (id: string) => selected.push(id) }) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

// The cards a workspace has made, seeded into the cache the rail reads them from. `connected` is what decides
// whether a card can actually post — the rail marks the ones that cannot.
const withPersonas = (personas: { id: string; label?: string; capabilities: string[] }[], connected: string[] = []): void => {
    queryClient.setQueryData(PERSONAS.of(), { personas, connected });
};

beforeEach(async () => {
    localStorage.clear();
    selected = [];
    resetChat();
    resetAgents();
    useChatGrouping().set(`persona`);
    withPersonas([
        { id: `work`, label: `Work`, capabilities: [`reddit-work`] },
        { id: `inbox`, label: `Inbox Manager`, capabilities: [`gmail-inbox`] },
    ]);
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    useChatGrouping().set(`lane`);
    queryClient.clear();
    document.body.replaceChildren();
});

const rows = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(`.rail-card`)].map((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() ?? ``);

const rowFor = (el: HTMLElement, label: string): HTMLElement | undefined =>
    [...el.querySelectorAll(`.rail-card`)].find((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() === label) as
        HTMLElement | undefined;

/* THE HEADLINE PROPERTY, and the one the old design could not have: a workspace that has never pinned a single
 * chat to a persona still gets a full rail, because the rows come from the CARDS. */
it("lists the workspace's personas without anyone having pinned a chat to them", async () => {
    const el = await mountList();
    expect(rows(el)).toEqual([`Work`, `Inbox Manager`, `Anyone`]);
});

// Anyone is a real row and it is last: a chat bound to nobody keeps every connected account, which is a
// different thing from any one card rather than the absence of a choice.
it("keeps Anyone as the final row", async () => {
    const el = await mountList();
    expect(rows(el).at(-1)).toBe(`Anyone`);
});

/* A WORKSPACE WITH NO CARDS MUST EXPLAIN ITSELF. Showing a lone "Anyone" row is how this shipped the first
 * time, and it read as a mode that does nothing — so with nothing set up the rail says what a persona is and
 * offers the way to make one. */
it("offers to set one up when the workspace has no personas", async () => {
    withPersonas([]);
    const el = await mountList();
    expect(el.textContent).toContain(`No personas yet`);
    expect(el.textContent).toContain(`Set up a persona`);
    expect(rows(el)).toEqual([]);
});

// Pressing a persona you have never talked to opens a chat ALREADY PINNED to them — the rail's whole promise,
// and the one thing that makes the pick something other than a manual step in the composer.
it("starts a chat pinned to a persona you have not talked to yet", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    const pinned = useChat().conversations.value.filter((conversation) => conversation.actsAs.value === `work`);
    expect(pinned).toHaveLength(1);
});

// ...and pressing one you HAVE talked to returns you to that conversation rather than opening a second one.
it("returns to the chat already acting as that persona", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    const first = useChat().conversations.value.find((conversation) => conversation.actsAs.value === `work`);
    selected = [];

    rowFor(el, `Work`)?.click();
    await settle();
    expect(selected).toEqual([first?.conversationId]);
    expect(useChat().conversations.value.filter((conversation) => conversation.actsAs.value === `work`)).toHaveLength(1);
});

/* A CARD WITH NOTHING SIGNED IN IS OFFERED, MARKED — the ordinary state of a freshly cloned workspace. Picking
 * it is still meaningful (the chat is bounded), it simply cannot post yet, and hiding it would answer "where
 * did Work go" with silence. */
it("marks a persona whose accounts are all signed out", async () => {
    const el = await mountList();
    expect(rowFor(el, `Work`)?.textContent).toContain(`not signed in yet`);
});

it("drops the marking once one of its accounts is connected", async () => {
    withPersonas([{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }], [`reddit-work`]);
    const el = await mountList();
    expect(rowFor(el, `Work`)?.textContent).not.toContain(`not signed in yet`);
    expect(rowFor(el, `Work`)?.textContent).toContain(`reddit-work`);
});

// The switch swaps the whole column, so the chats are still there on the way back.
it("hands the column back to the chats when the switch is flipped", async () => {
    const el = await mountList();
    expect(rows(el)).toContain(`Work`);
    useChatGrouping().set(`lane`);
    await settle();
    expect(rows(el)).not.toContain(`Work`);
    expect(el.querySelector(`[aria-label="Filter chats by your messages"]`)).not.toBeNull();
});
