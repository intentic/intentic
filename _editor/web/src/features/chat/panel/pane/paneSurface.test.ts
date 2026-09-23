import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import type { Router } from "vue-router";
import { Conversation } from "../../session/conversation";

// Pins what a pane's tool cards are handed: the picture a turn's strip holds opens in the pane's own viewer and any
// other as the file, in the chat's own checkout; the terminal and browser are the chat's; a route goes to the app.

const openWorkspaceRef = jest.fn<(path: string, line?: number, asked?: { readonly agent: string | undefined }) => Promise<void>>(
    async () => undefined,
);
jest.mock("../../../workspace/files/openFileRef", () => ({ openWorkspaceRef, openFileRefFromEvent: jest.fn() }));
const { paneSurface, viewingIn } = await import("./paneSurface");

const push = jest.fn<(to: string) => Promise<undefined>>(async () => undefined);
const router = unstubbed<Router>(`router`, { resolve: ((to: string) => ({ fullPath: to })) as unknown as Router[`resolve`], push });

it(`opens a picture a turn's strip holds in the pane's viewer, and any other as the file in the chat's checkout`, () => {
    const chat = new Conversation(`c1`);
    const viewCall = jest.fn<(toolId: string, path: string) => boolean>((toolId) => toolId === `t1`);
    const surface = viewingIn(
        paneSurface(() => chat, router),
        { viewCall },
    );

    surface.viewPicture?.(`t1`, `${STATE_DIR}/shots/home.png`);
    expect(openWorkspaceRef).not.toHaveBeenCalled();

    surface.viewPicture?.(`t2`, `docs/diagram.png`);
    chat.isolated.value = false;
    surface.viewPicture?.(`t2`, `docs/diagram.png`);
    expect(openWorkspaceRef.mock.calls).toEqual([
        [`docs/diagram.png`, undefined, { agent: `c1` }],
        [`docs/diagram.png`, undefined, { agent: undefined }],
    ]);
});

it(`hands a card the chat's own terminal and browser, and a route to the app's window`, () => {
    const chat = new Conversation(`c1`);
    chat.agentTerminal.value = `agent-s1`;
    chat.agentBrowser.value = `browser-s1`;
    const surface = paneSurface(() => chat, router);

    expect([surface.commandTerminal?.(), surface.commandBrowser?.()]).toEqual([`agent-s1`, `browser-s1`]);
    surface.watchBrowser?.(`browser-s1`);
    expect(push.mock.calls).toEqual([[`/browsers/browser-s1`]]);
});
