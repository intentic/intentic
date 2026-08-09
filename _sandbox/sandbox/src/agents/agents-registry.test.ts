import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, AgentSummary } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { noteSubagentTask, resetSubagents, type SubagentTaskMessage, type SubagentTurn } from "../agent/subagents.js";
import { createAgentsRegistry, type AgentTurnIdentity } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";
import type { LandedPresence, LandedPresences } from "./landed-presence.js";
import type { LandStanding, LandStandings } from "./standing.js";

// The derived half of a card's status, dialled by hand. Deriving it for real needs a git repo per case and is
// standing.integration.test.ts's whole subject; what belongs HERE is the projection — which of the two halves wins, and
// what each surface reads off the result.
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

// The card's other derived half — how much of what an agent landed is still in the tree — dialled the same way
// and for the same reason: deriving it needs a git repo per case (landed-presence.integration.test.ts).
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

    /* The rewind lease and the turn mutex are the SAME mutex, and these are the two directions that matter.
     * Both would pass against a naive "check, then act" too — what they pin is that the two operations see each
     * other at all, so a later refactor that gives either one its own flag fails here rather than in a
     * half-restored workspace. */
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
        // The lease is gone the moment the work is, so the very next turn runs.
        expect(await registry.begin(turn(), 2_000)).toBe(true);
    });

    it("refuses a rewind while a turn is running, and releases the lease even when the rewind throws", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);

        expect(await registry.withRewindLease("c1", async () => "restored")).toBeUndefined();
        // A different conversation is unaffected — the mutex is per conversation, not global.
        expect(await registry.withRewindLease("c2", async () => "restored")).toBe("restored");

        await registry.finish("c1", 2_000);
        await expect(
            registry.withRewindLease("c1", () => {
                throw new Error("restore blew up");
            }),
        ).rejects.toThrow("restore blew up");
        // Left unrunnable by a failed restore would be worse than the failure itself.
        expect(await registry.begin(turn(), 3_000)).toBe(true);
    });

    it("clearSession drops the pointer so the next turn opens a fresh provider thread", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "session", sessionId: "sess-1" });
        expect(registry.sessionIdOf("c1")).toBe("sess-1");

        await registry.clearSession("c1");
        // Both halves: the runtime's pending id (a first turn's, not yet flushed) and the persisted one.
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
        // The user takes the conversation over from its chat tab: an ordinary turn, carrying no origin of its
        // own, which must not strip the mention that opened the agent off its card.
        await registry.begin(turn({ prompt: "try the other fix" }), 3_000);
        expect(registry.get("c1")?.origin).toEqual(origin);
    });

    // What the agent RUNS ON is a fact about the agent, and the only record of it: a client opening the card
    // tomorrow has nowhere else to learn it, and seeding its composer from the browser's own last pick instead
    // is what made an open agent claim a model its session never used.
    it("records the settings a turn ran under and keeps them for a turn that states none", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false }), 1_000);
        expect(registry.get("c1")).toMatchObject({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false });
        await registry.finish("c1", 2_000);
        // A wake with no settings of its own (an automation, a Discord mention) leaves the record standing
        // rather than blanking the card back to "unknown".
        await registry.begin(turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")).toMatchObject({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false });
    });

    it("holds the autoLand override across turns and clears it on null", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        // Set mid-turn on purpose — the value is read at turn COMPLETION, so this is "hold THIS turn's work".
        expect((await registry.setAutoLand("c1", false))?.autoLand).toBe(false);
        await registry.finish("c1", 2_000);
        // The override is a standing choice about the conversation: the next turn's entry rebuild keeps it.
        await registry.begin(turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")?.autoLand).toBe(false);
        await registry.finish("c1", 4_000);
        // null strips the key back to "inherit the sandbox setting" — absent, not stored-false.
        expect((await registry.setAutoLand("c1", null))?.autoLand).toBeUndefined();
        expect(registry.entry("c1")?.autoLand).toBeUndefined();
        expect(await registry.setAutoLand("nope", true)).toBeUndefined();
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
        // The rename happened mid-turn; finish rebuilds the entry and must not resurrect the old title.
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.title).toBe("Login fix");
        // Unknown id and a title that sanitizes to nothing both refuse.
        expect(await registry.setTitle("nope", "x", "user")).toBeUndefined();
        expect(await registry.setTitle("c1", " \u0000 ", "user")).toBeUndefined();
        unsubscribe();
    });

    /* THE CHILDREN A TURN STARTS, on the board. The counts are not held here — summaryOf reads them off the
     * subagent registry — so what is pinned is the PUBLISH: nothing else announces a child, and a parent that
     * delegates and then waits on its children emits no frames of its own for the fleet to ride on. Driven
     * through the real registry rather than a stub, because the projection is the seam under test.
     *
     * The progress case is the other half. An update carrying only a child's tokens and tool name changes
     * nothing a card renders, and those arrive several times a second per child. */
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
        // Subscribing paints the fleet as it stands, so the run starts with the card as it was: no children.
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
        // Still on the card, and no longer working — which is the whole of what the chip says.
        expect(frames).toEqual([undefined, { running: 1, total: 1 }, { running: 0, total: 1 }]);
        unsubscribe();

        /* AND IT OUTLIVES THE TURN. resetSubagents() is the five-minute sweep and a daemon restart at once —
         * everything the live registry knew, gone. What the agent DID is on its entry, so the card still says
         * it delegated; only the live half falls to zero. */
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
        // A follow-up turn keeps counting from there rather than starting the tally again.
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
        expect(registry.get("c1")?.seenAt).toBeUndefined(); // never opened
        await registry.markSeen("c1", 3_000);
        expect(registry.get("c1")?.seenAt).toBe(3_000);
        expect(registry.get("c1")?.updatedAt).toBe(2_000); // reading is not activity
        expect(frames.at(-1)).toBe(3_000); // every connected surface clears its badge
        expect(store.saved().find((entry) => entry.id === "c1")?.seenAt).toBe(3_000);
        // The marker outlives the next turn's entry rebuild — it is what tells "New" from "Updated".
        await registry.begin(turn(), 4_000);
        await registry.finish("c1", 5_000);
        expect(registry.get("c1")?.seenAt).toBe(3_000);
        expect(await registry.markSeen("nope", 6_000)).toBeUndefined();
        unsubscribe();
    });

    it("markAllSeen stamps the whole fleet — the board's one escape hatch", async () => {
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

        // The card and every open tab learn the new name on the broadcast the plan frame was making anyway.
        expect(registry.get("c1")?.title).toBe("Fix the login submit handler");
        expect(frames.at(-1)).toBe("Fix the login submit handler");
        // Written out of band, so the name survives a restart while the plan sits waiting on the user.
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
        // The user sends it back to planning; the second plan refines the same job rather than starting a new
        // one, so the conversation keeps the name it already answers to.
        registry.observe("c1", { kind: "plan", requestId: "r2", text: "# Rewrite the form validation instead" });

        expect(registry.get("c1")?.title).toBe("Fix the login submit handler");
    });

    it("slots a model name above the derived guess and below a plan's own name", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn({ prompt: "we have recently added the fleet board" }), 1_000);

        // The quick model has written a name for the opening prompt — it beats the rule that only cut one…
        expect((await registry.setTitle("c1", "Fleet board broadcast · wire", "model"))?.title).toBe("Fleet board broadcast · wire");
        // …once. A second model name is a sideways move, so the first one stands.
        await registry.setTitle("c1", "A second reading", "model");
        expect(registry.get("c1")?.title).toBe("Fleet board broadcast · wire");

        // A plan heading is the agent's own name for the job: it replaces a model name —
        registry.observe("c1", { kind: "plan", requestId: "r1", text: "# Fix the fleet broadcast fan-out" });
        expect(registry.get("c1")?.title).toBe("Fix the fleet broadcast fan-out");
        // — and is never replaced by one.
        await registry.setTitle("c1", "A late reading", "model");
        expect(registry.get("c1")?.title).toBe("Fix the fleet broadcast fan-out");
    });

    /* The two conditions the CLI reports as prose (agent/failure-sentences.ts), each of which has reached this
     * function as a proposed name: the limit sentence from a naming pass whose quick-model call was out of
     * allowance, the auth sentence from one whose token had been revoked. Both are asserted at every rule
     * because guarding the first alone is precisely how the second got in. */
    const FAILURE_SENTENCES = [
        "You've hit your session limit · resets 11:50pm (UTC)",
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
    ];

    it.each(FAILURE_SENTENCES)("refuses %s as any automatic title — it names the failure, not the work", async (sentence) => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);

        // A naming pass whose own quick-model call hit the condition hands the sentence over as if it were
        // the name. The derived title must stand, and stand REPLACEABLE (the next honest name lands).
        await registry.setTitle("c1", sentence, "model");
        expect(registry.get("c1")?.title).toBe("Fix the login bug");
        expect((await registry.setTitle("c1", "Fleet board broadcast · wire", "model"))?.title).toBe("Fleet board broadcast · wire");
    });

    it.each(FAILURE_SENTENCES)("a stolen title reading %s forfeits its rank, so the next name heals it", async (sentence) => {
        // An entry poisoned before the guard covered this sentence: it sits at `model` rank, where the
        // sideways-move rule would protect it forever.
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

        // A rename is not a ranked promotion — renaming twice must not read as a rejected sideways move.
        expect((await registry.setTitle("c1", "Login bug (round two)", "user"))?.title).toBe("Login bug (round two)");
    });

    it("a card parks the agent until its own release — the frames trailing it do not", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        // The `ask` tool's question beats its own tool_call out of the SDK (the card is pushed from the
        // in-process MCP dispatch, the tool_call arrives on the queued message stream), and a turn parked on
        // one card keeps streaming whatever it had running beside it. Reading any of that as "the user
        // answered" is what kept an agent asking a question out of the fleet's Attention lane.
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
        // A daemon restarted mid-park never saw that card go up.
        registry.observe("c1", { kind: "resolved", requestId: "unknown" });
        expect(registry.get("c1")?.status).toBe("awaiting");
        registry.observe("c1", { kind: "resolved", requestId: "perm1" });
        expect(registry.get("c1")?.status).toBe("running");
        expect(registry.get("c1")?.attention.permission).toBe(false);
    });

    it("stopping a parked turn takes its card off the board — the release may never arrive", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("idle");
        expect(registry.get("c1")?.attention.question).toBe(false);
    });

    /* THE WINDOW A STOP OPENS, which is the whole reason `stopping` exists. /agent/stop aborts the provider and
     * then waits for the generator to unwind — worktree and registry cleanup, seconds of it on a turn holding a
     * long tool call — and every surface watching this agent reads the roster in the meantime. Publishing
     * `running` across that window is what kept a spinner turning on a turn the user had already killed. */
    it("publishes the stop the instant it lands, ahead of the unwind", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        registry.stopping("c1", "stopped");
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(frames.at(-1)).toBe("stopping"); // the press has a visible result before anything unwinds
        // Still the conversation's live turn: the mutex is held until finish, so a message sent now would
        // still collide with it rather than start a second one.
        expect(registry.running("c1")).toBe(true);
        unsubscribe();
    });

    // Where it comes to rest. NOT `error` (the abort's own unwind is not a failure — see agent.routes' frame
    // loop) and NOT `interrupted`, which is the daemon dying and is a candidate for the boot resume pass: a
    // turn a person chose to end must never come back on its own.
    it("settles a stopped turn as stopped, on the entry the next boot reads", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.stopping("c1", "stopped");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("stopped");
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("stopped");
        // And it does not leak into the next turn on the same conversation.
        await registry.begin(turn(), 3_000);
        expect(registry.get("c1")?.status).toBe("running");
        await registry.finish("c1", 4_000);
        expect(registry.get("c1")?.status).toBe("idle");
    });

    /* A DISMISSED CARD IS THE OTHER ENDING THE USER CHOOSES, and it does not come to rest where a Stop does.
     * Stopping reaches in to halt work the user still wanted, so its card waits to be picked up; waving a
     * question away says they are done with this one, so nothing is owed and the card settles with the
     * finished ones — whatever the turn wrote stays on its branch for a later message.
     *
     * The card also has to move ONCE. Releasing the question leaves a live turn with nothing parked on it,
     * which reads as a working agent, so a publish here would file the agent under Active for the blink
     * before the unwind lands — the two-step the browser used to do, only faster. */
    it("settles a dismissed turn where a clean one ends, and holds its place until it gets there", async () => {
        const store = memoryStore();
        const registry = createAgentsRegistry(store, standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        registry.stopping("c1", "dismissed");
        expect(frames.at(-1)).toBe("awaiting"); // the subscribe snapshot — nothing published on the way out
        // The card cannot be answered any more, and the turn is still the conversation's live one.
        expect(registry.get("c1")?.attention.question).toBe(false);
        expect(registry.running("c1")).toBe(true);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("idle");
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("idle");
        expect(frames.at(-1)).toBe("idle"); // one move: Attention straight to Finished
        unsubscribe();
    });

    // The abort settles every waiter, so a card raised by a frame still in flight behind the stop would ask a
    // question whose answer has nowhere to go — and would drag the card back into Attention on its way out.
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

    // A stop that raced the turn's own last frame is not news. Marking a settled conversation would leave the
    // flag on it for the NEXT turn to inherit, and publish a state nobody is in.
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
        expect(frames.length).toBe(1); // the subscribe snapshot, and nothing after it
        unsubscribe();
    });

    // A turn that had ALREADY failed when the user stopped it keeps its failure: the error frame is a fact
    // about the turn, where the stop is only how it ended.
    it("keeps an error that preceded the stop", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        registry.stopping("c1", "stopped");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    /* THE DAEMON DYING UNDER A PARKED TURN — a container rebuild (`docker rm -f`, so not even a SIGTERM), a
     * crash, an OOM kill. The next boot is a fresh registry over the same store, and everything that said the
     * agent was mid-task — running, the question's park, the attention flag it raised — was runtime state that
     * died with the process. So the entry's own status is the ONLY thing left to say so, and `begin` having
     * written the resting `idle` there is what filed a turn holding an unanswered question under Finished. */
    it("a turn the daemon died under comes back interrupted, not idle", async () => {
        const store = memoryStore();
        const first = createAgentsRegistry(store, standings(), presences());
        await first.init();
        await first.begin(turn(), 1_000);
        first.observe("c1", { kind: "question", requestId: "q1", questions: [] });
        expect(first.get("c1")?.status).toBe("awaiting");

        // No finish() — the process is gone. Whatever is on disk at this instant is what the user comes back to.
        const rebooted = createAgentsRegistry(store, standings(), presences());
        await rebooted.init();
        expect(rebooted.get("c1")?.status).toBe("interrupted");
        expect(rebooted.running("c1")).toBe(false);
    });

    // The same entry once the turn DOES report back: `interrupted` is a placeholder that every ordinary ending
    // overwrites, so a restart after this one reads the clean ending rather than the interruption — and from
    // there the card's status is the branch's, re-derived on the fresh daemon's first probe.
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

    it("error during the turn persists as error status at finish", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
    });

    /* A failure the daemon has already armed a resume for is not how the turn ENDED — it is coming back
     * (turn-resume.ts). Painting the card red for it turned every provider blip into a board full of agents that
     * look like they need attention while the daemon is quietly fixing them, which is the single most effective
     * way to make a user switch the automation off.
     *
     * Nor is it `idle`, which is what the fix originally left behind and what this case now pins: `idle` reads
     * as the resting state of a turn that finished, so for the seconds between the 401 and the re-minted token
     * the board filed the card under Finished and then pulled it back into Active — the fleet contradicting
     * itself about work that never stopped. */
    it("a failure with a scheduled resume publishes the card as still coming back", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        // Still the running turn's own state while it unwinds — the frame arrives mid-stream.
        expect(registry.get("c1")?.status).toBe("running");
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("resuming");
        // And the entry itself says nothing new: what is coming back is the daemon's own memory, so a restart
        // finds the interrupted turn rather than a state it would have to interpret.
        expect(registry.entry("c1")?.status).toBe("idle");
    });

    // The ordinary ending of that wait: the daemon re-mints the token and re-runs the turn, and the card goes
    // from "coming back" to running without ever having left the Active lane.
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

    /* The other ending, and the one that must not leave a spinner turning forever: the credential is genuinely
     * dead, so nothing re-runs. The wait closes into the failure it was holding open — Attention, where a person
     * is asked to reconnect the account — and not back into the clean `idle` the killed turn left on the entry. */
    it("an abandoned resume settles the card into the failure it was holding open", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        await registry.finish("c1", 2_000);
        expect(await registry.abandonResume("c1", 3_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
        // And it says which ending this was. The card has been promising to come back for as long as the
        // scheduler kept trying; "error" alone, at the end of that, is the least it could tell the reader.
        expect(registry.get("c1")?.failure).toBe("The Claude sign-in this turn ran on could not be renewed.");
        // Idempotent, because the scheduler's passes are: a second call has no wait left to close, which is
        // still the wait being over — so it answers true and the caller stops carrying the entry.
        expect(await registry.abandonResume("c1", 4_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
    });

    /* THE ABANDON THAT ARRIVES A SECOND TOO EARLY — the race that left the spinning cards this contract exists
     * for. The scheduler's pass can land between the refusal being recorded and the failed turn finishing its
     * unwind, and anything written in that window is overwritten by the finish that follows. Saying so is the
     * whole job: the caller keeps its pending entry and comes back, where dropping it silently meant the card
     * kept its "coming back" spinner with nothing left anywhere that could ever end it. */
    it("an abandon that lands while the turn is still unwinding reports that it did not take", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" });
        // No finish() yet: the frame has gone out and the generator is still walking its finallys.
        expect(await registry.abandonResume("c1", 2_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(false);
        expect(registry.get("c1")?.status).toBe("running");
        // The turn settles, and the very next attempt lands.
        await registry.finish("c1", 3_000);
        expect(await registry.abandonResume("c1", 4_000, "The Claude sign-in this turn ran on could not be renewed.")).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
    });

    /* WHY, NOT JUST THAT. The condition this exists for is a session refused on its first request: it writes no
     * report, takes no screenshot and never reaches the app, so the provider's own sentence is the only account
     * of it there will ever be — and it used to live nowhere but the transcript of a conversation nobody opens.
     * An unattended fan-out is exactly the case: ten sessions, ten identical deaths, ten transcripts. */
    it("keeps the sentence a failed turn died on, so the card can say why", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", {
            kind: "error",
            code: "claude-not-entitled",
            message: "Your organization has disabled Claude subscription access for Claude Code",
        });
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.status).toBe("error");
        expect(registry.get("c1")?.failure).toBe("Your organization has disabled Claude subscription access for Claude Code");
    });

    // The other half, and the one that keeps the field honest: an explanation is about the LAST turn, so a
    // conversation that runs again cleanly must stop carrying the death it recovered from.
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

    // The race the guard exists for: the user's own send beats the scheduler to the conversation, so the resume
    // it was going to fire is superseded. The abandon must not write a failure over the turn that is running.
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

    // "available" is the other half: nothing is armed, the turn is only REMEMBERED behind a setting the user has
    // not turned on, so the failure genuinely stands until they do something about it.
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

    /* THE PROJECTION, which is the whole of what this module now decides about status: the live turn first,
     * then how the last one ENDED, and only then where the work stands. `idle` is the one persisted value that
     * yields, because it is the one that means the entry has nothing left to say.
     *
     * The precedence matters in both directions. A branch that happens to hold outstanding work must not
     * relabel an errored turn as "ready to land" — the failure is the thing the user has to see. And a turn
     * that ended cleanly must not keep ANY land verdict of its own: that is the cache that outlived its subject
     * (see standing.ts), and the only cure is that there is nowhere left to write one. */
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
        // The Attention flag reads the DERIVED verdict too — deriving it from a stored status was the original
        // bug in miniature, a faithful projection over a stale input.
        expect(registry.get("c1")?.attention.conflict).toBe(true);
        // …and nothing about it reached the disk. The land verdict has no persisted home any more.
        expect(store.saved().find((entry) => entry.id === "c1")?.status).toBe("idle");

        land.set("c1", "ready");
        expect(registry.get("c1")?.status).toBe("ready");
        expect(registry.get("c1")?.attention.conflict).toBe(false);

        // An error outranks whatever the branch holds: outstanding work does not make a failed turn fine.
        await registry.begin(turn(), 3_000);
        registry.observe("c1", { kind: "error", message: "boom" });
        await registry.finish("c1", 4_000);
        expect(registry.get("c1")?.status).toBe("error");
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
        });
        await registry.finish("c1", 2_000);
        expect(store.saved().find((entry) => entry.id === "c1")?.repos).toEqual([{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }]);
        expect(registry.get("c1")?.diff).toEqual({ files: 12, insertions: 412, deletions: 96 });
    });

    // A card that says "Resolve conflict" but cannot say WHAT blocked is the dead end this report exists to
    // prevent, so it has to outlive the land that produced it — and has to disappear the moment a later land
    // succeeds, or the review keeps offering a resolution for something already resolved. (It is EVIDENCE, not
    // state: standing.ts reads it to explain an outstanding delta and never to invent one, so a report whose
    // delta is gone stops being rendered whether or not anything got round to clearing it.)
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
            conflicts,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toEqual(conflicts);

        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 3, insertions: 10, deletions: 1 },
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.conflicts).toBeUndefined();
    });

    it("counts turns and tool uses — live during the turn, folded at finish, never inflated by manual lands", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        await registry.begin(turn(), 1_000);
        registry.observe("c1", { kind: "tool_call", id: "t1", name: "Edit", category: "edit", status: "in_progress" });
        registry.observe("c1", { kind: "tool_call", id: "t2", name: "Bash", category: "execute", status: "in_progress" });
        // Live: the running turn's tool calls already show on the card.
        expect(registry.get("c1")?.toolUses).toBe(2);
        await registry.finish("c1", 2_000);
        expect(registry.get("c1")?.turns).toBe(1);
        expect(registry.get("c1")?.toolUses).toBe(2);
        // A manual land finishes OUTSIDE any turn — must not count as a turn.
        await registry.finish("c1", 3_000);
        expect(registry.get("c1")?.turns).toBe(1);
        await registry.begin(turn({ prompt: "again" }), 4_000);
        registry.observe("c1", { kind: "tool_call", id: "t3", name: "Read", category: "read", status: "in_progress" });
        await registry.finish("c1", 5_000);
        expect(registry.get("c1")?.turns).toBe(2);
        expect(registry.get("c1")?.toolUses).toBe(3);
    });

    it("liveSessionIds reports the in-flight turns' sdk sessions — the terminals list's 'still working' signal", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
        await registry.init();
        expect(registry.liveSessionIds()).toEqual([]);
        await registry.begin(turn(), 1_000);
        // The id arrives on the turn's FIRST frame, before any Bash — so the agent-* session it will run
        // commands in reads as running from the start, not only while a command happens to be in flight.
        registry.observe("c1", { kind: "session", sessionId: "3f2a9b1c-0000-4000-8000-000000000000" });
        expect(registry.liveSessionIds()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000"]);
        // A second conversation's turn joins the set; neither one's id leaks after its turn ends.
        await registry.begin(turn({ conversationId: "c2" }), 1_100);
        registry.observe("c2", { kind: "session", sessionId: "7c0e1ad7-0000-4000-8000-000000000000" });
        expect(registry.liveSessionIds().toSorted()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000", "7c0e1ad7-0000-4000-8000-000000000000"]);
        await registry.finish("c1", 2_000);
        expect(registry.liveSessionIds()).toEqual(["7c0e1ad7-0000-4000-8000-000000000000"]);
        await registry.finish("c2", 2_100);
        expect(registry.liveSessionIds()).toEqual([]);
        // A resumed turn before its first frame falls back to the session the last turn flushed onto the entry.
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

    it("subscribe delivers an immediate snapshot and change broadcasts", async () => {
        const registry = createAgentsRegistry(memoryStore(), standings(), presences());
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
        // Still fully addressable — cost, title and attribution all keep answering for an archived agent.
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

    // Every write path REPLACES `entries` rather than mutating it, so two overlapping persists would each
    // serialize the array they captured — and whichever wrote last would put back a snapshot missing the
    // other's change. Archiving several agents at once (or one while another finishes) is exactly that shape,
    // and the loss is invisible until the daemon restarts onto the older file.
    it("concurrent writes all survive the round-trip to disk", async () => {
        // Yields between capture and serialize, which is where the lost update happened. `delays` is loaded
        // only for the concurrent block below, so those three writes FINISH IN REVERSE — the case that
        // actually loses data, since the slowest write holds the oldest snapshot and lands on top of the rest.
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
});
