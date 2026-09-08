// @vitest-environment jsdom
// Pins the persona rail: rows are people (ChatPersonaRail), not sessions. Mounted via ChatTabList since the
// lane/persona switch is part of what's tested.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../../agents/fleet/useAgents";
import { useChatGrouping } from "../transcript/chatGrouping";
import { resetChat, useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { PERSONAS } from "../../../lib/queryKeys";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
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
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

// Seeds the persona cache the rail reads from; `connected` decides whether a card can post (marked when it can't).
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
    [...el.querySelectorAll(`.session-card`)].map((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() ?? ``);

const rowFor = (el: HTMLElement, label: string): HTMLElement | undefined =>
    [...el.querySelectorAll(`.session-card`)].find((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() === label) as
        HTMLElement | undefined;

it("lists the workspace's personas without anyone having pinned a chat to them", async () => {
    const el = await mountList();
    expect(rows(el)).toEqual([`Work`, `Inbox Manager`]);
});

it("lists no Anyone row", async () => {
    const el = await mountList();
    expect(rows(el)).not.toContain(`Anyone`);
    expect(el.textContent).not.toContain(`Every account you've connected`);
});

it("offers to set one up when the workspace has no personas", async () => {
    withPersonas([]);
    const el = await mountList();
    expect(el.textContent).toContain(`Set up a persona`);
    expect(rows(el)).toEqual([]);
});

it("opens the persona's group rather than a chat when the card is pressed", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    expect(useChat().conversations.value.filter((conversation) => conversation.actsAs.value === `work`)).toHaveLength(0);
    expect(selected).toEqual([]);
    expect(el.textContent).toContain(`New chat as Work`);
});

it("shuts the group again on a second press", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    rowFor(el, `Work`)?.click();
    await settle();
    expect(el.textContent).not.toContain(`New chat as Work`);
});

it("starts a chat pinned to the persona from inside the group", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`New chat as Work`))?.click();
    await settle();
    expect(useChat().conversations.value.filter((conversation) => conversation.actsAs.value === `work`)).toHaveLength(1);
});

it("spells no capability ids or account counts under a persona's name", async () => {
    withPersonas([{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }], [`reddit-work`]);
    const el = await mountList();
    const row = rowFor(el, `Work`);
    expect(row?.textContent).not.toContain(`reddit-work`);
    expect(row?.textContent).not.toContain(`account`);
});

it("says nothing about a persona that holds no accounts", async () => {
    withPersonas([{ id: `fresh`, label: `Fresh`, capabilities: [] }]);
    const el = await mountList();
    const row = rowFor(el, `Fresh`);
    expect(row?.textContent).not.toContain(`No accounts`);
    expect(row?.textContent).not.toContain(`can't post`);
    expect(row?.querySelector(`.text-warning`)).toBeNull();
});

// Opens conversations via the board, then pins each to a persona, simulating actsAs.
const pinTo = async (persona: string, ids: string[]): Promise<void> => {
    for (const id of ids) {
        openAgentConversation({ id, provider: `claude`, harness: `native` });
    }
    await settle();
    for (const id of ids) {
        const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
        if (conversation !== undefined) {
            conversation.actsAs.value = persona;
        }
    }
    await settle();
};

const disclosureFor = (el: HTMLElement, label: string): HTMLElement | undefined =>
    (el.querySelector(`[aria-label="Show ${label}'s chats"]`) as HTMLElement | null) ?? undefined;

// Chats drawn under a persona: everything in the list that isn't one of the persona rows themselves.
const sessionRows = (el: HTMLElement): string[] => {
    const personaNames = new Set([`Work`, `Inbox Manager`]);
    return [...el.querySelectorAll(`[data-chat-tab], .session-card`)]
        .map((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() ?? ``)
        .filter((title) => !personaNames.has(title));
};

it("lists a persona's chats and switches to the one you pick", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`, `second`]);
    // Collapsed until the disclosure is pressed.
    expect(sessionRows(el)).toEqual([]);

    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toHaveLength(2);

    // Selected via `[aria-label^="Open "]`, since persona cards share the `.session-card` class too.
    selected = [];
    el.querySelector(`[aria-label^="Open "]`)?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await settle();
    expect(selected).toHaveLength(1);
});

it("collapses the list again from the same control", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`, `second`]);
    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toHaveLength(2);

    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toEqual([]);
});

it("offers a new chat as that persona once its existing ones are on screen", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(el.textContent).toContain(`New chat as Work`);
});

it("opens a chatless persona onto the offer to start its first chat", async () => {
    const el = await mountList();
    expect(disclosureFor(el, `Work`)).toEqual(expect.any(Object));
    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toEqual([]);
    expect(el.textContent).toContain(`New chat as Work`);
});

it("expands the persona you press, and only then", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    expect(sessionRows(el)).toEqual([]);

    rowFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toHaveLength(1);
    expect(el.textContent).not.toContain(`New chat as Inbox Manager`);
});

// The two cuts share one transcript: switching to Personas must ring and open the persona of the chat you
// were already in.
it("rings the persona of the chat you walk in from, and opens it on that chat", async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    await pinTo(`work`, [`talking-as-work`]);

    useChatGrouping().set(`persona`);
    await settle();
    expect(rowFor(el, `Work`)?.classList.contains(`session-card-on`)).toBe(true);
    // The group must already be open, or the ring is invisible.
    expect(sessionRows(el)).toHaveLength(1);
    expect(el.querySelector(`[aria-label^="Open "]`)?.classList.contains(`session-card-on`)).toBe(true);
});

// actsAs is a fact the chat carries, never guessed.
it("rings nobody when the chat you walk in from names no persona", async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    openAgentConversation({ id: `nobody-in-particular`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    expect(rowFor(el, `Work`)?.classList.contains(`session-card-on`)).toBe(false);
    expect(sessionRows(el)).toEqual([]);
});

// The two cuts share one transcript; looking at Personas must not move the Agents cut's own place.
it("leaves the Agents cut on the chat it was reading", async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    openAgentConversation({ id: `working-on-this`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    // Starting the chat, not just opening the group, is what moves the transcript.
    rowFor(el, `Work`)?.click();
    await settle();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`New chat as Work`))?.click();
    await settle();

    selected = [];
    useChatGrouping().set(`lane`);
    await settle();
    expect(selected).toEqual([`working-on-this`]);
});

it("reveals nothing when the visit changed no chat", async () => {
    useChatGrouping().set(`lane`);
    await mountList();
    openAgentConversation({ id: `working-on-this`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    selected = [];
    useChatGrouping().set(`lane`);
    await settle();
    expect(selected).toEqual([]);
});

it("hands the column back to the chats when the switch is flipped", async () => {
    const el = await mountList();
    expect(rows(el)).toContain(`Work`);
    useChatGrouping().set(`lane`);
    await settle();
    expect(rows(el)).not.toContain(`Work`);
    expect(el.querySelector(`[aria-label="Filter chats by your messages"]`)).not.toBeNull();
});

// The row reads one of the persona's own chats for its facts line (ChatPersonaRail.leadOf: a turn in flight
// first, else the latest).

it("shows what the persona's chat runs on under the name", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === `first`);
    if (conversation !== undefined) {
        conversation.activeModel.value = `sonnet-under-test`;
    }
    await settle();
    expect(rowFor(el, `Work`)?.textContent).toContain(`sonnet-under-test`);
});

it("says nothing about what a persona runs on until it has a chat", async () => {
    withPersonas([{ id: `fresh`, label: `Fresh`, capabilities: [] }]);
    const el = await mountList();
    const row = rowFor(el, `Fresh`);
    expect(row?.textContent).not.toContain(`Claude`);
});
