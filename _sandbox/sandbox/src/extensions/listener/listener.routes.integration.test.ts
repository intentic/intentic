import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityEvent } from "@intentic/sandbox-contract/schemas/activity";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import type { ListenerDispatchFrame } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { Hono } from "hono";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../../store/journals/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { fileHeldWakesStore } from "../../automations/held-wakes-store.js";
import { fileAutomationsStore } from "../../automations/automations-store.js";
import { fileSendersStore } from "../../automations/senders-store.js";
import { fileCapabilitiesStore } from "../../capabilities/capabilities-store.js";
import { automationConfig } from "../../harness/route-stores.testing.js";
import type { Services } from "../../composition.js";
import { fileThreadSessionsStore } from "../../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { HELD_NOTICE, PAYLOAD_MAX } from "../../automations/scheduler.js";
import { listenerStateOf } from "./listener-state.js";
import { listenerStatus } from "../../capabilities/status/listener-status.js";
import { createListenerRoutes } from "./listener.routes.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import { drivenBy } from "../../seams/turn-starter.testing.js";
import { testConfig } from "../../env.config.testing.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { ExtensionGrant } from "../../auth/grants.js";

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
        heldWakes: fileHeldWakesStore(join(root, "history")),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
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

// A chunked body declares no length, so the old header check let it through to be read whole. This one never ends: only
// a read that counts what arrives can answer it, and it must stop pulling soon after the cap.
test("dispatch refuses an oversized chunked body with 413, reading little past the cap", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    const prompts: string[] = [];
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulled += 4096;
            controller.enqueue(new Uint8Array(4096).fill(0x20));
        },
    });
    const res = await appFor(services, fakeWake(prompts)).request("/listeners/discord/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-intentic-extension": "discord-token" },
        body,
        // SAFETY: `duplex` is required by the runtime for a stream body but missing from the DOM RequestInit type.
        duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(PAYLOAD_MAX + 4 * 4096);
    expect(prompts).toEqual([]);
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
    };
    expect((await postJson(app, "/listeners/discord/status", snapshot)).status).toBe(200);
    expect(listenerStatus("discord", Date.now())).toMatchObject(snapshot);
    expect((await postJson(app, "/listeners/discord/status", { connections: "nope" })).status).toBe(400);
});

// /state hands back stored credentials and the other three fire or mark a provider's automations, so each answers only
// the extension that owns this provider's listener: no token, another provider's gateway, an extension with no listener
// at all (whatever its globs say), or an impostor declaring discord's listener while the shipped discord extension owns
// it, is refused before anything is read or written.
test("every listener route refuses a caller that is not this provider's own extension", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("rf-live"));
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } });
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts));
    for (const token of [undefined, "slack-token", "plain-token", "impostor-token", "intruder"]) {
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

// Owning a provider's listener is not owning its cards either: the connectors /state returns are the ones whose cli
// contribution the calling extension itself declares, so a declarer that is not the card's extension is handed none.
test("state hands an extension only the connectors of cards it contributes", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("own-live"));
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } });
    expect((await listenerStateOf(services, "discord", "evil.discord-lookalike")).connectors).toEqual([]);
    const own = await getState(appFor(services, fakeWake([])), "discord", "discord-token");
    expect(((await own.json()) as { connectors: unknown[] }).connectors).toEqual([
        { id: "discord", config: { provider: "discord", botToken: "SECRET" } },
    ]);
});

// A streamed dispatch's frames, one per ndjson line.
const framesOf = async (res: Response): Promise<ListenerDispatchFrame[]> => {
    const lines = (await res.text()).trim().split("\n").filter(Boolean);
    // SAFETY: the dispatch route writes exactly one ListenerDispatchFrame per line (listener.routes.ts).
    return lines.map((line) => JSON.parse(line) as ListenerDispatchFrame);
};

// What a channel shows while its turn works: the conversation it opened, each step, the checklist, and the turn's own
// words only, a subagent's narration staying in the conversation.
test("dispatch?stream=1 frames the turn's progress and only the turn's own words", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("p-live"));
    const events: AgentEvent[] = [
        { kind: "tool_call", id: "t1", name: "Read", category: "read", status: "in_progress", target: "src/a.ts" },
        { kind: "tool_call_update", id: "t1", status: "completed" },
        { kind: "tool_call", id: "t2", name: "TodoWrite", category: "think", status: "completed" },
        { kind: "todos", items: [{ content: "Fix the guard", status: "in_progress" }] },
        { kind: "tool_call", id: "t3", name: "Grep", category: "search", status: "in_progress", target: "x", parentToolUseId: "sub" },
        { kind: "delta", text: "subagent narration", parentToolUseId: "sub" },
        { kind: "delta", text: "Fixed." },
        { kind: "done" },
    ];
    const frames = await framesOf(await postJson(appFor(services, fakeWake([], events)), "/listeners/discord/dispatch?stream=1", message({ id: "p1", mentioned: true })));
    expect(frames.find((frame) => frame.opened !== undefined)?.opened?.conversationId).toEqual(expect.any(String));
    expect(frames).toContainEqual({ automationId: "p-live", step: { id: "t1", tool: "Read", kind: "read", status: "running", target: "src/a.ts" } });
    expect(frames).toContainEqual({ automationId: "p-live", step: { id: "t1", tool: "Read", kind: "read", status: "done", target: "src/a.ts" } });
    expect(frames).toContainEqual({ automationId: "p-live", plan: [{ text: "Fix the guard", status: "in_progress" }] });
    expect(frames).toContainEqual({ automationId: "p-live", delta: "Fixed." });
    // Neither the checklist's own tool nor anything inside a subagent reaches the channel.
    expect(JSON.stringify(frames)).not.toContain("TodoWrite");
    expect(JSON.stringify(frames)).not.toContain("subagent narration");
    expect(JSON.stringify(frames)).not.toContain('"t3"');
    expect(frames.at(-1)).toEqual({ automationId: "p-live", end: true });
});

test("a wake held for a person's approval tells the channel so, rather than going quiet", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("h-live", { requireApproval: true }));
    const prompts: string[] = [];
    const frames = await framesOf(await postJson(appFor(services, fakeWake(prompts)), "/listeners/discord/dispatch?stream=1", message({ id: "h1", mentioned: true })));
    expect(frames).toContainEqual({ automationId: "h-live", held: HELD_NOTICE });
    expect(frames.at(-1)).toEqual({ automationId: "h-live", end: true });
    expect(prompts).toEqual([]);
});

// Stop: who may stop a channel's turn is who the automation answers without the owner's release, on a conversation that
// came from that provider.
type Entry = NonNullable<ReturnType<Services["agents"]["entry"]>>;

const stopApp = (services: Services, origin: AgentOrigin | undefined, stopped: string[]): Hono => {
    const routes = createListenerRoutes(
        unstubbed<Services>("services", {
            ...services,
            agents: unstubbed<Services["agents"]>("agents", {
                // The stop route reads only the entry's identity.origin; anything else it touched would throw.
                entry: (id) =>
                    id === "conv-1" && origin !== undefined
                        ? unstubbed<Entry>("entry", { id, identity: unstubbed<Entry["identity"]>("identity", { origin }) })
                        : undefined,
            }),
            turns: unstubbed<Services["turns"]>("turns", {
                stop: async (target) => {
                    stopped.push(target.conversationId);
                    return { stopped: true };
                },
            }),
        }),
    );
    return new Hono().post("/listeners/:provider/stop", routes.stop);
};

test("stop lets a person the automation answers stop its turn, and refuses anyone it holds or ignores", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(
        listenerAutomation("stop-live", { senders: { rules: [{ ids: ["u-mark"] }, { ids: ["u-guest"], requireApproval: true }], others: "ignore" } }),
    );
    const stopped: string[] = [];
    const app = stopApp(services, { automationId: "stop-live", provider: "discord", channelId: "c1", threadId: "t1" }, stopped);
    const asking = async (id: string) => (await postJson(app, "/listeners/discord/stop", { conversationId: "conv-1", author: { id, name: id } })).json();
    expect(await asking("u-guest")).toMatchObject({ stopped: false });
    expect(await asking("u-stranger")).toMatchObject({ stopped: false });
    expect(stopped).toEqual([]);
    expect(await asking("u-mark")).toEqual({ stopped: true });
    expect(stopped).toEqual(["conv-1"]);
});

test("stop refuses a conversation another provider's channel started, or none at all", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("stop-elsewhere"));
    const stopped: string[] = [];
    const slackOrigin = { automationId: "stop-elsewhere", provider: "slack", channelId: "c1" };
    const body = { conversationId: "conv-1", author: { id: "u1", name: "alice" } };
    expect(await (await postJson(stopApp(services, slackOrigin, stopped), "/listeners/discord/stop", body)).json()).toMatchObject({ stopped: false });
    expect(await (await postJson(stopApp(services, undefined, stopped), "/listeners/discord/stop", body)).json()).toMatchObject({ stopped: false });
    expect((await postJson(stopApp(services, undefined, stopped), "/listeners/discord/stop", { author: {} })).status).toBe(400);
    // Another provider's gateway cannot press Stop on discord's conversations at all.
    expect((await postJson(stopApp(services, undefined, stopped), "/listeners/discord/stop", body, "slack-token")).status).toBe(403);
    expect(stopped).toEqual([]);
});
