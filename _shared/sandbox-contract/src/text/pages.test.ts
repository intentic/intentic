import type { AgentEvent } from "../events/agent-events.js";
import type { Page } from "../events/requests.js";
import { settledRequests } from "../policy/request-status.js";
import {
    intoHead,
    mcpAppDataScript,
    PAGE_FALLBACK_THEMES,
    PAGE_THEME_VARIABLES,
    pageThemeCss,
    publishedPage,
    readMcpAppData,
    sealedPage,
    SEALED_PAGE_POLICY,
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
