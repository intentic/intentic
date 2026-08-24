import { mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { SETTLES } from "@intentic/testing/vitest";

import type { AgentEvent, Capability, RestoredMessage } from "@intentic/sandbox-contract";

import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

import { expect, test, vi } from "vitest";

import { createApp } from "./app.js";
import { createAuthConnections } from "./auth/connections.js";

import { createLogger } from "./logger.js";

import { createBootTracker } from "./platform/boot.js";
import { mintPairing } from "./platform/sync.js";

import type { AgentTool } from "./agent/agent-tools.js";

import { testConfig } from "./testing.js";

import {
    clientFor,
    codexConnectedProxy,
    collect,
    errorCode,
    fakeFiles,
    fakeHistory,
    memoryAutomationsStore,
    memoryCapabilitiesStore,
    postJson,
    rejectAuth,
    rejectForbidden,
    runAgentTurn,
    services,
    withTranslator,
} from "./route-testing.js";

test("GET /health reports ok, and names the sandbox so a loopback probe can tell WHICH daemon answered", async () => {
    const res = await createApp(services()).request("/health");
    expect(res.status).toBe(200);
    // No connect token (the loopback/test shape) ⇒ no id to claim, and no loopback shortcut to publish either.
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await (await createApp(services()).request("/health")).json()).not.toHaveProperty("sandboxId");

    // With one, the id is the SAME digest the tunnel hostname and the published port derive from: that
    // agreement is what makes the browser's "did I reach the right daemon" check meaningful.
    const named = await createApp(services({ config: { ...testConfig, connectToken: "tok" } })).request("/health");
    expect(await named.json()).toMatchObject({ ok: true, sandboxId: sandboxIdFromToken("tok") });

    // The posture rides the liveness probe because a local client needs it before any authenticated read.
    expect(await (await createApp(services()).request("/health")).json()).toMatchObject({ profile: "container" });
    const local = services({ config: { ...testConfig, sandbox: { ...testConfig.sandbox, profile: "local" } } });
    expect(await (await createApp(local).request("/health")).json()).toMatchObject({ profile: "local" });
});

/* /health is the one route that answers a stranger, and it answers with the sandbox id, which is also what the
 * loopback listener's port derives from. So CORS is not decoration here: without an allowlist, any page the user
 * happens to have open can walk the loopback port range, read the id off this route, and derive every preview
 * hostname the sandbox publishes. The wildcard this replaces made that a few seconds of fetches. */
test("CORS names the configured origins and no others, so an arbitrary page cannot read /health", async () => {
    const app = createApp(
        services({
            config: { ...testConfig, connectToken: "tok", webOrigin: "https://app.intentic.dev,https://localhost:47145" },
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
        }),
    );
    const originOf = async (origin: string) => (await app.request("/health", { headers: { origin } })).headers.get("access-control-allow-origin");

    // Each configured origin is reflected verbatim: a list, so one sandbox serves the hosted SPA and a dev origin.
    expect(await originOf("https://app.intentic.dev")).toBe("https://app.intentic.dev");
    expect(await originOf("https://localhost:47145")).toBe("https://localhost:47145");

    // The same emission with NO auth at all: the local profile's shape, where the host application serves
    // the app from its own origin and the browser preflights loopback like any cross-origin call.
    const authless = createApp(services({ config: { ...testConfig, webOrigin: "http://127.0.0.1:47188" } }));
    const authlessProbe = await authless.request("/health", { headers: { origin: "http://127.0.0.1:47188" } });
    expect(authlessProbe.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:47188");

    // A family entry admits one floating label and nothing more: an editor webview's per-session origin,
    // without opening the suffix to subdomain chains or foreign hosts.
    const family = createApp(services({ config: { ...testConfig, webOrigin: "https://*.webview.example.net" } }));
    const familyOf = async (origin: string) => (await family.request("/health", { headers: { origin } })).headers.get("access-control-allow-origin");
    expect(await familyOf("https://0a1b2c.webview.example.net")).toBe("https://0a1b2c.webview.example.net");
    expect(await familyOf("https://a.b.webview.example.net")).toBeNull();
    expect(await familyOf("https://webview.example.net")).toBeNull();
    expect(await familyOf("https://x.webview.example.net.evil.dev")).toBeNull();

    // Anything else gets NO header, not a wildcard and not someone else's origin: the browser refuses the read.
    expect(await originOf("https://evil.example")).toBeNull();
    // Including a lookalike that merely contains a configured origin: reflection is exact-match only.
    expect(await originOf("https://app.intentic.dev.evil.example")).toBeNull();

    // The body is still served: the daemon has nothing to hide from a request it can't attribute (the launch
    // scripts and the loopback probe are not browsers). CORS decides who may READ it, which is the whole point.
    expect(await (await app.request("/health", { headers: { origin: "https://evil.example" } })).json()).toMatchObject({
        ok: true,
        sandboxId: sandboxIdFromToken("tok"),
    });
});

test("GET /health carries the boot progress, so a poller can tell 'starting' from 'serving'", async () => {
    const boot = createBootTracker(createLogger(testConfig));
    boot.declare([{ key: "registry", label: "Loading conversations" }]);
    const app = createApp(services({ boot }));

    expect(await (await app.request("/health")).json()).toMatchObject({
        ok: true,
        boot: { ready: false, steps: [{ key: "registry", label: "Loading conversations", state: "pending" }] },
    });

    boot.finish();
    expect(await (await app.request("/health")).json()).toMatchObject({ boot: { ready: true } });
});

test("the boot gate holds data routes and lets the probe and the session exchange through", async () => {
    const boot = createBootTracker(createLogger(testConfig));
    boot.declare([{ key: "registry", label: "Loading conversations" }]);
    const app = createApp(services({ boot }));

    // A data route parks until the chain converges: an early request WAITS instead of reading half-built state.
    let settled = false;
    const held = (async (): Promise<Response> => {
        const response = await app.request("/settings");
        settled = true;
        return response;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // The exempt ones answer straight through. /system/session especially: it is the credential a browser needs
    // before it can open /events at all, so parking it left a cold browser unable to watch the very boot it
    // was waiting on. Its 4xx/5xx here is the auth-less shape refusing to mint: what matters is that it
    // ANSWERS rather than joining the queue.
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/system/session", { method: "POST" })).status).not.toBe(200);

    boot.finish();
    expect((await held).status).toBe(200);
});

test("system.session in loopback mode (no auth, no identity) answers 401: there is no session to mint", async () => {
    expect((await postJson(createApp(services({})), "/system/session")).status).toBe(401);
});

/* The WebSocket upgrades can't carry an Authorization header, so the credential is spent here instead and the
 * URL gets a ticket. This route is the reason no bearer appears in a query string any more, which means it has
 * to be gated exactly like every other authenticated route: by the middleware, on a header. */
test("POST /system/ws-ticket mints a one-shot ticket for the verified caller, and 401s an unauthenticated one", async () => {
    const app = createApp(
        services({ auth: { authorize: async () => ({ email: "o@x.com", role: "owner" as const }), authorizeOwner: rejectForbidden } }),
    );
    const response = await postJson(app, "/system/ws-ticket");
    expect(response.status).toBe(200);
    const { ticket } = (await response.json()) as { ticket: string };
    expect(ticket).toEqual(expect.any(String));

    // Rejected bearer ⇒ no ticket at all: the mint is the gate, so it must not be reachable without one.
    const closed = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await postJson(closed, "/system/ws-ticket")).status).toBe(401);
});

test("/system/ws-ticket 404s in loopback mode: no identity to bind, and the upgrades are ungated there", async () => {
    expect((await postJson(createApp(services({})), "/system/ws-ticket")).status).toBe(404);
});

test("POST /system/sessions/revoke re-keys sessions, closes live access, drops tickets, and requires the operating tier", async () => {
    let rotations = 0;
    const close = vi.fn();
    const connections = createAuthConnections();
    connections.register({ email: "owner@x.com", role: "owner" }, close);
    const auth = {
        authorize: async () => ({ email: "member@x.com", role: "collaborator" as const }),
        authorizeOwner: rejectForbidden,
        rotateSessions: async () => void (rotations += 1),
        connections,
    };
    // A verified lower role is a 403, and nothing rotates.
    expect((await postJson(createApp(services({ auth })), "/system/sessions/revoke")).status).toBe(403);
    expect(rotations).toBe(0);

    const ownerServices = services({ auth: { ...auth, authorizeOwner: async () => {} } });
    const ticket = ownerServices.wsTickets.mint({ email: "owner@x.com", role: "owner" });
    const owner = createApp(ownerServices);
    expect((await postJson(owner, "/system/sessions/revoke")).status).toBe(200);
    expect(rotations).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(ownerServices.wsTickets.redeem(ticket)).toBeUndefined();
});

test("account deletion can retire owner access permanently, and a member can remove only self", async () => {
    const ownerClose = vi.fn();
    const ownerConnections = createAuthConnections();
    ownerConnections.register({ email: "owner@x.com", role: "owner" }, ownerClose);
    const disable = vi.fn(async () => {});
    const rotate = vi.fn(async () => {});
    const ownerServices = services({
        auth: {
            authorize: async () => ({ email: "owner@x.com", role: "owner" as const }),
            authorizeOwner: async () => {},
            authorizeRetirement: async () => {},
            disableBrowserAccess: disable,
            rotateSessions: rotate,
            connections: ownerConnections,
        },
    });
    const ownerTicket = ownerServices.wsTickets.mint({ email: "owner@x.com", role: "owner" });
    expect((await postJson(createApp(ownerServices), "/system/access/disable")).status).toBe(200);
    expect(disable).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledOnce();
    expect(ownerClose).toHaveBeenCalledOnce();
    expect(ownerServices.wsTickets.redeem(ownerTicket)).toBeUndefined();

    // A prior partial account-deletion attempt has already disabled ordinary authorize(). The retirement
    // endpoint bypasses only that gate and re-verifies the owner, so retrying after another sandbox comes back
    // online can finish instead of being locked out by the successful first attempt.
    const retiredServices = services({
        auth: {
            authorize: async () => {
                throw new Error("browser access has been removed");
            },
            authorizeRetirement: async () => {},
            disableBrowserAccess: disable,
            rotateSessions: rotate,
        },
    });
    expect((await postJson(createApp(retiredServices), "/system/access/disable")).status).toBe(200);
    expect(disable).toHaveBeenCalledTimes(2);

    const removed: string[] = [];
    const memberClose = vi.fn();
    const memberConnections = createAuthConnections();
    memberConnections.register({ email: "member@x.com", role: "viewer" }, memberClose);
    const memberServices = services({
        auth: {
            authorize: async () => ({ email: "member@x.com", role: "viewer" as const }),
            authorizeOwner: rejectForbidden,
            connections: memberConnections,
        },
        members: { list: async () => [], add: async () => {}, remove: async (email) => void removed.push(email) },
    });
    const memberTicket = memberServices.wsTickets.mint({ email: "member@x.com", role: "viewer" });
    expect((await createApp(memberServices).request("/members/self", { method: "DELETE" })).status).toBe(200);
    expect(removed).toEqual(["member@x.com"]);
    expect(memberClose).toHaveBeenCalledOnce();
    expect(memberServices.wsTickets.redeem(memberTicket)).toBeUndefined();

    const ownerCannotSelfRemove = createApp(
        services({ auth: { authorize: async () => ({ email: "owner@x.com", role: "owner" as const }), authorizeOwner: async () => {} } }),
    );
    expect((await ownerCannotSelfRemove.request("/members/self", { method: "DELETE" })).status).toBe(400);
});

test("an editor-scoped control token reaches the agent-conversation surface and NOTHING else", async () => {
    // Auth rejects every bearer, so any 2xx below proves the x-intentic-control path admitted the call.
    const app = createApp(
        services({
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
            sessions: {
                list: async () => [],
                read: async () => [],
                search: async () => [],
                exists: async () => true,
            },
        }),
    );
    const editor = { "x-intentic-control": "ict_valid" };
    expect((await app.request("/sessions", { headers: editor })).status).toBe(200);
    // An unknown token is 401 on every route: it has no stored scope to check, so the daemon cannot say
    // anything about reach without first telling a stranger which routes exist.
    expect((await app.request("/sessions", { headers: { "x-intentic-control": "ict_wrong" } })).status).toBe(401);
    // A REAL token out of its scope is an explicit 403 (clear DX, not a baffling missing-bearer 401).
    expect((await app.request("/capabilities", { headers: editor })).status).toBe(403);
    expect((await app.request("/history/restore", { method: "POST", headers: editor })).status).toBe(403);
    expect((await app.request("/panels", { headers: editor })).status).toBe(403);
});

test("control-token scopes widen: read observes, drive works, only land merges", async () => {
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const as = (token: string, path: string, method = "GET") => app.request(path, { method, headers: { "x-intentic-control": token } });
    const forbidden = async (token: string, path: string, method = "GET") => (await as(token, path, method)).status === 403;

    // `read` sees the board and refuses every mutation on it.
    expect((await as("ict_read-token", "/agents")).status).toBe(200);
    expect(await forbidden("ict_read-token", "/agent", "POST")).toBe(true);
    expect(await forbidden("ict_read-token", "/agents/abc/land", "POST")).toBe(true);

    // `drive` works the agent but stops at the main tree: the whole reason the rung exists.
    expect((await as("ict_drive-token", "/agents")).status).toBe(200);
    expect(await forbidden("ict_drive-token", "/agents/abc/land", "POST")).toBe(true);
    expect(await forbidden("ict_drive-token", "/agents/abc/discard", "POST")).toBe(true);

    // `land` is the only scope the merge is open to. NOT_FOUND (the agent is fictional) proves it got past
    // the gate and reached the route, which is what this asserts: the handler's own answer is its business.
    expect((await as("ict_land-token", "/agents/abc/land", "POST")).status).not.toBe(403);

    // The floor holds for all three.
    for (const token of ["ict_read-token", "ict_drive-token", "ict_land-token"]) {
        expect(await forbidden(token, "/capabilities")).toBe(true);
        expect(await forbidden(token, "/vpn")).toBe(true);
    }
});

test("POST /enroll rejects a wrong connect token and 412s until DevOps (when auth is enforced)", async () => {
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "a@x.com", role: "owner" as const }), authorizeOwner: async () => {} },
            config: { ...testConfig, connectToken: "ct" },
        }),
    );
    const enroll = (token: string) =>
        app.request("/enroll", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-connect": token },
            body: JSON.stringify({ name: "prod", user: "deploy", address: "ssh-x.zone", sshKey: "KEY" }),
        });
    expect((await enroll("wrong")).status).toBe(401);
    // Right token, but the desired-state repo is absent under test → 412 (DevOps not active).
    expect((await enroll("ct")).status).toBe(412);
});

test("bearer middleware maps a ForbiddenError to 403 (wrong account) and any other auth failure to 401", async () => {
    // A verified-but-unauthorized identity → 403 with the daemon's message verbatim (the browser renders its
    // "no access" gate off the status, and surfaces the message).
    const forbiddenApp = createApp(services({ auth: { authorize: rejectForbidden, authorizeOwner: rejectForbidden } }));
    const forbidden = await forbiddenApp.request("/environment");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "not the sandbox owner" });

    // A missing/invalid token → 401, indistinguishable from an unreachable daemon on purpose.
    const unauthApp = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const unauth = await unauthApp.request("/environment");
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "unauthorized" });
});

test("the enrollment-minted sync token reads /ports, files its own machine report, and nothing else", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-token-home-"));
    // Bearer auth rejects everything, so a 200 proves the sync-token branch authorized the read.
    const app = createApp(
        services({
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
            config: {
                ...testConfig,
                connectToken: "token",
                historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
                sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
            },
            scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true }],
        }),
    );
    const enrolled = await app.request("/system/authorized-key", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-pair": mintPairing("mirror").token },
        body: JSON.stringify({ key: "ssh-ed25519 AAAAA laptop" }),
    });
    expect(enrolled.status).toBe(200);
    const { syncToken } = (await enrolled.json()) as { syncToken: string };
    expect(syncToken).toMatch(/^ist_/);

    const withToken = (path: string, method = "GET") => app.request(path, { method, headers: { "x-intentic-sync": syncToken } });
    const list = await withToken("/ports");
    expect(list.status).toBe(200);
    // Every row carries what it IS as well as where it answers: a listener with no command and no session is
    // named as exactly that rather than guessed at (ports/port-identity.ts).
    expect(await list.json()).toEqual({
        ports: [
            {
                port: 3000,
                host: "127.0.0.1",
                forwardable: true,
                kind: "system",
                forwarded: false,
                title: "Unclaimed port",
                purpose: "Something is listening here that no process in this sandbox owns, usually container plumbing.",
                origin: "unknown",
            },
        ],
    });
    /* The one WRITE the token carries: the machine's own report, the folders/ports/watcher half of desktop sync
     * that the daemon has no other way to learn (SYNC_DIR never reaches it). Filed under the enrollment that
     * presented the token, so the `hostname` in the body is a label and never an identity. */
    const report = {
        hostname: "laptop",
        os: "linux",
        agents: { sync: "0.1.0" },
        sandboxes: [],
        pairings: [{ sandboxId: "sandbox-abc.example.com", mode: "mirror" }],
        ports: [{ port: 3000, host: "127.0.0.1", sandboxId: "sandbox-abc.example.com", state: "mirrored" }],
        watcher: { running: true, pid: 42 },
        capturedAt: 1_700_000_000_000,
    };
    const filed = await app.request("/system/sync/report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-sync": syncToken },
        body: JSON.stringify(report),
    });
    expect(filed.status).toBe(200);
    // A body that isn't a report is refused as malformed rather than stored: this route takes a shape, not JSON.
    const malformed = await app.request("/system/sync/report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-sync": syncToken },
        body: JSON.stringify({ hostname: "laptop" }),
    });
    expect(malformed.status).toBe(400);
    // A token no enrollment owns cannot file a report for someone else's machine.
    const forged = await app.request("/system/sync/report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-sync": "ist_bogus" },
        body: JSON.stringify(report),
    });
    expect(forged.status).toBe(401);

    // Out of scope (403): any other route, and even the ports MUTATIONS, the token reads one list and writes
    // one report, and the report grants nothing back.
    expect((await withToken("/panels")).status).toBe(403);
    expect((await withToken("/ports/forward", "POST")).status).toBe(403);
    expect((await withToken("/system/sync")).status).toBe(403);
    // A bogus token on the in-scope route is plain unauthorized.
    expect((await app.request("/ports", { headers: { "x-intentic-sync": "ist_bogus" } })).status).toBe(401);
});

test("POST /automations/:id/fire skips bearer auth, enforces the automation token, and records a run", async () => {
    const store = memoryAutomationsStore([
        { id: "deploy", trigger: { kind: "event", token: "tok-1" }, prompt: "handle the event", enabled: true, runs: [] },
        { id: "paused", trigger: { kind: "event", token: "tok-2" }, prompt: "x", enabled: false, runs: [] },
        { id: "cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "x", enabled: true, runs: [] },
    ]);
    // Bearer auth rejects everything, so a 200 proves the route's exemption; the token is the only gate.
    const app = createApp(services({ automations: store, auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const fire = (path: string) => app.request(path, { method: "POST", body: "payload" });

    expect((await fire("/automations/ghost/fire?token=tok-1")).status).toBe(404);
    // Schedule automations can't be fired externally.
    expect((await fire("/automations/cron/fire?token=anything")).status).toBe(404);
    expect((await fire("/automations/deploy/fire?token=wrong")).status).toBe(401);
    expect((await fire("/automations/deploy/fire")).status).toBe(401);
    expect((await fire("/automations/paused/fire?token=tok-2")).status).toBe(409);

    const ok = await fire("/automations/deploy/fire?token=tok-1");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    // The turn runs detached (the fake agent completes instantly) and lands in the run history.
    await vi.waitFor(async () => expect((await store.get("deploy"))?.runs).toHaveLength(1), SETTLES);
    expect((await store.get("deploy"))?.runs[0]?.outcome).toBe("completed");
});

test("automations.run fires by hand on the real path: a disabled automation too, and past the approval gate", async () => {
    const store = memoryAutomationsStore([
        { id: "cron", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "sweep the logs", enabled: true, runs: [] },
        // Trying a prompt BEFORE switching the automation on is the main reason to press Run now, so: unlike the
        // webhook, which fails closed at 409 against an outside sender: an off automation still fires by hand.
        { id: "paused", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "x", enabled: false, runs: [] },
        // requireApproval would hold a scheduled fire in the owner's queue. Their own click is the approval.
        { id: "gated", trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "x", requireApproval: true, enabled: true, runs: [] },
    ]);
    const client = clientFor(createApp(services({ automations: store })));

    await expect(client.automations.run({ id: "ghost" })).rejects.toThrow();

    // The turn runs detached: the ack does not wait on it, because the guard alone may take a minute.
    expect(await client.automations.run({ id: "cron" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await store.get("cron"))?.runs).toHaveLength(1), SETTLES);
    expect((await store.get("cron"))?.runs[0]?.outcome).toBe("completed");

    expect(await client.automations.run({ id: "paused" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await store.get("paused"))?.runs).toHaveLength(1), SETTLES);

    expect(await client.automations.run({ id: "gated" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await store.get("gated"))?.runs).toHaveLength(1), SETTLES);
    expect((await store.get("gated"))?.runs[0]?.outcome).toBe("completed");
});

test("automations.setEnabled changes only enablement on a security-sensitive automation", async () => {
    const support = {
        id: "support",
        trigger: { kind: "listener" as const, provider: "webchat", eventType: "message", allowedOrigins: ["https://site.example"] },
        prompt: "answer support questions",
        webchat: {
            access: "google" as const,
            antiBot: "turnstile" as const,
            googleClientId: "client-id",
            turnstileSiteKey: "site-key",
            turnstileSecret: "secret-key",
        },
        allowedTools: ["Read", "Grep"],
        account: "night-account",
        holdForSeconds: 30,
        enabled: true,
        runs: [{ at: 1, outcome: "completed" as const }],
    };
    const store = memoryAutomationsStore([support]);
    const client = clientFor(createApp(services({ automations: store })));

    await expect(client.automations.setEnabled({ id: "missing", enabled: false })).rejects.toThrow();
    expect(await client.automations.setEnabled({ id: "support", enabled: false })).toEqual({ ok: true });
    expect(await store.get("support")).toEqual({ ...support, enabled: false });
});

test("POST /webchat/:id/message skips bearer auth, gates on the origin allowlist, reflects CORS, and records a run", async () => {
    const store = memoryAutomationsStore([
        {
            id: "support",
            trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://site.example"] },
            prompt: "help the visitor",
            enabled: true,
            runs: [],
        },
    ]);
    // Bearer auth rejects everything, so reaching the route at all (not a 401) proves the exemption; the origin
    // allowlist is the real gate. The widget's own origin is deliberately NOT in allowOrigins: /webchat reflects
    // the caller's origin regardless, which is what lets a legit embed on a third-party site through.
    const app = createApp(
        services({
            automations: store,
            config: { ...testConfig, webOrigin: "https://app.intentic" },
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
        }),
    );
    const send = (origin: string | undefined, body: unknown = { conversationId: "c1", content: "fix the header" }) =>
        app.request("/webchat/support/message", {
            method: "POST",
            headers: { "content-type": "application/json", ...(origin !== undefined ? { origin } : {}) },
            body: JSON.stringify(body),
        });

    // A disallowed / missing origin is refused by the route's own 403: NOT the bearer middleware's 401.
    expect((await send("https://evil.example")).status).toBe(403);
    expect((await send(undefined)).status).toBe(403);

    // An allowed origin streams back (text/event-stream) with CORS reflecting exactly that origin (not the daemon's
    // own app origin), and the wake runs to a recorded run through the real streamAgent + fake agent.
    const ok = await send("https://site.example");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://site.example");
    await ok.text();
    await vi.waitFor(async () => expect((await store.get("support"))?.runs).toHaveLength(1), SETTLES);
    expect((await store.get("support"))?.runs[0]?.outcome).toBe("completed");

    // The preflight is answered with the reflected origin too, so the browser lets the cross-site POST through.
    const preflight = await app.request("/webchat/support/message", { method: "OPTIONS", headers: { origin: "https://site.example" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://site.example");
});

test("agent.run streams the agent events, fenced by a user snapshot before and a turn snapshot after", async () => {
    const events: AgentEvent[] = [{ kind: "session", sessionId: "s1" }, { kind: "delta", text: "hi" }, { kind: "done" }];
    const triggers: string[] = [];
    const client = clientFor(
        createApp(
            services({
                history: fakeHistory({
                    snapshot: async (trigger) => {
                        triggers.push(trigger);
                        return undefined;
                    },
                }),
                agent: async function* () {
                    yield* events;
                },
            }),
        ),
    );
    /* Preamble frames dropped: an unstubbed git.sync makes every turn in this suite carry a repo-sync note, which
     * is a real injection being really disclosed (agent.routes.ts) and not part of what the adapter streamed.
     * The tier verdict goes with it and for the same reason: the complexity judge runs on every turn in the
     * default mode (settings.autoTier "shadow") and says so on its own frame, which the daemon adds ahead of
     * the adapter's stream. What this test is about is that the adapter's own frames arrive intact. */
    const frames = await runAgentTurn(client, { prompt: "do it" });
    expect(frames.filter((frame) => frame.kind !== "preamble" && frame.kind !== "tier")).toEqual(events);
    // Attribution: pending user changes are captured BEFORE the agent runs, so the turn snapshot is agent-only.
    expect(triggers).toEqual(["user", "turn"]);
});

test("agent.run resolves the oauth token from the sandbox store (not the body) and forwards model/session", async () => {
    let seen: { oauthToken?: string; model?: string; sessionId?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async (id) => (id === "default" ? { id: "default", label: "Claude", connectedAt: 0, accessToken: "tok-xyz" } : undefined),
                    write: async () => {},
                    clear: async () => {},
                    list: async () => [{ id: "default", label: "Claude", connectedAt: 0 }],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "do it", sessionId: "s1", model: "opus" });
    expect(seen?.oauthToken).toBe("tok-xyz");
    expect(seen?.model).toBe("opus");
    expect(seen?.sessionId).toBe("s1");
});

test("agent.run selects the Claude account named on the turn and forwards its token", async () => {
    let seen: { oauthToken?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                claudeStore: {
                    read: async (id) => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}` }),
                    write: async () => {},
                    clear: async () => {},
                    list: async () => [
                        { id: "a", label: "work", connectedAt: 1 },
                        { id: "b", label: "personal", connectedAt: 2 },
                    ],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "hi", account: "b" });
    expect(seen?.oauthToken).toBe("tok-b");
});

test("agent.run serves a Codex turn on the translator subscription over the local bearer, no per-turn home", async () => {
    let seen: { codexEndpoint?: { baseUrl: string; authToken: string }; codexHome?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: codexConnectedProxy,
                codexAgent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "codex" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
    // Served over the translator's OpenAI endpoint on the fixed local bearer; the adapter's default home serves.
    expect(seen?.codexEndpoint).toEqual({ baseUrl: "http://127.0.0.1:8788", authToken: "local-bearer" });
    expect(seen?.codexHome).toBeUndefined();
});

test("agent.run gates a Codex turn with no subscription and no api key as subscription-required", async () => {
    let codexCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                codexAgent: async function* () {
                    codexCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "codex" });
    expect(codexCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.code === "subscription-required")).toBe(true);
});

/* GEMINI HAS NO CLAUDE CODE ROAD LEFT, and this is the test that holds the door shut.
 *
 * It used to have one: every Gemini turn was routed through that loop before it got a native runtime. Then
 * Google's Antigravity channel began refusing on the identity line the Claude Code CLI bakes into every request
 * and no option removes, reporting it as a spent quota it never was. That made the selection not a slower
 * option but an impossible one, so the contract stopped offering it at all: capabilitiesOf answers Gemini's own
 * runtime whatever harness is asked for.
 *
 * ASKING FOR IT EXPLICITLY IS THE CASE WORTH PINNING, because that is the one a stored conversation, an
 * automation or an API caller can still do. It must land on the working loop rather than be honoured. */
test("agent.run sends a Gemini turn to the native runtime even when the Claude Code harness is asked for by name", async () => {
    let claudeCodeCalled = false;
    let nativeCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: {
                    accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
                    connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
                    complete: async () => {},
                    disconnect: async () => {},
                    models: async () => [],
                },
                agent: async function* () {
                    claudeCodeCalled = true;
                    yield { kind: "done" };
                },
                geminiAgent: async function* () {
                    nativeCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const events = await runAgentTurn(client, { prompt: "hi", agent: "gemini", harness: "claude-code" });

    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(nativeCalled).toBe(true);
    expect(claudeCodeCalled).toBe(false);
});

test("agent.run serves Kimi K3 on the Kimi Code subscription through the translator", async () => {
    let seen: { baseUrl?: string; authToken?: string; model?: string; oauthToken?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: {
                    accounts: async () => ({ codex: [], grok: [], kimi: [{ name: "kimi-user.json", label: "Kimi User" }], gemini: [] }),
                    connect: async () => ({ url: "", code: "", state: "", flow: "device" as const }),
                    complete: async () => {},
                    disconnect: async () => {},
                    models: async () => [{ id: "kimi-k3", label: "Kimi K3" }],
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const events = await runAgentTurn(client, { prompt: "hi", agent: "kimi" });

    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(seen?.baseUrl).toBe("http://127.0.0.1:8788");
    expect(seen?.authToken).toBe("local-bearer");
    expect(seen?.model).toBe("kimi-k3");
    expect(seen?.oauthToken).toBeUndefined();
});

test("agent.run keeps a pinned Gemini model the catalog still offers, and drops one it doesn't", async () => {
    const models = ["gemini-pro-agent", "gemini-3-flash"];
    const geminiConnected = {
        accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
        connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
        complete: async () => {},
        disconnect: async () => {},
        models: async () => [],
    };
    // Read off the NATIVE runner, which is the only one a Gemini turn reaches now: the catalog-membership rule
    // itself is unchanged, and it is the rule this test is about. Overridden on the DIRECT member the arm
    // reads (the gemini module resolves through its own slice, not through the derived record).
    const run = async (model: string): Promise<string | undefined> => {
        let seen: { model?: string } | undefined;
        const client = clientFor(
            createApp(
                services({
                    config: withTranslator,
                    cliProxy: geminiConnected,
                    geminiModels: {
                        models: async () => ({
                            models: models.map((id) => ({ id, label: id, inputModalities: ["text" as const] })),
                            default: models[0]!,
                        }),
                    },
                    geminiAgent: async function* (request) {
                        seen = request;
                        yield { kind: "done" };
                    },
                }),
            ),
        );
        await runAgentTurn(client, { prompt: "hi", agent: "gemini", model });
        return seen?.model;
    };
    expect(await run("gemini-3-flash")).toBe("gemini-3-flash");
    // A retired pick fails catalog membership and falls to the live default rather than 400ing upstream.
    expect(await run("gemini-2.5-pro")).toBe("gemini-pro-agent");
});

// No Google account is still a refusal that names the fix, and it is the NATIVE runtime that owns that gate now
//: both loops always wanted the same credential (the translator's), so removing the routed road cost the check
// nothing. Asserted on the sentence rather than the code: this refusal comes from the turn plan, which speaks
// prose, where the routed gate carried the composer's `subscription-required` discriminator.
test("agent.run gates a Gemini turn with no Google account connected", async () => {
    let nativeCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                geminiAgent: async function* () {
                    nativeCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const events = await runAgentTurn(client, { prompt: "hi", agent: "gemini" });

    expect(nativeCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && /Connect your Google account/.test(String(event.message)))).toBe(true);
});

/* A GEMINI TURN THAT NAMES NO HARNESS TAKES THE NATIVE RUNTIME: the default flipped when Gemini got one, and
 * this is the test that says so out loud rather than leaving it to be discovered.
 *
 * It matters because `native` is what agent.routes fills in for a turn that omits the field, so this is the
 * answer for every API caller and every stored conversation that predates the switch. Flipping it is the point:
 * the Claude Code loop is the road Google refuses, so defaulting to it would default to the broken one.
 *
 * Asserted through the RUNNER that was reached: geminiAgent is the OpenCode loop, `agent` is Claude Code, so
 * this pins the dispatch rather than a message about it. */
test("agent.run sends a Gemini turn with no harness to the native OpenCode runtime, not the Claude Code loop", async () => {
    let claudeCodeCalled = false;
    let nativeCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                // The native runtime's credential is the translator's, exactly as the routed one's is: one
                // connected Google account is all either harness needs.
                cliProxy: {
                    accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
                    connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
                    complete: async () => {},
                    disconnect: async () => {},
                    models: async () => [],
                },
                agent: async function* () {
                    claudeCodeCalled = true;
                    yield { kind: "done" };
                },
                geminiAgent: async function* () {
                    nativeCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const events = await runAgentTurn(client, { prompt: "hi", agent: "gemini" });

    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(nativeCalled).toBe(true);
    expect(claudeCodeCalled).toBe(false);
});

test("agent.run runs a Codex turn whose thread is gone as a fresh one, rather than refusing it", async () => {
    let seen: { sessionId?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: codexConnectedProxy,
                codexThreadExists: async () => false,
                codexAgent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "hi", agent: "codex", sessionId: "gone" });
    // The dead id is dropped rather than handed on: a resume against it fails opaquely inside the CLI.
    expect(seen?.sessionId).toBeUndefined();
    expect(events.some((event) => event.kind === "error")).toBe(false);
});

test("agent.run sends a Grok turn an explicit live-valid model, replacing an invalid or absent pinned id", async () => {
    const seen: (string | undefined)[] = [];
    const grokApp = () =>
        clientFor(
            createApp(
                services({
                    openCode: {
                        client: async () => ({}) as never,
                        events: async () => ({ stream: { async *[Symbol.asyncIterator]() {} } }),
                        watch: async () => {},
                        url: async () => "http://127.0.0.1:4096",
                        connected: async () => true,
                        sessionExists: async () => true,
                        xaiModels: async () => ({
                            models: [{ id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" }],
                            default: "grok-4.20-0309-reasoning",
                        }),
                        recordModels: async () => {},
                        disconnect: async () => {},
                    },
                    grokAgent: async function* (request) {
                        seen.push(request.model);
                        yield { kind: "done" };
                    },
                }),
            ),
        );
    await runAgentTurn(grokApp(), { prompt: "hi", agent: "grok", model: "grok-code-fast-1" }); // retired ⇒ live default
    await runAgentTurn(grokApp(), { prompt: "hi", agent: "grok", model: "grok-4.20-0309-reasoning" }); // still served ⇒ kept
    await runAgentTurn(grokApp(), { prompt: "hi", agent: "grok" }); // none ⇒ live default
    expect(seen).toEqual(["grok-4.20-0309-reasoning", "grok-4.20-0309-reasoning", "grok-4.20-0309-reasoning"]);
});

test("agent.run merges internal (env) tools with the mcp-kind capabilities for the turn", async () => {
    let seen: { tools?: readonly AgentTool[] } | undefined;
    const client = clientFor(
        createApp(
            services({
                tools: [{ name: "obs", url: "https://signoz.example.com/mcp", token: "internal" }],
                capabilities: memoryCapabilitiesStore([
                    { id: "linear", kind: "mcp", config: { url: "https://mcp.linear.app/sse", token: "external" } },
                ]),
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "do it" });
    // Internal first, then external mcp capabilities (last-wins on name collisions).
    expect(seen?.tools).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: "internal" },
        { name: "linear", url: "https://mcp.linear.app/sse", token: "external" },
    ]);
});

test("capabilities.setSecret replaces just the secret, and reveal returns it: even pre-scaffold", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh-1" } };
    const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };
    const client = clientFor(createApp(services({ capabilities: memoryCapabilitiesStore([github, reddit]) })));
    await client.capabilities.setSecret({ id: "github", value: "gh-2" });
    // No desired-state repo under test: capability reveal works before DevOps scaffolds it.
    expect(await client.secrets.reveal({ key: "github" })).toEqual({ value: "gh-2" });
    // A secretless capability is CONFLICT; an unknown id is NOT_FOUND.
    expect(await errorCode(client.capabilities.setSecret({ id: "reddit", value: "x" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.setSecret({ id: "ghost", value: "x" }))).toBe("NOT_FOUND");
});

test("capabilities.otp mints an expiring code off the stored seed and never reveals it", async () => {
    const npm: Capability = {
        id: "npm",
        kind: "cli",
        config: { provider: "npm", token: "npm-tok", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
    };
    const bare: Capability = { id: "bare", kind: "cli", config: { provider: "npm", token: "npm-tok" } };
    const client = clientFor(createApp(services({ capabilities: memoryCapabilitiesStore([npm, bare]) })));
    const minted = await client.capabilities.otp({ id: "npm" });
    // A six-digit code with its period's countdown, and nothing that could be the seed itself.
    expect(minted).toEqual({ code: expect.stringMatching(/^\d{6}$/), secondsRemaining: expect.any(Number) });
    expect(minted.secondsRemaining).toBeGreaterThan(0);
    expect(minted.secondsRemaining).toBeLessThanOrEqual(30);
    // A connection without a stored seed is CONFLICT; an unknown id is NOT_FOUND.
    expect(await errorCode(client.capabilities.otp({ id: "bare" }))).toBe("CONFLICT");
    expect(await errorCode(client.capabilities.otp({ id: "ghost" }))).toBe("NOT_FOUND");
});

test("agent.run surfaces a connect-your-account error (not an opaque CLI failure) when no account and no env creds", async () => {
    let agentCalled = false;
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {}, list: async () => [] },
                agent: async function* () {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "do it" });
    // The turn never reaches the agent: the user gets an actionable message instead of exit-code-1.
    expect(agentCalled).toBe(false);
    expect(events.some((event) => event.kind === "error" && event.message.includes("No Claude account connected"))).toBe(true);
});

/* THE STOPPED-IN-ITS-OPENING-SECONDS CASE, which is what makes this the ordinary path rather than the rebuilt-
 * sandbox curiosity it was written for. A runtime reports its session id in its first frame and writes the
 * session out seconds later, so a turn stopped in between leaves the conversation holding an id nothing was ever
 * saved under, and the next message was refused, telling the user their history was gone (naming two causes,
 * neither of which had happened) and asking them to send it again. The record outlives every session, so there
 * is nothing here the user was needed for. */
test("agent.run reopens a conversation whose session the sandbox never stored, seeded from its own record", async () => {
    let seen: { prompt?: string; sessionId?: string } | undefined;
    const recorded: RestoredMessage[] = [
        { role: "user", text: "what is 2+2?" },
        { role: "assistant", text: "4" },
    ];
    const client = clientFor(
        createApp(
            services({
                sessions: {
                    list: async () => [],
                    read: async () => [],
                    search: async () => [],
                    exists: async () => false,
                },
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async () => recorded,
                    open: async () => {},
                    fork: async () => {},
                    append: async () => {},
                    count: async () => recorded.length,
                    truncate: async () => 0,
                },
            }),
        ),
    );
    const events = await runAgentTurn(client, { prompt: "and now?", conversationId: "conv-stopped", sessionId: "gone" });
    expect(events.some((event) => event.kind === "error")).toBe(false);
    // Fresh session, carrying what the conversation already said: the same handoff a provider switch gets.
    expect(seen?.sessionId).toBeUndefined();
    expect(seen?.prompt).toContain("User: what is 2+2?");
    expect(seen?.prompt?.endsWith("and now?")).toBe(true);
});

test("agent.run folds a switched conversation's history into the prompt as a role-attributed preamble", async () => {
    let seen: { prompt?: string } | undefined;
    // The daemon's OWN record of the conversation: the seed for a turn that resumes no session, which is what
    // a provider/account/harness switch leaves behind. The client never sends a transcript up the wire.
    const recorded: RestoredMessage[] = [
        { role: "user", text: "what is 2+2?" },
        { role: "assistant", text: "4" },
    ];
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async () => recorded,
                    open: async () => {},
                    fork: async () => {},
                    append: async () => {},
                    count: async () => recorded.length,
                    truncate: async () => 0,
                },
            }),
        ),
    );
    // No sessionId: the retired session is exactly the case the preamble exists for.
    await runAgentTurn(client, { prompt: "and now?", conversationId: "conv-switched" });
    expect(seen?.prompt).toContain("continues from another AI runtime");
    expect(seen?.prompt).toContain("User: what is 2+2?");
    expect(seen?.prompt).toContain("Assistant: 4");
    // The user's actual message closes the prompt, after the preamble.
    expect(seen?.prompt?.endsWith("and now?")).toBe(true);
});

test("agent.run folds attachments into the claude prompt as absolute paths, allowing an attachment-only turn", async () => {
    let seen: { prompt?: string } | undefined;
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "", attachments: [`${STATE_DIR}/records/artifacts/attachments/x/shot.png`] });
    expect(seen?.prompt).toContain("/work/.intentic/records/artifacts/attachments/x/shot.png");
});

test("agent.run rejects an attachment path escaping the workspace with an error frame", async () => {
    const client = clientFor(createApp(services()));
    const events = await runAgentTurn(client, { prompt: "look", attachments: ["../escape.png"] });
    expect(events).toEqual([{ kind: "error", message: "invalid attachment path: ../escape.png" }, { kind: "done" }]);
});

/* STOPPING A TURN IS NOT A FAILURE: end to end, because the failure was assembled from three files agreeing
 * with each other. Every provider adapter reports the unwind of a hard-cancel as an error frame (from inside
 * one, an abort is indistinguishable from the provider dying), the registry reads any error frame as how the
 * turn ended, and the card draws that as `error` in the Attention lane. So the user pressed Stop and watched
 * their own deliberate press come back accusing them of a crash: after a wait, since the roster went on
 * saying `running` for the whole unwind. The fake agent below is that adapter behaviour, exactly. */
test("a stopped turn settles as stopped, with no error frame reaching the client, the log, or the card", async () => {
    let started: (() => void) | undefined;
    let abort: (() => void) | undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const aborted = new Promise<void>((resolve) => (abort = resolve));
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    request.signal.addEventListener("abort", () => abort?.(), { once: true });
                    started?.();
                    await aborted;
                    yield { kind: "error", message: "Claude Code process exited with code 143" };
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await client.agent.run({ prompt: "long task", conversationId: "conv1", isolated: true });
    // The run is DETACHED: the route acks the id and the pump walks the generator chain after it. The
    // adapter's first line is the barrier that says the chain got as far as registering the turn's abort
    // handle; stopping before that finds nothing to cancel, and the turn would sit here forever.
    await running;
    // Resolves only once the run has unwound, which is the same barrier the browser's Stop waits on.
    expect(await client.agent.stop({ conversationId: "conv1" })).toEqual({ ok: true });

    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "stopped" });
    // And nothing in the transcript a window replaying this run would draw as a failure.
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    const events = frames.flatMap((frame) => (frame.kind === "frame" ? [frame.event] : []));
    expect(events.filter((event) => event.kind === "error")).toEqual([]);

    // A stop with nothing running is still NOT_FOUND: the client retires its own control on that answer.
    expect(await errorCode(client.agent.stop({ conversationId: "conv1" }))).toBe("NOT_FOUND");
});

test("environment: lower roles read state, maintainers approve/reject, and failures map to statuses", async () => {
    const disk = new Map<string, string>();
    const memoryFiles = fakeFiles({
        read: async (path) => disk.get(path),
        write: async (path, content) => {
            disk.set(path, content as string);
        },
        remove: async (path) => {
            disk.delete(path);
        },
    });
    // A proposal is custom-section content only (the daemon owns the FROM).
    const proposal = "RUN apt-get install -y cowsay\n";
    const hash = sha256Hex(proposal);
    disk.set(`${WORKSPACE_ROOT}/${STATE_DIR}/config/environment.Dockerfile`, proposal);

    // A collaborator sees the state but cannot approve or reject.
    const memberApp = createApp(
        services({
            files: memoryFiles,
            auth: { authorize: async () => ({ email: "member@example.com", role: "collaborator" as const }), authorizeOwner: rejectForbidden },
        }),
    );
    const seen = await memberApp.request("/environment");
    expect(seen.status).toBe(200);
    expect(await seen.json()).toEqual({ proposal: { content: proposal, hash } });
    const approveDenied = await postJson(memberApp, "/environment/approve", { hash });
    expect(approveDenied.status).toBe(403);
    expect(await approveDenied.json()).toEqual({ error: "not a sandbox maintainer" });
    expect((await postJson(memberApp, "/environment/reject")).status).toBe(403);

    // Loopback (no auth) is the owner, like every other route.
    const ownerApp = createApp(services({ files: memoryFiles }));
    expect((await postJson(ownerApp, "/environment/approve")).status).toBe(400);
    expect((await postJson(ownerApp, "/environment/approve", { hash: "stale" })).status).toBe(409);
    const approved = await postJson(ownerApp, "/environment/approve", { hash });
    expect(approved.status).toBe(200);
    // Approve stores the custom section verbatim and returns the daemon-composed approved artifact.
    const state = (await approved.json()) as { proposal: unknown; custom: unknown; approved?: { content: string; hash: string } };
    expect(state.proposal).toEqual({ content: proposal, hash });
    expect(state.custom).toEqual({ content: proposal, hash });
    expect(state.approved?.content).toContain("FROM ghcr.io/intentic/sandbox:stable");
    expect(state.approved?.content).toContain(proposal.trim());
    expect(state.approved?.hash).toBe(sha256Hex(state.approved?.content ?? ""));

    // Reject deletes the proposal; approving with nothing proposed is a 404.
    expect((await postJson(ownerApp, "/environment/reject")).status).toBe(200);
    expect((await postJson(ownerApp, "/environment/approve", { hash })).status).toBe(404);

    // A proposal carrying its own FROM is invalid: the daemon owns the base image.
    disk.set("/work/.intentic/config/environment.Dockerfile", "FROM alpine:latest\n");
    expect((await postJson(ownerApp, "/environment/approve", { hash: sha256Hex("FROM alpine:latest\n") })).status).toBe(400);
});

/* The panel token, not the panels routes: a server-side panel calls the daemon with `x-intentic-panel`
 * instead of a Google bearer, and /panels is only the route it happens to knock on. The credential belongs to
 * the app's middleware, so it is checked where the middleware is. */
test("the panel token is accepted in place of a Google bearer (server-side panel → daemon calls)", async () => {
    // Auth rejects every bearer, so a 200 proves the x-intentic-panel token is the only thing admitting the call.
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await app.request("/panels", { headers: { "x-intentic-panel": "panel-secret" } })).status).toBe(200);
    expect((await app.request("/panels", { headers: { "x-intentic-panel": "wrong" } })).status).toBe(401);
    expect((await app.request("/panels")).status).toBe(401);
});
