import { checkSource, pageText, sourceLabel, sourceProblem, type SourceFetch } from "./watch-sources.js";

// The ready-made checks against canned answers: what each asks for, what it saw, and what it says while waiting.

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

const BUN = { "dist-tags": { latest: "1.4.2", canary: "1.4.3-canary.1" }, versions: { "1.4.1": {}, "1.4.2": {}, "1.4.3-canary.1": {} } };

test("npm with a range waits, naming the latest, until a full release satisfies it", async () => {
    const fetch = answering({ "https://registry.npmjs.org/bun": { body: BUN } });
    expect(await checkSource({ kind: "npm", package: "bun", range: ">=1.4.3" }, { fetch, env: {} })).toEqual({
        pass: false,
        detail: "no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)",
    });
    const shipped = answering({ "https://registry.npmjs.org/bun": { body: { ...BUN, versions: { ...BUN.versions, "1.4.3": {} } } } });
    expect(await checkSource({ kind: "npm", package: "bun", range: ">=1.4.3" }, { fetch: shipped, env: {} })).toEqual({
        pass: true,
        output: "bun@1.4.3",
    });
});

test("npm without a range reads a dist-tag, and a scoped name keeps its @ and escapes its slash", async () => {
    const asked: string[] = [];
    const fetch = answering({ "https://registry.npmjs.org/@scope%2Fpkg": { body: BUN } }, asked);
    expect(await checkSource({ kind: "npm", package: "@scope/pkg", tag: "canary" }, { fetch, env: {} })).toEqual({
        pass: true,
        output: "@scope/pkg@1.4.3-canary.1",
    });
    expect(asked).toEqual(["https://registry.npmjs.org/@scope%2Fpkg"]);
    expect(await checkSource({ kind: "npm", package: "nope" }, { fetch, env: {} })).toEqual({ pass: false, detail: "npm has no package named nope" });
});

test("a GitHub release check reads the newest full release, by its tag and name, skipping prereleases unless asked", async () => {
    const releases = [
        { tag_name: "bun-v1.4.3-canary", prerelease: true, html_url: "https://github.com/oven-sh/bun/releases/tag/c" },
        { tag_name: "bun-v1.4.2", name: "Bun v1.4.2", html_url: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2" },
    ];
    const fetch = answering({ "https://api.github.com/repos/oven-sh/bun/releases?per_page=20": { body: releases } });
    expect(await checkSource({ kind: "github-release", repo: "oven-sh/bun" }, { fetch, env: {} })).toEqual({
        pass: true,
        output: "bun-v1.4.2 (Bun v1.4.2)\nhttps://github.com/oven-sh/bun/releases/tag/bun-v1.4.2",
    });
    expect(await checkSource({ kind: "github-release", repo: "oven-sh/bun", prereleases: true }, { fetch, env: {} })).toEqual({
        pass: true,
        output: "bun-v1.4.3-canary\nhttps://github.com/oven-sh/bun/releases/tag/c",
    });
});

test("a GitHub request carries the owner's token when one is set", async () => {
    let authorization = null as string | null;
    const fetch: SourceFetch = async (_url, init) => {
        authorization = new Headers(init.headers).get("authorization");
        return new Response("[]", { status: 200 });
    };
    expect(await checkSource({ kind: "github-release", repo: "a/b" }, { fetch, env: { GITHUB_TOKEN: "t0ken" } })).toEqual({
        pass: false,
        detail: "a/b has published no full release yet",
    });
    expect(authorization).toBe("Bearer t0ken");
});

test("a page is watched by its words, or by what a pattern picks out of it", async () => {
    const html = `<html><head><style>p{}</style><script>var nonce="x1"</script></head><body><h1>Status</h1><p>All&nbsp;systems <b>go</b></p><span id="v">v2.3</span></body></html>`;
    const fetch = answering({ "https://example.com/status": { body: html, type: "text/html; charset=utf-8" } });
    expect(await checkSource({ kind: "url", url: "https://example.com/status" }, { fetch, env: {} })).toEqual({
        pass: true,
        output: "Status All systems go v2.3",
    });
    expect(await checkSource({ kind: "url", url: "https://example.com/status", select: '<span id="v">([^<]+)</span>' }, { fetch, env: {} })).toEqual({
        pass: true,
        output: "v2.3",
    });
    expect(await checkSource({ kind: "url", url: "https://example.com/status", select: "nowhere" }, { fetch, env: {} })).toEqual({
        pass: false,
        detail: "nothing on the page matches nowhere",
    });
});

test("a network failure is a check that did not pass, said as such", async () => {
    const fetch: SourceFetch = async () => {
        throw new Error("connect ECONNREFUSED");
    };
    expect(await checkSource({ kind: "npm", package: "bun" }, { fetch, env: {} })).toEqual({
        pass: false,
        detail: "could not reach registry.npmjs.org: connect ECONNREFUSED",
    });
});

test("labels and the problems upsert refuses", () => {
    expect(sourceLabel({ kind: "npm", package: "bun", range: ">=1.4.3" })).toBe("npm bun@>=1.4.3");
    expect(sourceProblem({ kind: "npm", package: "bun", range: "soon" })).toContain("not a semver range");
    expect(sourceProblem({ kind: "url", url: "https://x.dev", select: "(" })).toContain("does not compile");
    expect(sourceProblem({ kind: "npm", package: "bun", range: ">=1.4.3" })).toBeUndefined();
    expect(pageText("<p>a</p>\n\n<p>b &amp; c</p>")).toBe("a b & c");
});

test("a connected GitHub card's credential gateway answers a releases check before the open API does", async () => {
    const asked: string[] = [];
    const fetch = answering({ "http://127.0.0.1:8790/gh/repos/oven-sh/bun/releases?per_page=20": { body: [{ tag_name: "bun-v1.4.2" }] } }, asked);
    expect(
        await checkSource(
            { kind: "github-release", repo: "oven-sh/bun" },
            { fetch, env: { GITHUB_API_URL_GITHUB: "http://127.0.0.1:8790/gh/", GITHUB_TOKEN: "unused" } },
        ),
    ).toEqual({
        pass: true,
        output: "bun-v1.4.2",
    });
    expect(asked).toEqual(["http://127.0.0.1:8790/gh/repos/oven-sh/bun/releases?per_page=20"]);
});

test("a select pattern that backtracks without end on the page is stopped, rather than freezing the daemon", async () => {
    // `(a+)+$` against a run of a's that ends in something else takes exponential time on V8, the daemon's engine: 40 of
    // them is hours. Bun's own engine gives up by itself and answers "no match", so here only the bound is portable;
    // under Node the answer is the deadline's.
    const fetch = answering({ "https://status.example.com/": { body: `${"a".repeat(40)}!`, type: "text/plain" } });
    const started = Date.now();
    const checked = await checkSource({ kind: "url", url: "https://status.example.com/", select: "(a+)+$" }, { fetch, env: {} });
    expect(checked.pass).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
});
