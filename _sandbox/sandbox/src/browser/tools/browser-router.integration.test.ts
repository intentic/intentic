import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { type BrowserRouter, createBrowserRouter, createSchemaCache, type Prepared } from "./browser-router.js";

// The router's contract, driven in-process against real child processes:
// 1. handshake and tools/list are answered with no backend and no prepare; every listed tool gains an injected
//    `account` parameter.
// 2. a tool call resolves `account` to its owner, prepares that owner once, spawns it, strips the parameter, and
//    returns the reply.
// 3. an id outside the manifest is refused with the granted set named, and prepares nothing.
// 4. a prepare that refuses an owner turns into a tool error, not a dead call.
// 5. a sole-owner manifest serves tools with no `account` at all and routes everything to that owner.
// 6. closing the router (the turn ending) kills the backends.
// 7. a network tool's answer comes back with the credentials a site issued redacted, and its debugging facts intact.
// The backend is a canary standing in for @playwright/mcp; it writes a marker file on spawn and echoes call arguments
// back.

// What @playwright/mcp's browser_network_request answers for a token-exchange fetch, captured from the real server
// (playwright-core renderRequestDetails / renderRequestPart) with the values swapped for fixtures. Each credential is
// one a site issues, never a stored secret, so the exact-value masking in agent-redaction.ts cannot know it.
const BEARER = "fixtureBearer0123456789abcdef";
const OAUTH_CODE = "fixtureOauthCode987654";
const QUERY_TOKEN = "fixtureQueryToken123456";
const API_KEY = "fixtureApiKey7890xyzabc";
const CSRF = "fixtureCsrf4567890qwerty";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlZml4dHVyZQ";
const REFRESH = "fixtureRefresh0987654321";
const PASSWORD = "fixturePassword112233";
const URL = `https://app.example.com/oauth/token?code=${OAUTH_CODE}&access_token=${QUERY_TOKEN}&page=2#id_token=${JWT}`;
const REQUEST_HEADERS = [
    `authorization: Bearer ${BEARER}`,
    "referer: https://app.example.com/login",
    `x-api-key: ${API_KEY}`,
    `x-csrf-token: ${CSRF}`,
    "content-type: application/json",
];
const RESPONSE_HEADERS = ["content-length: 121", "content-type: application/json; charset=utf-8", `location: ${URL}`];
const NETWORK_ANSWERS = {
    list: `### Result\n2. [POST] ${URL} => [200] OK`,
    details: [
        `### Result\n#2 [POST] ${URL}`,
        "",
        "  General",
        "    status:    [200] OK",
        "    duration:  3ms",
        "    type:      fetch",
        "    mimeType:  application/json",
        "",
        "  Request headers",
        ...REQUEST_HEADERS.map((line) => `    ${line}`),
        "",
        "  Response headers",
        ...RESPONSE_HEADERS.map((line) => `    ${line}`),
        "",
        'Call browser_network_request with part="request-body" to read the request body.',
    ].join("\n"),
    "request-headers": `### Result\n${REQUEST_HEADERS.join("\n")}`,
    "request-body": `### Result\n{"password":"${PASSWORD}","grant_type":"authorization_code"}`,
    "response-body": `### Result\n{"access_token":"${JWT}","refresh_token":"${REFRESH}","user":"ok"}`,
} satisfies Record<string, string>;
const CREDENTIALS = [BEARER, OAUTH_CODE, QUERY_TOKEN, API_KEY, CSRF, JWT, REFRESH, PASSWORD];

const CANARY = `
const NETWORK = ${JSON.stringify(NETWORK_ANSWERS)};
const fs = require("fs");
const marker = process.argv[2];
fs.writeFileSync(marker, String(process.pid));
process.on("SIGTERM", () => { fs.unlinkSync(marker); process.exit(0); });
let buffer = "";
process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
        if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "canary", version: "1.0.0" } });
        else if (msg.method === "tools/list") reply({ tools: [{ name: "browser_probe", description: "canary tool", inputSchema: { type: "object", properties: {} } }] });
        else if (msg.method === "tools/call" && msg.params?.name === "browser_network_requests") reply({ content: [{ type: "text", text: NETWORK.list }] });
        else if (msg.method === "tools/call" && msg.params?.name === "browser_network_request") reply({ content: [{ type: "text", text: NETWORK[msg.params.arguments?.part ?? "details"] ?? "### Result\\n" + JSON.stringify(msg.params.arguments) }] });
        else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "echo:" + marker + ":" + JSON.stringify(msg.params?.arguments ?? {}) }] });
        else if (msg.id !== undefined) reply({});
    }
});
`;

interface Harness {
    readonly dir: string;
    readonly markers: Record<string, string>;
    readonly schemaCachePath: string;
    readonly router: BrowserRouter;
    // Owners the router asked to bring up, in order: the record that proves what was paid for and when.
    readonly prepares: string[];
    // Owners the stand-in prepare refuses instead of handing back a spec.
    readonly refusals: Map<string, string>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

const startRouter = async (soleOwner?: string): Promise<Harness> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-router-test-"));
    const canaryPath = join(dir, "canary.cjs");
    await writeFile(canaryPath, CANARY);
    const markers: Record<string, string> =
        soleOwner === undefined
            ? { "identity-1": join(dir, "identity-1.pid"), standalone: join(dir, "standalone.pid") }
            : { [soleOwner]: join(dir, `${soleOwner}.pid`) };
    const probeMarker = join(dir, "probe.pid");
    const schemaCachePath = join(dir, "tools.json");
    const prepares: string[] = [];
    const refusals = new Map<string, string>();
    const schemas = createSchemaCache();
    const router = createBrowserRouter(
        {
            // Two accounts of one identity plus the identity itself share a backend; a standalone owns its own.
            accounts: soleOwner === undefined ? { "identity-1": "identity-1", "born-acct": "identity-1", standalone: "standalone" } : {},
            owners: Object.fromEntries(Object.keys(markers).map((owner, index) => [owner, { port: 41_000 + index }])),
            backendEnv: {},
            ...(soleOwner === undefined ? {} : { soleOwner }),
        },
        {
            toolSchemas: () => schemas(schemaCachePath, { command: process.execPath, args: [canaryPath, probeMarker] }),
            prepare: async (owner): Promise<Prepared> => {
                prepares.push(owner);
                const refusal = refusals.get(owner);
                return refusal === undefined
                    ? { command: process.execPath, args: [canaryPath, markers[owner] as string], env: { ...process.env } as Record<string, string> }
                    : { refusal };
            },
        },
    );
    cleanups.push(async () => {
        router.close();
        await rm(dir, { recursive: true, force: true });
    });
    return { dir, markers, schemaCachePath, router, prepares, refusals };
};

const rpc = async (router: BrowserRouter, message: RpcMessage): Promise<Record<string, unknown>> =>
    (await router.handle(message)) as unknown as Record<string, unknown>;

const handshake = async (harness: Harness): Promise<void> => {
    await rpc(harness.router, {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(await harness.router.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
};

const exists = async (path: string): Promise<boolean> =>
    readFile(path)
        .then(() => true)
        .catch(() => false);

interface ToolResult {
    content: { text: string }[];
    isError?: boolean;
}

test("handshake and tools/list cost no backend, and every tool gains the required account parameter", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const list = await rpc(harness.router, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (list["result"] as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["browser_probe"]);
    expect(tools[0]?.inputSchema.properties["account"]).toMatchObject({ type: "string" });
    expect(tools[0]?.inputSchema.required).toContain("account");
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    // The point of the whole arrangement: a client can learn every browser tool without this sandbox starting a
    // display, dialling an exit or launching Chromium for any of them.
    expect(harness.prepares).toEqual([]);
    // Schema cache is unmutated by the probe; the account parameter is injected on the way out, not into the cache.
    expect(JSON.parse(await readFile(harness.schemaCachePath, "utf8"))).toEqual([
        { name: "browser_probe", description: "canary tool", inputSchema: { type: "object", properties: {} } },
    ]);
});

test("a call routes by account to the owner's backend with the parameter stripped; an identity-born account shares it", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const call = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "born-acct", url: "https://example.com" } },
    });
    const echoed = (call["result"] as ToolResult).content[0]?.text ?? "";
    expect(echoed).toContain(harness.markers["identity-1"] as string);
    expect(echoed).toContain('{"url":"https://example.com"}');
    expect(await exists(harness.markers["identity-1"] as string)).toBe(true);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);

    const other = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "standalone" } },
    });
    expect((other["result"] as ToolResult).content[0]?.text).toContain(harness.markers["standalone"] as string);
    expect(await exists(harness.markers["standalone"] as string)).toBe(true);
});

test("an account outside the manifest is refused with the granted set named, and no backend pays for it", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const denied = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "reddit-personal" } },
    });
    const result = denied["result"] as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"reddit-personal"');
    expect(result.content[0]?.text).toContain("identity-1");
    expect(result.content[0]?.text).toContain("standalone");

    const missing = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "browser_probe", arguments: {} },
    });
    expect((missing["result"] as ToolResult).isError).toBe(true);
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    expect(harness.prepares).toEqual([]);
});

test("the turn ending, the router closing: kills the backends, and a later call is refused", async () => {
    const harness = await startRouter();
    await handshake(harness);
    await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "identity-1" } },
    });
    expect(await exists(harness.markers["identity-1"] as string)).toBe(true);
    harness.router.close();
    for (let waited = 0; (await exists(harness.markers["identity-1"] as string)) && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // SIGTERM: the canary unlinks its marker on the way out.
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
    const after = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 71,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "identity-1" } },
    });
    expect((after["result"] as ToolResult).isError).toBe(true);
    expect(harness.prepares).toEqual(["identity-1"]);
});

test("a second turn's router answers tools/list straight from the cache: no probe, no backend", async () => {
    const first = await startRouter();
    await handshake(first);
    await rpc(first.router, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    first.router.close();

    const second = await startRouter();
    await writeFile(second.schemaCachePath, await readFile(first.schemaCachePath, "utf8"));
    await handshake(second);
    const list = await rpc(second.router, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((list["result"] as { tools: unknown[] }).tools).toHaveLength(1);
    expect(await exists(join(second.dir, "probe.pid"))).toBe(false);
});

test("an owner is prepared once, on its first call, however many calls name it", async () => {
    const harness = await startRouter();
    await handshake(harness);
    expect(harness.prepares).toEqual([]);
    // Sent together, deliberately: two racing first calls must not spawn two Chromiums on one profile.
    const [first, second] = await Promise.all([
        rpc(harness.router, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_probe", arguments: { account: "identity-1" } } }),
        rpc(harness.router, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_probe", arguments: { account: "born-acct" } } }),
    ]);
    expect((first["result"] as ToolResult).isError).toBeUndefined();
    expect((second["result"] as ToolResult).isError).toBeUndefined();
    await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "identity-1" } },
    });
    expect(harness.prepares).toEqual(["identity-1"]);
});

test("an owner the daemon refuses comes back as a tool error naming why, and nothing is spawned", async () => {
    const harness = await startRouter();
    harness.refusals.set("standalone", 'standalone browses through the exit "berlin", which is down.');
    await handshake(harness);
    const denied = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "standalone" } },
    });
    const result = denied["result"] as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("berlin");
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    // Not remembered as refused: the exit can come up inside the same turn.
    harness.refusals.delete("standalone");
    const retried = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "standalone" } },
    });
    expect((retried["result"] as ToolResult).isError).toBeUndefined();
    expect(await exists(harness.markers["standalone"] as string)).toBe(true);
});

test("a sole-owner router declares no account parameter and routes every call to its one owner", async () => {
    const harness = await startRouter("web");
    await handshake(harness);
    const list = await rpc(harness.router, { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} });
    const tools = (list["result"] as { tools: { inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] }).tools;
    expect(tools[0]?.inputSchema.properties["account"]).toBeUndefined();
    expect(tools[0]?.inputSchema.required ?? []).not.toContain("account");
    expect(harness.prepares).toEqual([]);
    const call = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { url: "https://example.com" } },
    });
    expect((call["result"] as ToolResult).content[0]?.text).toContain('{"url":"https://example.com"}');
    expect(harness.prepares).toEqual(["web"]);
    expect(await exists(harness.markers["web"] as string)).toBe(true);
});

const networkCall = async (harness: Harness, id: number, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    // SAFETY: every tools/call the router answers is a tool result (a refusal is one too), never a JSON-RPC error here.
    (await rpc(harness.router, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }))["result"] as ToolResult;

// The transcript and the model provider see whatever this returns, so a bearer token a signed-in site issued is as
// exposed here as a stored secret would be, and nothing downstream knows its value to mask it.
test.each([
    ["a signed-in account", undefined, { account: "born-acct" }],
    ["the anonymous browser", "web", {}],
] as const)("%s's network answers redact issued credentials and keep method, status, path and content-type", async (_label, soleOwner, routing) => {
    const harness = await startRouter(soleOwner);
    await handshake(harness);
    const answers = await Promise.all([
        networkCall(harness, 20, "browser_network_requests", routing),
        networkCall(harness, 21, "browser_network_request", { ...routing, index: 2 }),
        networkCall(harness, 22, "browser_network_request", { ...routing, index: 2, part: "request-headers" }),
        networkCall(harness, 23, "browser_network_request", { ...routing, index: 2, part: "request-body" }),
        networkCall(harness, 24, "browser_network_request", { ...routing, index: 2, part: "response-body" }),
    ]);
    const texts = answers.map((answer) => answer.content.map((block) => block.text).join("\n"));
    const leaked = CREDENTIALS.filter((credential) => texts.some((text) => text.includes(credential)));
    expect(leaked).toEqual([]);
    const [list, details, headers, requestBody, responseBody] = texts;
    expect(list).toBe("### Result\n2. [POST] https://app.example.com/oauth/token?code=***&access_token=***&page=*** => [200] OK");
    expect(details).toContain("#2 [POST] https://app.example.com/oauth/token?code=***&access_token=***&page=***\n");
    expect(details).toContain("    status:    [200] OK\n    duration:  3ms\n    type:      fetch\n    mimeType:  application/json\n");
    expect(details).toContain("    authorization: ***\n    referer: https://app.example.com/login\n    x-api-key: ***\n    x-csrf-token: ***\n");
    expect(details).toContain("    content-type: application/json; charset=utf-8\n    location: https://app.example.com/oauth/token?code=***&access_token=***&page=***\n");
    expect(headers).toBe(
        "### Result\nauthorization: ***\nreferer: https://app.example.com/login\nx-api-key: ***\nx-csrf-token: ***\ncontent-type: application/json",
    );
    expect(requestBody).toBe('### Result\n{"password":"***","grant_type":"authorization_code"}');
    expect(responseBody).toBe('### Result\n{"access_token":"***","refresh_token":"***","user":"ok"}');
});

// `filename` has the backend write the full answer to its output directory, where the router never sees it and any
// shell in the sandbox can read it, so the redaction above would be one argument away from bypassed.
test("a network call that asks for a file instead of an answer is refused before it reaches the backend", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const refused = await networkCall(harness, 25, "browser_network_request", { account: "identity-1", index: 2, filename: "leak.txt" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("filename");
    expect(harness.prepares).toEqual([]);
});
