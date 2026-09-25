import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActivityEvent, type AgentEvent, type Automation, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { fileHeldWakesStore } from "../automations/held-wakes-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import { fileSendersStore } from "../automations/senders-store.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import type { Services } from "../composition.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { listenerStatus } from "./listener-status.js";
import { createListenerRoutes } from "./listener.routes.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { drivenBy, testConfig } from "../testing.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import type { ExtensionGrant } from "../auth/grants.js";

// The per-extension tokens the fake backend resolves: the shipped discord extension's own gateway, the slack one, and a
// stranger naming discord as its listener without contributing the discord card.
const GRANTS: Readonly<Record<string, ExtensionGrant>> = {
    "discord-token": { id: "intentic.discord", permissions: [], listener: "discord" },
    "slack-token": { id: "intentic.slack", permissions: [], listener: "slack" },
    "impostor-token": { id: "evil.discord-lookalike", permissions: ["GET /listeners/*/state"], listener: "discord" },
    "plain-token": { id: "acme.tool", permissions: ["GET /listeners/*/state", "POST /listeners/*/dispatch"] },
};

// The listener routes touch automations/heldWakes/capabilities/activity/workspace/logger; `unstubbed` keeps the
// fake that small. The dispatch route drives fireAutomation, so heldWakes + a payload-guard-free automation are enough.
// The shipped _extensions tree (testConfig) is what says which extension contributes the discord card.
const fakeServices = (root: string, appends: ActivityEvent[] = []): Services =>
    unstubbed<Services>("services", {
        config: testConfig,
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", { verifyExtensionToken: (presented) => GRANTS[presented] }),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, "senders.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async (e) => void appends.push(e as ActivityEvent), list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): TurnStarter["stream"] =>
    async function* (input) {
        prompts.push(input.prompt);
        yield* events;
    };

const listenerAutomation = (id: string, extra: Partial<Automation> = {}): Automation =>
    automationConfig(id, { trigger: { kind: "listener", provider: "discord" }, ...extra });

const message = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    provider: "discord",
    type: "message",
    id: "m1",
    channelId: "c1",
    author: { id: "u1", name: "alice" },
    content: "hi",
    timestamp: "2026-07-03T00:00:00.000Z",
    ...over,
});

const appFor = (services: Services, wake: TurnStarter["stream"]): Hono => {
    const routes = createListenerRoutes(drivenBy(services, wake));
    return new Hono()
        .get("/listeners/:provider/state", routes.state)
        .post("/listeners/:provider/dispatch", routes.dispatch)
        .post("/listeners/:provider/failure", routes.failure)
        .post("/listeners/:provider/status", routes.status);
};

const postJson = (app: Hono, path: string, body: unknown, token = "discord-token") =>
    app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-extension": token },
        body: JSON.stringify(body),
    });

const getState = (app: Hono, provider: string, token?: string) =>
    app.request(`/listeners/${provider}/state`, { headers: token === undefined ? {} : { "x-intentic-extension": token } });

test("state returns the provider's enabled listener automations and its connector configs (secrets included)", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("st-live"));
    await services.automations.upsert(listenerAutomation("st-off", { enabled: false }));
    await services.automations.upsert(automationConfig("st-cron", { prompt: "p" }));
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } });
    const res = await getState(appFor(services, fakeWake([])), "discord", "discord-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automations: Automation[]; connectors: Array<{ id: string; config: unknown }> };
    expect(body.automations.map((automation) => automation.id)).toEqual(["st-live"]);
    // The gateway needs the bot token to connect: /state hands it the full config (to its own extension's token only).
    expect(body.connectors).toEqual([{ id: "discord", config: { provider: "discord", botToken: "SECRET" } }]);
});

test("dispatch?stream=1 holds an ndjson turn-stream, framing deltas + end per matched automation", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("s-live"));
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts, [{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "done" }]));
    const res = await postJson(app, "/listeners/discord/dispatch?stream=1", message({ id: "s1", mentioned: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = (await res.text())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    expect(frames).toContainEqual({ automationId: "s-live", delta: "Hel" });
    expect(frames).toContainEqual({ automationId: "s-live", delta: "lo" });
    expect(frames).toContainEqual({ automationId: "s-live", end: true });
    expect(prompts[0]).toContain("wake:s-live");
});

test("dispatch (no stream) wakes the matching automation and returns ok", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("d-plain"));
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts));
    const res = await postJson(app, "/listeners/discord/dispatch", message({ id: "d1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await waitFor(async () => expect((await services.automations.get("d-plain"))?.runs).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("wake:d-plain");
});

test("a message whose provider mismatches the route path is rejected", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    const res = await postJson(appFor(services, fakeWake([])), "/listeners/discord/dispatch", message({ provider: "slack" }));
    expect(res.status).toBe(400);
});

test("failure records an error run on the provider's listener automations", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("f-live"));
    const res = await postJson(appFor(services, fakeWake([])), "/listeners/discord/failure", { detail: "Discord rejected the bot token" });
    expect(res.status).toBe(200);
    expect((await services.automations.get("f-live"))?.runs[0]).toMatchObject({ outcome: "error", detail: "Discord rejected the bot token" });
});

test("status ingests the gateway snapshot for the activity probe to read, and refuses a malformed one", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    const app = appFor(services, fakeWake([]));
    const snapshot = {
        connections: [{ capabilityId: "discord", provider: "discord", gateway: "ready" }],
        voice: { channelId: "c1", channelName: "General", startedAt: 1, participants: ["alice"] },
        whisperReady: true,
    };
    expect((await postJson(app, "/listeners/discord/status", snapshot)).status).toBe(200);
    expect(listenerStatus("discord", Date.now())).toMatchObject(snapshot);
    expect((await postJson(app, "/listeners/discord/status", { connections: "nope" })).status).toBe(400);
});

// /state hands back stored credentials and the other three fire or mark a provider's automations, so each answers only
// the extension that declares this provider as its listener: no token, another provider's gateway, or an extension
// with no listener at all (whatever its globs say) is refused before anything is read or written.
test("every listener route refuses a caller that is not this provider's own extension", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("rf-live"));
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } });
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts));
    for (const token of [undefined, "slack-token", "plain-token", "intruder"]) {
        const state = await getState(app, "discord", token);
        expect(state.status).toBe(403);
        expect(await state.text()).not.toContain("SECRET");
        if (token !== undefined) {
            expect((await postJson(app, "/listeners/discord/dispatch", message({ id: `rf-${token}` }), token)).status).toBe(403);
            expect((await postJson(app, "/listeners/discord/failure", { detail: "x" }, token)).status).toBe(403);
            expect((await postJson(app, "/listeners/discord/status", { connections: [] }, token)).status).toBe(403);
        }
    }
    // A provider nothing declares is refused too, even to a real gateway.
    expect((await getState(app, "cloudflare", "discord-token")).status).toBe(403);
    expect(prompts).toEqual([]);
    expect((await services.automations.list()).find((automation) => automation.id === "rf-live")?.runs).toEqual([]);
});

// Naming a provider as one's listener is not owning its cards: the connectors /state returns are the ones whose cli
// contribution the calling extension itself declares.
test("state hands an extension only the connectors of cards it contributes", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("own-live"));
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } });
    const app = appFor(services, fakeWake([]));
    const impostor = await getState(app, "discord", "impostor-token");
    expect(impostor.status).toBe(200);
    expect(((await impostor.json()) as { connectors: unknown[] }).connectors).toEqual([]);
    const own = await getState(app, "discord", "discord-token");
    expect(((await own.json()) as { connectors: unknown[] }).connectors).toEqual([
        { id: "discord", config: { provider: "discord", botToken: "SECRET" } },
    ]);
});
