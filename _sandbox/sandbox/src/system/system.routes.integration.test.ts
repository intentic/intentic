import { mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { createApp } from "../app.js";

import { createLogger } from "../logger.js";

import { createBootTracker } from "../platform/boot.js";

import { testConfig } from "../testing.js";

import { clientFor, fakeFiles, fakeProcesses, rejectAuth, rejectForbidden, services } from "../route-testing.js";
import { publishRuntimeChange } from "./runtime-watch.js";

/* The system routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon:
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("system.terminals reports an empty list, not an error, when there is no tmux server to ask", async () => {
    // Pointed at a socket directory that holds no server: `list-panes` exits non-zero and that is an empty list.
    // Both vars matter: TMUX_TMPDIR picks the socket, and $TMUX (set whenever the suite itself runs inside tmux)
    // would otherwise send the query to the REAL server, where this machine's own agent-* sessions live.
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
                scopeOf: async () => undefined,
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
    // Not the owner → the gate closes the whole surface.
    const denied = createApp(services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } }));
    expect((await denied.request("/system/control/tokens", { method: "POST" })).status).toBe(401);
});

test("minting without a usable scope is refused rather than defaulted", async () => {
    const app = createApp(
        services({ auth: { authorize: async () => ({ email: "o@x.com", role: "owner" as const }), authorizeOwner: async () => {} } }),
    );
    const mintWith = (body: unknown) =>
        app.request("/system/control/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // Absent, misspelled, and not-a-string all land the same way: a 400 naming the scopes that exist. No
    // default, because every default here is wrong for somebody (see the route).
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
    // Fake auth resolving a full identity, exercises the whole seam: middleware → context → handler →
    // registry → stream.
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
    // An in-memory files seam so the id minted by the first connection persists to the second (the default
    // fake forgets writes): the browser relies on this stability to tell a surviving workspace from a wiped one.
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

    // /events answers BEFORE the gate on purpose: this frame is the only thing telling a browser that a daemon
    // it can reach is not a daemon it can read yet.
    const hello = (await frames.next()).value;
    expect(hello).toMatchObject({
        kind: "hello",
        // A build identity the browser compares against what it last cached from this sandbox.
        build: expect.stringContaining(":"),
        boot: { ready: false, steps: [{ key: "registry", state: "pending" }] },
    });

    // …and each transition re-frames it, so a browser connected mid-boot follows along rather than guessing.
    // The presence + fleet subscriptions push their own immediate snapshots onto this stream, so pull past
    // whatever the connect produced rather than assuming an order the contract never promised.
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

test("POST /system/authorized-key authorizes via the pairing token alone (no bearer)", async () => {
    const svc = services({ auth: { authorize: rejectAuth, authorizeOwner: rejectAuth } });
    const app = createApp(svc);
    // Empty body: a valid pairing must get past auth and fail on key validation (400), never on auth (401):
    // the regression was the global bearer middleware 401ing before the route's own pairing check ran.
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

/* A sandbox on the platform's own reachability fabric: the default, and the one that could not sync at all.
 * Its shares are HTTP, so there was no `ssh-<id>` name to hand Mutagen and the enroll answered 409 on the ONE
 * path the setup wizard offers. The transport is the daemon's own HTTPS surface now, so this sandbox enrolls
 * like any other and the card reads `available`. */
test("a sandbox on intentic's own fabric enrolls for sync like every other one", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-zrok-home-"));
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-zrok-history-")),
            zrok: { token: "acct", api: "https://zrok2.example.com", namespace: "ns" },
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
    expect(body.syncToken).toBeDefined();
    expect(body.mode).toBe("sync");
});

test("POST /system/authorized-key is single-holder: a rival machine needs takeover (423), which replaces the key", async () => {
    // Enrollment writes the store under historyRoot and derives ~/.ssh/authorized_keys from it: point both at
    // temp dirs so neither lands on the real /history nor in the real home.
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-enroll-home-"));
    // connectToken + publicUrl make syncSshHostname resolve, so enrollment gets past the tunnel-configured check.
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot: mkdtempSync(join(tmpdir(), "sync-history-")),
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
    });
    const app = createApp(svc);
    // A fresh single-use SYNC pairing per call (the owner's file-sync path); the key's comment is the machine label.
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
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ enrolled: true, syncingFrom: "machine-b" });
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
    // /system/sync shows all three mirroring and no file-sync holder.
    const sync = await (await app.request("/system/sync")).json();
    expect(sync).toMatchObject({ enrolled: true, mirroredBy: ["laptop-a", "laptop-b", "laptop-c"] });
    expect(sync).not.toHaveProperty("syncingFrom");
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
    expect(await (await app.request("/system/sync")).json()).toMatchObject({ mirroredBy: ["laptop-b"] });
    // A stale token that matches nothing is a 404.
    expect((await app.request("/system/authorized-key", { method: "DELETE", headers: { "x-intentic-sync": tokenA } })).status).toBe(404);
});

test("events: every runtime domain that moves reaches the browser's stream", async () => {
    /* THE FEED THAT REPLACED THE POLLS, over the wire the browser actually reads.
     *
     * Terminals, panels, ports, browsers and subagents each used to carry their own timer because none of them
     * has a file for the watcher to see. They have no timer now, so this frame is their whole live feed, which
     * makes "the frame arrives" the property the whole change rests on. */
    const client = clientFor(createApp(services()));
    const controller = new AbortController();
    const frames = (await client.system.events({ clientId: "runtime-1" }, { signal: controller.signal }))[Symbol.asyncIterator]();

    /* Read until the wanted domains have all been seen. Deliberately not "the next frame carries both": the bus
     * rate-limits PER DOMAIN, so a domain still inside its window rides the following frame instead of holding
     * the other one back, which is the property that keeps a panel starting from feeling as slow as the
     * chattiest thing in the sandbox, and would make a single-frame assertion flaky against the sampler running
     * beside it. What must hold is that everything published arrives. */
    const awaitDomains = async (wanted: readonly string[]): Promise<void> => {
        const outstanding = new Set(wanted);
        while (outstanding.size > 0) {
            const { value, done } = await frames.next();
            if (done === true) {
                throw new Error(`the stream ended still owing ${[...outstanding].join(", ")}`);
            }
            if (value.kind === "runtimeChanged") {
                for (const domain of value.domains) {
                    outstanding.delete(domain);
                }
            }
        }
    };

    /* Wait for the stream to be LIVE before publishing anything. The route sends its hello frame before it
     * subscribes to any feed, and a change published with nobody subscribed is dropped rather than queued
     * (runtime-watch.ts), so a publish issued between the two waits forever for a frame nobody made. A browser
     * is never in that gap; it holds a pull open. The presence frame is the proof of arrival: the route enqueues
     * it from inside the same block that registers the runtime listener. */
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
    await awaitDomains(["panels", "terminals"]);

    controller.abort();
});
