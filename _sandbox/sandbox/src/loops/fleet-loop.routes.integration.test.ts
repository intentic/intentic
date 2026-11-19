import type { Hono } from "hono";
import { waitFor } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import type { AppEnv } from "../app-env.js";
import { clientFor, proven } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";

// The shell doors `agents loop` and `agents continue` reach, over HTTP with the agent token: a chain started once instead
// of "continue" typed into a new conversation each time a turn ends, and a conversation carried on in a fresh session.
// (2026-11-19: in one audited sandbox the owner drove a backlog through nine conversations by hand.)

// Whole turns through the app: seconds each on a machine short of memory, where the default five would cut them off.
const TURNS_TIMEOUT_MS = 60_000;

const AGENT = { "x-intentic-agent": "agent-secret", "content-type": "application/json" };

// What every turn's runtime was handed: its prompt, and the session it was asked to resume, if any.
const recordingApp = () => {
    const handed: { readonly prompt: string; readonly sessionId: string | undefined }[] = [];
    const built = services({
        auth: { authorize: async () => proven("owner@example.com", "owner") },
        turnCheckpoints: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
        async *agent(request) {
            handed.push({ prompt: request.spec.prompt, sessionId: request.spec.sessionId });
            yield { kind: "session", sessionId: `sess-${String(handed.length)}` };
            yield { kind: "done" };
        },
        sessions: { list: async () => [], read: async () => [], readTail: async () => [], search: async () => [], exists: async () => true },
    });
    return { app: createApp(built), built, handed };
};

const post = async (app: Hono<AppEnv>, path: string, body: unknown) => {
    const response = await app.request(`http://sandbox.test${path}`, { method: "POST", headers: AGENT, body: JSON.stringify(body) });
    const answer: { readonly ok: boolean; readonly conversationId?: string; readonly message?: string; readonly run?: string } = await response.json();
    return { status: response.status, answer };
};

test("`agents loop` opens a new conversation and runs fresh rounds on it until a ceiling ends them", async () => {
    const { app, built, handed } = recordingApp();
    const { status, answer } = await post(app, "/fleet/loop", { prompt: "Take the next open item in BACKLOG.md.", max: 2, stall: 5 });
    expect(status).toBe(200);
    const id = answer.conversationId ?? "";
    expect(id).toMatch(/^[a-z]+-[a-z0-9]{4}$/u);
    await waitFor(async () => expect((await built.loops.get(id))?.state).toBe("exhausted"), { timeout: TURNS_TIMEOUT_MS / 2 });
    const record = await built.loops.get(id);
    // No round writes its claim here, so the loop runs out of rounds rather than calling anything done.
    expect(record).toMatchObject({ state: "exhausted", context: "fresh", output: { kind: "claim" }, isolated: true });
    expect(handed).toHaveLength(2);
    expect(handed[0]?.prompt).toContain("Take the next open item in BACKLOG.md.");
    expect(handed[0]?.prompt).toContain(`"remaining"`);
    // Each round opens fresh, and the second is told where the first ended.
    expect(handed.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    expect(handed[1]?.prompt).toContain("## Where the last round left it");
}, TURNS_TIMEOUT_MS);

test("a loop on a conversation nobody can name is refused, and stopping one that is not looping says so", async () => {
    const { app } = recordingApp();
    expect(await post(app, "/fleet/loop", { prompt: "x", on: "no-such-conversation" })).toMatchObject({ status: 404 });
    expect(await post(app, "/fleet/loop", { prompt: "x", model: "claude-opus-5-5" })).toMatchObject({ status: 400 });
    await runAgentTurn(clientFor(app), { prompt: "start the port", conversationId: "rhino-pvf5", isolated: true });
    expect(await post(app, "/fleet/loop/stop", { to: "rhino-pvf5" })).toMatchObject({ status: 404, answer: { message: "No loop is running on `rhino-pvf5`." } });
}, TURNS_TIMEOUT_MS);

test("`agents continue` carries a conversation on in a fresh session, opened with what its last turn said", async () => {
    const { app, handed } = recordingApp();
    await runAgentTurn(clientFor(app), { prompt: "start the port", conversationId: "rhino-pvf5", isolated: true });
    const { status, answer } = await post(app, "/fleet/continue", { to: "rhino-pvf5" });
    expect(status).toBe(200);
    expect(answer.conversationId).toBe("rhino-pvf5");
    await waitFor(() => expect(handed).toHaveLength(2), { timeout: TURNS_TIMEOUT_MS / 2 });
    expect(handed[1]?.sessionId).toBeUndefined();
    expect(handed[1]?.prompt).toContain("carries on in a fresh session, as somebody asked");
}, TURNS_TIMEOUT_MS);
