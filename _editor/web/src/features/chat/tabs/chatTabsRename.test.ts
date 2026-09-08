// @vitest-environment jsdom
// The rail's rename is one state shared by every row, so it has to end with the row it was opened on.
// Regression: a row that left mid-rename took its input with it and left nothing to blur the edit shut, so
// reopening that chat from the board drew an empty "New agent" field in the lane instead of its card.
import type { AgentSummary } from "@intentic/sandbox-contract";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { resetAgents } from "../../agents/fleet/useAgents";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { resetChat, useChat } from "../run/useChat";
import { openAgentConversation } from "../panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// Globals a mounted chat needs that jsdom lacks.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

let app: App | undefined;

const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
    await nextTick();
};

// Mounted once per test, mirroring the floating window's own lifetime: the state this pins only survives
// because the rail is never remounted.
const mountList = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    app = createApp({ render: () => h(ChatTabList, { onClose: (ids: ReadonlySet<string>) => useChat().closeTabs(ids) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await settle();
    return el;
};

beforeEach(async () => {
    localStorage.clear();
    resetChat();
    resetAgents();
    await nextTick();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

// Two running agents on their own branches, so their chats are isolated ones (an agent, not a workspace chat)
// and both sit in Active.
const seed = (revision = 100): void =>
    setAgents(
        [`working`, `other`].map((id, at) => ({
            id,
            status: `running`,
            provider: `claude`,
            harness: `native`,
            branch: `agent/${id}`,
            updatedAt: 2_000 - at,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        })) satisfies AgentSummary[],
        revision,
    );

// The same call a board card's click makes.
const openFromBoard = (id: string): void => {
    openAgentConversation({ id, provider: `claude`, harness: `native`, branch: `agent/${id}`, registered: true });
};

const cardOf = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector(`[data-chat-tab="${id}"]`);
// Rename fields open in the lanes, by what they offer as a name; an untitled agent chat shows "New agent".
const fields = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLInputElement>(`input[aria-label="Chat title"]`)].map((input) => input.placeholder);

const renameRow = async (el: HTMLElement, id: string): Promise<void> => {
    cardOf(el, id)?.dispatchEvent(new MouseEvent(`dblclick`, { bubbles: true }));
    await settle();
};

it(`opens a rename field on the row that was double-clicked`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    await settle();

    await renameRow(el, `working`);

    expect(fields(el)).toEqual([`New agent`]);
    expect(cardOf(el, `working`)).toBeNull();
});

it(`draws a reopened chat as its card, not the rename field its row was closed in`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    openFromBoard(`other`);
    await settle();
    await renameRow(el, `working`);
    expect(fields(el)).toEqual([`New agent`]);

    useChat().closeTabs(new Set([`working`]));
    await settle();
    openFromBoard(`working`);
    await settle();

    expect(fields(el)).toEqual([]);
    expect(cardOf(el, `working`)).not.toBeNull();
});

it(`keeps the field open while its row is on screen, roster frames and all`, async () => {
    seed();
    const el = await mountList();
    openFromBoard(`working`);
    await settle();
    await renameRow(el, `working`);

    seed(101);
    await settle();

    expect(fields(el)).toEqual([`New agent`]);
});
