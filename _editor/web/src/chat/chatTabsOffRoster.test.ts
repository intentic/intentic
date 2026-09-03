// @vitest-environment jsdom
//
// A CHAT THE ROSTER CANNOT RESOLVE IS STILL A CHAT. The fleet carries LIVE agents only: the daemon's retention
// sweep files finished ones away, the archive half is pull-only, and a conversation opened from History can
// outlive its registry entry altogether. The card used to read every fact it drew off the FleetAgent behind one
// `v-if`, so all of those cases collapsed to a bare title over a grey dot: a rail that had been full of models,
// costs and counts an hour earlier went blank as the sweep ran underneath it.
//
// What is asserted here is the FALLBACK, in the shape the user sees it: mount the list over a registered
// conversation the fleet has never heard of and read the card's own text back. jsdom lays nothing out, so the
// facts are checked as text rather than as pixels.
import { beforeEach, expect, it, vi } from "vitest";

// The daemon, stubbed at the one seam the list reaches it through, so the archive probe below can be asserted
// as the call it is, rather than inferred from a card that did or didn't fill in.
vi.mock("../composables/sandbox/sandboxClient", () => {
    const sandboxJson = vi.fn(async () => ({ agents: [] }));
    const sandboxRequest = vi.fn();
    return {
        sandboxJson,
        sandboxRequest,
        // The reach-aimed pair: `undefined` is the active box, which is every call this suite makes.
        sandboxJsonVia: (_at: string | undefined, path: string, init?: RequestInit) => sandboxJson(),
        sandboxRequestVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxRequest(path) : sandboxRequest(path, init),
    };
});

import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { sandboxJson } from "../composables/sandbox/sandboxClient";
import { resetChat, useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import ChatTabList from "./ChatTabList.vue";

// The import-time globals a mounted chat component needs: the same set chatTabsReveal.test.ts installs.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

let app: App | undefined;
let host: HTMLElement | undefined;
const mountList = async (): Promise<void> => {
    host = document.createElement(`div`);
    document.body.appendChild(host);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(host);
    await nextTick();
    await nextTick();
};

beforeEach(async () => {
    app?.unmount();
    app = undefined;
    host?.remove();
    localStorage.clear();
    resetChat();
    await nextTick();
});

it(`draws the model from the conversation when the fleet cannot resolve it`, async () => {
    const chat = useChat();
    const conversation = chat.active.value;
    // Registered, so the join treats it as a real agent that is merely off the roster, not as a draft (which
    // is the one case that legitimately has nothing to say).
    conversation.registered.value = true;
    conversation.title.value = `Detached intentic chat · fix`;
    conversation.model.value = `claude-opus-4-5`;
    // The cost is read off the rows: each turn's usage sits on the bubble its answer ended in.
    conversation.restoreMessages([{ role: `assistant`, text: `done`, usage: { costUsd: 7.02 } }]);

    await mountList();

    const card = host!.querySelector(`[data-chat-tab]`);
    expect(card?.textContent).toContain(`Detached intentic chat · fix`);
    expect(card?.textContent).toContain(modelLabelFor(`claude`, `claude-opus-4-5`));
    // ...and no spend, from either half of the join: money is the board's fact. A rail is a SWITCHER, read to
    // pick between the chats you have open, and the line a dollar figure filled is the one the live readout
    // needs (see ChatTabList's meta template).
    expect(card?.textContent).not.toContain(`$7.02`);
});

it(`asks the daemon for the archive when an open chat is off the roster`, async () => {
    const chat = useChat();
    chat.active.value.registered.value = true;
    vi.mocked(sandboxJson).mockClear();

    await mountList();

    // The sweep runs for the life of the window, so this is asked on the symptom rather than once at mount.
    expect(vi.mocked(sandboxJson).mock.calls.some(([path]) => path === `/agents/archived`)).toBe(true);
});

it(`prints no spend at all, so a restored chat cannot print a zero`, async () => {
    const chat = useChat();
    const conversation = chat.active.value;
    conversation.registered.value = true;
    conversation.title.value = `Pipeline triggers · implement`;

    await mountList();

    // `$0.00` under a chat this tab never streamed is the card inventing a fact rather than lacking one.
    expect(host!.querySelector(`[data-chat-tab]`)?.textContent).not.toContain(`$0`);
});
