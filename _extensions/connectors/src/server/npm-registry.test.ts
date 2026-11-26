import { checkNpm } from "./npm-registry.js";
import type { CheckFetch } from "./watch-http.js";

// The npm watch kind against canned registry answers: what it asks for, what it saw, and what it says while waiting.
// Moved with its client from the daemon's watch-sources.test.ts (2026-11-26).

const answering =
    (routes: Record<string, { readonly status?: number; readonly body: unknown }>, asked: string[] = []): CheckFetch =>
    async (url) => {
        asked.push(url);
        const route = routes[url];
        return route === undefined
            ? new Response("not found", { status: 404 })
            : new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
    };

const BUN = { "dist-tags": { latest: "1.4.2", canary: "1.4.3-canary.1" }, versions: { "1.4.1": {}, "1.4.2": {}, "1.4.3-canary.1": {} } };

test("with a range it waits, naming the latest, until a full release satisfies it", async () => {
    const fetch = answering({ "https://registry.npmjs.org/bun": { body: BUN } });
    expect(await checkNpm({ package: "bun", range: ">=1.4.3" }, fetch)).toEqual({ pass: false, detail: "no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)" });
    const shipped = answering({ "https://registry.npmjs.org/bun": { body: { ...BUN, versions: { ...BUN.versions, "1.4.3": {} } } } });
    expect(await checkNpm({ package: "bun", range: ">=1.4.3" }, shipped)).toEqual({ pass: true, output: "bun@1.4.3" });
});

test("without a range it reads a dist-tag, and a scoped name keeps its @ and escapes its slash", async () => {
    const asked: string[] = [];
    const fetch = answering({ "https://registry.npmjs.org/@scope%2Fpkg": { body: BUN } }, asked);
    expect(await checkNpm({ package: "@scope/pkg", tag: "canary" }, fetch)).toEqual({ pass: true, output: "@scope/pkg@1.4.3-canary.1" });
    expect(await checkNpm({ package: "@scope/pkg" }, fetch)).toEqual({ pass: true, output: "@scope/pkg@1.4.2" });
    expect(await checkNpm({ package: "@scope/pkg", tag: "beta" }, fetch)).toEqual({ pass: false, detail: '@scope/pkg has no "beta" tag' });
    expect(asked[0]).toBe("https://registry.npmjs.org/@scope%2Fpkg");
    expect(await checkNpm({ package: "nope" }, fetch)).toEqual({ pass: false, detail: "npm has no package named nope" });
});

test("a range semver cannot read is said before anything is asked", async () => {
    const asked: string[] = [];
    expect(await checkNpm({ package: "bun", range: "soon" }, answering({}, asked))).toEqual({
        pass: false,
        detail: '"soon" is not a semver range npm understands, like >=1.4.3 or ^2',
    });
    expect(asked).toEqual([]);
});

test("a network failure, a refusal and a body that is not a package document are checks that did not pass", async () => {
    const down: CheckFetch = async () => {
        throw new Error("connect ECONNREFUSED");
    };
    expect(await checkNpm({ package: "bun" }, down)).toEqual({ pass: false, detail: "could not reach registry.npmjs.org: connect ECONNREFUSED" });
    expect(await checkNpm({ package: "bun" }, answering({ "https://registry.npmjs.org/bun": { status: 503, body: {} } }))).toEqual({
        pass: false,
        detail: "the npm registry answered 503",
    });
    expect(await checkNpm({ package: "bun" }, answering({ "https://registry.npmjs.org/bun": { body: { versions: [1] } } }))).toEqual({
        pass: false,
        detail: "the npm registry answered something other than bun's package document",
    });
    expect(await checkNpm({ range: ">=1" }, answering({}))).toEqual({ pass: false, detail: "an npm watch names a package, and optionally a range or a tag" });
});
