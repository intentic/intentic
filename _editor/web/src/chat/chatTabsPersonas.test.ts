// @vitest-environment jsdom
//
// THE PERSONA RAIL: the chat list's other column, where a row is a PERSON this sandbox can be rather than a
// session it is running. Mounted through ChatTabList, because the switch between the two lists is half of what
// is being asserted; the rows themselves are ChatPersonaRail's.
//
// WHY THIS FILE REPLACED ONE THAT TESTED GROUPING. The first build of this feature grouped the open chats under
// persona headings, and every one of its tests passed while the feature was useless in the app: a chat's
// persona is a composer pick that nobody makes, so a real workspace put all 56 of its chats under one "Anyone"
// heading and the switch changed a word. The tests were green because they set `actsAs` by hand: they proved
// the grouping worked and could not have caught that there was nothing to group. So the assertions here are
// about what the rail shows WITHOUT anyone having pinned anything: the cards, straight from the workspace.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../composables/agents/useAgents";
import { useChatGrouping } from "../composables/chat/chatGrouping";
import { openAgentConversation, resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { PERSONAS } from "../composables/queryKeys";
import { router } from "../router";
import ChatTabList from "./ChatTabList.vue";

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
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

// The cards a workspace has made, seeded into the cache the rail reads them from. `connected` is what decides
// whether a card can actually post: the rail marks the ones that cannot.
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

/* THE HEADLINE PROPERTY, and the one the old design could not have: a workspace that has never pinned a single
 * chat to a persona still gets a full rail, because the rows come from the CARDS. */
it("lists the workspace's personas without anyone having pinned a chat to them", async () => {
    const el = await mountList();
    expect(rows(el)).toEqual([`Work`, `Inbox Manager`]);
});

/* NO "ANYONE" ROW. The composer's picker has one and means something precise by it; as a row in a list of
 * PEOPLE it meant "every chat nobody pinned", which is nearly all of them: eleven conversations and their
 * attention bar, at the bottom of a list about personas. Unpinned chats belong to the Agents cut. */
it("lists no Anyone row", async () => {
    const el = await mountList();
    expect(rows(el)).not.toContain(`Anyone`);
    expect(el.textContent).not.toContain(`Every account you've connected`);
});

/* A WORKSPACE WITH NO CARDS MUST STILL OFFER THE WAY IN. Showing a lone "Anyone" row is how this shipped the
 * first time, and it read as a mode that does nothing, so with nothing set up the rail offers the one press
 * that makes one. Just the button now: the explanation paragraph it used to carry was removed as noise. */
it("offers to set one up when the workspace has no personas", async () => {
    withPersonas([]);
    const el = await mountList();
    expect(el.textContent).toContain(`Set up a persona`);
    expect(rows(el)).toEqual([]);
});

/* PRESSING A PERSON OPENS THE PERSON, NOT A CHAT, and this is the assertion that pins it. The card's press used
 * to put the newest conversation acting as them on screen, and START one where there were none: so the
 * commonest press on the list, the one a reader makes while scanning for who is busy, both changed which chat
 * the window was showing and could create a conversation nobody asked for. A list is scanned far more often
 * than it is acted on, so its default press is the reversible one: the group opens, and everything that puts a
 * chat on screen is a deliberate second press inside it. */
it("opens the persona's group rather than a chat when the card is pressed", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    expect(useChat().conversations.value.filter((conversation) => conversation.actsAs.value === `work`)).toHaveLength(0);
    expect(selected).toEqual([]);
    // What it DID do: the group is open, so the way to a chat is now on screen.
    expect(el.textContent).toContain(`New chat as Work`);
});

// ...and pressing it again shuts the group, which is the other half of "the default press is reversible".
it("shuts the group again on a second press", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    rowFor(el, `Work`)?.click();
    await settle();
    expect(el.textContent).not.toContain(`New chat as Work`);
});

// The chat still gets started from inside the group: the rail's whole promise (a conversation ALREADY PINNED to
// this persona, with no manual step in the composer), now behind the press that says so.
it("starts a chat pinned to the persona from inside the group", async () => {
    const el = await mountList();
    rowFor(el, `Work`)?.click();
    await settle();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`New chat as Work`))?.click();
    await settle();
    expect(useChat().conversations.value.filter((conversation) => conversation.actsAs.value === `work`)).toHaveLength(1);
});

// ...and a persona you HAVE talked to lists those chats to pick from rather than choosing one for you: the
// switch itself is pinned by "lists a persona's chats and switches to the one you pick", further down.

/* NEITHER THE ACCOUNT SLUGS NOR A COUNT OF THEM belongs under a person's name. The row spelled the raw
 * capability ids there first (`reddit-radarsuspam`), which are internal slugs, and then a tally of them, which
 * answers a question the personas page exists for. Nobody reads a list of PEOPLE to find out either. That line
 * carries what the person is running on and what they are doing instead, which is what the board and the chats
 * rail put there and the only reading on this card that changes what you do next. */
it("spells no capability ids or account counts under a persona's name", async () => {
    withPersonas([{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }], [`reddit-work`]);
    const el = await mountList();
    const row = rowFor(el, `Work`);
    expect(row?.textContent).not.toContain(`reddit-work`);
    expect(row?.textContent).not.toContain(`account`);
});

/* A PERSONA HOLDING NO ACCOUNTS IS AN ORDINARY ROW, not a broken one. It still bounds what a chat can reach
 * and still names who is speaking, and it is the state every card is in for the minute after it is made, so
 * the rail says nothing at all rather than marking the row. This is pinned because the rail used to write
 * "No accounts yet" into that slot, which turned a normal state into a defect on every row of a new list. */
it("says nothing about a persona that holds no accounts", async () => {
    withPersonas([{ id: `fresh`, label: `Fresh`, capabilities: [] }]);
    const el = await mountList();
    const row = rowFor(el, `Fresh`);
    expect(row?.textContent).not.toContain(`No accounts`);
    expect(row?.textContent).not.toContain(`can't post`);
    expect(row?.querySelector(`.text-warning`)).toBeNull();
});

/* --- Reaching a persona's OTHER chats ---------------------------------------------------------------------
 * The row states a count, and until the disclosure existed that count named conversations no press could
 * reach: the card went to the newest and the rest were only findable by leaving this cut for the Agents one.
 * These pin the door being real. */
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

// The chats drawn UNDER a persona: everything the list holds that is not one of the persona rows themselves.
const sessionRows = (el: HTMLElement): string[] => {
    const personaNames = new Set([`Work`, `Inbox Manager`]);
    return [...el.querySelectorAll(`[data-chat-tab], .session-card`)]
        .map((card) => card.querySelector(`.line-clamp-2`)?.textContent?.trim() ?? ``)
        .filter((title) => !personaNames.has(title));
};

it("lists a persona's chats and switches to the one you pick", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`, `second`]);
    // Shut until asked: the rail stays a list of people, and nothing about what is active elsewhere opens it.
    expect(sessionRows(el)).toEqual([]);

    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toHaveLength(2);

    // A SESSION row, addressed by what it offers to do: the persona cards are also `.session-card`, and
    // pressing one of those only opens or shuts its group.
    selected = [];
    el.querySelector(`[aria-label^="Open "]`)?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await settle();
    expect(selected).toHaveLength(1);
});

// The card is the door, and it closes as well as opens.
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

/* THE SEVENTH CHAT. Before this, a persona holding one chat could never be given another from the rail: the
 * card's press went to the latest chat, so starting a second meant pressing New agent and naming the persona by
 * hand in the composer, which is the errand the rail exists to remove. */
it("offers a new chat as that persona once its existing ones are on screen", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(el.textContent).toContain(`New chat as Work`);
});

/* A PERSONA NOBODY HAS TALKED TO STILL OPENS, and opens onto the one thing there is to do with them. It used to
 * have no disclosure at all, because the card's own press started that first chat; now that the press is the
 * disclosure, a card that refused to open would be the one row on the list that answers nothing. It has no chats
 * to list, so what the group holds is the offer to start one. */
it("opens a chatless persona onto the offer to start its first chat", async () => {
    const el = await mountList();
    expect(disclosureFor(el, `Work`)).toEqual(expect.any(Object));
    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toEqual([]);
    expect(el.textContent).toContain(`New chat as Work`);
});

/* ONE PERSON AT A TIME, AND ONLY THE ONE YOU PRESSED. The groups are independent, so pressing a card must not
 * open anybody else's: a list of people that reshuffles around the row you touched is one you stop touching.
 * (A chat opened from inside a group also expands its own persona, and arrival expands the one you walked in
 * holding: both are separate acts with their own tests, above.) */
it("expands the persona you press, and only then", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    expect(sessionRows(el)).toEqual([]);

    rowFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toHaveLength(1);
    expect(el.textContent).not.toContain(`New chat as Inbox Manager`);
});

/* --- Arriving from the Agents cut --------------------------------------------------------------------------
 * The two cuts share one transcript, so the chat you switch over holding is still the chat on screen. If it
 * names a persona, this list has to say so: coming back to find your own conversation open with nobody ringed
 * for it is the list disowning a chat that is, by its own rule, one of that persona's. */
it("rings the persona of the chat you walk in from, and opens it on that chat", async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    await pinTo(`work`, [`talking-as-work`]);

    useChatGrouping().set(`persona`);
    await settle();
    expect(rowFor(el, `Work`)?.classList.contains(`session-card-on`)).toBe(true);
    // ...and the chat itself, which means its group is open from the first frame: a ring on a row nobody can
    // see is not a highlight.
    expect(sessionRows(el)).toHaveLength(1);
    expect(el.querySelector(`[aria-label^="Open "]`)?.classList.contains(`session-card-on`)).toBe(true);
});

// An UNPINNED chat rings nobody, because there is nobody to ring: the seed is a fact the chat carries, never
// a guess about which person you might have meant.
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

/* --- Detached from the Agents cut -------------------------------------------------------------------------
 * The two cuts share one transcript, so talking to a persona necessarily moves it. Going to look at who you
 * can send as must not cost you the conversation you were working in. */
it("leaves the Agents cut on the chat it was reading", async () => {
    useChatGrouping().set(`lane`);
    const el = await mountList();
    openAgentConversation({ id: `working-on-this`, provider: `claude`, harness: `native` });
    await settle();

    useChatGrouping().set(`persona`);
    await settle();
    // The card's press only opens the group now, so the transcript is moved the way it is moved for real:
    // from inside that group, by starting a chat as Work.
    rowFor(el, `Work`)?.click();
    await settle();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`New chat as Work`))?.click();
    await settle();

    selected = [];
    useChatGrouping().set(`lane`);
    await settle();
    expect(selected).toEqual([`working-on-this`]);
});

// ...and a visit that picked nobody ends in no reveal at all, rather than a redundant one.
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

// The switch swaps the whole column, so the chats are still there on the way back.
it("hands the column back to the chats when the switch is flipped", async () => {
    const el = await mountList();
    expect(rows(el)).toContain(`Work`);
    useChatGrouping().set(`lane`);
    await settle();
    expect(rows(el)).not.toContain(`Work`);
    expect(el.querySelector(`[aria-label="Filter chats by your messages"]`)).not.toBeNull();
});

/* --- What the row says the person is doing -----------------------------------------------------------------
 * The card's facts line, in the arrangement the fleet board and the chats rail already use: what it RUNS ON at
 * the left, what it is DOING at the right. A persona rail row is a person rather than a session, so it reads
 * one of that person's chats for both (ChatPersonaRail.leadOf: a turn in flight first, else the latest). */

// The model, under the name. On this card it is also the only place the provider can be said at all: the slot
// every other surface hangs the provider mark in is wearing a FACE here.
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

/* ...and a persona nobody has talked to yet says none of it. There is no chat to read a model, an activity or a
 * clock off, so the card draws none of the three rather than inventing a line for them: the same rule the empty
 * account slot follows, and for the same reason. A fresh card is an ordinary card, not a broken one. */
it("says nothing about what a persona runs on until it has a chat", async () => {
    withPersonas([{ id: `fresh`, label: `Fresh`, capabilities: [] }]);
    const el = await mountList();
    const row = rowFor(el, `Fresh`);
    expect(row?.textContent).not.toContain(`Claude`);
});
