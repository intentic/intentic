import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import { afterEach, expect, test } from "vitest";
import type { ResolvedContribution } from "./contributions.js";
import { probeCapability } from "./probe.js";

/* THE PROBE AGAINST A REAL SERVER, because everything it exists to catch is a fact about a real answer: which
 * header actually arrived, what a 401 says to a reader, what an unreachable host does. A stubbed fetch would
 * pin the shape of the code and none of that.
 *
 * The card here is a fixture rather than a real connector's: what is being tested is the machinery every card
 * shares (templating, the auth header arriving, how each answer is worded), and pinning a real API's URL here
 * would make this a test of that vendor's path spelling. */

let server: Server | undefined;

afterEach(() => {
    server?.close();
    server = undefined;
});

// A server that answers whatever the case needs, and records the request it was asked, so the assertions can
// be about what actually crossed rather than about what was intended.
const serve = async (handler: (request: { path: string; auth: string | undefined; method: string }) => { status: number; body: unknown }) => {
    const seen: { path: string; auth: string | undefined; method: string }[] = [];
    // Held locally as well as on the module binding: `afterEach` needs the module one to close, but everything
    // below is talking about the server this call just made, and `server?.address()` would have been asking
    // whether it exists three lines after creating it.
    const started = createServer((request, response) => {
        const call = { path: request.url ?? "", auth: request.headers.authorization, method: request.method ?? "GET" };
        seen.push(call);
        const answer = handler(call);
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
    });
    server = started;
    await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(started.address() as AddressInfo).port}`, seen };
};

// The probe shape as the cli arm declares it: taken off the union rather than restated, so a change to the
// manifest schema shows up here rather than in a passing test of a shape nothing accepts any more.
type DeclaredProbe = NonNullable<Extract<CapabilityContribution, { kind: "cli" }>["probe"]>;

const card = (probe: DeclaredProbe): Map<string, ResolvedContribution> => {
    const spec = {
        id: "example",
        kind: "cli",
        catalog: { name: "Example", description: "An example.", category: "code" },
        fields: [
            { key: "url", label: "URL" },
            { key: "token", label: "Token", secret: true },
        ],
        env: { EXAMPLE_TOKEN: "${token}" },
        skill: "SKILL.md",
        probe,
    } as unknown as CapabilityContribution;
    return new Map([["cli:example", { spec, extension: { id: "example", dir: "/tmp" } as ResolvedContribution["extension"] }]]);
};

test(`reaches the service with the card's own credential, and says who answered`, async () => {
    const { url, seen } = await serve(({ auth }) =>
        auth === "Bearer tok_live" ? { status: 200, body: { login: "ada" } } : { status: 401, body: {} },
    );
    const registry = card({ url: "${url}/user", headers: { authorization: "Bearer ${token}" }, identity: "login" });

    const answer = await probeCapability(registry, { id: "example", kind: "cli", config: { provider: "example", url, token: "tok_live" } });

    expect(answer).toMatchObject({ checked: true, ok: true });
    expect(answer.message).toContain(`ada`);
    // The template resolved against the form's answers rather than against anything stored.
    expect(seen[0]?.path).toBe(`/user`);
    expect(seen[0]?.auth).toBe(`Bearer tok_live`);
});

/* THE REFUSALS, each in the words a person standing at the form needs. A raw status code is what the card
 * afterwards already offers; what the reader cannot get anywhere else is which of their answers was wrong. */
test(`says which answer was wrong rather than printing a status code`, async () => {
    const { url } = await serve(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const registry = card({ url: "${url}/user", headers: { authorization: "Bearer ${token}" }, identity: "login" });

    const answer = await probeCapability(registry, { id: "example", kind: "cli", config: { provider: "example", url, token: "wrong" } });

    expect(answer.checked).toBe(true);
    expect(answer.ok).toBe(false);
    expect(answer.message).toContain(`Example`);
    expect(answer.message).toMatch(/401/);
});

test(`names an address nothing answers at, without a stack trace`, async () => {
    const registry = card({ url: "${url}/user", headers: {} });

    const answer = await probeCapability(registry, {
        id: "example",
        kind: "cli",
        // Port 1 on loopback: refused immediately rather than hanging the suite on a DNS timeout.
        config: { provider: "example", url: "http://127.0.0.1:1", token: "t" },
    });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain(`127.0.0.1:1`);
});

/* NOT TESTABLE IS NOT A FAILURE. An ssh box, a paired device and a signed-in browser are connections whose
 * check is the thing itself, and the page hides its Test button on this answer rather than drawing a refusal. */
test(`says plainly when a card has no test, and never calls it a failure`, async () => {
    const answer = await probeCapability(new Map(), {
        id: "ops-box",
        kind: "ssh",
        config: { host: "h", port: 22, user: "root", auth: "password", password: "x" },
    });

    expect(answer.checked).toBe(false);
    expect(answer.message).toContain(`can't be tested from here`);
});

// A model endpoint's check is the protocol's, not a vendor's: the list the chat's model picker itself reads.
test(`checks a model endpoint the way the thing that uses it would`, async () => {
    const { url, seen } = await serve(({ path }) => (path === `/v1/models` ? { status: 200, body: { data: [] } } : { status: 404, body: {} }));

    const answer = await probeCapability(new Map(), {
        id: "ollama",
        kind: "endpoint",
        config: { baseUrl: `${url}/v1/`, protocol: "openai", apiKey: "sk-local" },
    });

    expect(answer).toMatchObject({ checked: true, ok: true });
    expect(answer.message).toMatch(/endpoint/i);
    // The trailing slash the user typed does not become a double slash in the call.
    expect(seen[0]?.path).toBe(`/v1/models`);
    expect(seen[0]?.auth).toBe(`Bearer sk-local`);
});

// An MCP server's check is its `initialize` handshake, which is exactly what the agent does first.
test(`checks an MCP server by the handshake, and names the server that answered`, async () => {
    const { url, seen } = await serve(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "linear" } } } }));

    const answer = await probeCapability(new Map(), { id: "linear", kind: "mcp", config: { url: `${url}/mcp`, token: "mcp_tok" } });

    expect(answer).toMatchObject({ checked: true, ok: true });
    expect(answer.message).toContain(`linear`);
    expect(seen[0]?.method).toBe(`POST`);
    expect(seen[0]?.auth).toBe(`Bearer mcp_tok`);
});
