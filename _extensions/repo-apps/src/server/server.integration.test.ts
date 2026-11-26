import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import { graphPath, layersPath } from "../backendRoutes.js";
import { manifest } from "../manifest.js";
import * as server from "./server.js";

// The backend as the host activates it, on the SDK's fake daemon (@intentic/extension-api/testing), which refuses any
// daemon route the manifest does not declare, as the daemon would. It declares none and reaches none.

let extension: FakeExtension | undefined;
afterEach(async () => {
    await extension?.deactivate();
    await extension?.dispose();
    extension = undefined;
});

const plant = async (root: string, files: Record<string, string>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
    }
};

test("it answers a repository's graph and one package's layers from the workspace, reaching no daemon route", async () => {
    extension = await fakeExtensionApi({ manifest });
    await extension.activate(server);
    await plant(extension.api.workspaceRoot, {
        "shop/pnpm-workspace.yaml": `packages:\n  - "apps/*"\n  - "libs/*"\n`,
        "shop/apps/web/package.json": JSON.stringify({ name: "@s/web", dependencies: { "@s/ui": "workspace:*" } }),
        "shop/apps/web/src/main.ts": `import { button } from "@s/ui";\nimport { a } from "./lib/a.js";\n`,
        "shop/apps/web/src/lib/a.ts": `export const a = 1;\n`,
        "shop/libs/ui/package.json": JSON.stringify({ name: "@s/ui" }),
    });

    const graph = await extension.route(graphPath("shop"));
    expect(graph.status).toBe(200);
    expect(await graph.json()).toEqual({
        packages: [
            { name: "@s/web", dir: "apps/web", group: "apps" },
            { name: "@s/ui", dir: "libs/ui", group: "libs" },
        ],
        edges: [{ from: "@s/web", to: "@s/ui", type: "prod", usage: "code" }],
    });

    const layers = await extension.route(layersPath("shop", "@s/web"));
    expect(layers.status).toBe(200);
    expect(await layers.json()).toEqual({
        package: "@s/web",
        root: "apps/web/src",
        units: [
            { id: "(root)", modules: 1 },
            { id: "lib", modules: 1 },
        ],
        edges: [{ from: "(root)", to: "lib", imports: 1, sites: ["main.ts:2"] }],
    });
    expect(extension.calls).toEqual([]);
});

test("a repository id that could leave the workspace is refused, and one that is not there, or a package it lacks, is not found", async () => {
    extension = await fakeExtensionApi({ manifest });
    await extension.activate(server);
    await plant(extension.api.workspaceRoot, { "shop/pnpm-workspace.yaml": `packages: []\n` });

    expect((await extension.route(graphPath("../etc"))).status).toBe(400);
    expect((await extension.route(graphPath(""))).status).toBe(400);
    expect((await extension.route(graphPath("ghost"))).status).toBe(404);
    expect((await extension.route(layersPath("shop", "@s/nope"))).status).toBe(404);
    expect((await extension.route(`layers?repo=shop`)).status).toBe(400);
    // Anything else in its namespace is not its own.
    expect((await extension.route(`graphs?repo=shop`)).status).toBe(404);
    expect((await extension.route(graphPath("shop"), { method: "POST" })).status).toBe(404);
});

// (2026-11-26) The daemon's area fence, held by the backend through the caller the daemon verified (`api.caller`): a
// member fenced to areas reads only the repositories inside them, whatever the request names.
test("a member fenced to areas reads the graph and layers of the repositories inside them, and no other", async () => {
    extension = await fakeExtensionApi({ manifest });
    await extension.activate(server);
    await plant(extension.api.workspaceRoot, {
        "shop/pnpm-workspace.yaml": `packages:\n  - "apps/*"\n`,
        "shop/apps/web/package.json": JSON.stringify({ name: "@s/web" }),
        "bank/pnpm-workspace.yaml": `packages:\n  - "apps/*"\n`,
        "bank/apps/vault/package.json": JSON.stringify({ name: "@b/vault" }),
    });
    const fencedToShop = { caller: { kind: "person", email: "intern@example.com", tier: "viewer", areas: ["shop-area"], folders: ["shop"] } } as const;

    expect((await extension.route(graphPath("shop"), undefined, fencedToShop)).status).toBe(200);
    expect((await extension.route(layersPath("shop", "@s/web"), undefined, fencedToShop)).status).toBe(200);

    const bank = await extension.route(graphPath("bank"), undefined, fencedToShop);
    expect(bank.status).toBe(403);
    expect(await bank.json()).toEqual({ error: "outside your access to this workspace, which holds shop" });
    expect((await extension.route(layersPath("bank", "@b/vault"), undefined, fencedToShop)).status).toBe(403);
    // A repository that is not there answers the same as one outside the areas, so the fence tells nothing of the rest.
    expect((await extension.route(graphPath("ghost"), undefined, fencedToShop)).status).toBe(403);

    // A fence narrower than the repository (one of its folders) does not open the repository's whole graph.
    const fencedToApp = { caller: { kind: "person", email: "intern@example.com", tier: "viewer", areas: ["web"], folders: ["shop/apps/web"] } } as const;
    expect((await extension.route(graphPath("shop"), undefined, fencedToApp)).status).toBe(403);
    // Areas that hold no folders hold nothing.
    const fencedToNothing = { caller: { kind: "person", email: "intern@example.com", tier: "viewer", areas: [], folders: [] } } as const;
    expect(await (await extension.route(graphPath("shop"), undefined, fencedToNothing)).json()).toEqual({
        error: "your access to this workspace holds no folders; ask the owner for an area",
    });
});

test("an unfenced person, a panel and the owner's own machine read every repository; a request nobody vouched for reads none", async () => {
    extension = await fakeExtensionApi({ manifest });
    await extension.activate(server);
    await plant(extension.api.workspaceRoot, { "bank/pnpm-workspace.yaml": `packages: []\n` });

    expect((await extension.route(graphPath("bank"), undefined, { caller: { kind: "person", email: "m@example.com", tier: "maintainer" } })).status).toBe(200);
    expect((await extension.route(graphPath("bank"), undefined, { caller: { kind: "panel" } })).status).toBe(200);
    expect((await extension.route(graphPath("bank"), undefined, { caller: { kind: "local" } })).status).toBe(200);
    // Past its two-minute window the assertion is no caller at all, and the backend fails closed.
    expect((await extension.route(graphPath("bank"), undefined, { mintedAgoMs: 3 * 60_000 })).status).toBe(401);
});
