import { mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { createApp } from "../app.js";

import { createLogger } from "../logger.js";

import { createBootTracker } from "../platform/boot/boot.js";

import { testConfig } from "../testing.js";

import { clientFor, rejectAuth, rejectForbidden } from "../harness/route-client.testing.js";
import { fakeFiles, fakeProcesses } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { publishRuntimeChange } from "./runtime-watch.js";

// System routes, driven over the daemon's HTTP surface as the browser does. Fakes and the client are shared
// (route-services.testing.ts and siblings); what lives here is what these routes do.

test("system.terminals reports an empty list, not an error, when there is no tmux server to ask", async () => {
    // Points at an empty socket dir; TMUX_TMPDIR picks it, and clearing $TMUX keeps the query off the real server.
    vi.stubEnv("TMUX_TMPDIR", mkdtempSync(join(tmpdir(), "terminals-empty-")));
    vi.stubEnv("TMUX", undefined);
    const client = clientFor(createApp(services()));
    expect(await client.system.terminals()).toEqual({ sessions: [] });
});

test("system.usage folds the LEDGER (all-time, never pruned) per provider+account and skips unattributed turns", async () => {
    const client = clientFor(
        createApp(
            services({
                usage: {
                    record: async () => {},
                    // Two days on one account plus an unattributed env-token turn, which belongs to no account.
                    rollup: async () => [
                        {
                            day: "2026-07-20",
                            provider: "claude",
                            account: "work",
                            harness: "native",
                            turns: 1,
                            inputTokens: 100,
                            outputTokens: 50,
                            cacheReadTokens: 10,
                            cacheCreationTokens: 5,
                            costUsd: 0.25,
                            durationMs: 1_000,
                        },
                        {
                            day: "2026-07-21",
                            provider: "claude",
                            account: "work",
                            harness: "native",
                            turns: 3,
                            inputTokens: 300,
                            outputTokens: 150,
                            cacheReadTokens: 30,
                            cacheCreationTokens: 15,
                            costUsd: 0.75,
                            durationMs: 3_000,
                        },
                        {
                            day: "2026-07-21",
                            provider: "claude",
                            harness: "native",
                            turns: 9,
                            inputTokens: 900,
                            outputTokens: 900,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0,
                            costUsd: 9,
                            durationMs: 9_000,
                        },
                    ],
                },
            }),
        ),
    );

    // Both of the account's days summed into one row; the unattributed turn's $9 is excluded, not pooled.
    expect(await client.system.usage()).toEqual({
        accounts: [
            {
                provider: "claude",
                account: "work",
                turns: 4,
                inputTokens: 400,
                outputTokens: 200,
                cacheReadTokens: 40,
                cacheCreationTokens: 20,
                costUsd: 1,
            },
        ],
    });
});

test("system.killTerminal routes a panel-* session through the process manager, so `running` unmaps immediately", async () => {
    const processes = fakeProcesses();
    const client = clientFor(createApp(services({ processes })));
    expect(await client.system.killTerminal({ name: "panel-app" })).toEqual({ ok: true });
    expect(processes.stopped).toEqual(["app"]);
});

test("system.session exchanges the verified bearer for a daemon-minted session", async () => {
    const client = clientFor(
        createApp(
            services({
                auth: {
                    authorize: async () => ({ email: "o@x.com", role: "owner" as const }),
                    authorizeOwner: rejectForbidden,
                    mintSession: async (identity: { email: string }) => ({ token: `sess-${identity.email}`, expiresAt: 42 }),
                },
            }),
        ),
    );
    expect(await client.system.session()).toEqual({ token: "sess-o@x.com", expiresAt: 42, email: "o@x.com" });
});

test("control-token mint/list/revoke are owner-gated plain routes; mint returns the raw token once", async () => {
    const minted: { label: string; scope: string }[] = [];
    const app = createApp(
        services({
            auth: { authorize: async () => ({ email: "o@x.com", role: "owner" as const }), authorizeOwner: async () => {} },
            controlTokens: {
                mint: async (label, scope) => {
                    minted.push({ label, scope });
                    return { id: "ct-9", token: "ict_raw-once" };
                },
                resolve: async () => undefined,
                touch: async () => undefined,
                list: async () => [{ id: "ct-9", label: "zed", scope: "editor", createdAt: 1 }],
                revoke: async (id) => id === "ct-9",
            },
        }),
    );
    const mint = await app.request("/system/control/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "zed", scope: "editor" }),
    });
    expect(mint.status).toBe(200);
    expect(await mint.json()).toEqual({ id: "ct-9", token: "ict_raw-once" });
    expect(minted).toEqual([{ label: "zed", scope: "editor" }]);
    expect(await (await app.request("/system/control/tokens")).json()).toEqual({
        tokens: [{ id: "ct-9", label: "zed", scope: "editor", createdAt: 1 }],
    });
    expect((await app.request("/system/control/tokens/ct-9", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/system/control/tokens/nope", { method: "DELETE" })).status).toBe(404);
    // Not the owner: the gate closes the whole surface.
    const denied = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await denied.request("/system/control/tokens", { method: "POST" })).status).toBe(401);
});

test("minting without a usable scope is refused rather than defaulted", async () => {
    const app = createApp(
        services({ auth: { authorize: async () => ({ email: "o@x.com", role: "owner" as const }), authorizeOwner: async () => {} } }),
    );
    const mintWith = (body: unknown) =>
        app.request("/system/control/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // Absent, misspelled, and non-string scopes all land as a 400 naming valid scopes; no default exists here.
    expect((await mintWith({ label: "zed" })).status).toBe(400);
    expect((await mintWith({ label: "zed", scope: "editorr" })).status).toBe(400);
    expect((await mintWith({ label: "zed", scope: 7 })).status).toBe(400);
    expect((await mintWith({ scope: "drive" })).status).toBe(200);
});

test("system.info reports the sandbox image tag and exact bundled version", async () => {
    const client = clientFor(
        createApp(services({ info: { name: "intentic-sandbox", image: "ghcr.io/intentic/sandbox:stable", version: "1.52.0" } })),
    );
    expect(await client.system.info()).toEqual({
        name: "intentic-sandbox",
        image: "ghcr.io/intentic/sandbox:stable",
        version: "1.52.0",
    });
});

test("presence: an /events connection joins the roster and a /system/presence report fans back out", async () => {
    // Fake auth resolving a full identity, exercising the whole seam: middleware, context, handler, registry.
    const app = createApp(
        services({
            auth: {
                authorize: async () => ({ email: "a@x.com", name: "Ada", picture: "https://p/a.png", role: "maintainer" as const }),
                authorizeOwner: rejectForbidden,
            },
        }),
    );
    const client = clientFor(app);
    const controller = new AbortController();
    const stream = await client.system.events({ clientId: "seam-1" }, { signal: controller.signal });
    // Manual iterator: a for-await break would close the stream between the two phases.
    const iterator = stream[Symbol.asyncIterator]();
    const nextPresence = async () => {
        for (;;) {
            const { value, done } = await iterator.next();
            if (done === true) {
                throw new Error("stream ended before a presence frame");
            }
            if (value.kind === "presence") {
                return value.users;
            }
        }
    };
    // The subscribe-time snapshot: this connection's own entry, identity from the verified token.
    expect(await nextPresence()).toEqual([
        { clientId: "seam-1", email: "a@x.com", name: "Ada", picture: "https://p/a.png", role: "maintainer", idle: false },
    ]);
    await client.system.presence({ clientId: "seam-1", idle: true, view: "workspace", path: "src/app.ts" });
    expect(await nextPresence()).toEqual([
        {
            clientId: "seam-1",
            email: "a@x.com",
            name: "Ada",
            picture: "https://p/a.png",
            role: "maintainer",
            idle: true,
            view: "workspace",
            path: "src/app.ts",
        },
    ]);
    controller.abort();
});

test("events: the first frame is the workspace-identity hello, stable across connections", async () => {
    // In-memory files seam: the id from the first connection persists; the default fake forgets writes.
    const disk = new Map<string, string>();
    const app = createApp(
        services({
            files: fakeFiles({
                read: async (path) => disk.get(path),
                write: async (path, content) => {
                    disk.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
                },
            }),
        }),
    );
    const client = clientFor(app);
    const firstFrame = async () => {
        const controller = new AbortController();
        const stream = await client.system.events({}, { signal: controller.signal });
        const { value, done } = await stream[Symbol.asyncIterator]().next();
        controller.abort();
        if (done === true || value.kind !== "hello") {
            throw new Error(`expected a hello frame first, got ${done === true ? "stream end" : value.kind}`);
        }
        return value.workspaceId;
    };
    const minted = await firstFrame();
    expect(minted).not.toBe("");
    expect(await firstFrame()).toBe(minted);
});

test("events: the hello names the daemon's build and where its boot is, then streams every step", async () => {
    const boot = createBootTracker(createLogger(testConfig));
    boot.declare([{ key: "registry", label: "Loading conversations" }]);
    const client = clientFor(createApp(services({ boot })));
    const controller = new AbortController();
    const frames = (await client.system.events({}, { signal: controller.signal }))[Symbol.asyncIterator]();

    // /events answers before the gate: this frame is the only sign a reachable daemon isn't yet a readable one.
    const hello = (await frames.next()).value;
    expect(hello).toMatchObject({
        kind: "hello",
        // A build identity the browser compares against what it last cached from this sandbox.
        build: expect.stringContaining(":"),
        boot: { ready: false, steps: [{ key: "registry", state: "pending" }] },
    });

    // Each transition re-frames the boot state; presence and fleet also push their own snapshots on connect, so don't
    // assume a fixed frame order.
    const nextBoot = async () => {
        for (;;) {
            const { value, done } = await frames.next();
            if (done === true) {
                throw new Error("the stream ended before a boot frame arrived");
            }
            if (value.kind === "boot") {
                return value;
            }
        }
    };
    const step = boot.step("registry", async () => undefined);
    expect(await nextBoot()).toMatchObject({ ready: false, steps: [{ key: "registry", state: "running" }] });
    await step;
    expect(await nextBoot()).toMatchObject({ ready: false, steps: [{ key: "registry", state: "done" }] });
    boot.finish();
    expect(await nextBoot()).toMatchObject({ ready: true });
    controller.abort();
});

// Enrollment is a property of each device, read off the device list, not one syncingFrom/mirroredBy pair on the
// sandbox; these tests ask the same route the view does.
const enrollments = async (app: { request: (path: string) => Promise<Response> | Response }): Promise<{ machine: string; mode: string }[]> => {
    const body = (await (await app.request("/system/devices")).json()) as { devices: { sync?: { machine: string; mode: string } }[] };
    return body.devices.flatMap((row) => (row.sync === undefined ? [] : [{ machine: row.sync.machine, mode: row.sync.mode }]));
};

test("POST /system/authorized-key authorizes via the pairing token alone (no bearer)", async () => {
    const svc = services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } });
    const app = createApp(svc);
    // Empty body: a valid pairing must fail on key validation (400), not on auth (401).
    const post = (headers: Record<string, string> = {}) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({}),
        });
    expect((await post({ "x-intentic-pair": svc.syncPairings.mint("sync").token })).status).toBe(400);
    expect((await post()).status).toBe(401);
    expect((await post({ "x-intentic-pair": "bogus" })).status).toBe(401);
});

// A fabric sandbox has HTTP shares, not an ssh-<id> name; sync now goes over the daemon's own HTTPS surface.
test("a sandbox on intentic's own fabric enrolls for sync like every other one", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-home-"));
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
    });
    const app = createApp(svc);
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ available: true });
    const enrolled = await app.request("/system/authorized-key", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-pair": svc.syncPairings.mint("sync").token },
        body: JSON.stringify({ key: "ssh-ed25519 AAAAA laptop" }),
    });
    expect(enrolled.status).toBe(200);
    // The credential, and no address: the agent reaches this sandbox at the URL it already holds.
    const body = (await enrolled.json()) as { syncToken?: string; mode?: string };
    expect(body.syncToken).toEqual(expect.any(String));
    expect(body.mode).toBe("sync");
});

test("POST /system/authorized-key is single-holder: a rival machine needs takeover (423), which replaces the key", async () => {
    // Enrollment writes under historyRoot and derives ~/.ssh/authorized_keys from it; point both at temp dirs.
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-enroll-home-"));
    // connectToken and publicUrl make syncSshHostname resolve, so enrollment gets past the tunnel-configured check.
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
    });
    const app = createApp(svc);
    // A fresh single-use SYNC pairing per call; the key's comment is the machine label.
    const enroll = (key: string, extra: Record<string, string> = {}) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": svc.syncPairings.mint("sync").token, ...extra },
            body: JSON.stringify({ key }),
        });
    const KEY_A = "ssh-ed25519 AAAAA machine-a";
    const KEY_B = "ssh-ed25519 BBBBB machine-b";

    expect((await enroll(KEY_A)).status).toBe(200);
    // The same machine re-enrolling (its cached key) is idempotent: no takeover needed.
    expect((await enroll(KEY_A)).status).toBe(200);
    // A different machine is refused and told who currently holds sync.
    const blocked = await enroll(KEY_B);
    expect(blocked.status).toBe(423);
    expect(await blocked.json()).toEqual({ error: "sync already active", machine: "machine-a" });
    // An explicit takeover replaces the key; the status route now reports the new holder.
    expect((await enroll(KEY_B, { "x-intentic-sync-takeover": "1" })).status).toBe(200);
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ enrolled: true });
    // Sync holder is read off the device list, not sync status; a takeover revokes the displaced machine's key too.
    expect(await enrollments(app)).toEqual([{ machine: "machine-b", mode: "sync" }]);
});

test("POST /system/authorized-key: a MIRROR pairing lets many machines enroll: no single-holder lock", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-mirror-multi-"));
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
    });
    const app = createApp(svc);
    const enrollMirror = (key: string) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": svc.syncPairings.mint("mirror").token },
            body: JSON.stringify({ key }),
        });
    // Three collaborators mirror the same sandbox concurrently: every enroll succeeds, none locks.
    expect((await enrollMirror("ssh-ed25519 AAA laptop-a")).status).toBe(200);
    expect((await enrollMirror("ssh-ed25519 BBB laptop-b")).status).toBe(200);
    const c = await enrollMirror("ssh-ed25519 CCC laptop-c");
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ ok: true, mode: "mirror" });
    // Three mirroring rows, none holding file sync: one entry per enrolled device is the whole answer.
    expect(await enrollments(app)).toEqual([
        { machine: "laptop-a", mode: "mirror" },
        { machine: "laptop-b", mode: "mirror" },
        { machine: "laptop-c", mode: "mirror" },
    ]);
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ enrolled: true });
});

test("POST /system/sync/pair: the operating tier may mint sync, lower roles are capped to mirror", async () => {
    // Owner (loopback = owner): default sync, or mirror on request.
    const owner = createApp(services());
    expect(await (await owner.request("/system/sync/pair", { method: "POST" })).json()).toMatchObject({ mode: "sync" });
    expect(await (await owner.request("/system/sync/pair?mode=mirror", { method: "POST" })).json()).toMatchObject({ mode: "mirror" });
    const maintainer = createApp(
        services({ auth: { authorize: async () => ({ email: "m@x.com", role: "maintainer" as const }), authorizeOwner: rejectForbidden } }),
    );
    expect(
        await (await maintainer.request("/system/sync/pair?mode=sync", { method: "POST", headers: { authorization: "Bearer m" } })).json(),
    ).toMatchObject({ mode: "sync" });

    const collaborator = createApp(
        services({ auth: { authorize: async () => ({ email: "c@x.com", role: "collaborator" as const }), authorizeOwner: rejectForbidden } }),
    );
    expect(
        await (await collaborator.request("/system/sync/pair?mode=sync", { method: "POST", headers: { authorization: "Bearer c" } })).json(),
    ).toMatchObject({ mode: "mirror" });
});

test("DELETE /system/authorized-key: a sync token self-revokes just its own enrollment", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-revoke-"));
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
    });
    const app = createApp(svc);
    const enroll = (key: string) =>
        app.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": svc.syncPairings.mint("mirror").token },
            body: JSON.stringify({ key }),
        });
    const tokenA = ((await (await enroll("ssh-ed25519 AAA laptop-a")).json()) as { syncToken: string }).syncToken;
    await enroll("ssh-ed25519 BBB laptop-b");
    // Self-revoke with A's token removes only A; B keeps mirroring.
    expect((await app.request("/system/authorized-key", { method: "DELETE", headers: { "x-intentic-sync": tokenA } })).status).toBe(200);
    expect(await enrollments(app)).toEqual([{ machine: "laptop-b", mode: "mirror" }]);
    // A stale token that matches nothing is a 404.
    expect((await app.request("/system/authorized-key", { method: "DELETE", headers: { "x-intentic-sync": tokenA } })).status).toBe(404);

    // The owner's revoke is per machine, addressed by the row's name, not a whole-store clear.
    expect((await app.request("/system/authorized-key/laptop-b", { method: "DELETE" })).status).toBe(200);
    expect(await enrollments(app)).toEqual([]);
    // A machine nobody is enrolled under is a 404 rather than a cheerful no-op.
    expect((await app.request("/system/authorized-key/laptop-b", { method: "DELETE" })).status).toBe(404);
});

test("events: every runtime domain that moves reaches the browser's stream", async () => {
    // Terminals, panels, ports, browsers, subagents have no watcher file; this frame is their whole live feed.
    const client = clientFor(createApp(services()));
    const controller = new AbortController();
    const frames = (await client.system.events({ clientId: "runtime-1" }, { signal: controller.signal }))[Symbol.asyncIterator]();

    // Reads until every wanted domain has been seen, not until one frame carries them all: the bus rate-limits per
    // domain, so one can ride a later frame without the other waiting on it.
    // Returns what it actually saw arrive, so the caller can assert on it rather than the absence of a throw.
    const awaitDomains = async (wanted: readonly string[]): Promise<readonly string[]> => {
        const outstanding = new Set(wanted);
        const delivered: string[] = [];
        while (outstanding.size > 0) {
            const { value, done } = await frames.next();
            if (done === true) {
                throw new Error(`the stream ended still owing ${[...outstanding].join(", ")}`);
            }
            if (value.kind === "runtimeChanged") {
                for (const domain of value.domains) {
                    if (outstanding.delete(domain)) {
                        delivered.push(domain);
                    }
                }
            }
        }
        return delivered;
    };

    // Waits for stream to go live before publishing, since a publish with nobody subscribed is dropped, not queued.
    let live = false;
    while (!live) {
        const { value, done } = await frames.next();
        if (done === true) {
            throw new Error(`the stream ended before it subscribed to anything`);
        }
        live = value.kind === "presence";
    }

    // The announced half: a subsystem doing the thing and saying so on the way past.
    publishRuntimeChange("panels", "terminals");
    expect([...(await awaitDomains(["panels", "terminals"]))].sort()).toEqual(["panels", "terminals"]);

    controller.abort();
});

test("events: the beat states the fleet revision it was sent at, so a browser can tell a roster went missing", async () => {
    // The fleet roster is push-only, so a missed snapshot has no other way to surface; the heartbeat carries the roster
    // revision, sent only once the connection's queue is empty, so a mismatch tells the browser to re-read rather than
    // reload.
    const svc = services();
    const client = clientFor(createApp(svc));
    const controller = new AbortController();
    const frames = (await client.system.events({ clientId: "beat-1" }, { signal: controller.signal }))[Symbol.asyncIterator]();

    // Reads to the next beat, tracking the last roster revision actually sent; the pair is the invariant under test.
    const toBeat = async (roster: number | undefined): Promise<{ beat: number; roster: number }> => {
        let last = roster;
        for (;;) {
            const { value, done } = await frames.next();
            if (done === true) {
                throw new Error(`the stream ended before it beat`);
            }
            if (value.kind === "agents") {
                last = value.rev;
            }
            if (value.kind === "heartbeat") {
                if (last === undefined) {
                    // Every connection gets the roster on subscribe, before it can go idle enough to beat.
                    throw new Error(`the connection beat before it was ever sent a roster`);
                }
                return { beat: value.rev, roster: last };
            }
        }
    };

    // An immediate snapshot on open, then a no-op archive call: it broadcasts anyway, so this measures the beat.
    const opened = await toBeat(undefined);
    expect(opened.beat).toBe(opened.roster);

    await svc.agents.setArchived([], Date.now());
    const moved = await toBeat(opened.roster);
    expect(moved.roster).toBeGreaterThan(opened.roster);
    expect(moved.beat).toBe(moved.roster);

    controller.abort();
});
