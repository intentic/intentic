import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { streamedResponse } from "../../http/fetch.testing.js";
import { discoverMcpAuth } from "./mcp-discovery.js";
import { tokenRequest } from "./mcp-oauth-client.js";
import { type AddressLookup, isPublicAddress, OAuthFetchRefused, secureOAuthFetch } from "./oauth-fetch.js";

// The guard every OAuth request of an MCP sign-in goes through: a hostile server's metadata must not aim the code, the
// verifier or a refresh token at loopback or the owner's network, a redirect must not carry them off, and no answer is
// read past its cap.

// Stand-in DNS: `mcp.example` and `auth.example` are public, `evil.example` answers with a private address.
const DNS_TABLE = new Map<string, readonly string[]>([
    ["mcp.example", ["93.184.216.34"]],
    ["auth.example", ["93.184.216.35"]],
    ["evil.example", ["93.184.216.36", "10.0.0.5"]],
    ["localhost", ["127.0.0.1"]],
]);
const dns: AddressLookup = async (host) => {
    const found = DNS_TABLE.get(host);
    if (found === undefined) {
        throw new Error(`ENOTFOUND ${host}`);
    }
    return found;
};

interface Sent {
    readonly url: string;
    readonly method: string;
    readonly redirect: RequestRedirect | undefined;
    readonly body: string | undefined;
}

// A transport that answers from a table by URL, recording every request it was handed.
const transport = (answers: Record<string, () => Response>) => {
    const sent: Sent[] = [];
    const send = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
        const url = String(input);
        sent.push({ url, method: init.method ?? "GET", redirect: init.redirect, body: init.body === undefined || init.body === null ? undefined : String(init.body) });
        const answer = answers[url];
        if (answer === undefined) {
            return new Response("not here", { status: 404 });
        }
        return answer();
    };
    return { send, sent };
};

const refusalCode = async (work: Promise<unknown>): Promise<string> => {
    try {
        await work;
    } catch (error) {
        if (error instanceof OAuthFetchRefused) {
            return error.code;
        }
        throw error;
    }
    return "answered";
};

test("public and private addresses are told apart, IPv4 carried in IPv6 included", () => {
    for (const address of ["93.184.216.34", "2606:4700::1111", "[2606:4700::1111]"]) {
        expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "localhost", ""]) {
        expect(isPublicAddress(address)).toBe(false);
    }
});

test("a public MCP server's OAuth endpoint on loopback, a private network or plain http is refused before anything is sent", async () => {
    const { send, sent } = transport({});
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", fetch: send, lookup: dns });
    const post = { method: "POST", body: "code=secret&code_verifier=v" };
    expect(await refusalCode(guarded("https://127.0.0.1:4000/token", post))).toBe("private-endpoint");
    expect(await refusalCode(guarded("https://localhost/token", post))).toBe("private-endpoint");
    expect(await refusalCode(guarded("https://169.254.169.254/latest", post))).toBe("private-endpoint");
    // One private address among public ones is enough to refuse.
    expect(await refusalCode(guarded("https://evil.example/token", post))).toBe("private-endpoint");
    expect(await refusalCode(guarded("https://nowhere.example/token", post))).toBe("lookup-failed");
    expect(await refusalCode(guarded("http://auth.example/token", post))).toBe("insecure");
    expect(sent).toEqual([]);
});

test("an MCP server on loopback keeps signing in on loopback, over plain http", async () => {
    const { send, sent } = transport({ "http://127.0.0.1:4000/token": () => Response.json({ access_token: "a" }) });
    const guarded = secureOAuthFetch({ resource: "http://localhost:4000/mcp", fetch: send, lookup: dns });
    const answer = await guarded("http://127.0.0.1:4000/token", { method: "POST", body: "x=1" });
    expect(await answer.json()).toEqual({ access_token: "a" });
    expect(sent.map((one) => one.redirect)).toEqual(["manual"]);
});

test("each redirect hop is checked again, and a request carrying a credential never follows one to another origin", async () => {
    const { send, sent } = transport({
        "https://auth.example/.well-known/oauth-authorization-server": () => new Response(null, { status: 302, headers: { location: "https://localhost/meta" } }),
        "https://auth.example/token": () => new Response(null, { status: 307, headers: { location: "https://mcp.example/token" } }),
        "https://auth.example/moved": () => new Response(null, { status: 301, headers: { location: "/meta" } }),
        "https://auth.example/meta": () => Response.json({ issuer: "https://auth.example" }),
        "https://auth.example/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    });
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", fetch: send, lookup: dns });
    expect(await refusalCode(guarded("https://auth.example/.well-known/oauth-authorization-server"))).toBe("private-endpoint");
    expect(await refusalCode(guarded("https://auth.example/token", { method: "POST", body: "refresh_token=r" }))).toBe("redirect-origin");
    expect(sent.some((one) => one.url.startsWith("https://localhost") || one.url.startsWith("https://mcp.example"))).toBe(false);
    // A same-origin redirect of a bodyless read is followed.
    expect(await (await guarded("https://auth.example/moved")).json()).toEqual({ issuer: "https://auth.example" });
    expect(await refusalCode(guarded("https://auth.example/loop"))).toBe("too-many-redirects");
});

test("an answer past 1 MiB is refused without reading it whole", async () => {
    const { response, pulled } = streamedResponse(64, 64 * 1024);
    const { send } = transport({ "https://auth.example/token": () => response });
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", fetch: send, lookup: dns });
    expect(await refusalCode(guarded("https://auth.example/token", { method: "POST", body: "x" }))).toBe("too-large");
    expect(pulled.count).toBeLessThan(64);
});

test("a hung endpoint is cut at the deadline", async () => {
    const send = (_input: string | URL, init: RequestInit = {}): Promise<Response> =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", fetch: send, lookup: dns, deadlineMs: 30 });
    expect(await refusalCode(guarded("https://auth.example/token"))).toBe("timeout");
});

test("discovery refuses metadata a public MCP server points at the daemon's own loopback", async () => {
    // The MCP server is public; its protected-resource metadata names an authorization server on loopback.
    const { send, sent } = transport({
        "https://mcp.example/mcp": () => new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"' } }),
        "https://mcp.example/.well-known/oauth-protected-resource/mcp": () =>
            Response.json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://localhost:7777"] }),
    });
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", fetch: send, lookup: dns });
    // SAFETY: the transport stand-in answers every call discovery makes; it lacks only fetch's static `preconnect`.
    const found = await discoverMcpAuth("https://mcp.example/mcp", send as typeof fetch, guarded);
    expect(found.kind).toBe("token");
    expect(sent.some((one) => one.url.startsWith("https://localhost"))).toBe(false);
});

test("a token request a public server's metadata aims at loopback never leaves the daemon", async () => {
    const { send, sent } = transport({});
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", fetch: send, lookup: dns });
    const asked = tokenRequest({ clientId: "c", clientAuth: "none", tokenEndpoint: "https://127.0.0.1:3000/api/anything" }, { grant_type: "refresh_token", refresh_token: "r" }, guarded);
    expect(await refusalCode(asked)).toBe("private-endpoint");
    expect(sent).toEqual([]);
});

// The daemon's own transport, against a real loopback server.
let listening: Server | undefined;
afterEach(async () => {
    await new Promise((resolve) => listening?.close(resolve) ?? resolve(undefined));
    listening = undefined;
});

const serve = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    listening = createServer(handler);
    await new Promise<void>((resolve) => listening?.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    return `http://localhost:${String((listening.address() as AddressInfo).port)}`;
};

test("the daemon's transport refuses at the connect a name that resolved public to the check (DNS rebinding)", async () => {
    let reached = false;
    const origin = await serve((_request, response) => {
        reached = true;
        response.end("{}");
    });
    // The check's DNS says localhost is public; the socket's own lookup finds 127.0.0.1 and refuses it.
    const rebinding: AddressLookup = async () => ["93.184.216.34"];
    const guarded = secureOAuthFetch({ resource: "https://mcp.example/mcp", lookup: rebinding });
    // http on loopback passes the scheme check, so it is the connect that refuses.
    await expect(guarded(`${origin}/token`, { method: "POST", body: "code=c" })).rejects.toThrow(/not public/);
    expect(reached).toBe(false);
});

test("the daemon's transport carries a form, its headers and the answer for a loopback MCP server", async () => {
    let seen = { type: "", body: "" };
    const origin = await serve((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
        });
        request.on("end", () => {
            seen = { type: request.headers["content-type"] ?? "", body };
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ access_token: "t" }));
        });
    });
    const guarded = secureOAuthFetch({ resource: `${origin}/mcp` });
    const answer = await guarded(`${origin}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "x" }) });
    expect(await answer.json()).toEqual({ access_token: "t" });
    expect(seen.type).toContain("application/x-www-form-urlencoded");
    expect(seen.body).toBe("grant_type=x");
});
