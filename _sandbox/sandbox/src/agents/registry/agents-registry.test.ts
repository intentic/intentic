import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, AgentSummary } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { noteSubagentTask, resetSubagents, type SubagentTaskMessage, type SubagentTurn } from "../../agent/subagents/subagents.js";
import { MAX_NOTE_LENGTH, MAX_SUBJECT_LENGTH } from "../../git/ops/commit-message.js";
import { createAgentsRegistry, type AgentTurnIdentity } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";
import type { LandedPresence, LandedPresences } from "../land/landed-presence.js";
import type { LandStanding, LandStandings } from "../land/standing.js";

// Hand-dialed stand-in for land standing; real derivation needs a git repo per case (standing.integration.test.ts).
// This suite only pins the projection: which half wins, and what each surface reads off it.
const standings = (): LandStandings & { set: (id: string, standing: LandStanding) => void } => {
    const verdicts = new Map<string, LandStanding>();
    return {
        of: (id) => verdicts.get(id) ?? "idle",
        refresh: async () => false,
        forget: (ids) => {
            for (const id of ids) {
                verdicts.delete(id);
            }
        },
        set: (id, standing) => verdicts.set(id, standing),
    };
};

// Hand-dialed stand-in for landed presence; real derivation needs a git repo per case
// (landed-presence.integration.test.ts).
const presences = (): LandedPresences & { set: (id: string, presence: LandedPresence) => void } => {
    const readings = new Map<string, LandedPresence>();
    return {
        of: (id) => readings.get(id),
        refresh: async () => false,
        forget: (ids) => {
            for (const id of ids) {
                readings.delete(id);
            }
        },
        metrics: () => ({}),
        set: (id, presence) => readings.set(id, presence),
    };
};

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
    isolated: true,
    prompt: "Fix the login bug",
    provider: "claude",
    harness: "native",
    ...overrides,
});

describe("agents registry", () => {
    it("begin creates an entry with title, branch, and running status", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        expect(await registry.begin(turn(), 1_000)).toBe(true);
        const summary = registry.get("c1");
        expect(summary?.status).toBe("running");
        expect(summary?.branch).toBe("agent/c1");
        expect(summary?.title).toBe("Fix the login bug");
        expect(summary?.startedAt).toBe(1_000);
    });

    // Naming a runner forces a branch even if the request omits `isolated`: a remote conversation is isolated by
    // construction.
    it("a runner latches on the first turn, survives turns that name none, and cannot be moved", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        expect(await registry.begin(turn({ runner: "rog", isolated: false }), 1_000)).toBe(true);
        expect(registry.entry("c1")?.runner).toBe("rog");
        expect(registry.entry("c1")?.branch).toBe("agent/c1");
        await registry.finish("c1", 1_500);
        expect(await registry.begin(turn(), 2_000)).toBe(true);
        expect(registry.entry("c1")?.runner).toBe("rog");
        await registry.finish("c1", 2_500);
        expect(await registry.begin(turn({ runner: "other" }), 3_000)).toBe(true);
        expect(registry.entry("c1")?.runner).toBe("rog");
    });

    it("a conversation that ran here never picks up a runner from a later request", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        expect(await registry.begin(turn(), 1_000)).toBe(true);
        await registry.finish("c1", 1_500);
        expect(await registry.begin(turn({ runner: "rog" }), 2_000)).toBe(true);
        expect(registry.entry("c1")?.runner).toBeUndefined();
    });

    // The rewind lease and the turn mutex are the same lock; splitting them would let a rewind and a turn miss each
    // other.
    it("refuses a turn while a rewind holds the conversation, and readmits it after", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();

        let beganDuringRewind: boolean | undefined;
        const held = await registry.withRewindLease("c1", async () => {
            beganDuringRewind = await registry.begin(turn(), 1_000);
            return "restored";
        });

        expect(held).toBe("restored");
        expect(beganDuringRewind).toBe(false);
        expect(await registry.begin(turn(), 2_000)).toBe(true);
    });

    it("refuses a rewind while a turn is running, and releases the lease even when the rewind throws", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);

        expect(await registry.withRewindLease("c1", async () => "restored")).toBeUndefined();
        // Mutex is per conversation; a different one is unaffected.
        expect(await registry.withRewindLease("c2", async () => "restored")).toBe("restored");

        await registry.finish("c1", 2_000);
        await expect(
            registry.withRewindLease("c1", () => {
                throw new Error("restore blew up");
            }),
        ).rejects.toThrow("restore blew up");
        expect(await registry.begin(turn(), 3_000)).toBe(true);
    });

    it("writes the session id through to the store as the frame arrives, not at the finish that flushes it", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "sess-1" });

        // Awaits `setTitle` to flush the fire-and-forget session write, like a persisting caller would.
        await registry.setTitle("c1", "Fix the login bug", "user");
        expect(store.saved().find((entry) => entry.id === "c1")?.sessionId).toBe("sess-1");

        // A session switch mid-turn (a handoff) moves the pointer with it.
        registry.observe("c1", { kind: "session", sessionId: "sess-2" });
        await registry.finish("c1", 2_000);
        expect(store.saved().find((entry) => entry.id === "c1")?.sessionId).toBe("sess-2");
    });

    // Stores the frame's account, not the request's: an account-less request is served by whichever connected account
    // has headroom.
    it("records the account that actually served the turn, whatever the request asked for", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();

        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "sess-1", account: "acct-work" });
        await registry.setTitle("c1", "Fix the login bug", "user");
        expect(store.saved().find((entry) => entry.id === "c1")).toMatchObject({ sessionId: "sess-1", account: "acct-work" });

        // A frame naming no account does not clear a previously recorded one.
        registry.observe("c1", { kind: "session", sessionId: "sess-2" });
        await registry.finish("c1", 2_000);
        expect(store.saved().find((entry) => entry.id === "c1")).toMatchObject({ sessionId: "sess-2", account: "acct-work" });
    });

    it("moves the recorded account when a later turn runs on a different one", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn({ account: "acct-work" }), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "sess-1", account: "acct-work" });
        await registry.finish("c1", 2_000);

        await registry.begin(turn({ account: "acct-personal" }), 3_000);
        registry.observe("c1", { kind: "session", sessionId: "sess-2", account: "acct-personal" });
        await registry.finish("c1", 4_000);

        expect(store.saved().find((entry) => entry.id === "c1")).toMatchObject({ sessionId: "sess-2", account: "acct-personal" });
    });

    it("clearSession drops the pointer so the next turn opens a fresh provider thread", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "sess-1" });
        expect(registry.sessionIdOf("c1")).toBe("sess-1");

        await registry.clearSession("c1");
        // `sessionIdOf` checks the live pending id and the persisted one.
        expect(registry.sessionIdOf("c1")).toBeUndefined();
        await registry.finish("c1", 2_000);
        expect(registry.sessionIdOf("c1")).toBeUndefined();
    });

    it("registers a workspace conversation without inventing a branch and projects its clean completion as idle", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ isolated: false }), 1_000);

        expect(registry.get("c1")).toMatchObject({ id: "c1", status: "running", title: "Fix the login bug" });
        expect(registry.get("c1")).not.toHaveProperty("branch");

        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        expect(registry.get("c1")?.status).toBe("awaiting");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("idle");
    });

    it("latches placement to the conversation instead of accepting a later request's stale posture", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();

        await registry.begin(turn({ conversationId: "workspace", isolated: false }), 1_000);
        await registry.finish("workspace", 1_100);
        await registry.begin(turn({ conversationId: "workspace", isolated: true }), 1_200);
        expect(registry.get("workspace")).not.toHaveProperty("branch");

        await registry.begin(turn({ conversationId: "isolated", isolated: true }), 2_000);
        await registry.finish("isolated", 2_100);
        await registry.begin(turn({ conversationId: "isolated", isolated: false }), 2_200);
        expect(registry.get("isolated")?.branch).toBe("agent/isolated");
    });

    it("records where an outside message came from and keeps it across the user's own follow-up turns", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        const origin = { automationId: "support", provider: "discord", channelId: "c-general", author: "alice" };
        await registry.begin(turn({ origin, title: "alice: the build is red" }), 1_000);
        expect(registry.get("c1")?.origin).toEqual(origin);
        await registry.finish("c1", 2_000);
        await registry.begin(turn({ prompt: "try the other fix" }), 3_000);
        expect(registry.get("c1")?.origin).toEqual(origin);
    });

    it("records the settings a turn ran under and keeps them for a turn that states none", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false }), 1_000);
        expect(registry.get("c1")).toMatchObject({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false });
        await registry.finish("c1", 2_000);
        await registry.begin(turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")).toMatchObject({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false });
    });

    it("holds the autoLand override across turns and clears it on null", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        // Set mid-turn; read at the turn's completion.
        expect((await registry.setAutoLand("c1", false))?.autoLand).toBe(false);
        await registry.finish("c1", 2_000);
        await registry.begin(turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")?.autoLand).toBe(false);
        await registry.finish("c1", 4_000);
        // null clears to absent ('inherit the sandbox setting'), not to a stored `false`.
        expect((await registry.setAutoLand("c1", null))?.autoLand).toBeUndefined();
        expect(registry.entry("c1")?.autoLand).toBeUndefined();
        expect(await registry.setAutoLand("nope", true)).toBeUndefined();
    });

    it("holds the resumeAfterOutage override across turns and clears it on null", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        // Set mid-turn: the offer is typically pressed while the dead turn is still unwinding.
        expect((await registry.setResumeAfterOutage("c1", true))?.resumeAfterOutage).toBe(true);
        await registry.finish("c1", 2_000);
        await registry.begin(turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")?.resumeAfterOutage).toBe(true);
        await registry.finish("c1", 4_000);
        // `false` is a real answer ('stop resuming'), distinct from the default, which may itself be resume.
        expect((await registry.setResumeAfterOutage("c1", false))?.resumeAfterOutage).toBe(false);
        // null is what hands the conversation back to the default.
        expect((await registry.setResumeAfterOutage("c1", null))?.resumeAfterOutage).toBeUndefined();
        expect(registry.entry("c1")?.resumeAfterOutage).toBeUndefined();
        expect(await registry.setResumeAfterOutage("nope", true)).toBeUndefined();
    });

    it("begin is a mutex: a second concurrent turn is refused until finish", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        expect(await registry.begin(turn(), 2_000)).toBe(false);
        await registry.finish("c1", 3_000);
        expect(await registry.begin(turn(), 4_000)).toBe(true);
    });

    it("keeps the first title and accumulates usage across turns", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
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

    it("begin prefers the turn's title over the prompt; a whitespace title falls back to the prompt", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ title: "My renamed draft" }), 1_000);
        expect(registry.get("c1")?.title).toBe("My renamed draft");
        await registry.begin(turn({ conversationId: "c2", title: "   " }), 2_000);
        expect(registry.get("c2")?.title).toBe("Fix the login bug");
    });

    it("setTitle persists, broadcasts, keeps updatedAt, and survives a running turn's finish", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.title));
        const before = registry.get("c1")?.updatedAt;
        const summary = await registry.setTitle("c1", "  Login fix  ", "user");
        expect(summary?.title).toBe("Login fix");
        expect(frames.at(-1)).toBe("Login fix");
        expect(registry.get("c1")?.updatedAt).toBe(before);
        expect(store.saved().find((entry) => entry.id === "c1")?.title).toBe("Login fix");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.title).toBe("Login fix");
        expect(await registry.setTitle("nope", "x", "user")).toBeUndefined();
        expect(await registry.setTitle("c1", " \u0000 ", "user")).toBeUndefined();
        unsubscribe();
    });

    // Counts come from the subagent registry via `summaryOf`; this only pins the publish. Runs against the real
    // registry, not a stub, since the projection is what's under test.
    it("publishes the fleet when a child is born and when it settles, but not for its progress", async () => {
        resetSubagents();
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const child: SubagentTurn = { conversationId: "c1", cwd: WORKSPACE_ROOT, sessionId: "sess-1", subagentsDir: undefined };
        const frame = (message: SubagentTaskMessage): AgentEvent => {
            const born = noteSubagentTask(child, message);
            if (born === undefined) {
                throw new Error(`the subagent registry ignored a ${message.subtype}`);
            }
            return born;
        };
        const frames: (AgentSummary["subagents"] | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.subagents));
        expect(frames).toEqual([undefined]);

        registry.observe(
            "c1",
            frame({ subtype: "task_started", task_id: "task-a", tool_use_id: "call-1", description: "Locate the handler", subagent_type: "Explore" }),
        );
        expect(frames).toEqual([undefined, { running: 1, total: 1 }]);

        registry.observe("c1", frame({ subtype: "task_progress", task_id: "task-a", tool_use_id: "call-1", usage: { total_tokens: 9_000 } }));
        expect(frames).toEqual([undefined, { running: 1, total: 1 }]);

        registry.observe("c1", frame({ subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } }));
        expect(frames).toEqual([undefined, { running: 1, total: 1 }, { running: 0, total: 1 }]);
        unsubscribe();

        // `resetSubagents()` simulates a restart; `total`, persisted on the entry, survives it.
        const store = memoryStore();
        const persisted = createAgentsRegistry(store, standings(), presences());
        await persisted.init();
        await persisted.begin(turn(), 1_000);
        persisted.observe(
            "c1",
            frame({ subtype: "task_started", task_id: "task-b", tool_use_id: "call-2", description: "Audit the deps", subagent_type: "Explore" }),
        );
        await persisted.finish("c1", 2_000);
        resetSubagents();
        expect(persisted.get("c1")?.subagents).toEqual({ running: 0, total: 1 });
        expect(store.saved().find((entry) => entry.id === "c1")?.subagents).toBe(1);
        // Subagent totals accumulate across turns rather than resetting.
        await persisted.begin(turn(), 3_000);
        persisted.observe(
            "c1",
            frame({ subtype: "task_started", task_id: "task-c", tool_use_id: "call-3", description: "Draft the fix", subagent_type: "claude" }),
        );
        expect(persisted.get("c1")?.subagents).toEqual({ running: 1, total: 2 });
    });

    it("markSeen persists the read marker, broadcasts it, and leaves updatedAt alone", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        const frames: (number | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.seenAt));
        expect(registry.get("c1")?.seenAt).toBeUndefined();
        await registry.markSeen("c1", 3_000);
        expect(registry.get("c1")?.seenAt).toBe(3_000);
        expect(registry.get("c1")?.updatedAt).toBe(2_000);
        expect(frames.at(-1)).toBe(3_000);
        expect(store.saved().find((entry) => entry.id === "c1")?.seenAt).toBe(3_000);
        // The read marker survives the next turn's entry rebuild.
        await registry.begin(turn(), 4_000);
        await registry.finish("c1", 5_000);
        expect(registry.get("c1")?.seenAt).toBe(3_000);
        expect(await registry.markSeen("nope", 6_000)).toBeUndefined();
        unsubscribe();
    });

    it("markAllSeen stamps the whole fleet: the board's one escape hatch", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.begin(turn({ conversationId: "c2" }), 2_000);
        await registry.markAllSeen(9_000);
        expect(registry.list().map((agent) => agent.seenAt)).toEqual([9_000, 9_000]);
        expect(store.saved().every((entry) => entry.seenAt === 9_000)).toBe(true);
    });

    it("promotes the title to a plan's heading, which names the job the opening prompt only hinted at", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn({ prompt: "the login page throws on submit" }), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.title));

        registry.observe("c1", { kind: "plan", requestId: "r1", text: "## Fix the login submit handler\n\nFirst, read the form." });

        // Rides the plan frame's own broadcast; no extra one is sent.
        expect(registry.get("c1")?.title).toBe("Fix the login submit handler");
        expect(frames.at(-1)).toBe("Fix the login submit handler");
        // Persisted out of band; the `setTimeout(0)` lets that write land before checking the store.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.saved().find((entry) => entry.id === "c1")?.title).toBe("Fix the login submit handler");
        unsubscribe();
    });

    it("leaves the title alone for a plan with no heading to take it from", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ prompt: "the login page throws on submit" }), 1_000);

        registry.observe("c1", { kind: "plan", requestId: "r1", text: "Read the form, then fix the handler." });

        expect(registry.get("c1")?.title).toBe("The login page throws on submit");
    });

    it("lets the first plan name the job and refuses to let a replan rename it", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);

        registry.observe("c1", { kind: "plan", requestId: "r1", text: "# Fix the login submit handler" });
        registry.observe("c1", { kind: "plan", requestId: "r2", text: "# Rewrite the form validation instead" });

        expect(registry.get("c1")?.title).toBe("Fix the login submit handler");
    });

    it("slots a model name above the derived guess and below a plan's own name", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ prompt: "we have recently added the fleet board" }), 1_000);

        expect((await registry.setTitle("c1", "Fleet board broadcast · wire", "model"))?.title).toBe("Fleet board broadcast · wire");
        // A repeated model-sourced title does not override the first.
        await registry.setTitle("c1", "A second reading", "model");
        expect(registry.get("c1")?.title).toBe("Fleet board broadcast · wire");

        registry.observe("c1", { kind: "plan", requestId: "r1", text: "# Fix the fleet broadcast fan-out" });
        expect(registry.get("c1")?.title).toBe("Fix the fleet broadcast fan-out");
        // A plan's title is never replaced by a later model-sourced one.
        await registry.setTitle("c1", "A late reading", "model");
        expect(registry.get("c1")?.title).toBe("Fix the fleet broadcast fan-out");
    });

    // The two failure sentences (agent/failure-sentences.ts); guarding only one is how the other got through.
    const FAILURE_SENTENCES = [
        "You've hit your session limit · resets 11:50pm (UTC)",
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
        "Claude Haiku",
        "I am Claude",
    ];

    it.each(FAILURE_SENTENCES)("refuses %s as any automatic title: it names the failure, not the work", async (sentence) => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);

        // The derived title must stay replaceable; a later honest model title still lands.
        await registry.setTitle("c1", sentence, "model");
        expect(registry.get("c1")?.title).toBe("Fix the login bug");
        expect((await registry.setTitle("c1", "Fleet board broadcast · wire", "model"))?.title).toBe("Fleet board broadcast · wire");
    });

    it.each(FAILURE_SENTENCES)("a stolen title reading %s forfeits its rank, so the next name heals it", async (sentence) => {
        // Fixture: an entry already titled with a failure sentence, at `model` rank, predating this guard.
        const poisoned: PersistedAgent = {
            id: "c1",
            branch: "agent/c1",
            provider: "claude",
            harness: "native",
            repos: [],
            status: "idle",
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            createdAt: 1_000,
            updatedAt: 1_000,
            title: sentence,
            titleSource: "model",
        };
        const registry = createAgentsRegistry(memoryStore([poisoned]), standings(), presences());
        await registry.init();
        expect((await registry.setTitle("c1", "Fleet board broadcast · wire", "model"))?.title).toBe("Fleet board broadcast · wire");
    });

    it("never lets a plan rename what the user named, and still allows a second rename", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.setTitle("c1", "Login bug", "user");

        registry.observe("c1", { kind: "plan", requestId: "r1", text: "# Fix the login submit handler" });
        expect(registry.get("c1")?.title).toBe("Login bug");

        // A user rename is not ranked; a second one is not a rejected sideways move.
        expect((await registry.setTitle("c1", "Login bug (round two)", "user"))?.title).toBe("Login bug (round two)");
    });

    it("a card parks the agent until its own release: the frames trailing it do not", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        // The `ask` tool's question can arrive before its own `tool_call` frame (dispatch vs queued stream); a `delta`
        // afterward must not read as an answer.
        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        registry.observe("c1", { kind: "tool_call", id: "t1", name: "AskUserQuestion", category: "other", status: "in_progress" });
        registry.observe("c1", { kind: "delta", text: "still waiting" });
        expect(registry.get("c1")?.status).toBe("awaiting");
        expect(registry.get("c1")?.attention.question).toBe(true);
        registry.observe("c1", { kind: "resolved", requestId: "q1" });
        expect(registry.get("c1")?.status).toBe("running");
        expect(registry.get("c1")?.attention.question).toBe(false);
    });

    it("cards are released one at a time; a release for one nobody raised changes nothing", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "plan", requestId: "p1", text: "the plan" });
        registry.observe("c1", { kind: "permission", requestId: "perm1", toolName: "Bash" });
        registry.observe("c1", { kind: "resolved", requestId: "p1" });
        expect(registry.get("c1")?.status).toBe("awaiting");
        expect(registry.get("c1")?.attention).toMatchObject({ plan: false, permission: true });
        registry.observe("c1", { kind: "resolved", requestId: "unknown" });
        expect(registry.get("c1")?.status).toBe("awaiting");
        registry.observe("c1", { kind: "resolved", requestId: "perm1" });
        expect(registry.get("c1")?.status).toBe("running");
        expect(registry.get("c1")?.attention.permission).toBe(false);
    });

    it("stopping a parked turn takes its card off the board: the release may never arrive", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("idle");
        expect(registry.get("c1")?.attention.question).toBe(false);
    });

    it("publishes the stop the instant it lands, ahead of the unwind", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        registry.stopping("c1", "stopped");
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(frames.at(-1)).toBe("stopping");
        // Mutex is still held during `stopping`; a new turn would still collide with it.
        expect(registry.running("c1")).toBe(true);
        unsubscribe();
    });

    // Not `error` (an abort's own unwind is not a failure) and not `interrupted` (that means the daemon died): a chosen
    // stop must never come back on its own.
    it("settles a stopped turn as stopped, on the entry the next boot reads", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.stopping("c1", "stopped");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("stopped");
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("stopped");
        // Does not leak into the next turn on the same conversation.
        await registry.begin(turn(), 3_000);
        expect(registry.get("c1")?.status).toBe("running");
        await registry.finish("c1", 4_000);
        expect(registry.get("c1")?.status).toBe("idle");
    });

    // Dismissal settles immediately, unlike a stop. The card must never read `running` in between, even though the
    // transitional `dismissing` publish is skipped and finish's own broadcast covers the gap.
    it("publishes a dismissal at the press, under the ending it is heading for", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        registry.stopping("c1", "dismissed");
        expect(frames.at(-1)).toBe("dismissing");
        // The turn is still live; only the card's question is gone.
        expect(registry.get("c1")?.attention.question).toBe(false);
        expect(registry.running("c1")).toBe(true);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("idle");
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("idle");
        // `dismissing` and `idle` are both filed under the Finished lane (`laneOf`), so the card never moves lanes.
        expect(frames.at(-1)).toBe("idle");
        expect(frames).not.toContain("running");
        unsubscribe();
    });

    it("drops the cards a stopping turn was parked on, and refuses to raise new ones", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        expect(registry.get("c1")?.status).toBe("awaiting");
        registry.stopping("c1", "stopped");
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(registry.get("c1")?.attention.question).toBe(false);
        registry.observe("c1", { kind: "permission", requestId: "perm1", toolName: "Bash" });
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(registry.get("c1")?.attention.permission).toBe(false);
    });

    // Would otherwise leak a stale flag into the conversation's next turn.
    it("says nothing for a stop with no live turn under it", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        const frames: number[] = [];
        const unsubscribe = registry.subscribe(() => frames.push(1));
        registry.stopping("c1", "stopped");
        registry.stopping("never-heard-of-it", "stopped");
        expect(registry.get("c1")?.status).toBe("idle");
        expect(frames.length).toBe(1);
        unsubscribe();
    });

    it("keeps an error that preceded the stop", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        registry.stopping("c1", "stopped");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // Runtime state (running flag, parked question, attention) dies with the process; only the persisted status
    // survives a crash, which is why a crashed turn must read back as `interrupted`, not `idle`.
    it("a turn the daemon died under comes back interrupted, not idle", async () => {
        const store = memoryStore();
        const first = createAgentsRegistry(store, standings(), presences());
        await first.init();
        await first.begin(turn(), 1_000);
        first.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        expect(first.get("c1")?.status).toBe("awaiting");

        // No `finish()`: simulates the process dying with the write already on disk.
        const rebooted = createAgentsRegistry(store, standings(), presences());
        await rebooted.init();
        expect(rebooted.get("c1")?.status).toBe("interrupted");
        expect(rebooted.running("c1")).toBe(false);
    });

    // `interrupted` is a placeholder; any ordinary ending overwrites it, so a later boot reads the real status instead.
    it("finishing overwrites the interrupted placeholder, and it does not survive the next boot", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        const landed = standings();
        landed.set("c1", "landed");
        const rebooted = createAgentsRegistry(store, landed, presences());
        await rebooted.init();
        expect(rebooted.get("c1")?.status).toBe("landed");
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("idle");
    });

    // Guards the whole roster refresh in one `finally`; a repo throwing here must not silence any other conversation's
    // probe.
    it("a probe that throws cannot fail a turn, and does not silence the other one", async () => {
        const failing: LandStandings = {
            of: () => "idle",
            refresh: async () => {
                throw new Error(`fatal: cannot change to '${WORKSPACE_ROOT}/deleted': No such file or directory`);
            },
            forget: () => {},
        };
        const moving = presences();
        // Presence refresh still succeeds; only standings is made to throw.
        const registry = createAgentsRegistry(memoryStore(), failing, { ...moving, refresh: async () => true });
        await registry.init();
        await registry.begin(turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        await expect(registry.finish("c1", 2_000)).resolves.toBeUndefined();
        await expect(registry.refreshStandings()).resolves.toBeUndefined();
        unsubscribe();
        expect(registry.get("c1")?.status).toBe("idle");
        expect(frames).toContain("idle");
    });

    it("error during the turn persists as error status at finish", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // A failure with a resume already scheduled must read neither `error` (not done failing) nor `idle` (not done):
    // only `resuming` says work is still coming back.
    it("a failure with a scheduled resume publishes the card as still coming back", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        // Status stays `running` until finish; the error frame lands mid-stream.
        expect(registry.get("c1")?.status).toBe("running");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("resuming");
        // Persisted status stays `idle`; `resuming` is a live-only projection, never written.
        expect(registry.entry("c1")?.status).toBe("idle");
    });

    it("the resumed turn takes the card straight back to running", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        await registry.finish("c1", 2_000);
        expect(await registry.begin(turn({ prompt: "…resumed automatically. Fix the login bug" }), 3_000)).toBe(true);
        expect(registry.get("c1")?.status).toBe("running");
        await registry.finish("c1", 4_000);
        expect(registry.get("c1")?.status).toBe("idle");
    });

    // A restored card's placeholder turn finishes seconds before the real resumed turn begins; `markResuming` holds the
    // card through that gap.
    it("markResuming holds the card through the settle that precedes its resumed turn", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.markResuming("c1");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("resuming");
        // The resumed turn's own `begin` ends the wait, same as the error-frame path.
        expect(await registry.begin(turn({ prompt: "…their response follows below. Approved." }), 3_000)).toBe(true);
        expect(registry.get("c1")?.status).toBe("running");
    });

    // Settles into `error`/Attention, never back into the clean `idle` the dead turn left behind.
    it("an abandoned resume settles the card into the failure it was holding open", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        await registry.finish("c1", 2_000);
        const failure = "The Claude sign-in this turn ran on could not be renewed.";
        expect(await registry.abandonResume("c1", 3_000, failure)).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
        // `failure` names the reason; `error` alone does not say why the wait ended.
        expect(registry.get("c1")?.failure).toBe(failure);
        // Idempotent: a second `abandonResume` still answers true, since the wait is already over.
        expect(await registry.abandonResume("c1", 4_000, failure)).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // A write in this window is overwritten by the finish that follows; the caller must retry.
    it("an abandon that lands while the turn is still unwinding reports that it did not take", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        // No `finish()` yet: the generator is still unwinding.
        expect(await registry.abandonResume("c1", 2_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(false);
        expect(registry.get("c1")?.status).toBe("running");
        await registry.finish("c1", 3_000);
        expect(await registry.abandonResume("c1", 4_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // The only record of a session that failed before producing any other output, such as a report or screenshot.
    it("keeps the sentence a failed turn died on, so the card can say why", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const message = "Your organization has disabled Claude subscription access for Claude Code";
        registry.observe("c1", {
            kind: "error",
            code: "claude-not-entitled",
            message,
        });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
        expect(registry.get("c1")?.failure).toBe(message);
    });

    // `failure` describes only the last turn; a clean rerun must drop it.
    it("drops the explanation the moment the conversation runs again", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "API Error: 403 organization not allowed" });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.failure).not.toBeUndefined();
        await registry.begin(turn({ prompt: "try again" }), 3_000);
        await registry.finish("c1", 4_000);
        expect(registry.get("c1")?.status).toBe("idle");
        expect(registry.get("c1")?.failure).toBeUndefined();
        expect(registry.entry("c1")?.failure).toBeUndefined();
    });

    // The user's own restart can beat the scheduler; abandon must not overwrite a turn that is now running.
    it("an abandoned resume leaves a turn the user already restarted alone", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        await registry.finish("c1", 2_000);
        await registry.begin(turn({ prompt: "try again" }), 3_000);
        expect(await registry.abandonResume("c1", 4_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(false);
        expect(registry.get("c1")?.status).toBe("running");
    });

    // `available` means nothing is armed yet; unlike `scheduled`, the failure stands as error.
    it("a failure whose resume is merely on offer still ends the turn in error", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "provider-outage", message: "API Error: 529", autoResume: "available" });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    it("session and worktree composition persist across a turn's finish", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "s9" });
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.sessionId).toBe("s9");
        expect(registry.get("c1")?.base).toBe("aaaaaaa");
    });

    // Precedence: live turn, then the last ending, then land standing; only `idle` yields. An error or interruption
    // outranks branch work, and a clean turn keeps no land verdict of its own.
    it("projects the land standing under a clean ending, and never over an error or an interruption", async () => {
        const store = memoryStore();
        const land = standings();
        const registry = createAgentsRegistry(store, land, presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("idle");

        land.set("c1", "conflict");
        expect(registry.get("c1")?.status).toBe("conflict");
        // `attention.conflict` reads the same derived verdict, not a stored status.
        expect(registry.get("c1")?.attention.conflict).toBe(true);
        // The land verdict is never persisted; the stored status stays `idle`.
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("idle");

        land.set("c1", "ready");
        expect(registry.get("c1")?.status).toBe("ready");
        expect(registry.get("c1")?.attention.conflict).toBe(false);

        // An error outranks the branch's land standing.
        await registry.begin(turn(), 3_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        await registry.finish("c1", 4_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // The lease is what keeps a second press from rebasing the worktree the first land is reading; the status is what
    // the card wears meanwhile, above the ending the last turn wrote, below a live turn.
    it("a land lease reads as `landing` from the claim to the last release, and queues a second land behind the first", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");

        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = registry.withLandLease("c1", async () => {
            await gate;
            return "first";
        });
        // Claimed synchronously: a request asking right after the claim already sees it.
        expect(registry.landing("c1")).toBe(true);
        expect(registry.get("c1")?.status).toBe("landing");

        let secondRan = false;
        const second = registry.withLandLease("c1", async () => {
            secondRan = true;
            return "second";
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(secondRan).toBe(false);

        release();
        expect(await first).toBe("first");
        expect(await second).toBe("second");
        expect(registry.landing("c1")).toBe(false);
        expect(registry.get("c1")?.status).toBe("error");
    });

    it("a land lease is released when its work throws, and a running turn keeps its own status over it", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        await expect(
            registry.withLandLease("c1", async () => {
                throw new Error("git refused");
            }),
        ).rejects.toThrow("git refused");
        expect(registry.landing("c1")).toBe(false);
        expect(registry.get("c1")?.status).toBe("idle");

        // A running turn's own end-of-turn land is still that turn running, not a card that stopped to land.
        await registry.begin(turn(), 3_000);
        let release: () => void = () => undefined;
        const lease = registry.withLandLease(
            "c1",
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        expect(registry.landing("c1")).toBe(true);
        expect(registry.get("c1")?.status).toBe("running");
        // The lease's work starts on the next tick; `release` is bound only once it has.
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await lease;
        await registry.finish("c1", 4_000);
    });

    it("recordLanded persists advanced landedTips and the cumulative diffstat", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 12, insertions: 412, deletions: 96 },
            adjudicated: true,
        });
        await registry.finish("c1", 2_000);
        expect(store.saved().find((entry) => entry.id === "c1")?.repos).toEqual([{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }]);
        expect(registry.get("c1")?.diff).toEqual({ files: 12, insertions: 412, deletions: 96 });
    });

    it("setLandedSubject keeps the release note and the breaking warning whole, and bounds the subject by git's header limit rather than a card's width", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const note = "You can now create, edit, and manage custom skills for your agent directly in the sandbox, without editing a file by hand.";
        const breaking =
            "The old skills folder is no longer read — move anything you keep there into the skills panel before updating, or it stops loading.";
        await registry.setLandedSubject("c1", { subject: "f".repeat(120), note, breaking });
        const saved = () => store.saved().find((entry) => entry.id === "c1");
        expect(saved()?.landedNote).toBe(note);
        expect(saved()?.landedBreaking).toBe(breaking);
        expect(saved()?.landedSubject).toHaveLength(MAX_SUBJECT_LENGTH);
        expect(MAX_SUBJECT_LENGTH).toBeGreaterThan(80);

        // Same cap enforced even if the model ignores the 'one sentence' guidance in the prompt.
        await registry.setLandedSubject("c1", { subject: "skills panel", note: "n".repeat(500) });
        expect(saved()?.landedNote).toHaveLength(MAX_NOTE_LENGTH);
    });

    it("setLandedSubject puts the message on the card and broadcasts it", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const frames: (AgentSummary["landedMessage"] | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.landedMessage));
        expect(frames).toEqual([undefined]);

        await registry.setLandedSubject("c1", { subject: "fix: cascading markers", note: "Markers stop cascading." });
        expect(frames.at(-1)).toEqual({ subject: "fix: cascading markers", note: "Markers stop cascading." });
        expect(registry.get("c1")?.landedMessage).toEqual({ subject: "fix: cascading markers", note: "Markers stop cascading." });

        // A second land replaces the message wholesale; nothing carries over from the first.
        await registry.setLandedSubject("c1", { subject: "fix: cascading markers and their counts" });
        expect(frames.at(-1)).toEqual({ subject: "fix: cascading markers and their counts" });
        unsubscribe();
    });

    // The stored report is evidence for standing.ts to explain a delta, never used to invent one; it must vanish once a
    // clean land clears the delta it described.
    it("recordLanded stores the land's conflict report, and a later clean land clears it", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        const conflicts = [{ repo: "root", paths: [{ path: "app.ts", reason: "workspace" as const }], clean: 2 }];
        await registry.recordLanded("c1", {
            landed: false,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            diff: { files: 3, insertions: 10, deletions: 1 },
            adjudicated: true,
            conflicts,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toEqual(conflicts);

        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 3, insertions: 10, deletions: 1 },
            adjudicated: true,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toBeUndefined();
    });

    // Every surface that explains a conflict (standing, review, the resolve action) reads off the stored report; a
    // measure land touches none of that and must not clear it.
    it("a measure land settles the books without retiring the last refusal", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        const conflicts = [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" as const }], clean: 2 }];
        await registry.recordLanded("c1", {
            landed: false,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            diff: { files: 3, insertions: 10, deletions: 1 },
            adjudicated: true,
            conflicts,
        });

        // Turn ended (stopped/dismissed): books settle, but the delta stays on the branch.
        await registry.recordLanded("c1", {
            landed: false,
            held: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            diff: { files: 4, insertions: 12, deletions: 1 },
            adjudicated: false,
        });
        const settled = store.saved().find((entry) => entry.id === "c1");
        expect(settled?.conflicts).toEqual(conflicts);
        // The diffstat still refreshes; only the conflict report and land outcome are held.
        expect(settled?.diffFiles).toBe(4);

        // A real land still has the final say, clearing the conflict report.
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 4, insertions: 12, deletions: 1 },
            adjudicated: true,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toBeUndefined();
    });

    // `begin` rebuilds the entry from an explicit field list; anything left off is dropped on the next turn.
    // `conflicts` and `landRequested` must survive it, since one more turn resolves neither.
    it("a follow-up turn keeps the land refusal and the ask still waiting on one", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        const conflicts = [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" as const }], clean: 2 }];
        await registry.recordLanded("c1", {
            landed: false,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            diff: { files: 3, insertions: 10, deletions: 1 },
            adjudicated: true,
            conflicts,
        });
        await registry.requestLand("c1", { email: "m@x.com", name: "Mo" }, 1_500);
        // The refused land runs after `finish`; `begin` would otherwise refuse while a turn is still running.
        await registry.finish("c1", 1_800);

        expect(await registry.begin(turn({ prompt: "rebase onto main" }), 2_000)).toBe(true);

        // Checked on the persisted entry; the live summary carries only the derived standing, not `conflicts`.
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toEqual(conflicts);
        expect(registry.get("c1")?.landRequested).toMatchObject({ email: "m@x.com", name: "Mo" });

        await registry.recordLanded("c1", {
            landed: false,
            held: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            diff: { files: 4, insertions: 12, deletions: 1 },
            adjudicated: false,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toEqual(conflicts);
    });

    it("counts turns and tool uses: live during the turn, folded at finish, never inflated by manual lands", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "tool_call", id: "t1", name: "Edit", category: "edit", status: "in_progress" });
        registry.observe("c1", { kind: "tool_call", id: "t2", name: "Bash", category: "execute", status: "in_progress" });
        expect(registry.get("c1")?.toolUses).toBe(2);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.turns).toBe(1);
        expect(registry.get("c1")?.toolUses).toBe(2);
        await registry.finish("c1", 3_000);
        expect(registry.get("c1")?.turns).toBe(1);
        await registry.begin(turn({ prompt: "again" }), 4_000);
        registry.observe("c1", { kind: "tool_call", id: "t3", name: "Read", category: "read", status: "in_progress" });
        await registry.finish("c1", 5_000);
        expect(registry.get("c1")?.turns).toBe(2);
        expect(registry.get("c1")?.toolUses).toBe(3);
    });

    // Needed so the next turn's plan re-states preamble notes a compaction summarized away (turn-plan.ts).
    it("files a compaction under the turn it happened in, once per turn, and persists it", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "compact", trigger: "auto" });
        // Filed against the pre-increment count: the first turn is 0, turn 1 is the one retold.
        expect(registry.entry("c1")?.compactedTurn).toBe(0);
        await registry.finish("c1", 2_000);
        expect(registry.entry("c1")?.turns).toBe(1);

        await registry.begin(turn({ prompt: "again" }), 3_000);
        registry.observe("c1", { kind: "compact", trigger: "auto" });
        registry.observe("c1", { kind: "compact", trigger: "manual" });
        expect(registry.entry("c1")?.compactedTurn).toBe(1);
        await registry.finish("c1", 4_000);

        expect(store.saved().find((entry) => entry.id === "c1")?.compactedTurn).toBe(1);
    });

    it("liveSessionIds reports the in-flight turns' sdk sessions, the terminals list's 'still working' signal", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        expect(registry.liveSessionIds()).toEqual([]);
        await registry.begin(turn(), 1_000);
        // The session id lands on the turn's first frame, before any Bash runs.
        registry.observe("c1", { kind: "session", sessionId: "3f2a9b1c-0000-4000-8000-000000000000" });
        expect(registry.liveSessionIds()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000"]);
        // A second conversation's session joins the set; each id drops once its own turn ends.
        await registry.begin(turn({ conversationId: "c2" }), 1_100);
        registry.observe("c2", { kind: "session", sessionId: "7c0e1ad7-0000-4000-8000-000000000000" });
        expect(registry.liveSessionIds().toSorted()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000", "7c0e1ad7-0000-4000-8000-000000000000"]);
        await registry.finish("c1", 2_000);
        expect(registry.liveSessionIds()).toEqual(["7c0e1ad7-0000-4000-8000-000000000000"]);
        await registry.finish("c2", 2_100);
        expect(registry.liveSessionIds()).toEqual([]);
        // Before its first frame, a resumed turn falls back to the session the last turn flushed.
        await registry.begin(turn({ prompt: "again" }), 3_000);
        expect(registry.liveSessionIds()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000"]);
    });

    it("activity tracks the last tool and current todo", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
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

    // What a turn left open, from only what it itself measured: the todo checklist and the workspace's own end-of-turn
    // check. No model is asked, and no agent declares anything.
    describe("unfinished work", () => {
        const list = (...items: [string, "pending" | "in_progress" | "completed"][]): AgentEvent => ({
            kind: "todos",
            items: items.map(([content, status]) => ({ content, status })),
        });

        it("counts what the last turn left on its own list, and names what it would have done next", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.observe("c1", list(["Read the registry", "completed"], ["Draw the mark", "in_progress"], ["Cover it with tests", "pending"]));
            await registry.finish("c1", 2_000);
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 2, total: 3, next: "Draw the mark" } });
        });

        it("says nothing about a turn that finished its own list", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.observe("c1", list(["Read the registry", "completed"], ["Draw the mark", "completed"]));
            await registry.finish("c1", 2_000);
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        // Re-measured every turn rather than stamped once, so finishing the work later actually clears it.
        it("clears once a later turn completes the list", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.observe("c1", list(["Draw the mark", "in_progress"]));
            await registry.finish("c1", 2_000);
            expect(registry.get("c1")?.unfinished?.steps).toEqual({ open: 1, total: 1, next: "Draw the mark" });

            await registry.begin(turn({ prompt: "carry on" }), 3_000);
            registry.observe("c1", list(["Draw the mark", "completed"]));
            await registry.finish("c1", 4_000);
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        it("re-stamps when a turn moves the list and still leaves something on it", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.observe("c1", list(["Draw the mark", "pending"], ["Cover it with tests", "pending"]));
            await registry.finish("c1", 2_000);

            await registry.begin(turn({ prompt: "carry on" }), 3_000);
            registry.observe("c1", list(["Draw the mark", "completed"], ["Cover it with tests", "in_progress"]));
            await registry.finish("c1", 4_000);
            expect(registry.get("c1")?.unfinished).toEqual({ at: 4_000, steps: { open: 1, total: 2, next: "Cover it with tests" } });
        });

        // Every turn starts with fresh runtime state, so no `todos` frame this turn does not mean nothing is left;
        // treating it as empty would wipe the mark after a restart or a turn that never touched the list.
        it("keeps what it knew through a turn that never touched the list", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.observe("c1", list(["Draw the mark", "pending"], ["Cover it with tests", "pending"]));
            await registry.finish("c1", 2_000);

            await registry.begin(turn({ prompt: "what does this file do?" }), 3_000);
            await registry.finish("c1", 4_000);
            // `at` stays the turn that measured the list; a question-only turn must not reset that clock.
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 2, total: 2, next: "Draw the mark" } });
        });

        // The workspace's own end-of-turn check, independent of any todo list: a turn gets two rounds to repair a
        // failing check and may still end red (rules/turn-ending.ts).
        it("marks a turn that ended with its own check still failing", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.noteCheck("c1", { label: "Verify before you finish", failed: true });
            await registry.finish("c1", 2_000);
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, check: "Verify before you finish" });
        });

        it("takes the repaired re-run as the verdict", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.noteCheck("c1", { label: "Verify before you finish", failed: true });
            registry.noteCheck("c1", { label: "Verify before you finish", failed: false });
            await registry.finish("c1", 2_000);
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        // Unlike the todo mark, a check verdict is spent with the turn that earned it, not carried into the next.
        it("does not carry a red check into the next turn", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.noteCheck("c1", { label: "Verify before you finish", failed: true });
            await registry.finish("c1", 2_000);

            await registry.begin(turn({ prompt: "carry on" }), 3_000);
            await registry.finish("c1", 4_000);
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        // The entry keeps the fact throughout; only what the card shows is held back while a turn works through that
        // very list.
        it("holds the mark back while a turn is in flight and reports it again once the turn settles", async () => {
            const registry = createAgentsRegistry(memoryStore(), standings(), presences());
            await registry.init();
            await registry.begin(turn(), 1_000);
            registry.observe("c1", list(["Draw the mark", "pending"]));
            await registry.finish("c1", 2_000);
            const left = { open: 1, total: 1, next: "Draw the mark" };
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: left });

            await registry.begin(turn({ prompt: "carry on" }), 3_000);
            expect(registry.get("c1")?.unfinished).toBeUndefined();
            expect(registry.entry("c1")?.unfinished).toEqual({ at: 2_000, steps: left });

            await registry.finish("c1", 4_000);
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: left });
        });
    });

    it("subscribe delivers an immediate snapshot and change broadcasts", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        const frames: number[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents.length));
        expect(frames).toEqual([0]);
        await registry.begin(turn(), 1_000);
        expect(frames.at(-1)).toBe(1);
        // Delta frames are not card-visible; they never broadcast.
        const count = frames.length;
        registry.observe("c1", { kind: "delta", text: "..." });
        expect(frames.length).toBe(count);
        unsubscribe();
    });

    it("archiving takes an agent off the roster without touching the entry", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);

        await registry.setArchived(["c1"], 5_000);
        expect(registry.list()).toEqual([]);
        expect(registry.listArchived().map((agent) => agent.id)).toEqual(["c1"]);
        expect(registry.get("c1")?.archivedAt).toBe(5_000);
        expect(registry.entry("c1")?.title).toBe("Fix the login bug");
        expect(registry.ids()).toEqual(["c1"]);

        await registry.clearArchived(["c1"]);
        expect(registry.list().map((agent) => agent.id)).toEqual(["c1"]);
        expect(registry.get("c1")?.archivedAt).toBeUndefined();
        expect(store.saved()[0]?.archivedAt).toBeUndefined();
    });

    it("a new turn un-archives the agent it runs on", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        await registry.setArchived(["c1"], 5_000);

        expect(await registry.begin(turn(), 6_000)).toBe(true);
        expect(registry.get("c1")?.archivedAt).toBeUndefined();
        expect(registry.list().map((agent) => agent.id)).toEqual(["c1"]);
        expect(registry.listArchived()).toEqual([]);
    });

    // Each write path replaces `entries` wholesale; two overlapping persists can each serialize their own captured
    // snapshot, and the later one silently drops the other's change.
    it("concurrent writes all survive the round-trip to disk", async () => {
        // `delays` staggers the three concurrent saves to finish in reverse order, the shape that actually loses data:
        // the slowest save holds the oldest snapshot and lands on top of the rest.
        let data: PersistedAgent[] = [];
        const delays: number[] = [];
        const store: AgentsStore & { saved: () => PersistedAgent[] } = {
            load: async () => data,
            save: async (agents) => {
                await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
                data = JSON.parse(JSON.stringify(agents)) as PersistedAgent[];
            },
            saved: () => data,
        };
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        for (const id of ["c1", "c2", "c3"]) {
            await registry.begin(turn({ conversationId: id }), 1_000);
            await registry.finish(id, 2_000);
        }

        delays.push(20, 10, 0);
        await Promise.all([registry.setArchived(["c1"], 5_000), registry.setArchived(["c2"], 5_001), registry.markSeen("c3", 5_002)]);

        expect(store.saved().find((entry) => entry.id === "c1")?.archivedAt).toBe(5_000);
        expect(store.saved().find((entry) => entry.id === "c2")?.archivedAt).toBe(5_001);
        expect(store.saved().find((entry) => entry.id === "c3")?.seenAt).toBe(5_002);
    });

    it("the archived list survives a restart, newest first", async () => {
        const store = memoryStore();
        const first = createAgentsRegistry(store, standings(), presences());
        await first.init();
        await first.begin(turn(), 1_000);
        await first.finish("c1", 1_500);
        await first.begin(turn({ conversationId: "c2" }), 2_000);
        await first.finish("c2", 2_500);
        await first.setArchived(["c1"], 5_000);
        await first.setArchived(["c2"], 6_000);

        const second = createAgentsRegistry(store, standings(), presences());
        await second.init();
        expect(second.list()).toEqual([]);
        expect(second.listArchived().map((agent) => agent.id)).toEqual(["c2", "c1"]);
    });

    it("remove drops the entry and rehydration restores persisted entries", async () => {
        const store = memoryStore();
        const first = createAgentsRegistry(store, standings(), presences());
        await first.init();
        await first.begin(turn(), 1_000);
        await first.finish("c1", 2_000);
        const second = createAgentsRegistry(store, standings(), presences());
        await second.init();
        expect(second.get("c1")?.status).toBe("idle");
        await second.remove(["c1"]);
        expect(second.get("c1")).toBeUndefined();
        expect(store.saved()).toEqual([]);
    });

    // Only the exact (landedHead, landedTip) pair the scan measured may take the mark; anything else is stale.
    it("markLandingAbsorbed stamps the measured landing, persists it, and refuses every other row", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        await registry.finish("c1", 2_000);
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "b1", landedTip: "t1", landedHead: "h1", landedAt: 3_000 }],
            diff: { files: 1, insertions: 1, deletions: 0 },
            adjudicated: true,
        });

        // A mismatched hash (a stale scan racing a newer land) is a no-op.
        await registry.markLandingAbsorbed("c1", "root", "h0", "t1", 4);
        expect(registry.entry("c1")?.repos[0]?.absorbed).toBeUndefined();

        await registry.markLandingAbsorbed("c1", "root", "h1", "t1", 4);
        expect(registry.entry("c1")?.repos[0]?.absorbed).toBe(4);
        // Idempotent: a second mark, even with a different size, changes nothing.
        await registry.markLandingAbsorbed("c1", "root", "h1", "t1", 9);
        expect(registry.entry("c1")?.repos[0]?.absorbed).toBe(4);
        // Unknown agent or repo ids are silently ignored.
        await registry.markLandingAbsorbed("gone", "root", "h1", "t1", 1);
        await registry.markLandingAbsorbed("c1", "nested", "h1", "t1", 1);

        // Persists across a restart; the store round-trip is what this proves.
        const restarted = createAgentsRegistry(store, standings(), presences());
        await restarted.init();
        expect(restarted.entry("c1")?.repos[0]?.absorbed).toBe(4);

        // A fresh `recordLanded` row has no `absorbed` mark: a landing just landed cannot already be absorbed.
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "b1", landedTip: "t2", landedHead: "h2", landedAt: 5_000 }],
            diff: { files: 1, insertions: 1, deletions: 0 },
            adjudicated: true,
        });
        expect(registry.entry("c1")?.repos[0]?.absorbed).toBeUndefined();
    });
});
