import { describe, expect, it } from "vitest";
import { createAgentsRegistry, type AgentTurnIdentity } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";

const memoryStore = (initial: PersistedAgent[] = []): AgentsStore & { saved: () => PersistedAgent[] } => {
    let data = initial;
    return {
        load: async () => data,
        save: async (agents) => {
            data = [...agents];
        },
        saved: () => data,
    };
};

const turn = (overrides: Partial<AgentTurnIdentity> = {}): AgentTurnIdentity => ({
    conversationId: "c1",
    prompt: "Fix the login bug",
    provider: "claude",
    harness: "native",
    ...overrides,
});

describe("agents registry", () => {
    it("begin creates an entry with title, branch, and running status", async () => {
        const registry = createAgentsRegistry(memoryStore());
        await registry.init();
        expect(await registry.begin(turn(), 1_000)).toBe(true);
        const summary = registry.get("c1");
        expect(summary?.status).toBe("running");
        expect(summary?.branch).toBe("agent/c1");
        expect(summary?.title).toBe("Fix the login bug");
        expect(summary?.startedAt).toBe(1_000);
    });

    it("begin is a mutex: a second concurrent turn is refused until finish", async () => {
        const registry = createAgentsRegistry(memoryStore());
        await registry.init();
        await registry.begin(turn(), 1_000);
        expect(await registry.begin(turn(), 2_000)).toBe(false);
        await registry.finish("c1", 3_000);
        expect(await registry.begin(turn(), 4_000)).toBe(true);
    });

    it("keeps the first title and accumulates usage across turns", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store);
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "usage", costUsd: 0.5, inputTokens: 100, outputTokens: 50 });
        await registry.finish("c1", 2_000);
        await registry.begin(turn({ prompt: "another prompt" }), 3_000);
        registry.observe("c1", { kind: "usage", costUsd: 0.25, inputTokens: 10, outputTokens: 5 });
        await registry.finish("c1", 4_000);
        const summary = registry.get("c1");
        expect(summary?.title).toBe("Fix the login bug");
        expect(summary?.costUsd).toBeCloseTo(0.75);
        expect(summary?.inputTokens).toBe(110);
        expect(summary?.outputTokens).toBe(55);
        expect(store.saved().find((entry) => entry.id === "c1")?.costUsd).toBeCloseTo(0.75);
    });

    it("plan pauses to awaiting with attention; the next frame resumes", async () => {
        const registry = createAgentsRegistry(memoryStore());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "plan", decisionId: "d1", text: "the plan" });
        expect(registry.get("c1")?.status).toBe("awaiting");
        expect(registry.get("c1")?.attention.plan).toBe(true);
        registry.observe("c1", { kind: "delta", text: "resumed" });
        expect(registry.get("c1")?.status).toBe("running");
        expect(registry.get("c1")?.attention.plan).toBe(false);
    });

    it("error during the turn persists as error status at finish", async () => {
        const registry = createAgentsRegistry(memoryStore());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    it("session and worktree composition persist; land outcome raises conflict attention", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store);
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "s9" });
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.sessionId).toBe("s9");
        expect(registry.get("c1")?.base).toBe("aaaaaaa");
        await registry.setLandOutcome("c1", "conflict", 3_000);
        expect(registry.get("c1")?.status).toBe("conflict");
        expect(registry.get("c1")?.attention.conflict).toBe(true);
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("conflict");
    });

    it("activity tracks the last tool and current todo", async () => {
        const registry = createAgentsRegistry(memoryStore());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "tool_call", id: "t1", name: "Edit", category: "edit", status: "in_progress", target: "src/app.ts" });
        registry.observe("c1", {
            kind: "todos",
            items: [
                { content: "done thing", status: "completed", activeForm: "doing" },
                { content: "current thing", status: "in_progress", activeForm: "doing" },
            ],
        });
        expect(registry.get("c1")?.activity).toEqual({ tool: "Edit", target: "src/app.ts", todo: "current thing" });
    });

    it("subscribe delivers an immediate snapshot and change broadcasts", async () => {
        const registry = createAgentsRegistry(memoryStore());
        await registry.init();
        const frames: number[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents.length));
        expect(frames).toEqual([0]);
        await registry.begin(turn(), 1_000);
        expect(frames.at(-1)).toBe(1);
        // delta frames are not card-visible — no broadcast.
        const count = frames.length;
        registry.observe("c1", { kind: "delta", text: "..." });
        expect(frames.length).toBe(count);
        unsubscribe();
    });

    it("remove drops the entry and rehydration restores persisted entries", async () => {
        const store = memoryStore();
        const first = createAgentsRegistry(store);
        await first.init();
        await first.begin(turn(), 1_000);
        await first.finish("c1", 2_000);
        const second = createAgentsRegistry(store);
        await second.init();
        expect(second.get("c1")?.status).toBe("idle");
        await second.remove("c1");
        expect(second.get("c1")).toBeUndefined();
        expect(store.saved()).toEqual([]);
    });
});
