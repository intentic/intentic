import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { SETTLES, stubEnv, waitFor } from "@intentic/testing/bun";

import { daemonVersionOfBuild } from "@intentic/sandbox-contract/state/daemon-floor";
import type { Hello, SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import { projectRemoteDir } from "@intentic/sandbox-contract/ids/project-dir";
import { RAW_ROUTE_NAMES } from "@intentic/sandbox-contract";
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import { createApp } from "../app.js";

import { createLogger } from "../logger.js";

import { createBootTracker } from "./boot/boot.js";

import { beginTurn } from "../conversations/actor/conversation-actors.testing.js";
import { testConfig } from "../env.config.testing.js";

import { clientFor, proven, rejectForbidden } from "../harness/route-client.testing.js";
import { rejectAuth } from "../auth/auth-slice.testing.js";
import { fakeFiles } from "../workspace/workspace-slice.testing.js";
import { fakeProcesses } from "../processes/processes-slice.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryAreasStore } from "../harness/route-stores.testing.js";
import { HOST_PEER } from "../hosts/host-peer.js";
import { filePeerStore } from "../peers/peer-store.js";
import { MAX_BACKLOG_FRAMES } from "../seams/frame-backlog.js";
import { connectedCount } from "./presence.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { version } from "../version.js";

// System routes, driven over the daemon's HTTP surface as the browser does. Fakes and the client are shared
// (route-services.testing.ts and siblings); what lives here is what these routes do.

test("system.terminals reports an empty list, not an error, when there is no tmux server to ask", async () => {
    // Points at an empty socket dir; TMUX_TMPDIR picks it, and clearing $TMUX keeps the query off the real server.
    stubEnv("TMUX_TMPDIR", mkdtempSync(join(tmpdir(), "terminals-empty-")));
    stubEnv("TMUX", undefined);
    const client = clientFor(createApp(services()));
    expect(await client.system.terminals()).toEqual({ sessions: [] });
});

test("system.terminals: the windows one frame sends to re-read share a tmux listing, and a read after an announced change takes a new one", async () => {
    // A tmux that counts its listings: every open window refetches on the same `terminals` frame, and each read used
    // to fork its own.
    const bin = mkdtempSync(join(tmpdir(), "terminals-tmux-"));
    const calls = join(bin, "calls");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho listed >> "${calls}"\nprintf 'web-a\\t0\\t\\t1700000000\\tzsh\\n'\n`, { mode: 0o755 });
    stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
    const listings = (): number => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
    const client = clientFor(createApp(services()));

    const wave = await Promise.all(Array.from({ length: 8 }, () => client.system.terminals()));
    expect(listings()).toBe(1);
    for (const answer of wave) {
        expect(answer.sessions.map((session) => session.name)).toEqual(["web-a"]);
    }
    await client.system.terminals();
    expect(listings()).toBe(1);

    // A change announced since the listing was taken: what is read now must postdate it.
    publishRuntimeChange("terminals");
    await client.system.terminals();
    expect(listings()).toBe(2);
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
                    authorize: async () => proven("o@x.com", "owner"),
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
            auth: { authorize: async () => proven("o@x.com", "owner"), authorizeOwner: async () => {} },
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
    const app = createApp(services({ auth: { authorize: async () => proven("o@x.com", "owner"), authorizeOwner: async () => {} } }));
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

// What answers rides /info, so a page following a swap tells the new container by its build and boot, never by a
// version a checkout build never moves off 0.0.0.
test("system.info reports what answers: the build this container runs and when its daemon started", async () => {
    const running = { build: { base: "ghcr.io/intentic/sandbox:stable", baseDigest: `sha256:${"a".repeat(64)}`, overlay: "h1" }, bootedAt: 1_700_000_000_000 };
    const client = clientFor(createApp(services({ info: { name: "intentic-sandbox", image: "ghcr.io/intentic/sandbox:stable", version: "0.0.0", running } })));
    expect((await client.system.info()).running).toEqual(running);
});

test("presence: an /events connection joins the roster and a /system/presence report fans back out", async () => {
    // Fake auth resolving a full identity, exercising the whole seam: middleware, context, handler, registry.
    const app = createApp(
        services({
            auth: {
                authorize: async () => ({ ...proven("a@x.com", "maintainer"), name: "Ada", picture: "https://p/a.png" }),
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

// A tab frozen in the background keeps its connection open and reads nothing: every snapshot it missed was held for it
// for as long as it slept, and its roster entry kept the sandbox awake and everyone's notifications quiet.
test("events: a connection that stopped reading is cut, and leaves the roster", async () => {
    const app = createApp(services({ auth: { authorize: async () => proven("a@x.com", "maintainer"), authorizeOwner: rejectForbidden } }));
    const client = clientFor(app);
    const controller = new AbortController();
    const frames = (await client.system.events({ clientId: "frozen-1" }, { signal: controller.signal }))[Symbol.asyncIterator]();
    // Read up to its own roster entry, which is what proves the connection has joined; then it reads nothing more.
    for (;;) {
        const { value, done } = await frames.next();
        if (done === true) {
            throw new Error("stream ended before a presence frame");
        }
        if (value.kind === "presence" && value.users.some((user) => user.clientId === "frozen-1")) {
            break;
        }
    }
    const joined = connectedCount();
    try {
        // Each report fans a presence frame out to every connection, this one included.
        for (let report = 0; report <= MAX_BACKLOG_FRAMES + 64 && connectedCount() === joined; report += 1) {
            await client.system.presence({ clientId: "frozen-1", idle: report % 2 === 0 });
        }
        expect(connectedCount()).toBe(joined - 1);
    } finally {
        controller.abort();
    }
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

// The hand-written routes are half of what this daemon serves, and used to ride on no field of this frame at all: a
// browser calling one an older daemon predates could only read the 404 it came back as.
test("events: the hello names the hand-written routes and their shapes, beside the procedures'", async () => {
    const hello = await helloFrom(clientFor(createApp(services())));
    expect(hello.rawRoutes).toContain("GET /system/links");
    expect(hello.rawRoutes).toEqual([...RAW_ROUTE_NAMES]);
    // Named and fingerprinted are separate: a route whose schemas can't be expressed is still advertised, and a
    // fingerprint is only ever published for a route that has one.
    expect(hello.rawFingerprints?.["GET /system/links"]).toEqual(expect.any(String));
    expect(Object.keys(hello.rawFingerprints ?? {}).every((name) => hello.rawRoutes?.includes(name))).toBe(true);
});

// The editor holds this daemon against the oldest one it supports by the version at the head of the hello's build id;
// a build id that stopped opening with it would read as a daemon of no known age, never as one too old.
test("events: the hello's build opens with this daemon's version", async () => {
    const hello = await helloFrom(clientFor(createApp(services())));
    expect(daemonVersionOfBuild(hello.build)).toBe(version);
});

// The editor drops its own switch divider at send only where the record will say it (agent/run/turn/turn-switch.ts).
test("events: the hello says every turn's switch is in the conversation's record", async () => {
    expect((await helloFrom(clientFor(createApp(services())))).recordsSwitches).toBe(true);
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

// The first frame of a fresh /events connection, which is always the hello.
const helloFrom = async (client: ReturnType<typeof clientFor>): Promise<Hello> => {
    const controller = new AbortController();
    const stream = await client.system.events({}, { signal: controller.signal });
    const { value, done } = await stream[Symbol.asyncIterator]().next();
    controller.abort();
    if (done === true || value.kind !== "hello") {
        throw new Error(`expected a hello frame first, got ${done === true ? "stream end" : value.kind}`);
    }
    return value;
};

// testConfig's workspace root is the container's own, so this reads as `ic` hands it over.
const projectConfig = { ...testConfig, sandbox: { ...testConfig.sandbox, projectDir: projectRemoteDir("my-app") } };

// The browser opens a project sandbox on the owner's folder from its first frame, before any route answers.
test("events: a project sandbox's hello names its folder, workspace-relative, and any other sandbox's names none", async () => {
    expect(await helloFrom(clientFor(createApp(services({ config: projectConfig }))))).toMatchObject({ kind: "hello", projectDir: "my-app" });
    expect(Object.keys(await helloFrom(clientFor(createApp(services()))))).toEqual([
        "kind",
        "workspaceId",
        "routes",
        "shapes",
        "rawRoutes",
        "rawFingerprints",
        "uploadEncodings",
        "voiceCodecs",
        "build",
        "boot",
        "recordsSwitches",
    ]);
});

// A fence withholds a folder it does not reach, as it withholds any repository's name; one on the way down to a held
// folder still reaches it, since the project explains what changes inside the part that is theirs.
test("events: a fenced member's hello names the project folder only when their fence reaches it", async () => {
    let areas: readonly string[] = [];
    const client = clientFor(
        createApp(
            services({
                config: projectConfig,
                auth: { authorize: async () => proven("dee@example.com", "writer", ["google"], areas), authorizeOwner: rejectForbidden },
                areas: memoryAreasStore([
                    { id: "support", folders: ["support"] },
                    { id: "frontend", folders: ["my-app/src"] },
                ]),
            }),
        ),
        { bearer: "member" },
    );
    areas = ["support"];
    expect(Object.keys(await helloFrom(client))).not.toContain("projectDir");
    areas = ["frontend"];
    expect(await helloFrom(client)).toMatchObject({ kind: "hello", projectDir: "my-app" });
});

// On the contract like the doors it leads to, so the daemon advertises its shape and a browser reading a field this
// build doesn't send is told, instead of quietly drawing a fleet with nothing in it.
test("system.devices answers the fleet view through the typed client", async () => {
    const client = clientFor(createApp(services()));
    expect(await client.system.devices()).toEqual({ devices: [] });
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
    const maintainer = createApp(services({ auth: { authorize: async () => proven("m@x.com", "maintainer"), authorizeOwner: rejectForbidden } }));
    expect(
        await (await maintainer.request("/system/sync/pair?mode=sync", { method: "POST", headers: { authorization: "Bearer m" } })).json(),
    ).toMatchObject({ mode: "sync" });

    const collaborator = createApp(services({ auth: { authorize: async () => proven("c@x.com", "collaborator"), authorizeOwner: rejectForbidden } }));
    expect(
        await (await collaborator.request("/system/sync/pair?mode=sync", { method: "POST", headers: { authorization: "Bearer c" } })).json(),
    ).toMatchObject({ mode: "mirror" });
});

test("DELETE /system/authorized-key: a sync token self-revokes just its own enrollment", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "sync-revoke-"));
    const historyRoot = mkdtempSync(join(tmpdir(), "sync-history-"));
    const svc = services({
        config: {
            ...testConfig,
            connectToken: "token",
            historyRoot,
            sandbox: { ...testConfig.sandbox, publicUrl: "https://sandbox-abc.example.com" },
        },
        // The owner's revoke reaches the device door too, so this machine can hold both: the real store over the same
        // empty history, where nothing is enrolled and the ssh key is all there is to drop.
        hosts: filePeerStore(historyRoot, HOST_PEER.store),
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

// A window reads back only its own person's drafts (composer-drafts.ts draftsOf), so pushing every draft move to every
// window made each member's typing cost every member's every window a read.
test("events: a draft write is pushed to its writer's connections and nobody else's", async () => {
    const people = new Map([
        ["ada", proven("ada@example.test", "maintainer")],
        ["bob", proven("bob@example.test", "maintainer")],
    ]);
    const app = createApp(
        services({
            auth: {
                authorize: async (bearer: string) => {
                    const person = people.get(bearer);
                    if (person === undefined) {
                        throw new Error(`no such bearer ${bearer}`);
                    }
                    return person;
                },
                authorizeOwner: rejectForbidden,
            },
        }),
    );
    const controller = new AbortController();
    // Every drafts push each person's connection hears, read in the background for the whole test.
    const heard = new Map<string, number>();
    const listen = async (bearer: string): Promise<void> => {
        const frames = await clientFor(app, { bearer }).system.events({ clientId: `drafts-${bearer}` }, { signal: controller.signal });
        heard.set(bearer, 0);
        void (async () => {
            try {
                for await (const frame of frames) {
                    if (frame.kind === "runtimeChanged" && frame.domains.includes("drafts")) {
                        heard.set(bearer, (heard.get(bearer) ?? 0) + 1);
                    }
                }
            } catch {
                // allow(silent-catch): the abort at the end of the test ends the stream
            }
        })();
    };
    await listen("ada");
    await listen("bob");
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));
    try {
        await clientFor(app, { bearer: "ada" }).agents.writeDraft({ id: "c1", text: "half a thought" });
        await settle();
        expect(Object.fromEntries(heard)).toEqual({ ada: 1, bob: 0 });

        await clientFor(app, { bearer: "bob" }).agents.writeDraft({ id: "c1", text: "his own words" });
        await settle();
        expect(Object.fromEntries(heard)).toEqual({ ada: 1, bob: 1 });
    } finally {
        controller.abort();
    }
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

// Every progress tick used to resend every card to every window. A connection that asks for changes is sent only the
// cards that moved, each frame naming the revision it follows on from; one that does not ask (an older editor, a phone)
// keeps getting the whole roster, and a change someone made reaches both whole.
test("events: a connection asking for roster changes is sent only the moved cards, chained by revision; others stay whole", async () => {
    const svc = services();
    const opening = (id: string) =>
        ({ conversationId: id, isolated: false, prompt: `work ${id}`, profile: { agent: "claude", harness: "native" } }) as const;
    await beginTurn(svc.conversations, opening("c1"), 1_000);
    await beginTurn(svc.conversations, opening("c2"), 1_000);
    const client = clientFor(createApp(svc));
    const controller = new AbortController();
    // What one connection hears of the roster, in order: each frame's revision, the cards it names, what a change
    // follows on from, and the beats.
    type Heard = { readonly kind: string; readonly rev: number; readonly ids?: string[]; readonly since?: number };
    const heardOf = (frame: SystemEvent): Heard[] => {
        switch (frame.kind) {
            case "agents":
                return [{ kind: frame.kind, rev: frame.rev, ids: frame.agents.map((agent) => agent.id) }];
            case "agentsChanged":
                return [{ kind: frame.kind, rev: frame.rev, ids: frame.agents.map((agent) => agent.id), since: frame.since }];
            case "heartbeat":
                return [{ kind: frame.kind, rev: frame.rev }];
            default:
                return [];
        }
    };
    // Read in the background for the whole test.
    const follow = async (input: { readonly clientId: string; readonly roster?: "changes" }): Promise<Heard[]> => {
        const heard: Heard[] = [];
        const frames = await client.system.events(input, { signal: controller.signal });
        void (async () => {
            try {
                for await (const frame of frames) {
                    heard.push(...heardOf(frame));
                }
            } catch {
                // allow(silent-catch): the abort at the end of the test ends the stream
            }
        })();
        return heard;
    };
    const changes = await follow({ clientId: "roster-changes", roster: "changes" });
    const whole = await follow({ clientId: "roster-whole" });
    const lastRoster = (heard: Heard[]): Heard | undefined => heard.findLast((frame) => frame.kind !== "heartbeat");
    const tick = (id: string, tool: string): void => {
        svc.conversations.send(id, { kind: "frame", frame: { kind: "tool_call", id: tool, name: tool, category: "edit", status: "in_progress" } });
    };
    try {
        // The first roster is whole either way.
        const opened = svc.agents.revision();
        await waitFor(() =>
            expect(changes.filter((frame) => frame.kind !== "heartbeat")).toEqual([{ kind: "agents", rev: opened, ids: ["c1", "c2"] }]),
        );

        tick("c2", "Edit");
        await waitFor(() => expect(lastRoster(changes)).toEqual({ kind: "agentsChanged", rev: svc.agents.revision(), ids: ["c2"], since: opened }));
        await waitFor(() => expect(lastRoster(whole)).toEqual({ kind: "agents", rev: svc.agents.revision(), ids: ["c1", "c2"] }));
        const first = svc.agents.revision();

        // The next tick follows on from the last one sent, past the window that holds a burst together.
        tick("c1", "Read");
        await waitFor(() => expect(lastRoster(changes)).toEqual({ kind: "agentsChanged", rev: svc.agents.revision(), ids: ["c1"], since: first }));
        // And the beat vouches for that change frame's revision, as it does for a whole roster's. Other runtime
        // events restart the idle wait, so this is an eventual heartbeat, not a three-second latency contract.
        const moved = svc.agents.revision();
        await waitFor(() => expect(changes.at(-1)).toEqual({ kind: "heartbeat", rev: moved }), SETTLES);

        // A change someone made reaches both whole.
        await svc.agents.setArchived([], Date.now());
        const archived = { kind: "agents", rev: svc.agents.revision(), ids: ["c1", "c2"] };
        await waitFor(() => expect(lastRoster(changes)).toEqual(archived));
        await waitFor(() => expect(lastRoster(whole)).toEqual(archived));
        expect(whole.some((frame) => frame.kind === "agentsChanged")).toBe(false);
    } finally {
        controller.abort();
    }
});

// The route answers the one reading the sampler took (system/resources/live-metrics.ts), told of the conversations
// this daemon's roster holds: a stamp another daemon or an archived conversation left behind is nobody's card.
test("system.metrics answers the reading, told only of conversations this daemon knows", async () => {
    const reading: SandboxMetrics = {
        at: 1,
        sandbox: { cores: 2, memoryBytes: 1, memoryLimitBytes: 2, loadAverage: [0, 0, 0], processes: 4 },
        daemon: { rssBytes: 1, heapUsedBytes: 1 },
        sessions: { c1: { processes: 2, rssBytes: 10, cpuPercent: 50 }, stray: { processes: 1, rssBytes: 30 } },
        roles: { agentRuntime: { processes: 3, rssBytes: 40 } },
    };
    const composed = services({
        liveMetrics: { read: async () => reading },
        auth: { authorize: async () => proven("o@x.com", "owner"), authorizeOwner: async () => {} },
    });
    await beginTurn(
        composed.conversations,
        { conversationId: "c1", isolated: false, prompt: "work", profile: { agent: "claude", harness: "native" } },
        1_000,
    );
    expect(await clientFor(createApp(composed)).system.metrics()).toEqual({
        ...reading,
        sessions: { c1: { processes: 2, rssBytes: 10, cpuPercent: 50 } },
    });
});

test("system.metrics is not a guest's to read, and refusing one costs no reading", async () => {
    let readings = 0;
    const app = createApp(
        services({
            liveMetrics: {
                read: async () => {
                    readings += 1;
                    throw new Error("a refused caller reached the sampler");
                },
            },
            auth: { authorize: async () => proven("g@x.com", "guest", ["google"], ["support"]), authorizeOwner: rejectForbidden },
        }),
    );
    expect((await app.request("/system/metrics")).status).toBe(403);
    expect(readings).toBe(0);
});
