import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApp } from "../../app.js";
import type { Services } from "../../composition.js";
import { services } from "../../harness/route-services.testing.js";
import { testConfig } from "../../testing.js";
import { workspaceExtensionsRoot } from "../../capabilities/extension-dirs.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createExtensionBackend, type ExtensionBackend } from "./backend-supervisor.js";

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

const writeExtension = async (root: string, name: string, server: string): Promise<void> => {
    const dir = join(workspaceExtensionsRoot(root), name);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "intentic-extension.json"),
        JSON.stringify({ publisher: "acme", name, version: "1.0.0", engines: { intentic: "^2.1.0" }, server: "server.js" }),
    );
    await writeFile(join(dir, "server.js"), server);
};

// Wires the real supervisor into the route harness's services through a holder, resolving their circular construction.
// extensionsDir is emptied so the repo's own first-party extensions stay out of the host under test.
const harness = (root: string): { svc: Services; backend: ExtensionBackend } => {
    const holder: { current?: Services } = {};
    const backend = createExtensionBackend(
        () => holder.current!,
        0,
        // eslint-disable-next-line no-console -- the test host's forwarded lines are noise unless it fails
        { info: () => {}, warn: console.warn, error: console.error } as unknown as Services["logger"],
    );
    const svc = services({
        workspace: workspacePaths(root),
        config: { ...testConfig, extensionsDir: "" },
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
