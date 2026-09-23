import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { hoisted } from "@intentic/testing/bun";
import { afterEach, expect, it, mock } from "bun:test";
import { type App, type ComputedRef, createApp, defineComponent, h, inject } from "vue";
import type { Router } from "vue-router";
import { Conversation } from "../../session/conversation";
import { CHAT_SURFACE, type ChatSurface } from "../../tools/chatToolSurface";

// Pins what a pane's tool cards are handed: the picture a turn's strip holds opens in the pane's own viewer and any
// other as the file, in the chat's own checkout; the terminal and browser are the chat's; a route goes to the app.

const { openWorkspaceRef } = hoisted(() => ({
    openWorkspaceRef: mock<(path: string, line?: number, asked?: { readonly agent: string | undefined }) => Promise<void>>(async () => undefined),
}));
mock.module("../../../workspace/files/openFileRef", () => ({ openWorkspaceRef, openFileRefFromEvent: mock() }));
const { usePaneSurface } = await import("./paneSurface");

let mounted: App | undefined;

// A pane over `conversation`, and what a card inside it injects.
const paneOver = (conversation: Conversation, holds: boolean) => {
    const push = mock<(to: string) => Promise<undefined>>(async () => undefined);
    const router = unstubbed<Router>(`router`, { resolve: ((to: string) => ({ fullPath: to })) as unknown as Router[`resolve`], push });
    const viewer = { viewCall: mock<(toolId: string, path: string) => boolean>(() => holds) };
    const found: { surface?: ChatSurface; pictureScope?: ComputedRef<string | undefined> } = {};
    const Card = defineComponent({
        setup() {
            found.surface = inject(CHAT_SURFACE);
            return () => h(`div`);
        },
    });
    const Pane = defineComponent({
        setup() {
            found.pictureScope = usePaneSurface({ conversation: () => conversation, router, viewer }).pictureScope;
            return () => h(Card);
        },
    });
    mounted = createApp(Pane);
    mounted.mount(document.createElement(`div`));
    return { surface: found.surface!, pictureScope: found.pictureScope!, viewer, push };
};

afterEach(() => {
    mounted?.unmount();
    openWorkspaceRef.mockClear();
});

it(`opens a picture a turn's strip holds in the pane's viewer, and any other as the file in the chat's checkout`, () => {
    const chat = new Conversation(`c1`);

    const held = paneOver(chat, true);
    held.surface.viewPicture?.(`t1`, `${STATE_DIR}/shots/home.png`);
    expect(held.viewer.viewCall.mock.calls).toEqual([[`t1`, `.intentic/shots/home.png`]]);
    expect(openWorkspaceRef).not.toHaveBeenCalled();

    const loose = paneOver(chat, false);
    loose.surface.viewPicture?.(`t2`, `docs/diagram.png`);
    expect(openWorkspaceRef.mock.calls).toEqual([[`docs/diagram.png`, undefined, { agent: `c1` }]]);
});

it(`reads a chat's pictures in its own checkout, and a shared-tree chat's unscoped`, () => {
    const chat = new Conversation(`c1`);
    const pane = paneOver(chat, true);
    expect(pane.pictureScope.value).toBe(`c1`);

    chat.isolated.value = false;
    expect(pane.pictureScope.value).toBeUndefined();
});

it(`hands a card the chat's own terminal and browser, and a route to the app's window`, () => {
    const chat = new Conversation(`c1`);
    chat.agentTerminal.value = `agent-s1`;
    chat.agentBrowser.value = `browser-s1`;
    const pane = paneOver(chat, true);

    expect([pane.surface.commandTerminal?.(), pane.surface.commandBrowser?.()]).toEqual([`agent-s1`, `browser-s1`]);
    pane.surface.watchBrowser?.(`browser-s1`);
    expect(pane.push.mock.calls).toEqual([[`/browsers/browser-s1`]]);
});
