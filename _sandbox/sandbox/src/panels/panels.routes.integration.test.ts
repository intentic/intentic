import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { panelsContract } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { errorCode, fakeProcesses, routesClient, tempWorkspace } from "../route-testing.js";
import { testConfig } from "../testing.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { type PanelsRoutesDeps, createPanelsRoutes } from "./panels.routes.js";

/* The operator-panel routes, over the five seams they read.
 *
 * Split out of app.integration.test.ts — 116 tests over every route in the daemon, in one file — and then
 * stood up on `PanelsRoutesDeps` rather than on the daemon. Real repos on disk, because what these routes
 * report IS what is in the workspace: which repo owns an operator/ dir, and which content facts the
 * extensions detect on. The panel TOKEN is the app's middleware and is checked there. */

const panelsClient = (workspace: WorkspacePaths, overrides: Partial<PanelsRoutesDeps> = {}) =>
    routesClient(
        panelsContract,
        createPanelsRoutes({
            workspace,
            config: testConfig,
            panelToken: "panel-secret",
            processes: fakeProcesses(),
            ensurePreviewRoutes: async () => {},
            // Nothing listening unless a test says otherwise — the scan is a seam here rather than the real
            // machine's sockets, which used to make "no servers" depend on what happened to be up.
            scanPorts: async () => [],
            ...overrides,
        }),
    );

// Listen on an OS-assigned port and hand it back — the probe behind `servers` dials for real.
const serve = async (server: http.Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
};

test("panels.list enumerates every repo with its operator panel + runtime status", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }, { name: "desired-state" }]);
    const client = panelsClient(workspace, {
        // The zone comes from the public URL, the hostname's sandbox id from the connect token
        // (sha256("token")[0:12] = 3c469e9d6c58) — both are needed for a previewUrl to be advertised.
        config: { ...testConfig, connectToken: "token", sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } },
        // "app" is running on a dead port (nothing answers it in either scheme ⇒ no servers ⇒ healthy false);
        // "desired-state" isn't running. Neither repo is a temp dir any real listener was launched from, so the
        // procfs attribution finds nothing for them either.
        processes: fakeProcesses({ app: 1 }),
    });
    const facts = { deployConfig: false, desiredState: false, directoryUi: false, monorepo: false, vitest: false, userStories: false, docs: false };
    expect(await client.list()).toEqual({
        panels: [
            {
                repo: "app",
                hasPanel: true,
                running: true,
                healthy: false,
                servers: [],
                port: 1,
                role: "app",
                ...facts,
                previewUrl: "https://preview-app-3c469e9d6c58.example.com",
            },
            {
                repo: "desired-state",
                hasPanel: false,
                running: false,
                healthy: false,
                servers: [],
                role: "desired-state",
                ...facts,
                previewUrl: "https://preview-desired-state-3c469e9d6c58.example.com",
            },
        ],
    });
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

test("panels.list advertises no previewUrl without a connect token (loopback — nothing would resolve)", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const client = panelsClient(workspace, {
        config: { ...testConfig, sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" } },
    });
    expect(await client.list()).toEqual({
        panels: [
            {
                repo: "app",
                hasPanel: true,
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

/* WHAT IS OCCUPYING THE PORT, AND WHERE. A monorepo serving two apps is two addresses and two answers to "where
 * do I go to stop this" — the terminal the scan traced each listener back to. The second one has none: a dev
 * server outside the sandbox answers just as well, and saying so is the whole point of the field. */
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
    // Ordered by port, which the OS assigned — so the expectation sorts the same way rather than assuming.
    expect(panel?.servers).toEqual(
        [
            { port: sitePort, url: `http://localhost:${sitePort}`, dir: join("_site", "site"), session: "web-3f2a" },
            { port: webPort, url: `http://localhost:${webPort}`, dir: join("_editor", "web") },
        ]
            .toSorted((a, b) => a.port - b.port)
            .map(({ port: _port, ...server }) => server),
    );
    site.close();
    web.close();
});

// A panel the daemon started answers with ITS terminal even when procfs gave up the cwd — the daemon put the
// process there, so the session is a fact rather than an attribution.
test("panels.list gives the panel's own terminal to the assigned port the scan couldn't attribute", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }]);
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await serve(server);
    const client = panelsClient(workspace, { processes: fakeProcesses({ app: port }) });

    const [panel] = (await client.list()).panels;
    expect(panel?.servers).toEqual([{ url: `http://localhost:${port}`, session: "panel-app" }]);
    server.close();
});

test("panels.start runs the repo's operator dir, rejects unknown repos + repos with no panel; stop is idempotent", async () => {
    const workspace = tempWorkspace([{ name: "app", panel: true }, { name: "desired-state" }]);
    const processes = fakeProcesses();
    const ensured: string[] = [];
    const client = panelsClient(workspace, {
        processes,
        ensurePreviewRoutes: async (labels) => {
            ensured.push(...labels);
        },
    });

    expect(await client.start({ repo: "app" })).toEqual({ ok: true });
    expect(processes.started).toEqual([{ repo: "app", cwd: join(workspace.root, "app", "operator") }]);
    // The preview route is minted (as its label) before the panel is observable as running.
    expect(ensured).toEqual(["preview-app"]);
    // A repo with no operator/ can't start; an unknown repo is NOT_FOUND.
    expect(await errorCode(client.start({ repo: "desired-state" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.start({ repo: "ghost" }))).toBe("NOT_FOUND");
    expect(await client.stop({ repo: "app" })).toEqual({ ok: true });
    expect(processes.stopped).toEqual(["app"]);
    expect(await errorCode(client.stop({ repo: "ghost" }))).toBe("NOT_FOUND");
});
