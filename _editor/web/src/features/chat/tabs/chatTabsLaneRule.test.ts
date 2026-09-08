// @vitest-environment jsdom
// The switcher places a chat by the fleet's rule (laneOf), never one of its own. Regression: a conversation the
// fleet can't card was placed by message count instead — a refused turn read as Finished while the board's card
// for the same standing reads Attention, and every freshly opened chat passed through Active on its way to its
// real lane.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { laneOf, NO_ATTENTION, standingFrom } from "../../agents/fleet/agentStatus";
import { agentSeed } from "../../agents/fleet/useAgents-actions";
import { resetAgents } from "../../agents/fleet/useAgents";
import { resetChat, useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { standingOf } from "./tabFacts";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

let app: App | undefined;
let host: HTMLElement | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// Mounted with an empty roster: the case under test is a chat this window's fleet holds no card for.
const mountList = async (): Promise<void> => {
    host = document.createElement(`div`);
    document.body.appendChild(host);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(host);
    await settle();
};

beforeEach(async () => {
    localStorage.clear(); // the tab snapshot persists per sandbox; each test starts from one fresh chat
    resetChat();
    resetAgents();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    host?.remove();
    document.body.replaceChildren();
});

// Which lane holds which chat, by the lane's own header label.
const laneOfRow = (id: string): string | undefined =>
    [...host!.querySelectorAll(`section`)]
        .filter((section) => section.querySelector(`[data-chat-tab="${id}"]`) !== null)
        .map((section) => section.querySelectorAll(`header span`)[1]?.textContent?.trim())[0];

it(`puts a refused turn where its standing does, not where its message count does`, async () => {
    const conversation = useChat().active.value;
    // Registered, so the join reads it as an agent this window's roster hasn't answered for, not a draft.
    conversation.registered.value = true;
    conversation.title.value = `Provider usage limits · audit`;
    conversation.restoreMessages([{ role: `user`, text: `carry on` }]);
    conversation.error.value = `Usage limit reached`;

    await mountList();

    // The standing a refused turn carries is `failed`, and `laneOf` calls that blocked — the same answer the
    // board's own client card gets for it.
    expect(standingOf(conversation)).toBe(`failed`);
    expect(laneOf({ status: standingOf(conversation), attention: NO_ATTENTION })).toBe(`attention`);
    expect(laneOfRow(conversation.conversationId)).toBe(`Attention`);
});

it(`opens a chat straight into its own lane, with no pass through Active`, async () => {
    await mountList();

    // A board card's own click: the seed carries the agent's session, so the standing is settled from the first
    // frame rather than after the transcript arrives.
    const opened = openAgentConversation({ id: `settled`, provider: `claude`, harness: `native`, sessionId: `session-1`, branch: `agent/settled` });
    await nextTick();

    expect(opened.messages.value).toHaveLength(0);
    expect(standingOf(opened)).toBe(`resumed`);
    expect(laneOfRow(`settled`)).toBe(`Finished`);
});

it(`keeps a chat with nothing in it in Active, where a fresh draft belongs`, async () => {
    await mountList();

    expect(laneOfRow(useChat().active.value.conversationId)).toBe(`Active`);
});

// A spent allowance as the daemon files it (agents.json): an errored turn with the rate-limit code, which
// `blocked` counts, so the board's card sits in Attention.
const limitHit = {
    id: `spent`,
    provider: `claude`,
    harness: `native`,
    status: `error`,
    failureCode: `rate_limit`,
    attention: NO_ATTENTION,
    sessionId: `session-spent`,
    branch: `agent/spent`,
} as const;

it(`lands a card in the lane its board card has, though this window's roster holds nothing`, async () => {
    await mountList();

    // The seed a board card's own click builds, carried to whichever window draws the chat.
    const opened = openAgentConversation(agentSeed(limitHit));
    await nextTick();

    expect(laneOf(limitHit)).toBe(`attention`);
    expect(opened.standing.value).toEqual(standingFrom(limitHit));
    expect(laneOfRow(limitHit.id)).toBe(`Attention`);
});

it(`lets what this window can see outrank the account the card came in with`, async () => {
    await mountList();
    const opened = openAgentConversation(agentSeed(limitHit));
    await nextTick();
    expect(laneOfRow(limitHit.id)).toBe(`Attention`);

    // The user sends again from here: a turn running in this window is newer than anything the card said.
    opened.streaming.value = true;
    await nextTick();

    expect(laneOfRow(limitHit.id)).toBe(`Active`);
});
