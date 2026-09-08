import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import { afterEach, expect, test } from "vitest";
import type { ResolvedContribution } from "./contributions.js";
import { probeCapability } from "./probe.js";

// Probes against a real server, not a stubbed fetch, since headers, status wording and unreachable hosts are
// real-server facts. Uses a fixture card so the test pins shared probe machinery, not one vendor's API shape.

let server: Server | undefined;

afterEach(() => {
    server?.close();
    server = undefined;
});

// Answers whatever the handler returns and records each request the test can assert against.
const serve = async (handler: (request: { path: string; auth: string | undefined; method: string }) => { status: number; body: unknown }) => {
    const seen: { path: string; auth: string | undefined; method: string }[] = [];
    // Kept locally too: `server` is only for `afterEach`, this code needs the instance just created.
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

// Taken from the cli union in the manifest schema, not restated, so a schema change surfaces here.
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
    expect(seen[0]?.path).toBe(`/user`);
    expect(seen[0]?.auth).toBe(`Bearer tok_live`);
});

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
        // Port 1 on loopback refuses immediately, avoiding a DNS timeout hang.
        config: { provider: "example", url: "http://127.0.0.1:1", token: "t" },
    });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain(`127.0.0.1:1`);
});

test(`says plainly when a card has no test, and never calls it a failure`, async () => {
    const answer = await probeCapability(new Map(), {
        id: "ops-box",
        kind: "ssh",
        config: { host: "h", port: 22, user: "root", auth: "password", password: "x" },
    });

    expect(answer.checked).toBe(false);
    expect(answer.message).toContain(`can't be tested from here`);
});

test(`checks a model endpoint the way the thing that uses it would`, async () => {
    const { url, seen } = await serve(({ path }) => (path === `/v1/models` ? { status: 200, body: { data: [] } } : { status: 404, body: {} }));

    const answer = await probeCapability(new Map(), {
        id: "ollama",
        kind: "endpoint",
        config: { baseUrl: `${url}/v1/`, protocol: "openai", apiKey: "sk-local" },
    });

    expect(answer).toMatchObject({ checked: true, ok: true });
    expect(answer.message).toMatch(/endpoint/i);
    expect(seen[0]?.path).toBe(`/v1/models`);
    expect(seen[0]?.auth).toBe(`Bearer sk-local`);
});

test(`checks an MCP server by the handshake, and names the server that answered`, async () => {
    const { url, seen } = await serve(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "linear" } } } }));

    const answer = await probeCapability(new Map(), { id: "linear", kind: "mcp", config: { url: `${url}/mcp`, token: "mcp_tok" } });

    expect(answer).toMatchObject({ checked: true, ok: true });
    expect(answer.message).toContain(`linear`);
    expect(seen[0]?.method).toBe(`POST`);
    expect(seen[0]?.auth).toBe(`Bearer mcp_tok`);
});
