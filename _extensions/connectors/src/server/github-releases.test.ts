import { checkGithubRelease, githubApi } from "./github-releases.js";
import type { CheckFetch } from "./watch-http.js";

// The GitHub release watch kind against canned answers, and how it finds its way in: a connected card's gateway address
// handed with the check, else the owner's token, else none. Moved with its client from the daemon (2026-11-26).

const answering =
    (routes: Record<string, { readonly status?: number; readonly body: unknown }>, asked: string[] = []): CheckFetch =>
    async (url) => {
        asked.push(url);
        const route = routes[url];
        return route === undefined
            ? new Response("not found", { status: 404 })
            : new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
    };

const NONE = { reach: {}, env: {} };
const RELEASES = "https://api.github.com/repos/oven-sh/bun/releases?per_page=20";

test("it reads the newest full release, by its tag and name, skipping prereleases unless asked", async () => {
    const releases = [
        { tag_name: "bun-v1.4.3-canary", prerelease: true, html_url: "https://github.com/oven-sh/bun/releases/tag/c" },
        { tag_name: "bun-v1.4.2", name: "Bun v1.4.2", html_url: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2" },
    ];
    const fetch = answering({ [RELEASES]: { body: releases } });
    expect(await checkGithubRelease({ repo: "oven-sh/bun" }, fetch, NONE)).toEqual({
        pass: true,
        output: "bun-v1.4.2 (Bun v1.4.2)\nhttps://github.com/oven-sh/bun/releases/tag/bun-v1.4.2",
    });
    expect(await checkGithubRelease({ repo: "oven-sh/bun", prereleases: true }, fetch, NONE)).toEqual({
        pass: true,
        output: "bun-v1.4.3-canary\nhttps://github.com/oven-sh/bun/releases/tag/c",
    });
});

test("a request carries the owner's token when one is set and no card is connected", async () => {
    let authorization: string | null = "never asked";
    const fetch: CheckFetch = async (_url, init) => {
        authorization = new Headers(init.headers).get("authorization");
        return new Response("[]", { status: 200 });
    };
    expect(await checkGithubRelease({ repo: "a/b" }, fetch, { reach: {}, env: { GITHUB_TOKEN: "t0ken" } })).toEqual({ pass: false, detail: "a/b has published no full release yet" });
    expect(authorization).toBe("Bearer t0ken");
});

test("a connected GitHub card's gateway address answers before the open API, carrying no token of its own", async () => {
    const asked: string[] = [];
    const fetch = answering({ "http://127.0.0.1:8790/gh/repos/oven-sh/bun/releases?per_page=20": { body: [{ tag_name: "bun-v1.4.2" }] } }, asked);
    expect(await checkGithubRelease({ repo: "oven-sh/bun" }, fetch, { reach: { GITHUB_API_URL_GITHUB: "http://127.0.0.1:8790/gh/" }, env: { GITHUB_TOKEN: "unused" } })).toEqual({
        pass: true,
        output: "bun-v1.4.2",
    });
    expect(asked).toEqual(["http://127.0.0.1:8790/gh/repos/oven-sh/bun/releases?per_page=20"]);
    expect(githubApi({ reach: { GITHUB_API_URL_WORK: "http://127.0.0.1:1/b", GITHUB_API_URL_HOME: "http://127.0.0.1:1/a/" }, env: {} })).toEqual({ base: "http://127.0.0.1:1/a", headers: {} });
});

test.each([
    { status: 403, detail: "GitHub answered 403 (likely its hourly limit for requests without a token)" },
    { status: 404, detail: "GitHub has no repository oven-sh/bun this sandbox can see" },
    { status: 500, detail: "GitHub answered 500" },
])("an HTTP $status is a check that did not pass", async ({ status, detail }) => {
    expect(await checkGithubRelease({ repo: "oven-sh/bun" }, answering({ [RELEASES]: { status, body: {} } }), NONE)).toEqual({ pass: false, detail });
});

test("a repository not named as owner/name is said before anything is asked", async () => {
    const asked: string[] = [];
    expect(await checkGithubRelease({ repo: "bun" }, answering({}, asked), NONE)).toEqual({ pass: false, detail: "a GitHub release watch names a repository as owner/name" });
    expect(asked).toEqual([]);
});
