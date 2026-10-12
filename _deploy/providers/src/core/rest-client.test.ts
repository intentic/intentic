import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { restClient, vendorRequest } from "./rest-client.js";

// A Cloudflare edge page as the tunnel answers it when the host's connector is down: the code sits far past the start
// of the page, beyond any excerpt of it.
const edgePage = `<!DOCTYPE html><html><head><title>Cloudflare Tunnel error | example.com | Cloudflare</title></head><body>${"<p>filler</p>".repeat(80)}<script>window.__CF$cv$params={errorCode: 1033}</script></body></html>`;

afterEach(() => {
    unstubAllGlobals();
});

describe("vendorRequest", () => {
    it("names a Cloudflare edge page in a refusal by its code instead of quoting the page", async () => {
        stubGlobal("fetch", async () => new Response(edgePage, { status: 530 }));
        await expect(vendorRequest("https://git.example.com/api/v1/user", { label: "Forgejo API GET /user" })).rejects.toThrow(
            "Forgejo API GET /user failed (HTTP 530): Cloudflare edge error 1033: the tunnel has no connected connector",
        );
    });

    it("keeps an accepted refusal's body to read", async () => {
        stubGlobal("fetch", async () => new Response(JSON.stringify({ retry_after: 2 }), { status: 429 }));
        const response = await vendorRequest("https://discord.com/api/v10/guilds", { accept: [429] });
        expect(response).toMatchObject({ status: 429, json: { retry_after: 2 } });
    });

    it("names the call when the host could not be reached, instead of a bare transport error", async () => {
        stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
        await expect(vendorRequest("https://deploy.example.com/read", { label: "Komodo read/ListServers" })).rejects.toThrow(
            "Komodo read/ListServers could not be reached: fetch failed",
        );
    });
});

describe("restClient", () => {
    const { json, maybe } = restClient("GitHub");

    it("answers a 404 as absent and anything else as the body", async () => {
        stubGlobal("fetch", async (url: string) => (url.endsWith("/missing") ? new Response("", { status: 404 }) : new Response(JSON.stringify({ id: 1 }))));
        expect(await maybe("https://api.github.com/missing")).toBeUndefined();
        expect(await (await maybe("https://api.github.com/there"))?.json()).toEqual({ id: 1 });
        expect(await json("https://api.github.com/there")).toEqual({ id: 1 });
    });

    it("keeps its refusal message shape, with the body cut to one bounded line", async () => {
        stubGlobal("fetch", async () => new Response(`${"x".repeat(1000)}`, { status: 422 }));
        const failure = await json("https://api.github.com/user/repos", { method: "POST", body: "{}" }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toBe(`Error: GitHub API POST https://api.github.com/user/repos: 422 ${"x".repeat(300)}…`);
    });
});
