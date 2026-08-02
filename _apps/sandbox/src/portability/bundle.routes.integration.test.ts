import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { rejectAuth, rejectForbidden, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";

/* The bundle ROUTES, driven over the daemon's HTTP surface. What the round-trip suite next door does not cover
 * is the gate: both directions read or overwrite everything the sandbox holds, so "owner only" is the property
 * worth a test of its own rather than a line of prose. */

const appOn = async (): Promise<{ app: ReturnType<typeof createApp>; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "bundle-routes-"));
    const app = createApp(
        services({
            workspace: workspacePaths(join(dir, "work")),
            config: { ...testConfig, workspaceRoot: join(dir, "work"), historyRoot: join(dir, "history") },
        } as Parameters<typeof services>[0]),
    );
    return { app, dir };
};

test("a member may not export or restore — both directions are owner-gated", async () => {
    // The member's exact position: the bearer verifies, the owner check refuses. A verified non-owner is 403.
    const app = createApp(services({ auth: { authorize: async () => ({ email: "member@example.com" }), authorizeOwner: rejectForbidden } }));
    expect((await app.request("/bundle")).status).toBe(403);
    expect((await app.request("/bundle", { method: "POST", body: "x" })).status).toBe(403);
});

test("an unauthenticated caller gets 401 from both, indistinguishable from an unreachable daemon", async () => {
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await app.request("/bundle")).status).toBe(401);
    expect((await app.request("/bundle", { method: "POST", body: "x" })).status).toBe(401);
});

test("the export answers a gzip attachment the browser can save", async () => {
    const { app, dir } = await appOn();
    const response = await app.request("/bundle");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="intentic-.*\.tar\.gz"$/);
    await response.arrayBuffer();
    await rm(dir, { recursive: true, force: true });
});

test("a body that is not a bundle is a 400, not a half-written workspace", async () => {
    const { app, dir } = await appOn();
    const response = await app.request("/bundle", { method: "POST", body: new Uint8Array([1, 2, 3, 4]) });
    expect(response.status).toBe(400);
    await rm(dir, { recursive: true, force: true });
});

test("an empty body is refused before anything is touched", async () => {
    const { app, dir } = await appOn();
    expect((await app.request("/bundle", { method: "POST" })).status).toBe(400);
    await rm(dir, { recursive: true, force: true });
});
