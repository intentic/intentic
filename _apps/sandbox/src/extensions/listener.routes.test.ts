import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityEvent, AgentEvent, Automation } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { fileTurnJournal } from "../agent/turn-journal.js";
import { fileApprovalsStore } from "../automations/approvals-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import { listenerStatus } from "./listener-status.js";
import { createListenerRoutes } from "./listener.routes.js";

// The listener routes touch automations/approvals/capabilities/activity/workspace/logger; a cast keeps the fake
// that small. The dispatch route drives fireAutomation, so approvals + a payload-guard-free automation are enough.
const fakeServices = (root: string, appends: ActivityEvent[] = []): Services =>
    ({
        automations: fileAutomationsStore(join(root, "automations.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        activity: { append: async (e: Omit<ActivityEvent, "id" | "at">) => void appends.push(e as ActivityEvent), list: async () => [] },
        workspace: { root },
        logger: { error: () => {}, warn: () => {} },
    }) as unknown as Services;

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

const listenerAutomation = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "listener", provider: "discord" },
    prompt: `wake:${id}`,
    enabled: true,
    ...extra,
});

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

const appFor = (services: Services, wake: WakeFn): Hono => {
    const routes = createListenerRoutes(services, wake);
    return new Hono()
        .get("/listeners/:provider/state", routes.state)
        .post("/listeners/:provider/dispatch", routes.dispatch)
        .post("/listeners/:provider/failure", routes.failure)
        .post("/listeners/:provider/status", routes.status);
};

const postJson = (app: Hono, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("state returns the provider's enabled listener automations and its connector configs (secrets included)", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("st-live"));
    await services.automations.upsert(listenerAutomation("st-off", { enabled: false }));
    await services.automations.upsert({ id: "st-cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "p", enabled: true });
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "SECRET" } });
    const res = await appFor(services, fakeWake([])).request("/listeners/discord/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automations: Automation[]; connectors: Array<{ id: string; config: unknown }> };
    expect(body.automations.map((automation) => automation.id)).toEqual(["st-live"]);
    // The gateway needs the bot token to connect — /state hands it the full config (panel-token route, in-container).
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
}, 10_000);

test("dispatch (no stream) wakes the matching automation and returns ok", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-route-")));
    await services.automations.upsert(listenerAutomation("d-plain"));
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts));
    const res = await postJson(app, "/listeners/discord/dispatch", message({ id: "d1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await services.automations.get("d-plain"))?.runs).toHaveLength(1), { timeout: 3_000 });
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
