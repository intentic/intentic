import type { AgentEvent } from "../events/agent-events.js";
import type { Page } from "../events/requests.js";
import { settledRequests } from "../policy/request-status.js";
import {
    intoHead,
    mcpAppDataScript,
    PAGE_FALLBACK_THEMES,
    PAGE_THEME_VARIABLES,
    pageMediaScript,
    pageMediaSigned,
    pageThemeCss,
    placePageMedia,
    readPageMedia,
    sealedPagePolicy,
    withoutPageMedia,
    publishedPage,
    readMcpAppData,
    sealedPage,
    SEALED_PAGE_POLICY,
    sizedFirst,
    standalonePage,
} from "./pages.js";
import { foldTurn, userRow } from "./transcript-fold.js";

// path-literals: content, a page's stored path as a transcript row carries it
const PAGE: Page = { id: "a1b2c3d4e5", title: "Q3 revenue", path: ".intentic/records/artifacts/pages/c1/a1b2c3d4e5.r0.html" };

describe("intoHead", () => {
    it("puts markup first inside an existing head", () => {
        expect(intoHead(`<!doctype html><html><head><title>x</title></head><body></body></html>`, `<i>`)).toBe(
            `<!doctype html><html><head><i><title>x</title></head><body></body></html>`,
        );
    });

    it("makes a head inside the html element when the page wrote none", () => {
        expect(intoHead(`<html lang="en"><body>hi</body></html>`, `<i>`)).toBe(`<html lang="en"><head><i></head><body>hi</body></html>`);
    });

    it("makes one after a lone doctype, and for a bare fragment", () => {
        expect(intoHead(`<!DOCTYPE html><p>hi</p>`, `<i>`)).toBe(`<!DOCTYPE html><head><i></head><p>hi</p>`);
        expect(intoHead(`<p>hi</p>`, `<i>`)).toBe(`<!doctype html><head><i></head><p>hi</p>`);
    });

    it("never takes a head written inside a script or comment for the real one", () => {
        const html = `<!-- <head> --><html><head><script>const s = "<head>";</script></head></html>`;
        expect(intoHead(html, `<i>`)).toBe(`<!-- <head> --><html><head><i><script>const s = "<head>";</script></head></html>`);
    });
});

describe("sealedPage", () => {
    it("leads with the policy, then the theme and the bootstrap, before the page's own head", () => {
        const sealed = sealedPage(`<html><head><style>body{color:red}</style></head><body></body></html>`, PAGE_FALLBACK_THEMES.dark);
        const policy = sealed.indexOf(SEALED_PAGE_POLICY);
        const theme = sealed.indexOf(`id="intentic-theme"`);
        const own = sealed.indexOf(`body{color:red}`);
        expect(policy).toBeGreaterThan(-1);
        expect(policy).toBeLessThan(theme);
        expect(theme).toBeLessThan(own);
        expect(sealed).toContain(`window.intentic=`);
    });

    it("keeps the theme's values from ending the rule they sit in", () => {
        const hostile = { ...PAGE_FALLBACK_THEMES.light, variables: { ...PAGE_FALLBACK_THEMES.light.variables, "--foreground": `red;}</style><script>x()` } };
        expect(pageThemeCss(hostile)).not.toContain(`</style>`);
        expect(pageThemeCss(hostile)).toContain(`--foreground:red/stylescriptx();`);
    });

    it("names every theme variable", () => {
        const css = pageThemeCss(PAGE_FALLBACK_THEMES.dark);
        for (const name of PAGE_THEME_VARIABLES) {
            expect(css).toContain(`${name}:`);
        }
    });
});

describe("standalonePage", () => {
    it("carries defaults at no specificity, so the chat's theme and the page's own rules win", () => {
        const stored = standalonePage(`<html><head></head><body>x</body></html>`);
        expect(stored).toContain(`:where(:root){`);
        expect(stored).toContain(`@media (prefers-color-scheme: light)`);
        expect(stored).not.toMatch(/(^|[^(]):root\{/);
        expect(stored).toContain(`if(!window.intentic)`);
    });
});

describe("pages in the fold", () => {
    const fold = (events: readonly AgentEvent[]) => foldTurn([userRow("show me", 1, [])], events).slice(1);

    it("draws a page on the bubble whose call showed it, and starts the next words below", () => {
        const rows = fold([
            { kind: "tool_call", id: "t1", name: "mcp__ui__show_page", category: "other", status: "in_progress" },
            { kind: "page", page: PAGE },
            { kind: "tool_call_update", id: "t1", status: "completed" },
            { kind: "delta", text: "Revenue doubled." },
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0]?.page).toEqual(PAGE);
        expect(rows[0]?.tools?.[0]?.status).toBe("completed");
        expect(rows[1]).toEqual({ role: "assistant", text: "Revenue doubled." });
    });

    it("folds an earlier drawing away when the page is redrawn", () => {
        const redrawn: Page = { ...PAGE, path: PAGE.path.replace(".r0.", ".r1."), revision: 1 };
        const rows = fold([
            { kind: "page", page: PAGE },
            { kind: "delta", text: "Here." },
            { kind: "text_end" },
            { kind: "page", page: redrawn },
        ]);
        expect(rows[0]?.page?.superseded).toBe(true);
        expect(rows.at(-1)?.page).toEqual(redrawn);
    });

    it("parks a page asked on as a card, and settles it with what the page sent", () => {
        const rows = fold([
            { kind: "page_ask", requestId: "r1", page: PAGE },
            { kind: "resolved", requestId: "r1", reply: { kind: "page_ask", requestId: "r1", value: `{"pick":"B"}` } },
        ]);
        expect(rows[0]?.pageAsk).toEqual({ requestId: "r1", page: PAGE, status: "answered", value: `{"pick":"B"}` });
    });

    it("draws nothing for a draft: it is live state, never transcript", () => {
        expect(fold([{ kind: "page_draft", callId: "t1", at: 0, text: "<p>" }])).toEqual([]);
        expect(fold([{ kind: "file_draft", callId: "t2", path: "a.md", op: "write", at: 0, text: "# A" }])).toEqual([]);
    });

    it("reads a dismissal, or a turn that died, as cancelled with no value", () => {
        const card = { pageAsk: { requestId: "r1", page: PAGE, status: "pending" as const } };
        expect(settledRequests(card, { kind: "page_ask", requestId: "r1", cancelled: true }).pageAsk).toEqual({ ...card.pageAsk, status: "cancelled" });
        expect(settledRequests(card, undefined).pageAsk?.status).toBe("cancelled");
    });
});

describe("an MCP app's call, kept inside its page", () => {
    it("reads back exactly what was stored, markup in its values included", () => {
        const data = { server: "maps", tool: "show_map", input: { q: "</script><b>" }, result: { content: [{ type: "text", text: "<i>3</i>" }] } };
        const stored = standalonePage(intoHead(`<html><head></head><body></body></html>`, mcpAppDataScript(data)));
        expect(stored).not.toContain("</script><b>");
        expect(readMcpAppData(stored)).toEqual(data);
        expect(readMcpAppData(`<html></html>`)).toBeUndefined();
    });
});

describe("publishedPage", () => {
    it("seals a stored page off the network and has it say its height to the page around it", () => {
        const published = publishedPage(standalonePage(`<html><head></head><body>x</body></html>`));
        expect(published.indexOf(SEALED_PAGE_POLICY)).toBeLessThan(published.indexOf(`intentic-page-defaults`));
        expect(published).toContain(`ui/notifications/size-changed`);
    });
});

describe("sizedFirst", () => {
    const page = `<!DOCTYPE html><html><head><script>var a = "</script>";</script></head><body>x</body></html>`;
    const shell = sizedFirst(page);

    it("carries the page whole inside one script the page cannot close", () => {
        expect(shell.startsWith(`<!DOCTYPE html><script>`)).toBe(true);
        expect(shell.endsWith(`</script>`)).toBe(true);
        // The only `</` left is the shell's own closing tag: the page's markup cannot end the script early.
        expect(shell.split(`</`).length).toBe(2);
    });

    it("writes back exactly the page it was given", () => {
        const literal = /var page=(".*?"),done=/.exec(shell)?.[1];
        expect(literal).toBeDefined();
        expect(JSON.parse(literal!)).toBe(page);
    });
});

describe("a page's streamed media", () => {
    const TAKE = { path: "/work/shots/take1.mp4", type: "video/mp4", size: 12_000_000, mtimeMs: 1_731_400_000_000.25 };
    const ADDRESS = "https://sandbox.example/pages/media/T0k3n_-x/0";

    it("opens media-src to exactly the addresses named, and nothing else to anything", () => {
        const policy = sealedPagePolicy([ADDRESS]);
        const directives = Object.fromEntries(policy.split("; ").map((directive) => [directive.split(" ")[0], directive]));
        expect(directives["media-src"]).toBe(`media-src data: blob: ${ADDRESS}`);
        expect(directives["default-src"]).toBe(`default-src 'none'`);
        expect(directives["connect-src"]).toBe(`connect-src data: blob:`);
        expect(directives["img-src"]).toBe(`img-src data: blob:`);
        expect(policy.split(ADDRESS).length).toBe(2);
        expect(sealedPagePolicy()).toBe(SEALED_PAGE_POLICY);
        expect(SEALED_PAGE_POLICY).toContain(`media-src data: blob:;`);
    });

    it("leaves out an address that could break out of its source expression", () => {
        const policy = sealedPagePolicy([`https://bad.example/a; script-src *`, `https://bad.example/b c`, `javascript:alert(1)`, ADDRESS]);
        expect(policy).not.toContain(`script-src *`);
        expect(policy).not.toContain(`bad.example`);
        expect(policy).toContain(ADDRESS);
    });

    it("reads back the manifest the daemon wrote, and none the page wrote itself once it is dropped", () => {
        const stored = standalonePage(intoHead(`<video src="intentic-media:0"></video>`, pageMediaScript({ files: [TAKE], signature: `sig` })));
        expect(readPageMedia(stored)).toEqual({ files: [TAKE], signature: `sig` });
        expect(readPageMedia(`<p>no media</p>`)).toBeUndefined();
        const written = `<script type="application/json" id="intentic-page-media"><script type="application/json" id="intentic-page-media">[]</script>`;
        expect(withoutPageMedia(written)).not.toContain(`id="intentic-page-media"`);
    });

    it("publishes a page without its manifest, so a share never carries the sandbox's paths", () => {
        const stored = standalonePage(intoHead(`<video src="intentic-media:0"></video>`, pageMediaScript({ files: [TAKE], signature: `sig` })));
        const published = publishedPage(stored);
        expect(published).not.toContain(TAKE.path);
        expect(readPageMedia(published)).toBeUndefined();
        expect(published).toContain(`<video src="intentic-media:0"></video>`);
    });

    it("signs over the page and every field of every file, so neither can move without the signature failing", () => {
        const signed = pageMediaSigned(`pages/c1/a.r0.html`, [TAKE]);
        expect(pageMediaSigned(`pages/c2/a.r0.html`, [TAKE])).not.toBe(signed);
        expect(pageMediaSigned(`pages/c1/a.r0.html`, [{ ...TAKE, mtimeMs: TAKE.mtimeMs + 1 }])).not.toBe(signed);
        expect(pageMediaSigned(`pages/c1/a.r0.html`, [{ mtimeMs: TAKE.mtimeMs, size: TAKE.size, type: TAKE.type, path: TAKE.path }])).toBe(signed);
    });

    it("swaps each reference the manifest numbers for its address, leaving one past it alone", () => {
        const html = `<video src="intentic-media:0"></video><script>const t=["intentic-media:0","intentic-media:1"]</script>`;
        expect(placePageMedia(html, 1, (index) => `https://s/${index}`)).toBe(`<video src="https://s/0"></video><script>const t=["https://s/0","intentic-media:1"]</script>`);
    });
});
