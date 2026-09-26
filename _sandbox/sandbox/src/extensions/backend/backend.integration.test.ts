import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract";
import { createApp } from "../../app.js";
import type { Services } from "../../composition.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../../capabilities/capabilities-slice.testing.js";
import { testConfig } from "../../testing.js";
import { workspaceExtensionsRoot } from "../../capabilities/extension-dirs.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { approveExtension } from "../extension-approvals.js";
import { createExtensionBackend, type ExtensionBackend } from "./backend-supervisor.js";
import { extensionMcpToolsOf } from "./extension-mcp.js";

// Extension backend system end-to-end against a real spawned host process (supervisor, /x proxy, containment rules).
// Slow (node spawn + health poll); it catches seams the unit tests fake.

const started: ExtensionBackend[] = [];
afterEach(() => {
    for (const backend of started.splice(0)) {
        backend.stop();
    }
});

// Backend-only extension: no build step or imports, so the bundle stands alone as written.
const echoServer = `export const activateServer = (api, context) => {
    api.routes.mount(async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/ping") {
            return Response.json(
                { pong: true, extension: context.extensionId, q: url.searchParams.get("q") },
                {
                    headers: {
                        connection: "keep-alive, x-backend-hop",
                        "keep-alive": "timeout=5",
                        "x-backend-hop": "one connection only",
                        "x-backend-answer": "preserved",
                    },
                },
            );
        }
        if (request.method === "POST" && url.pathname === "/echo") {
            return Response.json({ echoed: await request.text() });
        }
        return undefined;
    });
};
`;

// Each root keeps the owner's approvals beside it, so one test's yes is never another's.
const historyOf = (root: string): string => `${root}-history`;

// Written and approved, as the owner's own extension would be, unless the test is about one nobody approved.
const writeExtension = async (root: string, name: string, server: string, approved = true, contributes?: Record<string, unknown>): Promise<void> => {
    const dir = join(workspaceExtensionsRoot(root), name);
    const manifest = {
        publisher: "acme",
        name,
        version: "1.0.0",
        engines: { intentic: "^2.1.0" },
        server: "server.js",
        ...(contributes === undefined ? {} : { contributes }),
    };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "server.js"), server);
    if (approved) {
        await approveExtension(historyOf(root), `acme.${name}`, ExtensionManifestSchema.parse(manifest));
    }
};

// Wires the real supervisor into the route harness's services through a holder, resolving their circular construction.
// extensionsDir is emptied so the repo's own first-party extensions stay out of the host under test.
const harness = (root: string, capabilities: readonly Capability[] = []): { svc: Services; backend: ExtensionBackend } => {
    const holder: { current?: Services } = {};
    const backend = createExtensionBackend(
        () => holder.current!,
        0,
        // eslint-disable-next-line no-console -- the test host's forwarded lines are noise unless it fails
        { info: () => {}, warn: console.warn, error: console.error } as unknown as Services["logger"],
    );
    const svc = services({
        workspace: workspacePaths(root),
        config: { ...testConfig, extensionsDir: "", historyRoot: historyOf(root) },
        capabilities: memoryCapabilitiesStore([...capabilities]),
        extensionBackend: backend,
    });
    holder.current = svc;
    started.push(backend);
    return { svc, backend };
};

test("a workspace extension's backend serves its /x namespace through the daemon proxy", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-"));
    await writeExtension(root, "echo", echoServer);
    const { svc, backend } = harness(root);
    await backend.start();
    expect(backend.status().state).toBe("running");
    expect(backend.statusOf("acme.echo")).toEqual({ id: "acme.echo", state: "running" });

    const app = createApp(svc);
    const ping = await app.request("http://sandbox.test/x/acme.echo/ping?q=hello");
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: true, extension: "acme.echo", q: "hello" });
    // x-backend-hop is named in Connection (hop-by-hop); x-backend-answer is ordinary and must survive the same filter.
    expect(ping.headers.get("connection")).toBeNull();
    expect(ping.headers.get("keep-alive")).toBeNull();
    expect(ping.headers.get("x-backend-hop")).toBeNull();
    expect(ping.headers.get("x-backend-answer")).toBe("preserved");
    const echo = await app.request("http://sandbox.test/x/acme.echo/echo", { method: "POST", body: "round trip" });
    expect(await echo.json()).toEqual({ echoed: "round trip" });
    expect((await app.request("http://sandbox.test/x/acme.echo/nowhere")).status).toBe(404);
    expect((await app.request("http://sandbox.test/x/acme.nobody/ping")).status).toBe(404);

    const target = backend.proxyTarget();
    const direct = await fetch(`http://127.0.0.1:${target!.port}/x/acme.echo/ping`);
    expect(direct.status).toBe(401);

    const list = (await (await app.request("http://sandbox.test/extensions")).json()) as {
        extensions: { id: string; backend?: { state: string } }[];
    };
    expect(list.extensions.find((extension) => extension.id === "acme.echo")?.backend).toEqual({ state: "running" });

    backend.stop();
    const stopped = await app.request("http://sandbox.test/x/acme.echo/ping");
    expect(stopped.status).toBe(503);
    expect(((await stopped.json()) as { error: string }).error).toContain("stopped");
});

test("a workspace extension nobody approved never loads into the host, beside one that did", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-pending-"));
    await writeExtension(root, "echo", echoServer);
    await writeExtension(root, "stranger", echoServer, false);
    const { svc, backend } = harness(root);
    await backend.start();

    expect(backend.statusOf("acme.stranger")).toBeUndefined();
    const app = createApp(svc);
    expect((await app.request("http://sandbox.test/x/acme.stranger/ping")).status).toBe(404);
    expect((await app.request("http://sandbox.test/x/acme.echo/ping")).status).toBe(200);
});

// A handler that never answers: the shape that took a hosted sandbox down, where every other route queued behind it.
const stallServer = `export const activateServer = (api) => {
    api.routes.mount(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/hang") {
            await new Promise(() => {});
        }
        if (url.pathname === "/ping") {
            return Response.json({ ok: true });
        }
        return undefined;
    });
};
`;

test("a stalled extension is shed rather than queued, and the rest of the daemon keeps answering", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-stall-"));
    await writeExtension(root, "stall", stallServer);
    await writeExtension(root, "echo", echoServer);
    const { svc, backend } = harness(root);
    await backend.start();
    const app = createApp(svc);

    // Saturates the cap without naming it: each probe that is not refused is itself one more request waiting on a first
    // byte, so this converges on the refusal instead of asserting a number this test would have to be told. It also
    // outlasts the grace a call gets before it counts as stalled, which is the whole reason a burst is not shed.
    const hanging: Promise<unknown>[] = [];
    let refused: Response | undefined;
    for (let attempt = 0; attempt < 60 && refused === undefined; attempt += 1) {
        const inFlight = Promise.resolve(app.request("http://sandbox.test/x/acme.stall/hang"));
        hanging.push(inFlight.catch(() => undefined));
        const settled = await Promise.race([inFlight, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))]);
        if (settled?.status === 503) {
            refused = settled;
        }
    }
    const notice = (await refused?.json()) as { error: string; extension: string; path: string } | undefined;
    expect(notice).toMatchObject({ extension: "acme.stall", path: "/x/acme.stall/hang" });
    expect(notice?.error).toContain("waiting seconds for a first byte");

    // The point of the cap: one wedged extension is one wedged extension, not a wedged sandbox.
    expect((await app.request("http://sandbox.test/health")).status).toBe(200);
    expect((await app.request("http://sandbox.test/x/acme.echo/ping")).status).toBe(200);
    // The budget belongs to the extension rather than the route: once spent, its healthy routes are shed with the rest.
    expect((await app.request("http://sandbox.test/x/acme.stall/ping")).status).toBe(503);

    backend.stop();
    await Promise.all(hanging);
});

test("a burst of quick calls is concurrency, not a stall, and is served in full", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-burst-"));
    await writeExtension(root, "echo", echoServer);
    const { svc, backend } = harness(root);
    await backend.start();
    const app = createApp(svc);

    // Comfortably more at once than the cap allows to be stalled: a panel that fans out its reads must not be shed for
    // being busy, which is what a plain concurrency limit here would do.
    const burst = await Promise.all(Array.from({ length: 24 }, async () => app.request("http://sandbox.test/x/acme.echo/ping")));
    expect(burst.map((answer) => answer.status)).toEqual(Array.from({ length: 24 }, () => 200));
});

test("one extension's failing activation is its own row, never the host's death", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-fail-"));
    await writeExtension(root, "echo", echoServer);
    await writeExtension(root, "broken", `export const activateServer = () => { throw new Error("no config"); };\n`);
    const { svc, backend } = harness(root);
    await backend.start();

    expect(backend.status().state).toBe("running");
    expect(backend.statusOf("acme.broken")).toEqual({ id: "acme.broken", state: "error", detail: "no config" });
    const app = createApp(svc);
    expect((await app.request("http://sandbox.test/x/acme.echo/ping")).status).toBe(200);
    const broken = await app.request("http://sandbox.test/x/acme.broken/anything");
    expect(broken.status).toBe(404);
    expect(((await broken.json()) as { error: string }).error).toContain("no config");
});

// A card's MCP endpoint answers only through the daemon's MCP door, which checks the calling turn's lease: /x/* is
// reachable with a panel's or a member's bearer, so it refuses that path however it is spelled, and nothing else.
test("an extension's declared MCP endpoint is refused under /x, beside its ordinary routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-tools-"));
    const card = {
        id: "ledger",
        kind: "cli",
        catalog: { name: "Ledger", icon: "plug", description: "Ledger", category: "business" },
        fields: [{ key: "token", label: "Token", secret: true }],
        env: { LEDGER_TOKEN: "${token}" },
        skill: "SKILL.md",
        mcp: "tools/mcp",
    };
    await writeExtension(root, "echo", echoServer, true, { capabilities: [card] });
    const { svc, backend } = harness(root);
    await backend.start();
    const app = createApp(svc);

    expect(backend.isToolPath("/x/acme.echo/tools/mcp/billing")).toBe(true);
    for (const path of ["/x/acme.echo/tools/mcp/billing", "/x/acme.echo/tools/mcp", "/x/acme.echo//tools/%6Dcp/billing", "/x/acme%2Eecho/tools/mcp/billing"]) {
        const refused = await app.request(`http://sandbox.test${path}`, { method: "POST", body: "{}" });
        expect({ path, status: refused.status }).toEqual({ path, status: 403 });
    }
    // A sibling path that merely begins the same is the extension's own route, not its MCP endpoint.
    expect(backend.isToolPath("/x/acme.echo/tools/mcpx")).toBe(false);
    expect((await app.request("http://sandbox.test/x/acme.echo/ping")).status).toBe(200);
});

// An extension that hands the host its tools: the card it was mounted for, the card's settings as the daemon holds them,
// the calling conversation, all given to the call; the transport and the handshake are the host's.
const toolsServer = `export const activateServer = (api) => {
    api.tools.serve((card) => card === undefined ? [] : [{
        name: "whoami",
        description: "Says which card it was handed.",
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
        call: async (args, context) => card.id + ":" + card.config.token + ":" + args.x + ":" + context.conversationId,
    }]);
};
`;

test("an extension's tools reach a turn through the MCP door, served by the host with the card handed to them", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-served-"));
    const card = {
        id: "ledger",
        kind: "cli",
        catalog: { name: "Ledger", icon: "plug", description: "Ledger", category: "business" },
        fields: [{ key: "token", label: "Token", secret: true }],
        env: { LEDGER_TOKEN: "${token}" },
        skill: "SKILL.md",
    };
    await writeExtension(root, "tooled", toolsServer, true, { capabilities: [card], tools: { perCard: "ledger" } });
    const books: Capability = { id: "books", kind: "cli", config: { provider: "ledger", token: "s3cret" } };
    const { svc, backend } = harness(root, [books]);
    await backend.start();
    expect(backend.statusOf("acme.tooled")).toEqual({ id: "acme.tooled", state: "running" });

    const [tool] = await extensionMcpToolsOf(svc, [books], svc.turnMounts.lease("conv-1"), undefined);
    expect(tool).toEqual({ name: "books", url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/books`, token: tool?.token });
    const app = createApp(svc);
    const rpc = async (body: unknown): Promise<unknown> =>
        (
            await app.request("http://sandbox.test/mcp/books", {
                method: "POST",
                headers: { authorization: `Bearer ${tool?.token ?? ""}`, "content-type": "application/json" },
                body: JSON.stringify(body),
            })
        ).json();

    expect(await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).toMatchObject({
        id: 1,
        result: { capabilities: { tools: {} }, serverInfo: { name: "books" } },
    });
    expect(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "whoami", description: "Says which card it was handed.", inputSchema: { type: "object", properties: { x: { type: "string" } } } }] },
    });
    expect(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: { x: "hi" } } })).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "books:s3cret:hi:conv-1" }] },
    });
    // The host's door onto the tools is not under /x, and /x is where a person's or a panel's bearer reaches.
    expect((await app.request("http://sandbox.test/x/acme.tooled/tools/acme.tooled", { method: "POST", body: "{}" })).status).toBe(404);
});

// A converge restarts the one shared host only when what it would run changed: a write that moves no backend's code
// (a manifest's label, a file beside the bundle) leaves every extension's in-memory state standing.
test("the host restarts when a backend's code changes, and a converge that changes nothing leaves it running", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-converge-"));
    await writeExtension(root, "echo", echoServer);
    const { backend } = harness(root);
    await backend.start();
    const first = backend.proxyTarget();
    expect(first).toMatchObject({ port: expect.any(Number) });

    const dir = join(workspaceExtensionsRoot(root), "echo");
    await writeFile(join(dir, "README.md"), "notes beside the bundle");
    await backend.start();
    expect(backend.proxyTarget()).toEqual(first);
    expect(backend.status().state).toBe("running");

    await writeFile(join(dir, "server.js"), `${echoServer}\n// a new build\n`);
    await backend.start();
    const second = backend.proxyTarget();
    expect(second?.port).not.toBe(first?.port);
    expect(second?.hostToken).not.toBe(first?.hostToken);
    expect(backend.statusOf("acme.echo")).toEqual({ id: "acme.echo", state: "running" });
});
