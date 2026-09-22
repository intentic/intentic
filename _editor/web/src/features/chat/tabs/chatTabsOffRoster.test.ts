// Pins the fallback text a card shows for a chat off the fleet roster (title, model, cost), checked as text
// since jsdom lays nothing out.
import "@intentic/testing/dom";
import { it, expect, beforeEach, mock } from "bun:test";
import { mocked, hoisted } from "@intentic/testing/bun";

// Stubs the daemon at the seam the list reaches it through, so the archive probe is asserted as a call.
mock.module("../../sandbox/client/sandboxClient", () => {
    const sandboxJson = mock(async () => ({ agents: [] }));
    const sandboxRequest = mock();
    return {
        sandboxJson,
        sandboxRequest,
        // `undefined` is the active box: every call this suite makes.
        sandboxJsonVia: (_at: string | undefined, path: string, init?: RequestInit) => sandboxJson(),
        sandboxRequestVia: (_at: string | undefined, path: string, init?: RequestInit) =>
            init === undefined ? sandboxRequest(path) : sandboxRequest(path, init),
        // Named by the graph but never called here; bun links an ESM import against exactly what this returns.
        sandboxJsonAt: mock(),
        sandboxJsonQuietly: mock(),
        sandboxBlob: mock(),
        sandboxError: mock(async () => new Error(`unused`)),
        SandboxHttpError: class SandboxHttpError extends Error {},
    };
});

import { VueQueryPlugin } from "@tanstack/vue-query";
import { type App, createApp, h, nextTick } from "vue";
import { modelLabelFor } from "../accounts/providerCatalog";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { resetChat, useChat } from "../run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import ChatTabList from "./ChatTabList.vue";
import { IconStub } from "@intentic/ui/testing";

// Same globals a mounted chat needs as chatTabsReveal.test.ts: matchMedia, window.env, scrollIntoView.
hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
});

let app: App | undefined;
let host: HTMLElement | undefined;
const mountList = async (): Promise<void> => {
    host = document.createElement(`div`);
    document.body.appendChild(host);
    app = createApp({ render: () => h(ChatTabList) });
    app.component(`Icon`, IconStub);
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
    // Registered, so the join treats it as an agent merely off the roster, not a draft.
    conversation.registered.value = true;
    conversation.title.value = `Detached intentic chat · fix`;
    conversation.model.value = `claude-opus-4-5`;
    // Cost is read off the rows: each turn's usage sits on the bubble its answer ended in.
    conversation.restoreMessages([{ role: `assistant`, text: `done`, usage: { costUsd: 7.02 } }]);

    await mountList();

    const card = host!.querySelector(`[data-chat-tab]`);
    expect(card?.textContent).toContain(`Detached intentic chat · fix`);
    expect(card?.textContent).toContain(modelLabelFor(`claude`, `claude-opus-4-5`));
    // No spend from either half of the join: that's the board's fact, not the switcher's.
    expect(card?.textContent).not.toContain(`$7.02`);
});

it(`asks the daemon for the archive when an open chat is off the roster`, async () => {
    const chat = useChat();
    chat.active.value.registered.value = true;
    mocked(sandboxJson).mockClear();

    await mountList();

    expect(mocked(sandboxJson).mock.calls.some(([path]) => path === `/agents/archived`)).toBe(true);
});

it(`prints no spend at all, so a restored chat cannot print a zero`, async () => {
    const chat = useChat();
    const conversation = chat.active.value;
    conversation.registered.value = true;
    conversation.title.value = `Pipeline triggers · implement`;

    await mountList();

    expect(host!.querySelector(`[data-chat-tab]`)?.textContent).not.toContain(`$0`);
});
