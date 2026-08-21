import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApp } from "../../app.js";
import type { Services } from "../../composition.js";
import { services } from "../../route-testing.js";
import { testConfig } from "../../testing.js";
import { workspaceExtensionsRoot } from "../../capabilities/extension-dirs.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createExtensionBackend, type ExtensionBackend } from "./backend-supervisor.js";

/* The extension backend system end to end, against a REAL spawned host process: a workspace extension whose
 * server bundle is plain ESM on disk, the supervisor bringing the host up, the daemon's /x proxy carrying a
 * request through it, and the containment rules: a throwing activation is one row, an unproxied caller is
 * refused, a stopped host answers 503 with words. Slow by this suite's standards (a node spawn + health
 * poll), which is exactly what makes it the one test that can catch the seams the unit tests fake. */

const started: ExtensionBackend[] = [];
afterEach(() => {
    for (const backend of started.splice(0)) {
        backend.stop();
    }
});

// A workspace extension with a BACKEND only: no build step, no imports, the bundle-self-containment rule
// satisfied trivially, the way an agent authoring one in place would start.
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

// The real supervisor over the route-testing services: the circular seam production composition solves with
// a holder, solved here the same way. extensionsDir is emptied so the repo's own first-party extensions stay
// out of the host under test.
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
    // GET with a query: the proxy must carry both the rebased path and the search intact.
    const ping = await app.request("http://sandbox.test/x/acme.echo/ping?q=hello");
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: true, extension: "acme.echo", q: "hello" });
    // The backend host is HTTP/1.1, so every response naturally carries Connection/Keep-Alive. Copying those
    // through made Node's browser-facing HTTP/2 listener throw ERR_HTTP2_INVALID_CONNECTION_HEADERS after the
    // route had answered 200, leaving extension views on their loading skeleton forever. A field explicitly
    // named by Connection is hop-by-hop too; an ordinary end-to-end field must survive the same filter.
    expect(ping.headers.get("connection")).toBeNull();
    expect(ping.headers.get("keep-alive")).toBeNull();
    expect(ping.headers.get("x-backend-hop")).toBeNull();
    expect(ping.headers.get("x-backend-answer")).toBe("preserved");
    // A body-carrying method streams through.
    const echo = await app.request("http://sandbox.test/x/acme.echo/echo", { method: "POST", body: "round trip" });
    expect(await echo.json()).toEqual({ echoed: "round trip" });
    // A path the extension does not serve is the host's readable 404, not a hang or a proxy error.
    expect((await app.request("http://sandbox.test/x/acme.echo/nowhere")).status).toBe(404);
    // …and so is a namespace nobody owns.
    expect((await app.request("http://sandbox.test/x/acme.nobody/ping")).status).toBe(404);

    // The host only answers the daemon: the same request straight to the host's port, without the proxy's
    // header, is refused: loopback is container-shared and the auth gate lives daemon-side.
    const target = backend.proxyTarget();
    expect(target).toBeDefined();
    const direct = await fetch(`http://127.0.0.1:${target!.port}/x/acme.echo/ping`);
    expect(direct.status).toBe(401);

    // The extensions list carries the backend's state on the row.
    const list = (await (await app.request("http://sandbox.test/extensions")).json()) as {
        extensions: { id: string; backend?: { state: string } }[];
    };
    expect(list.extensions.find((extension) => extension.id === "acme.echo")?.backend).toEqual({ state: "running" });

    // Stopping the host turns the namespace into a 503 that says so: the web's cue to retry, not an error state.
    backend.stop();
    const stopped = await app.request("http://sandbox.test/x/acme.echo/ping");
    expect(stopped.status).toBe(503);
    expect(((await stopped.json()) as { error: string }).error).toContain("stopped");
});

test("one extension's failing activation is its own row, never the host's death", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-backend-fail-"));
    await writeExtension(root, "echo", echoServer);
    await writeExtension(root, "broken", `export const activateServer = () => { throw new Error("no config"); };\n`);
    const { svc, backend } = harness(root);
    await backend.start();

    // The host runs, the healthy extension serves, and the broken one is a sentence on its status.
    expect(backend.status().state).toBe("running");
    expect(backend.statusOf("acme.broken")).toEqual({ id: "acme.broken", state: "error", detail: "no config" });
    const app = createApp(svc);
    expect((await app.request("http://sandbox.test/x/acme.echo/ping")).status).toBe(200);
    // The broken one's namespace answers 404 with the activation failure named, not a silent nothing.
    const broken = await app.request("http://sandbox.test/x/acme.broken/anything");
    expect(broken.status).toBe(404);
    expect(((await broken.json()) as { error: string }).error).toContain("no config");
});
