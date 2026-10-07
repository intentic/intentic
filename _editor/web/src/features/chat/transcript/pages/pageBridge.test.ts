// What a page in the chat may say to the window around it, read where it arrives: the two dialects (the sealed
// document's link guide, the page bridge's JSON-RPC) become a handful of asks, and everything else is nothing.
import { PAGE_BRIDGE, PAGE_FALLBACK_THEMES, PAGE_VALUE_MAX } from "@intentic/sandbox-contract";
import { withPageDraft } from "../../session/turnClient";
import { initializeResult, readPageAsk, themeMessage } from "./pageBridge";

const rpc = (method: string, params: unknown, id?: string | number) => ({ jsonrpc: `2.0`, method, params, ...(id === undefined ? {} : { id }) });

describe(`readPageAsk`, () => {
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
