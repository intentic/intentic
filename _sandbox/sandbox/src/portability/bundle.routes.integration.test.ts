import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { createApp } from "../app.js";
import { rejectAuth, rejectForbidden, services } from "../route-testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { exportsDir } from "./exports.js";

/* The bundle ROUTES, driven over the daemon's HTTP surface.
 *
 * Two properties live here rather than in the round-trip suite next door. The GATE, because both directions
 * read or overwrite everything the sandbox holds. And the fact that starting an export ANSWERS IMMEDIATELY:
 * the whole point of making it an artifact is that the request does not wait for the pack, so a browser is free
 * to navigate away the moment it has the name.
 */

// `Response.json()` is untyped on this Hono version, so the shape is asserted once here rather than at each
// call site. Test-local: the daemon's own answers are schema-checked where they are produced.
const jsonOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type ExportRow = { name: string; status: string };

const dirs: string[] = [];
// Each app hands back its OWN history root. Looking it up by index instead made one failing test cascade into
// the next two: the failure skipped the cleanup, so the following test read the previous test's directory.
const appOn = async (options: { readonly authed?: true } = {}): Promise<{ app: ReturnType<typeof createApp>; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "bundle-routes-"));
    dirs.push(dir);
    const app = createApp(
        services({
            workspace: workspacePaths(join(dir, "work")),
            config: { ...testConfig, workspaceRoot: join(dir, "work"), historyRoot: join(dir, "history") },
            /* Most tests run in loopback shape (no auth at all); the ticket test needs a daemon that actually
             * checks one, because the download route skips the check when there is no auth: same as
             * /workspace/media, and for the same reason.
             *
             * The bearer is checked the way the real one is: no header, no caller. A stub that authorized the
             * headerless request too made the download test pass while the browser's own navigation, which
             * cannot send a header: was being refused by the bearer middleware before the route ever ran.
             */
            ...(options.authed === true
                ? {
                      auth: {
                          authorize: async (presented: string) => {
                              // "" is what a request with no Authorization header presents (auth/auth.ts
                              // bearerFrom), and the real authorize refuses it in exactly these words.
                              if (presented === "") {
                                  throw new Error("missing bearer token");
                              }
                              return { email: "owner@example.com", role: "owner" as const };
                          },
                          authorizeOwner: async () => {},
                      },
                  }
                : {}),
        } as Parameters<typeof services>[0]),
    );
    return { app, history: join(dir, "history") };
};

afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a collaborator may not list, start, delete or bring one in: every direction is operating-tier gated", async () => {
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "member@example.com", role: "collaborator" as const }), authorizeOwner: rejectForbidden },
        }),
    );
    expect((await app.request("/bundles")).status).toBe(403);
    expect((await app.request("/bundles", { method: "POST" })).status).toBe(403);
    expect((await app.request("/bundles?name=x.tar.gz", { method: "DELETE" })).status).toBe(403);
    expect((await app.request("/bundles/ticket?name=x.tar.gz", { method: "POST" })).status).toBe(403);
    expect((await app.request("/arrivals/plan", { method: "POST", body: "x" })).status).toBe(403);
});

test("an unauthenticated caller gets 401, indistinguishable from an unreachable daemon", async () => {
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await app.request("/bundles")).status).toBe(401);
    expect((await app.request("/bundles", { method: "POST" })).status).toBe(401);
});

test("starting an export answers with its name at once, and the list carries it from that moment", async () => {
    const { app } = await appOn();
    const started = await app.request("/bundles", { method: "POST" });
    expect(started.status).toBe(200);
    const { name } = await jsonOf<{ name: string }>(started);
    expect(name).toMatch(/\.tar\.gz$/);

    // The row is visible immediately: this is what a browser that navigates away and comes back will read.
    const listed = await jsonOf<{ exports: ExportRow[] }>(await app.request("/bundles"));
    expect(listed.exports.map((entry) => entry.name)).toContain(name);

    await vi.waitFor(async () => {
        const now = await jsonOf<{ exports: ExportRow[] }>(await app.request("/bundles"));
        expect(now.exports.find((entry) => entry.name === name)?.status).toBe("ready");
    }, SETTLES);
});

test("a second start while one is packing is a 409, not a race", async () => {
    const { app, history } = await appOn();
    await mkdir(exportsDir(history), { recursive: true });
    await writeFile(join(exportsDir(history), "intentic-busy-2026-01-01-00-00-00.tar.gz.part"), "half");
    expect((await app.request("/bundles", { method: "POST" })).status).toBe(409);
});

/* The download is the one bundle route a BROWSER reaches by navigating to it, so every request below is made
 * the way that navigation makes it: no Authorization header, ticket only. The owner-gated calls that set it up
 * carry the bearer, as the web app's own fetches do.
 */
const owner = { authorization: "Bearer owner-token" } as const;

test("download needs a ticket for THAT bundle, and serves it with a real length", async () => {
    const { app } = await appOn({ authed: true });
    const { name } = await jsonOf<{ name: string }>(await app.request("/bundles", { method: "POST", headers: owner }));
    await vi.waitFor(async () => {
        const now = await jsonOf<{ exports: ExportRow[] }>(await app.request("/bundles", { headers: owner }));
        expect(now.exports.find((entry) => entry.name === name)?.status).toBe("ready");
    }, SETTLES);

    // No ticket, or one minted for a different bundle, buys nothing: the credential is scoped to one file.
    expect((await app.request(`/bundles/download?name=${encodeURIComponent(name)}`)).status).toBe(401);
    const { ticket } = await jsonOf<{ ticket: string }>(
        await app.request(`/bundles/ticket?name=${encodeURIComponent(name)}`, { method: "POST", headers: owner }),
    );
    expect((await app.request(`/bundles/download?name=other.tar.gz&ticket=${ticket}`)).status).toBe(401);

    // The ticket ALONE opens it: the bearer middleware exempts this path, exactly as it does /workspace/media.
    const response = await app.request(`/bundles/download?name=${encodeURIComponent(name)}&ticket=${ticket}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
    // A length the browser's download manager can show progress against: impossible while the bundle was
    // packed straight into the response.
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    await response.arrayBuffer();
});

test("a ticket for an export that does not exist is refused at the mint, not at the download", async () => {
    const { app } = await appOn();
    expect((await app.request("/bundles/ticket?name=nope.tar.gz", { method: "POST" })).status).toBe(404);
});

test("deleting an unknown export is a 404 rather than a silent success", async () => {
    const { app } = await appOn();
    expect((await app.request("/bundles?name=nope.tar.gz", { method: "DELETE" })).status).toBe(404);
});

/* THE INBOUND HALF IS /arrivals NOW, one route for all four sources, so these two guards moved with it. They
 * still belong in this file: taking a bundle in is the other direction of the export beside it, and what they
 * assert is that a body which is not readable is refused at the READ, before anything is written. */
test("a body that is not any arrival this daemon reads is a 400, not a half-written workspace", async () => {
    const { app } = await appOn();
    // Four bytes of nothing: not gzip, so it is read as a definition, and it is not one.
    expect((await app.request("/arrivals/plan", { method: "POST", body: new Uint8Array([1, 2, 3, 4]) })).status).toBe(400);
});

test("an empty arrival body is refused before anything is touched", async () => {
    const { app } = await appOn();
    expect((await app.request("/arrivals/plan", { method: "POST" })).status).toBe(400);
});

// A plan the daemon never minted, or minted and consumed: the FILE was fine and the preview went stale, which
// is a different answer from "that is not a bundle" and the card reacts to it differently.
test("applying against a token nothing holds is a 409, not a 400", async () => {
    const { app } = await appOn();
    const response = await app.request("/arrivals/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "nope", items: [], includeSecrets: false }),
    });
    expect(response.status).toBe(409);
});
