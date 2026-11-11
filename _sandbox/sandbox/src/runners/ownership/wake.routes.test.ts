import { Hono } from "hono";
import { createRunnerWakeRoute } from "./wake.routes.js";

/* A runner's own wake is said by the parent, and only into a conversation the parent placed on that runner. */

const entryOn = (runner: string | undefined) => ({
    id: "c1",
    placement: runner === undefined ? { kind: "main" } : { kind: "worktree", runner, repos: [] },
    profile: { provider: "claude", harness: "native" },
    identity: {},
});

const route = (entry: unknown) => {
    const said: unknown[] = [];
    const services = {
        runners: { verify: async () => ({ kind: "enrolled", id: "omen" }) },
        agents: { entry: () => entry },
        turns: {
            say: async (words: unknown) => {
                said.push(words);
                return { delivered: "started", run: "r1" };
            },
        },
        logger: { info: () => undefined },
    };
    const app = new Hono();
    // SAFETY: the route reads only the four services stubbed above.
    app.post("/system/runners/wake", createRunnerWakeRoute(services as never));
    const wake = (body: object) =>
        app.request("/system/runners/wake", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { said, wake };
};

test("a watch that fired on the runner starts the turn here, said as the parent's own wake", async () => {
    const { said, wake } = route(entryOn("omen"));
    const response = await wake({ conversationId: "c1", prompt: "The capture finished.", voice: "sandbox", source: "automation:watch-5qp2", messageId: "m1" });
    expect(await response.json()).toEqual({ forwarded: true, said: { delivered: "started", run: "r1" } });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
        voice: "sandbox",
        turn: { conversationId: "c1", prompt: "The capture finished.", messageId: "m1", speaker: { kind: "sandbox", source: "runner:omen:automation:watch-5qp2" } },
    });
});

test("a conversation not placed on that runner is left to the runner, and nothing is said here", async () => {
    for (const entry of [undefined, entryOn(undefined), entryOn("rog")]) {
        const { said, wake } = route(entry);
        const response = await wake({ conversationId: "c1", prompt: "hi", voice: "agent" });
        expect(await response.json()).toEqual({ forwarded: false });
        expect(said).toEqual([]);
    }
});
