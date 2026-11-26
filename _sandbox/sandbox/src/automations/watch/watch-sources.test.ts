import { checkUrlSource, pageText, sourceProblem, type SourceFetch } from "./watch-sources.js";
import { streamedResponse } from "../../http/fetch.testing.js";

// The daemon's own ready-made check, a page, against canned answers: what it asks for, what it saw, and what it says while
// waiting. The npm and GitHub release checks moved with their clients to the connectors extension (2026-11-26).

const answering =
    (routes: Record<string, { readonly status?: number; readonly body: unknown; readonly type?: string }>, asked: string[] = []): SourceFetch =>
    async (url) => {
        asked.push(url);
        const route = routes[url];
        if (route === undefined) {
            return new Response("not found", { status: 404 });
        }
        const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
        return new Response(text, { status: route.status ?? 200, headers: { "content-type": route.type ?? "application/json" } });
    };

test("a page is watched by its words, or by what a pattern picks out of it", async () => {
    const html = `<html><head><style>p{}</style><script>var nonce="x1"</script></head><body><h1>Status</h1><p>All&nbsp;systems <b>go</b></p><span id="v">v2.3</span></body></html>`;
    const fetch = answering({ "https://example.com/status": { body: html, type: "text/html; charset=utf-8" } });
    expect(await checkUrlSource({ kind: "url", url: "https://example.com/status" }, { fetch })).toEqual({
        pass: true,
        output: "Status All systems go v2.3",
    });
    expect(await checkUrlSource({ kind: "url", url: "https://example.com/status", select: '<span id="v">([^<]+)</span>' }, { fetch })).toEqual({
        pass: true,
        output: "v2.3",
    });
    expect(await checkUrlSource({ kind: "url", url: "https://example.com/status", select: "nowhere" }, { fetch })).toEqual({
        pass: false,
        detail: "nothing on the page matches nowhere",
    });
});

test("a network failure is a check that did not pass, said as such", async () => {
    const fetch: SourceFetch = async () => {
        throw new Error("connect ECONNREFUSED");
    };
    expect(await checkUrlSource({ kind: "url", url: "https://status.example.com/" }, { fetch })).toEqual({
        pass: false,
        detail: "could not reach status.example.com: connect ECONNREFUSED",
    });
});

test("a watched page stops downloading at its cap, including a chunked answer with no length", async () => {
    const { response, pulled } = streamedResponse(32, 1_000_000);
    const checked = await checkUrlSource({ kind: "url", url: "https://example.com/large" }, { fetch: async () => response });
    expect(checked).toEqual({ pass: true, output: "a".repeat(2_000_000) });
    expect(pulled.cancelled).toBe(true);
    expect(pulled.count).toBeLessThanOrEqual(4);
});

test.each([
    { source: { kind: "url" as const, url: "https://example.com/" }, status: 503, detail: "the page answered 503" },
    { source: { kind: "url" as const, url: "https://example.com/gone" }, status: 404, detail: "the page answered 404" },
])("an unread HTTP $status watch refusal releases its response body", async ({ source, status, detail }) => {
    const { response, pulled } = streamedResponse(32, 100_000, 0x61, { status });
    expect(await checkUrlSource(source, { fetch: async () => response })).toEqual({ pass: false, detail });
    expect(pulled.cancelled).toBe(true);
    expect(pulled.count).toBeLessThanOrEqual(1);
});

test("the problems upsert refuses, and a page's words", () => {
    expect(sourceProblem({ kind: "url", url: "https://x.dev", select: "(" })).toContain("does not compile");
    expect(sourceProblem({ kind: "url", url: "ftp://x.dev" })).toBe("a watched page must be an http or https address");
    expect(sourceProblem({ kind: "url", url: "https://x.dev", select: "v(\\d+)" })).toBeUndefined();
    expect(pageText("<p>a</p>\n\n<p>b &amp; c</p>")).toBe("a b & c");
});

test("a select pattern that backtracks without end on the page is stopped, rather than freezing the daemon", async () => {
    // `(a+)+$` against a run of a's that ends in something else takes exponential time on V8, the daemon's engine: 40 of
    // them is hours. Bun's own engine gives up by itself and answers "no match", so here only the bound is portable;
    // under Node the answer is the deadline's.
    const fetch = answering({ "https://status.example.com/": { body: `${"a".repeat(40)}!`, type: "text/plain" } });
    const started = Date.now();
    const checked = await checkUrlSource({ kind: "url", url: "https://status.example.com/", select: "(a+)+$" }, { fetch });
    expect(checked.pass).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
});
