import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityEvent, AgentEvent, Automation } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { fileApprovalsStore } from "../automations/approvals-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import { fileTurnJournal } from "../agent/turn-journal.js";
import type { Services } from "../composition.js";
import { createWebchatRoute } from "./webchat.routes.js";

const ORIGIN = "https://site.example";

const fakeServices = (root: string, appends: ActivityEvent[]): Services =>
    ({
        automations: fileAutomationsStore(join(root, "automations.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        activity: { append: async (e: Omit<ActivityEvent, "id" | "at">) => void appends.push(e as ActivityEvent), list: async () => [] },
        workspace: { root },
        logger: { error: () => {}, warn: () => {} },
        // A held automation notifies the owner (scheduler.ts). Fire-and-forget there, so a missing stub
        // surfaces only as an unhandled rejection — loud enough to poison a later test, quiet enough to hide.
        pushSender: { notify: async () => {}, notifyIfAway: async () => {} },
    }) as unknown as Services;

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

const webchat = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "listener", provider: "webchat", allowedOrigins: [ORIGIN] },
    prompt: `support:${id}`,
    enabled: true,
    ...extra,
});

const appFor = (services: Services, wake: WakeFn): Hono => new Hono().post("/webchat/:id/message", createWebchatRoute(services, wake));

const post = (app: Hono, id: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    app.request(`/webchat/${id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });

const setup = async (automation: Automation) => {
    const appends: ActivityEvent[] = [];
    const services = fakeServices(mkdtempSync(join(tmpdir(), "webchat-")), appends);
    await services.automations.upsert(automation);
    return { services, appends };
};

test("an allowed visitor message wakes the agent and streams the reply back as SSE", async () => {
    const { services, appends } = await setup(webchat("wc-ok"));
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts, [{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "done" }]));
    const res = await post(app, "wc-ok", { conversationId: "c1", content: "fix the bug" });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: delta\ndata: Hel");
    expect(body).toContain("event: delta\ndata: lo");
    expect(body).toContain("event: done");
    // The visitor message reached the wake and a completed run was recorded.
    expect(prompts[0]).toContain("support:wc-ok");
    expect(prompts[0]).toContain("fix the bug");
    expect((await services.automations.get("wc-ok"))?.runs[0]?.outcome).toBe("completed");
    // The inbound request landed in the activity feed.
    expect(appends[0]).toMatchObject({ provider: "webchat", direction: "in", type: "message.received", content: "fix the bug" });
});

test("a requireApproval automation holds the wake and streams a pending notice instead of a reply", async () => {
    const { services } = await setup(webchat("wc-gated", { requireApproval: true }));
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts));
    const res = await post(app, "wc-gated", { conversationId: "c1", content: "change the header" });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("event: pending");
    // Held, not run: no prompt reached the agent and one approval is queued.
    expect(prompts).toEqual([]);
    expect(await services.approvals.list()).toHaveLength(1);
    expect((await services.automations.get("wc-gated"))?.runs).toEqual([]);
});

test("a disallowed or missing origin is refused before any wake", async () => {
    const { services } = await setup(webchat("wc-origin"));
    const prompts: string[] = [];
    const app = appFor(services, fakeWake(prompts));
    expect((await post(app, "wc-origin", { conversationId: "c1", content: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(app, "wc-origin", { conversationId: "c1", content: "x" }, {})).status).toBe(403);
    expect(prompts).toEqual([]);
});

test("unknown id, disabled automation, and invalid body are rejected", async () => {
    const { services } = await setup(webchat("wc-guard", { enabled: false }));
    const app = appFor(services, fakeWake([]));
    expect((await post(app, "missing", { conversationId: "c1", content: "x" })).status).toBe(404);
    expect((await post(app, "wc-guard", { conversationId: "c1", content: "x" })).status).toBe(409);
    // Enable it, then send a body with no content.
    await services.automations.upsert(webchat("wc-guard"));
    expect((await post(app, "wc-guard", { conversationId: "c1" })).status).toBe(400);
});

test("a conversation is rate limited after the window fills", async () => {
    const { services } = await setup(webchat("wc-rate"));
    const app = appFor(services, fakeWake([]));
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
        const res = await post(app, "wc-rate", { conversationId: "burst", content: `m${i}` });
        await res.text();
        statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
});
