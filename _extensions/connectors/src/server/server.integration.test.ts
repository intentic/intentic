import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import { manifest } from "../manifest.js";
import * as server from "./server.js";

// The backend as the host activates it, on the SDK's fake daemon: it serves the checks of the two watch kinds its
// manifest declares, and a stored watch's parameters reach the client that answers them. It reaches no daemon route.

let extension: FakeExtension | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
    globalThis.fetch = realFetch;
    await extension?.deactivate();
    await extension?.dispose();
    extension = undefined;
});

// Every request the backend sends, answered from `routes`.
const answering = (routes: Record<string, unknown>, asked: string[]): void => {
    // SAFETY: the backend only ever calls fetch(url, init), which this answers; `preconnect` is never reached.
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        asked.push(url);
        const body = routes[url];
        return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
    }) as typeof fetch;
};

test("it serves the npm and GitHub release checks its manifest declares, each from the parameters a watch stored", async () => {
    extension = await fakeExtensionApi({ manifest });
    await extension.activate(server);
    const asked: string[] = [];
    answering(
        {
            "https://registry.npmjs.org/bun": { "dist-tags": { latest: "1.4.3" }, versions: { "1.4.3": {} } },
            "http://127.0.0.1:8790/gh/repos/oven-sh/bun/releases?per_page=20": [{ tag_name: "bun-v1.4.3" }],
        },
        asked,
    );
    expect(await extension.check("npm", { params: { package: "bun", range: ">=1.4.3" } })).toEqual({ pass: true, output: "bun@1.4.3" });
    expect(await extension.check("github-release", { params: { repo: "oven-sh/bun" }, reach: { GITHUB_API_URL_GITHUB: "http://127.0.0.1:8790/gh" } })).toEqual({
        pass: true,
        output: "bun-v1.4.3",
    });
    expect(asked).toEqual(["https://registry.npmjs.org/bun", "http://127.0.0.1:8790/gh/repos/oven-sh/bun/releases?per_page=20"]);
    expect(extension.calls).toEqual([]);
});

test("once deactivated it serves neither check", async () => {
    extension = await fakeExtensionApi({ manifest });
    await extension.activate(server);
    await extension.deactivate();
    await expect(extension.check("npm", { params: { package: "bun" } })).rejects.toThrow(`serves no "npm" watch kind`);
});
