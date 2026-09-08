import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { panelsContract } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { errorCode, routesClient } from "../harness/route-client.testing.js";
import { fakeProcesses, tempWorkspace } from "../harness/route-fakes.testing.js";
import { testConfig } from "../testing.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { type PanelsRoutesDeps, createPanelsRoutes } from "./panels.routes.js";

// Operator-panel routes, tested over real repos on disk since these routes report exactly what is in the workspace.
// Panel token auth is the app's middleware, checked there.

const panelsClient = (workspace: WorkspacePaths, overrides: Partial<PanelsRoutesDeps> = {}) =>
    routesClient(
        panelsContract,
        createPanelsRoutes({
            workspace,
            config: testConfig,
            panelToken: "panel-secret",
            processes: fakeProcesses(),
            // Nothing listening unless a test overrides it: the scan is a seam, not the real machine's sockets.
            scanPorts: async () => [],
            ...overrides,
        }),
    );

// Listens on an OS-assigned port and returns it; the probe behind `servers` dials it for real.
const serve = async (server: http.Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
};

test("panels.list enumerates every repo with its operator panel + runtime status", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }, { name: "desired-state" }]);
    const client = panelsClient(workspace, {
        // Zone from the public URL; hostname's sandbox id from the connect token (sha256("token")[0:12]=3c469e9d6c58).
        config: { ...testConfig, connectToken: "token", sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } },
        // "app" answers on a dead port (unhealthy); neither repo gets a previewUrl since neither is routable.
        processes: fakeProcesses({ app: 1 }),
    });
    const facts = { deployConfig: false, desiredState: false, directoryUi: false, monorepo: false, vitest: false, userStories: false, docs: false };
    expect(await client.list()).toEqual({
        panels: [
            { repo: "app", hasPanel: true, installed: false, running: true, healthy: false, servers: [], port: 1, role: "app", ...facts },
            { repo: "desired-state", hasPanel: false, installed: true, running: false, healthy: false, servers: [], role: "desired-state", ...facts },
        ],
    });
});

test("panels.list advertises previewUrl only while the preview hostname really serves the repo", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await serve(server);
    const config = { ...testConfig, connectToken: "token", sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } };
    const url = "https://preview-app-3c469e9d6c58.example.com";

    // Assigned port answers: the ordinary scaffolded app.
    const running = panelsClient(workspace, { config, processes: fakeProcesses({ app: port }) });
    expect((await running.list()).panels[0]?.previewUrl).toBe(url);

    // Pinned its own port; assigned port silent: still one address, still previewable.
    const pinned = panelsClient(workspace, {
        config,
        processes: fakeProcesses({ app: 1 }),
        scanPorts: async () => [{ port, host: "127.0.0.1", forwardable: true, cwd: join(workspace.root, "app") }],
    });
    expect((await pinned.list()).panels[0]?.previewUrl).toBe(url);

    // Three servers on their own ports: healthy, but no single hostname can stand for it.
    const fanned = panelsClient(workspace, {
        config,
        processes: fakeProcesses({ app: 1 }),
        scanPorts: async () => [
            { port, host: "127.0.0.1", forwardable: true, cwd: join(workspace.root, "app", "_editor", "web") },
            { port: port + 1, host: "127.0.0.1", forwardable: true, cwd: join(workspace.root, "app", "_site", "site") },
        ],
    });
    const several = (await fanned.list()).panels[0];
    expect(several?.healthy).toBe(true);
    expect(several?.previewUrl).toBeUndefined();
    server.close();
});

test("panels.list reports the content facts extensions detect on", async () => {
    const workspace = tempWorkspace([{ name: "extra" }]);
    const dir = join(workspace.root, "extra");
    writeFileSync(join(dir, "deploy.config.ts"), "export default {};");
    writeFileSync(join(dir, "desired-state.json"), "{}");
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []");
    writeFileSync(join(dir, "turbo.json"), "{}");
    mkdirSync(join(dir, `${STATE_DIR}`, "ui"), { recursive: true });
    writeFileSync(join(dir, `${STATE_DIR}`, "ui", "index.html"), "<html></html>");
    mkdirSync(join(dir, "docs", "user-stories"), { recursive: true });
    mkdirSync(join(dir, "docs", "architecture"), { recursive: true });
    const client = panelsClient(workspace);
    expect(await client.list()).toEqual({
        panels: [
            {
                repo: "extra",
                hasPanel: false,
                installed: true,
                running: false,
                healthy: false,
                servers: [],
                deployConfig: true,
                desiredState: true,
                directoryUi: true,
                monorepo: true,
                vitest: false,
                userStories: true,
                docs: true,
            },
        ],
    });
});

test("panels.list advertises no previewUrl without a connect token (loopback: nothing would resolve)", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const client = panelsClient(workspace, {
        config: { ...testConfig, sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } },
    });
    expect(await client.list()).toEqual({
        panels: [
            {
                repo: "app",
                hasPanel: true,
                installed: false,
                running: false,
                healthy: false,
                servers: [],
                role: "app",
                deployConfig: false,
                desiredState: false,
                directoryUi: false,
                monorepo: false,
                vitest: false,
                userStories: false,
                docs: false,
            },
        ],
    });
});

// A server outside the sandbox has no session; that absence is itself meaningful, not a gap.
test("panels.list names the terminal each answering dev server is running in", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const site = http.createServer((_request, response) => response.end("site"));
    const web = http.createServer((_request, response) => response.end("web"));
    const [sitePort, webPort] = await Promise.all([serve(site), serve(web)]);
    const client = panelsClient(workspace, {
        scanPorts: async () => [
            { port: sitePort, host: "127.0.0.1", forwardable: true, cwd: join(workspace.root, "app", "_site", "site"), session: "web-3f2a" },
            { port: webPort, host: "127.0.0.1", forwardable: true, cwd: join(workspace.root, "app", "_editor", "web") },
        ],
    });

    const [panel] = (await client.list()).panels;
    expect(panel?.healthy).toBe(true);
    // Ports are OS-assigned in no fixed order; sorted the same way here instead of assumed.
    expect(panel?.servers).toEqual(
        [
            { port: sitePort, url: `http://localhost:${sitePort}`, dir: join("_site", "site"), session: "web-3f2a" },
            { port: webPort, url: `http://localhost:${webPort}`, dir: join("_editor", "web") },
        ].toSorted((a, b) => a.port - b.port),
    );
    site.close();
    web.close();
});

test("panels.list gives the panel's own terminal to the assigned port the scan couldn't attribute", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await serve(server);
    const client = panelsClient(workspace, { processes: fakeProcesses({ app: port }) });

    const [panel] = (await client.list()).panels;
    expect(panel?.servers).toEqual([{ port, url: `http://localhost:${port}`, session: "panel-app" }]);
    server.close();
});

test("panels.start runs the repo's operator dir, rejects unknown repos + repos with no panel; stop is idempotent", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }, { name: "desired-state" }]);
    const processes = fakeProcesses();
    const client = panelsClient(workspace, { processes });

    expect(await client.start({ repo: "app" })).toEqual({ ok: true });
    expect(processes.started).toEqual([{ repo: "app", cwd: join(workspace.root, "app", "operator") }]);
    // No operator/ means BAD_REQUEST; an unknown repo is NOT_FOUND.
    expect(await errorCode(client.start({ repo: "desired-state" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.start({ repo: "ghost" }))).toBe("NOT_FOUND");
    expect(await client.stop({ repo: "app" })).toEqual({ ok: true });
    expect(processes.stopped).toEqual(["app"]);
    expect(await errorCode(client.stop({ repo: "ghost" }))).toBe("NOT_FOUND");
});
