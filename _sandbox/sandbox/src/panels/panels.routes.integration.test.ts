import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
            ...overrides,
        }),
    );

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
    const facts = { deployConfig: false, desiredState: false, directoryUi: false, monorepo: false, vitest: false, userStories: false };
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
    mkdirSync(join(dir, ".intentic", "ui"), { recursive: true });
    writeFileSync(join(dir, ".intentic", "ui", "index.html"), "<html></html>");
    mkdirSync(join(dir, "docs", "user-stories"), { recursive: true });
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
            },
        ],
    });
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
