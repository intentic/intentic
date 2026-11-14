// What a page in the chat may say to the window around it, read where it arrives: the two dialects (the sealed
// document's link guide, the page bridge's JSON-RPC) become a handful of asks, and everything else is nothing.
import { PAGE_BRIDGE, PAGE_ERROR_CHARS, PAGE_FALLBACK_THEMES, PAGE_PICTURES_MAX } from "@intentic/sandbox-contract/text/pages";
import { PAGE_VALUE_MAX } from "@intentic/sandbox-contract/events/requests";
import { withPageDraft } from "../../../../models/conversations/session/turnLiveState";
import { initializeResult, readPageAsk, themeMessage } from "./pageBridge";

const rpc = (method: string, params: unknown, id?: string | number) => ({ jsonrpc: `2.0`, method, params, ...(id === undefined ? {} : { id }) });

describe(`readPageAsk`, () => {
    it(`reads the notices that carry only their name: the handshake's end, and a player that failed`, () => {
        expect(readPageAsk(rpc(PAGE_BRIDGE.initialized, {}))).toEqual({ kind: `initialized` });
        expect(readPageAsk(rpc(PAGE_BRIDGE.mediaError, {}))).toEqual({ kind: `mediaError` });
        expect(readPageAsk(rpc(`intentic/unknown`, {}))).toBeUndefined();
    });

    it(`reads the link guide's asks: a workspace file, an address, and nothing for the pointer`, () => {
        expect(readPageAsk({ intenticHtmlPreview: { open: `docs/a.md` } })).toEqual({ kind: `openFile`, path: `docs/a.md` });
        expect(readPageAsk({ intenticHtmlPreview: { href: `https://example.com` } })).toEqual({ kind: `openLink`, id: undefined, url: `https://example.com` });
        expect(readPageAsk({ intenticHtmlPreview: { pointer: true } })).toBeUndefined();
        // A path that climbs out of the workspace is not an ask at all.
        expect(readPageAsk({ intenticHtmlPreview: { open: `../etc/passwd` } })).toBeUndefined();
    });

    it(`reads the bridge's size, handshake, link, message and answer`, () => {
        expect(readPageAsk(rpc(PAGE_BRIDGE.sizeChanged, { height: 412.5 }))).toEqual({ kind: `size`, height: 412.5 });
        expect(readPageAsk(rpc(PAGE_BRIDGE.initialize, {}, 1))).toEqual({ kind: `initialize`, id: 1 });
        expect(readPageAsk(rpc(PAGE_BRIDGE.openLink, { url: `https://x.dev` }, `a`))).toEqual({ kind: `openLink`, id: `a`, url: `https://x.dev` });
        expect(readPageAsk(rpc(PAGE_BRIDGE.message, { role: `user`, content: [{ type: `text`, text: `Build B` }] }, 2))).toEqual({
            kind: `message`,
            id: 2,
            text: `Build B`,
        });
        expect(readPageAsk(rpc(PAGE_BRIDGE.submit, { value: { pick: `B`, sizes: [1, 2] } }, 3))).toEqual({ kind: `submit`, id: 3, value: `{"pick":"B","sizes":[1,2]}` });
    });

    it(`reads what the page's scripts threw, trimmed and cut to the cap, and nothing for an empty one`, () => {
        expect(readPageAsk(rpc(PAGE_BRIDGE.error, { message: ` TypeError: x is undefined at draw (about:srcdoc:12:3) ` }))).toEqual({
            kind: `error`,
            message: `TypeError: x is undefined at draw (about:srcdoc:12:3)`,
        });
        const long = readPageAsk(rpc(PAGE_BRIDGE.error, { message: `e`.repeat(PAGE_ERROR_CHARS * 2) }));
        expect(long?.kind === `error` && long.message.length).toBe(PAGE_ERROR_CHARS);
        expect(readPageAsk(rpc(PAGE_BRIDGE.error, { message: `  ` }))).toBeUndefined();
        expect(readPageAsk(rpc(PAGE_BRIDGE.error, { message: 42 }))).toBeUndefined();
    });

    it(`refuses what a page has no business asking: another scheme, an empty message, an answer too large to be one`, () => {
        expect(readPageAsk(rpc(PAGE_BRIDGE.openLink, { url: `javascript:alert(1)` }, 1))).toBeUndefined();
        expect(readPageAsk(rpc(PAGE_BRIDGE.message, { content: [{ type: `image`, data: `` }] }, 1))).toBeUndefined();
        expect(readPageAsk(rpc(PAGE_BRIDGE.submit, { value: `x`.repeat(PAGE_VALUE_MAX + 1) }, 4))).toEqual({ kind: `oversize`, id: 4 });
        // A tool call is an ask (the frame decides whether the page is an app that may make one); one without a name is not.
        expect(readPageAsk(rpc(`tools/call`, { name: `zoom`, arguments: { level: 3 } }, 5))).toEqual({ kind: `toolCall`, id: 5, name: `zoom`, arguments: { level: 3 } });
        expect(readPageAsk(rpc(`tools/call`, {}, 6))).toBeUndefined();
        expect(readPageAsk(`not even an object`)).toBeUndefined();
        // A request that cannot be answered is no request.
        expect(readPageAsk(rpc(PAGE_BRIDGE.submit, { value: 1 }))).toBeUndefined();
    });

    it(`reads the picture the pointer rests on, and its leaving as no picture`, () => {
        const src = `data:image/png;base64,iVBORw0KGgo=`;
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureLook, { src, alt: ` Before `, left: 10, top: -4, width: 320, height: 180, aspect: 16 / 9 }))).toEqual({
            kind: `pictureLook`,
            picture: { src, alt: `Before`, rect: { left: 10, top: -4, width: 320, height: 180 }, aspect: 16 / 9 },
        });
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureLook, {}))).toEqual({ kind: `pictureLook`, picture: undefined });
        // Only a picture's own data is ever shown outside the page: an address or a script reads as the pointer leaving.
        for (const other of [`https://example.com/a.png`, `javascript:alert(1)`, `data:text/html,<script>`, `blob:null/1`]) {
            expect(readPageAsk(rpc(PAGE_BRIDGE.pictureLook, { src: other, left: 0, top: 0, width: 1, height: 1, aspect: 1 }))).toEqual({
                kind: `pictureLook`,
                picture: undefined,
            });
        }
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureLook, { src, left: 0, top: 0, width: 0, height: 1, aspect: 1 }))).toEqual({ kind: `pictureLook`, picture: undefined });
    });

    it(`reads a press on a picture as every picture on the page, landing on the pressed one past any that is none`, () => {
        const a = `data:image/png;base64,AAAA`;
        const b = `data:image/svg+xml,%3Csvg%3E`;
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureOpen, { pictures: [{ src: a, alt: `before` }, { src: `https://x.dev/a.png` }, { src: b }], index: 2 }))).toEqual({
            kind: `pictureOpen`,
            pictures: [
                { src: a, alt: `before` },
                { src: b, alt: `` },
            ],
            index: 1,
        });
        // A press that is not on a picture opens nothing, nor does a list past the cap.
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureOpen, { pictures: [{ src: a }, { src: `https://x.dev/a.png` }], index: 1 }))).toBeUndefined();
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureOpen, { pictures: [{ src: a }], index: 3 }))).toBeUndefined();
        expect(readPageAsk(rpc(PAGE_BRIDGE.pictureOpen, { pictures: Array.from({ length: PAGE_PICTURES_MAX + 1 }, () => ({ src: a })), index: 0 }))).toBeUndefined();
    });

    it(`answers the handshake with the theme, and says a theme change in the same words`, () => {
        const theme = PAGE_FALLBACK_THEMES.dark;
        expect(initializeResult(theme).hostContext).toMatchObject(themeMessage(theme).params);
        // An MCP server's app is told which call it shows, and that it may call its server.
        expect(initializeResult(theme, `show_map`)).toMatchObject({ hostCapabilities: { serverTools: {} }, hostContext: { toolInfo: { tool: { name: `show_map` } } } });
        expect(initializeResult(theme)).not.toHaveProperty(`hostContext.toolInfo`);
        expect(themeMessage(theme).params.styles.variables[`--foreground`]).toBe(theme.variables[`--foreground`]);
    });
});

describe(`withPageDraft`, () => {
    const fact = (at: number, text: string, extra: { title?: string; done?: boolean } = {}) => ({ kind: `page_draft` as const, callId: `c1`, at, text, ...extra });

    it(`extends a draft stretch by stretch, and lets it go when it is done`, () => {
        let drafts = withPageDraft(new Map(), fact(0, `<div>`, { title: `Chart` }));
        drafts = withPageDraft(drafts, fact(5, `hi`));
        expect(drafts.get(`c1`)).toEqual({ html: `<div>hi`, title: `Chart` });
        expect(withPageDraft(drafts, fact(0, ``, { done: true })).size).toBe(0);
    });

    it(`rewrites from where a replay starts, and waits rather than drawing a gap past the end`, () => {
        const drafts = withPageDraft(new Map(), fact(0, `<div>hi`));
        expect(withPageDraft(drafts, fact(5, `yo`)).get(`c1`)?.html).toBe(`<div>yo`);
        expect(withPageDraft(drafts, fact(40, `later`)).get(`c1`)?.html).toBe(`<div>hi`);
    });
});
