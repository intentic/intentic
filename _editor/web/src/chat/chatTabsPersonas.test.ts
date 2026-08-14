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
import { openAgentConversation, resetChat, useChat } from "../composables/chat/useChat";
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
    expect(rows(el)).toEqual([`Work`, `Inbox Manager`]);
});

/* NO "ANYONE" ROW. The composer's picker has one and means something precise by it; as a row in a list of
 * PEOPLE it meant "every chat nobody pinned", which is nearly all of them — eleven conversations and their
 * attention bar, at the bottom of a list about personas. Unpinned chats belong to the Agents cut. */
it("lists no Anyone row", async () => {
    const el = await mountList();
    expect(rows(el)).not.toContain(`Anyone`);
    expect(el.textContent).not.toContain(`Every account you've connected`);
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

// The accounts under the name, because a name alone cannot tell `reddit-work` from `reddit-personal` — and
// those being different accounts is the whole reason a persona exists.
it("names the accounts a persona holds", async () => {
    withPersonas([{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }], [`reddit-work`]);
    const el = await mountList();
    expect(rowFor(el, `Work`)?.textContent).toContain(`reddit-work`);
});

/* A PERSONA HOLDING NO ACCOUNTS IS AN ORDINARY ROW, not a broken one. It still bounds what a chat can reach
 * and still names who is speaking, and it is the state every card is in for the minute after it is made — so
 * the rail says nothing at all rather than marking the row. This is pinned because the rail used to write
 * "No accounts yet" into that slot, which turned a normal state into a defect on every row of a new list. */
it("says nothing about a persona that holds no accounts", async () => {
    withPersonas([{ id: `fresh`, label: `Fresh`, capabilities: [] }]);
    const el = await mountList();
    const row = rowFor(el, `Fresh`);
    expect(row).toBeDefined();
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

// The chats drawn UNDER a persona — everything the list holds that is not one of the persona rows themselves.
const sessionRows = (el: HTMLElement): string[] => {
    const personaNames = new Set([`Work`, `Inbox Manager`]);
    return [...el.querySelectorAll(`[data-chat-tab], .rail-card`)]
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

    // A SESSION row, addressed by what it offers to do — the persona cards are also `.rail-card`, and pressing
    // one of those would start a chat rather than switch to one.
    selected = [];
    el.querySelector(`[aria-label^="Open "]`)?.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await settle();
    expect(selected).toHaveLength(1);
});

// The count is the door, and it closes as well as opens.
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

/* THE SEVENTH CHAT. Before this, a persona holding one chat could never be given another from the rail — the
 * card's press means "the latest, or a new one if there are none" — so starting a second meant pressing New
 * agent and naming the persona by hand in the composer, which is the errand the rail exists to remove. */
it("offers a new chat as that persona once its existing ones are on screen", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    disclosureFor(el, `Work`)?.click();
    await settle();
    expect(el.textContent).toContain(`New chat as Work`);
});

// The disclosure only exists where it leads somewhere: a persona nobody has talked to yet has no list to open
// and a card whose own press already starts the first chat.
it("shows no disclosure on a persona with no chats", async () => {
    const el = await mountList();
    expect(disclosureFor(el, `Work`)).toBeUndefined();
});

/* THE PERSONA YOU OPENED FROM HERE expands itself, so the rail shows where the press landed. Keyed to this
 * rail's own pick rather than to the window's active chat — which is what keeps walking in from the Agents cut
 * from flinging a group open about a conversation you were reading somewhere else. */
it("expands the persona you press, and only then", async () => {
    const el = await mountList();
    await pinTo(`work`, [`first`]);
    expect(sessionRows(el)).toEqual([]);

    rowFor(el, `Work`)?.click();
    await settle();
    expect(sessionRows(el)).toHaveLength(1);
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
    rowFor(el, `Work`)?.click(); // opens a chat as Work — the transcript moves
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
