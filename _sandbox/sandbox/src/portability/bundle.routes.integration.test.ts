import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { createApp } from "../app.js";
import { rejectAuth, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { testConfig } from "../testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { exportsDir } from "./exports.js";

// Bundle routes over HTTP: the owner gate (both directions touch everything the sandbox holds), and that starting an
// export answers immediately, without waiting for the pack.

// Response.json() is untyped on this Hono version; asserted once here rather than at each call site.
const jsonOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type ExportRow = { name: string; status: string };

const dirs: string[] = [];
// Each app gets its own history root, so a failing test's skipped cleanup can't leak into the next test's.
const appOn = async (options: { readonly authed?: true } = {}): Promise<{ app: ReturnType<typeof createApp>; history: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "bundle-routes-"));
    dirs.push(dir);
    const app = createApp(
        services({
            workspace: workspacePaths(join(dir, "work")),
            config: { ...testConfig, workspaceRoot: join(dir, "work"), historyRoot: join(dir, "history") },
            // Most tests run without auth; the ticket test needs a real check, since download skips auth when it's off
            // (like /workspace/media). A header-less request is refused exactly as the real bearer refuses it.
            ...(options.authed === true
                ? {
                      auth: {
                          authorize: async (presented: string) => {
                              // "" is what a header-less request presents (bearerFrom); refused in the real authorize's
                              // own words.
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

    // Visible immediately: what a browser that navigates away and comes back would read.
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

// Download is the one bundle route a browser reaches by navigating, so these requests carry no Authorization header,
// ticket only; the owner-gated setup calls carry the bearer, as the web app's fetches do.
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

    // The ticket alone opens it: the bearer middleware exempts this path, as it does /workspace/media.
    const response = await app.request(`/bundles/download?name=${encodeURIComponent(name)}&ticket=${ticket}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
    // A length to show progress against; impossible when a bundle streamed straight into the response.
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

// Inbound arrivals now live at /arrivals, one route for all four sources, but these guards stayed: taking a bundle in
// is the export's other direction, and both assert an unreadable body is refused at the read, before anything is
// written.
test("a body that is not any arrival this daemon reads is a 400, not a half-written workspace", async () => {
    const { app } = await appOn();
    // Four bytes of nothing: not gzip, so read as a definition, and not a valid one.
    expect((await app.request("/arrivals/plan", { method: "POST", body: new Uint8Array([1, 2, 3, 4]) })).status).toBe(400);
});

test("an empty arrival body is refused before anything is touched", async () => {
    const { app } = await appOn();
    expect((await app.request("/arrivals/plan", { method: "POST" })).status).toBe(400);
});

// Never minted, or already consumed: the file was fine but the preview went stale, unlike "not a bundle".
test("applying against a token nothing holds is a 409, not a 400", async () => {
    const { app } = await appOn();
    const response = await app.request("/arrivals/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "nope", items: [], includeSecrets: false }),
    });
    expect(response.status).toBe(409);
});
