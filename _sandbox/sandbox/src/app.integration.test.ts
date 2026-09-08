import { mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { SETTLES } from "@intentic/testing/vitest";

import { type AgentEvent, type Capability, isTurnFact, type TranscriptRow } from "@intentic/sandbox-contract";

import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";

import { expect, test, vi } from "vitest";

import { createApp } from "./app.js";
import { createAuthConnections } from "./auth/connections.js";

import { createLogger } from "./logger.js";

import { createBootTracker } from "./platform/boot/boot.js";

import type { AgentTool } from "./agent/tools/agent-tools.js";

import { testConfig } from "./testing.js";

import { clientFor, collect, errorCode, postJson, rejectAuth, rejectForbidden } from "./harness/route-client.testing.js";
import { fakeFiles, fakeHistory } from "./harness/route-fakes.testing.js";
import { codexConnectedProxy, services, withTranslator } from "./harness/route-services.testing.js";
import { automationRecord, memoryAutomationsStore, memoryCapabilitiesStore } from "./harness/route-stores.testing.js";
import { runAgentTurn } from "./harness/route-turns.testing.js";
import { windowOf } from "./sessions/transcript-record.js";

test("GET /health reports ok, and names the sandbox so a loopback probe can tell WHICH daemon answered", async () => {
    const res = await createApp(services()).request("/health");
    expect(res.status).toBe(200);
    // No connect token: nothing to name, so no sandboxId in the body.
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await (await createApp(services()).request("/health")).json()).not.toHaveProperty("sandboxId");

    // The id is the same digest the tunnel hostname and the published port derive from.
    const named = await createApp(services({ config: { ...testConfig, connectToken: "tok" } })).request("/health");
    expect(await named.json()).toMatchObject({ ok: true, sandboxId: sandboxIdFromToken("tok") });

    // The profile rides on the liveness probe since a local client needs it before any authenticated read.
    expect(await (await createApp(services()).request("/health")).json()).toMatchObject({ profile: "container" });
    const local = services({ config: { ...testConfig, sandbox: { ...testConfig.sandbox, profile: "local" } } });
    expect(await (await createApp(local).request("/health")).json()).toMatchObject({ profile: "local" });
});

// /health answers a stranger with the sandbox id, which the loopback port also derives from.
// CORS is the actual gate here: without an allowlist, any open page could read the id and derive every preview
// hostname.
test("CORS names the configured origins and no others, so an arbitrary page cannot read /health", async () => {
    const app = createApp(
        services({
            config: { ...testConfig, connectToken: "tok", webOrigin: "https://app.intentic.dev,https://localhost:47145" },
            auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
        }),
    );
    const originOf = async (origin: string) => (await app.request("/health", { headers: { origin } })).headers.get("access-control-allow-origin");

    // Each configured origin is reflected verbatim; a list lets one sandbox serve the hosted SPA and a dev origin.
    expect(await originOf("https://app.intentic.dev")).toBe("https://app.intentic.dev");
    expect(await originOf("https://localhost:47145")).toBe("https://localhost:47145");

    // No auth at all is the local profile's shape: the host serves its own origin and preflights loopback normally.
    const authless = createApp(services({ config: { ...testConfig, webOrigin: "http://127.0.0.1:47188" } }));
    const authlessProbe = await authless.request("/health", { headers: { origin: "http://127.0.0.1:47188" } });
    expect(authlessProbe.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:47188");

    // A family entry admits one floating label (a webview's own origin), not subdomain chains or foreign hosts.
    const family = createApp(services({ config: { ...testConfig, webOrigin: "https://*.webview.example.net" } }));
    const familyOf = async (origin: string) => (await family.request("/health", { headers: { origin } })).headers.get("access-control-allow-origin");
    expect(await familyOf("https://0a1b2c.webview.example.net")).toBe("https://0a1b2c.webview.example.net");
    expect(await familyOf("https://a.b.webview.example.net")).toBeNull();
    expect(await familyOf("https://webview.example.net")).toBeNull();
    expect(await familyOf("https://x.webview.example.net.evil.dev")).toBeNull();

    // Anything else gets no header, not a wildcard or someone else's origin; the browser refuses the read.
    expect(await originOf("https://evil.example")).toBeNull();
    // A lookalike that merely contains a configured origin still gets nothing: reflection is exact-match.
    expect(await originOf("https://app.intentic.dev.evil.example")).toBeNull();

    // The body is still served regardless; CORS decides who may read it, not whether the daemon answers.
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

    // A data route parks until the chain converges; an early request waits instead of reading half-built state.
    let settled = false;
    const held = (async (): Promise<Response> => {
        const response = await app.request("/settings");
        settled = true;
        return response;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // /system/session must answer straight through: it mints the credential a browser needs to open /events.
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/system/session", { method: "POST" })).status).not.toBe(200);

    boot.finish();
    expect((await held).status).toBe(200);
});

test("system.session in loopback mode (no auth, no identity) answers 401: there is no session to mint", async () => {
    expect((await postJson(createApp(services({})), "/system/session")).status).toBe(401);
});

// WebSocket upgrades can't carry an Authorization header, so this route mints a one-shot ticket the URL carries
// instead.
// It still has to be gated like any authenticated route: by the middleware, on a header.
test("POST /system/ws-ticket mints a one-shot ticket for the verified caller, and 401s an unauthenticated one", async () => {
    const app = createApp(
        services({ auth: { authorize: async () => ({ email: "o@x.com", role: "owner" as const }), authorizeOwner: rejectForbidden } }),
    );
    const response = await postJson(app, "/system/ws-ticket");
    expect(response.status).toBe(200);
    const { ticket } = (await response.json()) as { ticket: string };
    expect(ticket).toEqual(expect.any(String));

    // Rejected bearer means no ticket: the mint itself is the gate.
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
    // A verified lower role gets 403 and nothing rotates.
    expect((await postJson(createApp(services({ auth })), "/system/sessions/revoke")).status).toBe(403);
    expect(rotations).toBe(0);

    const ownerServices = services({
        auth: { ...auth, authorize: async () => ({ email: "owner@x.com", role: "owner" as const }), authorizeOwner: async () => {} },
    });
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

    // A prior partial deletion already disabled ordinary authorize(); retirement bypasses only that gate and
    // re-verifies the owner.
    // A retry can then finish instead of staying locked out by the earlier attempt.
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
                readTail: async () => [],
                search: async () => [],
                exists: async () => true,
            },
        }),
    );
    const editor = { "x-intentic-control": "ict_valid" };
    expect((await app.request("/sessions", { headers: editor })).status).toBe(200);
    // An unknown token 401s everywhere: no stored scope to check, and saying otherwise leaks which routes exist.
    expect((await app.request("/sessions", { headers: { "x-intentic-control": "ict_wrong" } })).status).toBe(401);
    // A real token out of its scope is an explicit 403, not a missing-bearer 401.
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

    // `drive` works the agent but stops at the main tree.
    expect((await as("ict_drive-token", "/agents")).status).toBe(200);
    expect(await forbidden("ict_drive-token", "/agents/abc/land", "POST")).toBe(true);
    expect(await forbidden("ict_drive-token", "/agents/abc/discard", "POST")).toBe(true);

    // `land` is the only scope the merge is open to; NOT_FOUND here proves it reached the route, past the gate.
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
    // Right token, but the desired-state repo is absent under test, so 412 (DevOps not active).
    expect((await enroll("ct")).status).toBe(412);
});

test("bearer middleware maps a ForbiddenError to 403 (wrong account) and any other auth failure to 401", async () => {
    // A verified-but-unauthorized identity gets 403 with the daemon's message verbatim.
    const forbiddenApp = createApp(services({ auth: { authorize: rejectForbidden, authorizeOwner: rejectForbidden } }));
    const forbidden = await forbiddenApp.request("/environment");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "not the sandbox owner" });

    // A missing/invalid token is 401, indistinguishable from an unreachable daemon.
    const unauthApp = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const unauth = await unauthApp.request("/environment");
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: "unauthorized" });
});

test("the enrollment-minted sync token reads /ports, files its own machine report, and nothing else", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-token-home-"));
    // Bearer auth rejects everything, so a 200 proves the sync-token branch authorized the read.
    const svc = services({
        auth: { authorize: rejectAuth, authorizeOwner: rejectAuth },
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
        scanPorts: async () => [{ port: 3000, host: "127.0.0.1", forwardable: true }],
    });
    const app = createApp(svc);
    const enrolled = await app.request("/system/authorized-key", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-pair": svc.syncPairings.mint("mirror").token },
        body: JSON.stringify({ key: "ssh-ed25519 AAAAA laptop" }),
    });
    expect(enrolled.status).toBe(200);
    const { syncToken } = (await enrolled.json()) as { syncToken: string };
    expect(syncToken).toMatch(/^ist_/);

    const withToken = (path: string, method = "GET") => app.request(path, { method, headers: { "x-intentic-sync": syncToken } });
    const list = await withToken("/ports");
    expect(list.status).toBe(200);
    // Every row names what it is, not just where it answers; an unowned listener is named as such.
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
    // The one write the token carries: the device's own report (folders/ports/agent), the only way the daemon learns
    // it.
    // Filed under the enrollment that presented the token; `hostname` in the body is a label, never an identity.
    const report = {
        hostname: "laptop",
        os: "linux",
        sandboxes: [],
        pairings: [{ sandboxId: "sandbox-abc.example.com", mode: "mirror" }],
        ports: [{ port: 3000, host: "127.0.0.1", sandboxId: "sandbox-abc.example.com", state: "mirrored" }],
        agent: { running: true, pid: 42, installed: "0.1.0" },
        capturedAt: 1_700_000_000_000,
    };
    const filed = await app.request("/system/sync/report", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-sync": syncToken },
        body: JSON.stringify(report),
    });
    expect(filed.status).toBe(200);
    // A body that isn't a report is refused as malformed: this route takes a shape, not raw JSON.
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

    // Out of scope (403) elsewhere, including port mutations: the token reads one list, writes one report.
    expect((await withToken("/panels")).status).toBe(403);
    expect((await withToken("/ports/forward", "POST")).status).toBe(403);
    expect((await withToken("/system/sync")).status).toBe(403);
    // A bogus token on the in-scope route is plain unauthorized.
    expect((await app.request("/ports", { headers: { "x-intentic-sync": "ist_bogus" } })).status).toBe(401);
});

test("POST /automations/:id/fire skips bearer auth, enforces the door's token from the query or a bearer header, and records a run", async () => {
    const store = memoryAutomationsStore([
        automationRecord("deploy", { trigger: { kind: "event" }, prompt: "handle the event" }),
        automationRecord("paused", { trigger: { kind: "event" }, prompt: "x", enabled: false }),
        automationRecord("cron", { prompt: "x" }),
    ]);
    // Bearer auth rejects everything, so a 200 proves the route's exemption; the door's token is the only gate.
    const composed = services({ automations: store, auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } });
    const app = createApp(composed);
    // The credential lives in the door store, never on the record: this is what an operator copies off the row.
    const deployToken = await composed.doorTokens.ensure("automation", "deploy");
    const pausedToken = await composed.doorTokens.ensure("automation", "paused");
    const fire = (path: string, headers: Record<string, string> = {}) => app.request(path, { method: "POST", body: "payload", headers });

    expect((await fire(`/automations/ghost/fire?token=${deployToken}`)).status).toBe(404);
    // Schedule automations can't be fired externally.
    expect((await fire("/automations/cron/fire?token=anything")).status).toBe(404);
    expect((await fire("/automations/deploy/fire?token=wrong")).status).toBe(401);
    expect((await fire("/automations/deploy/fire")).status).toBe(401);
    expect((await fire(`/automations/paused/fire?token=${pausedToken}`)).status).toBe(409);
    // A caller that can set a header keeps the credential out of the URL, and the header wins over a stale query.
    expect((await fire("/automations/paused/fire?token=stale", { authorization: `Bearer ${pausedToken}` })).status).toBe(409);
    expect((await fire("/automations/deploy/fire", { authorization: "Bearer wrong" })).status).toBe(401);

    const ok = await fire(`/automations/deploy/fire?token=${deployToken}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    // The turn runs detached (the fake agent completes instantly) and lands in the run history.
    await vi.waitFor(async () => expect((await store.get("deploy"))?.runs).toHaveLength(1), SETTLES);
    expect((await store.get("deploy"))?.runs[0]?.outcome).toBe("completed");
});

test("automations.run fires by hand on the real path: a disabled automation too, and past the approval gate", async () => {
    const store = memoryAutomationsStore([
        automationRecord("cron", { trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "sweep the logs" }),
        // Trying a prompt BEFORE switching the automation on is the main reason to press Run now, so: unlike the
        // webhook, which fails closed at 409 against an outside sender: an off automation still fires by hand.
        automationRecord("paused", { trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "x", enabled: false }),
        // requireApproval would hold a scheduled fire in the owner's queue. Their own click is the approval.
        automationRecord("gated", { trigger: { kind: "schedule", cron: "0 3 * * *" }, prompt: "x", requireApproval: true }),
    ]);
    const client = clientFor(createApp(services({ automations: store })));

    await expect(client.automations.run({ id: "ghost" })).rejects.toThrow();

    // The turn runs detached; the ack doesn't wait on it since the guard alone can take a minute.
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
    const support = automationRecord("support", {
        trigger: { kind: "listener", provider: "webchat", eventType: "message", allowedOrigins: ["https://site.example"] },
        prompt: "answer support questions",
        webchat: {
            access: "google",
            antiBot: "turnstile",
            googleClientId: "client-id",
            turnstileSiteKey: "site-key",
            turnstileSecret: "secret-key",
        },
        allowedTools: ["Read", "Grep"],
        account: "night-account",
        holdForSeconds: 30,
        runs: [{ at: 1, outcome: "completed" }],
    });
    const store = memoryAutomationsStore([support]);
    const client = clientFor(createApp(services({ automations: store })));

    await expect(client.automations.setEnabled({ id: "missing", enabled: false })).rejects.toThrow();
    expect(await client.automations.setEnabled({ id: "support", enabled: false })).toEqual({ ok: true });
    expect(await store.get("support")).toEqual({ ...support, enabled: false });
});

test("POST /webchat/:id/message skips bearer auth, gates on the origin allowlist, reflects CORS, and records a run", async () => {
    const store = memoryAutomationsStore([
        automationRecord("support", {
            trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://site.example"] },
            prompt: "help the visitor",
        }),
    ]);
    // Bearer auth rejects everything, so reaching the route at all proves the exemption; the origin allowlist is the
    // real gate.
    // The widget's own origin isn't in allowOrigins: /webchat reflects the caller's origin regardless, letting a
    // third-party embed through.
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

    // A disallowed / missing origin is refused by the route's own 403, not the bearer middleware's 401.
    expect((await send("https://evil.example")).status).toBe(403);
    expect((await send(undefined)).status).toBe(403);

    // An allowed origin streams back as text/event-stream, with CORS reflecting that origin, not the daemon's own.
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
                async *agent() {
                    yield* events;
                },
            }),
        ),
    );
    // Tier verdict is dropped: the complexity judge runs every turn by default (settings.autoTier "shadow") and reports
    // its own fact.
    // The repo-sync note this suite's unstubbed git.sync adds lands on the user's row instead, not as a fact.
    const { facts, rows } = await runAgentTurn(client, { prompt: "do it" });
    // The session frame carries the account the daemon resolved (here, "default"), since a session resumes only under
    // the credential that minted it.
    // Everything else arrives exactly as the adapter streamed it.
    expect(facts.filter((fact) => fact.kind !== "tier")).toEqual(
        events.filter(isTurnFact).map((event) => (event.kind === "session" ? { ...event, account: "default" } : event)),
    );
    expect(rows).toMatchObject([
        { role: "user", text: "do it" },
        { role: "assistant", text: "hi" },
    ]);
    // Pending user changes are captured before the agent runs; the turn snapshot is agent-only.
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
                async *agent(request) {
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
                async *agent(request) {
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
                async *codexAgent(request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "codex" });
    expect(facts.some((fact) => fact.kind === "error")).toBe(false);
    // Served over the translator's endpoint on the fixed local bearer; codexHome falls back to the adapter default.
    expect(seen?.codexEndpoint).toEqual({ baseUrl: "http://127.0.0.1:8788", authToken: "local-bearer" });
    expect(seen?.codexHome).toBeUndefined();
});

test("agent.run gates a Codex turn with no subscription and no api key as subscription-required", async () => {
    let codexCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                async *codexAgent() {
                    codexCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "codex" });
    expect(codexCalled).toBe(false);
    expect(facts.some((fact) => fact.kind === "error" && fact.code === "subscription-required")).toBe(true);
});

// Gemini has no Claude Code road left: capabilitiesOf always answers Gemini's own runtime, whatever harness is asked
// for.
// Asking for the Claude Code harness explicitly must still land on the native runtime, not be honoured.
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
                async *agent() {
                    claudeCodeCalled = true;
                    yield { kind: "done" };
                },
                async *geminiAgent() {
                    nativeCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "gemini", harness: "claude-code" });

    expect(facts.some((fact) => fact.kind === "error")).toBe(false);
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
                async *agent(request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "kimi" });

    expect(facts.some((fact) => fact.kind === "error")).toBe(false);
    expect(seen?.baseUrl).toBe("http://127.0.0.1:8788");
    expect(seen?.authToken).toBe("local-bearer");
    expect(seen?.model).toBe("kimi-k3");
    expect(seen?.oauthToken).toBeUndefined();
});

test("agent.run keeps a pinned Gemini model the catalog still offers, and refuses one it doesn't", async () => {
    const models = ["gemini-pro-agent", "gemini-3-flash"];
    const geminiConnected = {
        accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
        connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
        complete: async () => {},
        disconnect: async () => {},
        models: async () => [],
    };
    // Read off the native runner, the only one a Gemini turn reaches; the catalog-membership rule under test is
    // unchanged.
    // geminiModels overrides the direct member the runtime reads, not the derived record.
    const run = async (model?: string): Promise<{ sent: string | undefined; errors: Extract<AgentEvent, { kind: "error" }>[] }> => {
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
                    async *geminiAgent(request) {
                        seen = request;
                        yield { kind: "done" };
                    },
                }),
            ),
        );
        const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "gemini", ...(model === undefined ? {} : { model }) });
        return { sent: seen?.model, errors: facts.flatMap((fact) => (fact.kind === "error" ? [fact] : [])) };
    };
    expect((await run("gemini-3-flash")).sent).toBe("gemini-3-flash");
    // Nothing pinned is the one case that resolves to the catalog's own head.
    expect((await run()).sent).toBe("gemini-pro-agent");

    // A pick this channel no longer lists ends the turn instead of spending another model's allowance under its name:
    // the channel vends Claude, Gemini and GPT-OSS rows on one provider id, each metered separately. The code is what
    // holds the message and reloads the picker in the composer.
    const retired = await run("gemini-2.5-pro");
    expect(retired.sent).toBeUndefined();
    expect(retired.errors.map((fact) => fact.code)).toEqual(["model-unavailable"]);
    expect(retired.errors[0]?.message).toContain("gemini-2.5-pro");
});

// No Google account is still a named-fix refusal; the native runtime owns that gate now, not the routed one.
// Asserted on the message text, since the turn plan speaks prose here rather than a `subscription-required`
// discriminator.
test("agent.run gates a Gemini turn with no Google account connected", async () => {
    let nativeCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                async *geminiAgent() {
                    nativeCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "gemini" });

    expect(nativeCalled).toBe(false);
    // The requirement is the provider's spec row (PROVIDER_ACCESS.requirement), naming what the prompt does.
    expect(facts.some((fact) => fact.kind === "error" && /Connect your Google sign-in/.test(String(fact.message)))).toBe(true);
});

// A Gemini turn naming no harness takes the native runtime: agent.routes fills `native` in for any turn omitting the
// field.
// Asserted through which runner ran (geminiAgent vs agent), pinning the dispatch rather than a message.
test("agent.run sends a Gemini turn with no harness to the native OpenCode runtime, not the Claude Code loop", async () => {
    let claudeCodeCalled = false;
    let nativeCalled = false;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                // The native runtime uses the same translator credential as the routed one: one Google account either
                // way.
                cliProxy: {
                    accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: "antigravity-user.json", label: "user@gmail.com" }] }),
                    connect: async () => ({ url: "", code: "", state: "", flow: "redirect" as const }),
                    complete: async () => {},
                    disconnect: async () => {},
                    models: async () => [],
                },
                async *agent() {
                    claudeCodeCalled = true;
                    yield { kind: "done" };
                },
                async *geminiAgent() {
                    nativeCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "gemini" });

    expect(facts.some((fact) => fact.kind === "error")).toBe(false);
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
                async *codexAgent(request) {
                    seen = request;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "hi", agent: "codex", sessionId: "gone" });
    // The dead id is dropped rather than handed on: a resume against it fails opaquely inside the CLI.
    expect(seen?.sessionId).toBeUndefined();
    expect(facts.some((fact) => fact.kind === "error")).toBe(false);
});

test("agent.run sends a Grok turn an explicit live-valid model, replacing an invalid or absent pinned id", async () => {
    const seen: (string | undefined)[] = [];
    const grokApp = () =>
        clientFor(
            createApp(
                services({
                    openCode: {
                        client: async () => ({}) as never,
                        stop: async () => {},
                        events: async () => ({ stream: { async *[Symbol.asyncIterator]() {} } }),
                        watch: async () => {},

                        connected: async () => true,
                        sessionExists: async () => true,
                        xaiModels: async () => ({
                            models: [{ id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" }],
                            default: "grok-4.20-0309-reasoning",
                        }),
                        recordModels: async () => {},
                        disconnect: async () => {},
                    },
                    async *grokAgent(request) {
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
                async *agent(request) {
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
    // A six-digit code with its countdown, never anything that could be the seed.
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
                async *agent() {
                    agentCalled = true;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "do it" });
    // The turn never reaches the agent: the user gets an actionable message instead of exit-code-1.
    expect(agentCalled).toBe(false);
    expect(facts.some((fact) => fact.kind === "error" && fact.message.includes("No Claude account connected"))).toBe(true);
});

// A runtime reports its session id in its first frame but writes the session out later; a turn stopped in between
// leaves an id nothing was saved under.
// The record outlives the session, so reopening needs nothing from the user.
test("agent.run reopens a conversation whose session the sandbox never stored, seeded from its own record", async () => {
    let seen: { prompt?: string; sessionId?: string } | undefined;
    const recorded: TranscriptRow[] = [
        { role: "user", text: "what is 2+2?" },
        { role: "assistant", text: "4" },
    ];
    const client = clientFor(
        createApp(
            services({
                sessions: {
                    list: async () => [],
                    read: async () => [],
                    readTail: async () => [],
                    search: async () => [],
                    exists: async () => false,
                },
                async *agent(request) {
                    seen = request;
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async () => recorded,
                    fork: async () => {},
                    append: async () => {},
                    page: async (_agent, window = {}) => windowOf(recorded, window),
                    count: async () => recorded.length,
                    truncate: async () => 0,
                },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "and now?", conversationId: "conv-stopped", sessionId: "gone" });
    expect(facts.some((fact) => fact.kind === "error")).toBe(false);
    // Fresh session, carrying what the conversation already said: the same handoff a provider switch gets.
    expect(seen?.sessionId).toBeUndefined();
    expect(seen?.prompt).toContain("User: what is 2+2?");
    expect(seen?.prompt?.endsWith("and now?")).toBe(true);
});

test("agent.run folds a switched conversation's history into the prompt as a role-attributed preamble", async () => {
    let seen: { prompt?: string } | undefined;
    // The daemon's own record seeds a turn resuming no session, which is what a provider/account/harness switch leaves
    // behind.
    // The client never sends a transcript up the wire.
    const recorded: TranscriptRow[] = [
        { role: "user", text: "what is 2+2?" },
        { role: "assistant", text: "4" },
    ];
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    seen = request;
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async () => recorded,
                    fork: async () => {},
                    append: async () => {},
                    page: async (_agent, window = {}) => windowOf(recorded, window),
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
                async *agent(request) {
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
    const { facts } = await runAgentTurn(client, { prompt: "look", attachments: ["../escape.png"] });
    expect(facts).toEqual([{ kind: "error", message: "invalid attachment path: ../escape.png" }]);
});

// Stopping a turn is not a failure: every adapter reports a hard-cancel's unwind as an error frame from the inside.
// The fake agent below reproduces that adapter behavior exactly.
test("a stopped turn settles as stopped, with no error frame reaching the client, the log, or the card", async () => {
    let started: (() => void) | undefined;
    let abort: (() => void) | undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const aborted = new Promise<void>((resolve) => (abort = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
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
    // The run is detached: the route acks the id, and the generator chain walks after it.
    // The adapter's first yield is the barrier proving the abort handle is registered; stopping before that would find
    // nothing to cancel.
    await running;
    // Resolves only once the run has unwound, which is the same barrier the browser's Stop waits on.
    expect(await client.agent.stop({ conversationId: "conv1" })).toEqual({ ok: true });

    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "stopped" });
    // Nothing in the transcript a window replaying this run would draw as a failure.
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    expect(frames.filter((frame) => frame.kind === "fact" && frame.fact.kind === "error")).toEqual([]);
    // The record must say the turn stopped short: this has to outlive the window that pressed Stop.
    // Reopening this session on another device, or after the board's Stop, must see the same ending, not a bare
    // composer.
    expect(await client.agents.transcript({ id: "conv1" })).toMatchObject({ ending: { reason: "stopped" } });

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
    // A proposal is custom-section content only; the daemon owns the FROM.
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
    expect(await approveDenied.json()).toEqual({ error: "maintainer access required", floor: "maintainer" });
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

// The panel token, not the panels routes: a server-side panel calls with `x-intentic-panel` instead of a Google bearer.
// /panels is only the route it happens to knock on; the credential is checked in the app's middleware.
test("the panel token is accepted in place of a Google bearer (server-side panel → daemon calls)", async () => {
    // Auth rejects every bearer, so a 200 proves the x-intentic-panel token is the only thing admitting the call.
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await app.request("/panels", { headers: { "x-intentic-panel": "panel-secret" } })).status).toBe(200);
    expect((await app.request("/panels", { headers: { "x-intentic-panel": "wrong" } })).status).toBe(401);
    expect((await app.request("/panels")).status).toBe(401);
});

// A route a grant refuses must stay refused at every spelling the router treats as the same route.
// Asserted end to end rather than on the regex: two individually-correct path checks can still disagree with each
// other.
test("the panel grant's refusal survives the spellings the router treats as the same route", async () => {
    const app = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    const probe = { id: "zz", kind: "endpoint", config: { baseUrl: "http://127.0.0.1:1/", protocol: "openai", apiKey: "k" } };
    for (const path of ["/capabilities/probe", "/capabilities/probe/", "/capabilities/probe//"]) {
        const response = await app.request(path, {
            method: "POST",
            headers: { "x-intentic-panel": "panel-secret", "content-type": "application/json" },
            body: JSON.stringify(probe),
        });
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
    // The credential read is the same rule and gets the same treatment.
    for (const path of ["/capabilities/reddit/connection", "/capabilities/reddit/connection/"]) {
        expect((await app.request(path, { headers: { "x-intentic-panel": "panel-secret" } })).status).toBe(403);
    }
    // Normalizing the path for the grant check must not narrow what a panel legitimately reaches.
    expect((await app.request("/panels/", { headers: { "x-intentic-panel": "panel-secret" } })).status).toBe(200);
});
