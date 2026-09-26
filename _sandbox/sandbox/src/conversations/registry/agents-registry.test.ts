import { opt } from "../../opt.js";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { waitFor } from "@intentic/testing/bun";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, AgentSummary, LandConflictReason } from "@intentic/sandbox-contract";
import { noteSubagentTask, resetSubagents, type SubagentTaskMessage, type SubagentTurn } from "../../agent/subagents/subagents.js";
import { MAX_NOTE_LENGTH, MAX_SUBJECT_LENGTH } from "../../git/ops/commit-message.js";
import { beginTurn, conversationEntry, fleetStoreOver, isolatedAgent } from "../../testing.js";
import type { BeginOutcome, BeginTurn } from "../actor/conversation-decide.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { createFleet, type FleetStore } from "./agents-registry.js";
import { type PersistedAgent, sqliteAgentsStore, worktreeOf } from "./agents-store.js";
import { sqliteTurnCheckpoints } from "../../agent/checkpoints/turn-checkpoints.js";
import { type JournalledTurn, sqliteTurnJournal } from "../../agent/run/turn/turn-journal.js";
import type { LandedPresence, LandedPresences } from "../land/landed-presence.js";
import type { LandStanding, LandStandings } from "../land/standing.js";
import { nextPromptDayAt } from "../../agent/run/prompt-fingerprint.js";

// Hand-dialed stand-in for land standing; real derivation needs a git repo per case (standing.integration.test.ts).
// This suite only pins the projection: which half wins, and what each surface reads off it.
const standings = (): LandStandings & { set: (id: string, standing: LandStanding, causes?: readonly LandConflictReason[]) => void } => {
    const verdicts = new Map<string, { standing: LandStanding; causes: readonly LandConflictReason[] }>();
    return {
        of: (id) => verdicts.get(id)?.standing ?? "idle",
        causesOf: (id) => verdicts.get(id)?.causes ?? [],
        refresh: async () => false,
        forget: (ids) => {
            for (const id of ids) {
                verdicts.delete(id);
            }
        },
        set: (id, standing, causes = []) => verdicts.set(id, { standing, causes }),
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

// The real store over an in-memory database, seeded with `initial`, and what the database holds right now.
const memoryStore = (initial: PersistedAgent[] = []): FleetStore & { saved: () => PersistedAgent[] } => {
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    store.agents.save(initial);
    return { ...store, saved: () => store.agents.load() };
};

const turn = (overrides: Partial<BeginTurn> = {}): BeginTurn => ({
    conversationId: "c1",
    isolated: true,
    prompt: "Fix the login bug",
    profile: { agent: "claude", harness: "native" },
    ...overrides,
});

describe("agents registry", () => {
    // Every tab asks at once after a restart, and a probe's cost is its git reads, so one runs at a time. A caller that
    // arrives mid-probe gets the one after it, which cannot have started before whatever that caller changed.
    it("shares one standings probe among the boards asking at once, and follows it with one more for the late ones", async () => {
        let started = 0;
        const releases: (() => void)[] = [];
        const gated = {
            ...standings(),
            refresh: async () => {
                started += 1;
                await new Promise<void>((resolve) => releases.push(resolve));
                return false;
            },
        };
        const { agents: registry } = createFleet(memoryStore(), gated, presences());
        // Loading probes once on its own; this is the probe the boards below arrive in the middle of.
        await registry.init();
        expect(started).toBe(1);
        const boards = Promise.all([registry.refreshStandings(), registry.refreshStandings(), registry.refreshStandings()]);
        releases.shift()?.();
        await waitFor(() => expect(releases).toHaveLength(1));
        releases.shift()?.();
        await boards;
        expect(started).toBe(2);
        const later = registry.refreshStandings();
        await waitFor(() => expect(releases).toHaveLength(1));
        releases.shift()?.();
        await later;
    });

    it("once a change feed is watched, a roster read re-derives standings only after a reported change", async () => {
        let probes = 0;
        const counted = {
            ...standings(),
            refresh: async () => {
                probes += 1;
                return false;
            },
        };
        const { agents: registry } = createFleet(memoryStore([isolatedAgent([{ repo: "intentic", base: "b0" }])]), counted, presences());
        await registry.init();
        await registry.refreshStandings();
        const unwatched = probes;
        await registry.refreshStandings();
        // Without a feed nothing can say an answer still holds, so every read probes.
        expect(probes).toBe(unwatched + 1);

        let report: (() => void) | undefined;
        registry.watchStandings((changed) => {
            report = changed;
            return () => undefined;
        });
        await registry.refreshStandings();
        const watched = probes;
        await registry.refreshStandings();
        await registry.refreshStandings();
        expect(probes).toBe(watched);
        report?.();
        await registry.refreshStandings();
        expect(probes).toBe(watched + 1);
    });

    it("a watched standing is re-derived once it is a minute old, even with the feed silent", async () => {
        let probes = 0;
        const counted = {
            ...standings(),
            refresh: async () => {
                probes += 1;
                return false;
            },
        };
        const { agents: registry } = createFleet(memoryStore([isolatedAgent([{ repo: "intentic", base: "b0" }])]), counted, presences());
        await registry.init();
        registry.watchStandings(() => () => undefined);
        jest.useFakeTimers();
        try {
            await registry.refreshStandings();
            const fresh = probes;
            jest.setSystemTime(Date.now() + 60_000);
            await registry.refreshStandings();
            expect(probes).toBe(fresh);
            jest.setSystemTime(Date.now() + 1);
            await registry.refreshStandings();
            expect(probes).toBe(fresh + 1);
        } finally {
            jest.useRealTimers();
        }
    });

    // The board never re-reads the roster by itself, so a refusal whose blocker was cleared (the edits in its way
    // committed) must be re-probed and published on the feed's word, or the card keeps asking for edits already gone.
    it("re-probes and publishes a refusing card by itself once the feed reports a change", async () => {
        const verdicts = standings();
        let probes = 0;
        const clearing = {
            ...verdicts,
            refresh: async () => {
                probes += 1;
                // What the real probe finds once the edits in the way are committed.
                verdicts.set("c1", "ready");
                return true;
            },
        };
        const refused = isolatedAgent([{ repo: "intentic", base: "b0" }], {
            landing: { conflicts: [{ repo: "intentic", paths: [{ path: "a.ts", reason: "workspace" }], clean: 0 }] },
        });
        const { agents: registry } = createFleet(memoryStore([refused]), clearing, presences(), { refusalRecheckMs: 5 });
        await registry.init();
        verdicts.set("c1", "conflict", ["workspace"]);
        await waitFor(() => expect(probes).toBe(1));
        let report: (() => void) | undefined;
        registry.watchStandings((changed) => {
            report = changed;
            return () => undefined;
        });
        const frames: AgentSummary[][] = [];
        registry.subscribe((agents) => frames.push(agents));
        expect(frames.at(-1)?.[0]?.status).toBe("conflict");

        report?.();
        report?.();
        await waitFor(() => expect(frames.at(-1)?.[0]?.status).toBe("ready"));
        // One burst of reports, one probe.
        expect(probes).toBe(2);
    });

    it("leaves a board with no refusing card to its roster reads when the feed reports a change", async () => {
        let probes = 0;
        const counted = {
            ...standings(),
            refresh: async () => {
                probes += 1;
                return false;
            },
        };
        const { agents: registry } = createFleet(memoryStore([isolatedAgent([{ repo: "intentic", base: "b0" }])]), counted, presences(), {
            refusalRecheckMs: 1,
        });
        await registry.init();
        await waitFor(() => expect(probes).toBe(1));
        let report: (() => void) | undefined;
        registry.watchStandings((changed) => {
            report = changed;
            return () => undefined;
        });
        report?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(probes).toBe(1);
    });

    it("begin creates an entry with title, branch, and running status", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        expect(await beginTurn(conversations, turn(), 1_000)).toBe("begun");
        const summary = registry.get("c1");
        expect(summary?.status).toBe("running");
        expect(summary?.branch).toBe("agent/c1");
        expect(summary?.title).toBe("Fix the login bug");
        expect(summary?.startedAt).toBe(1_000);
    });

    // The frame `begin` publishes is what moves every board's card out of the lane it was sent from, and it is read
    // off in-memory entries, so it must not wait on the write: this store's save is held open, and the card is
    // published anyway. Synchronously, even — `begin` reaches its broadcast before it returns the promise the write
    // is behind.
    it("publishes the running card before the roster write lands", async () => {
        const store = memoryStore();
        const frames: string[][] = [];
        // What the board had been sent at the moment each write came in.
        const publishedAtWrite: string[][][] = [];
        const watched: FleetStore = {
            ...store,
            agents: {
                ...store.agents,
                save: (entries) => {
                    publishedAtWrite.push([...frames]);
                    store.agents.save(entries);
                },
            },
        };
        const { agents: registry, conversations } = createFleet(watched, standings(), presences());
        await registry.init();
        const unsubscribe = registry.subscribe((agents) => frames.push(agents.map((agent) => agent.status)));

        expect(await beginTurn(conversations, turn(), 1_000)).toBe("begun");

        expect(publishedAtWrite).toEqual([[[], ["running"]]]);
        expect(store.saved().map((agent) => agent.id)).toEqual(["c1"]);
        unsubscribe();
    });

    // Naming a runner forces a branch even if the request omits `isolated`: a remote conversation is isolated by
    // construction.
    it("a runner latches on the first turn, survives turns that name none, and cannot be moved", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        expect(await beginTurn(conversations, turn({ runner: "rog", isolated: false }), 1_000)).toBe("begun");
        expect(worktreeOf(registry.entry("c1"))?.runner).toBe("rog");
        expect(worktreeOf(registry.entry("c1"))?.branch).toBe("agent/c1");
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        expect(await beginTurn(conversations, turn(), 2_000)).toBe("begun");
        expect(worktreeOf(registry.entry("c1"))?.runner).toBe("rog");
        await conversations.send("c1", { kind: "settle" }, 2_500).settled;
        expect(await beginTurn(conversations, turn({ runner: "other" }), 3_000)).toBe("begun");
        expect(worktreeOf(registry.entry("c1"))?.runner).toBe("rog");
    });

    it("a conversation that ran here never picks up a runner from a later request", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        expect(await beginTurn(conversations, turn(), 1_000)).toBe("begun");
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        expect(await beginTurn(conversations, turn({ runner: "rog" }), 2_000)).toBe("begun");
        expect(worktreeOf(registry.entry("c1"))?.runner).toBeUndefined();
    });

    // The rewind lease and the turn mutex are the same lock; splitting them would let a rewind and a turn miss each
    // other.
    it("refuses a turn while a rewind holds the conversation, and readmits it after", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();

        let beganDuringRewind: BeginOutcome | undefined;
        const held = await conversations.withRewindLease("c1", async () => {
            beganDuringRewind = await beginTurn(conversations, turn(), 1_000);
            return "restored";
        });

        expect(held).toBe("restored");
        expect(beganDuringRewind).toBe("busy");
        expect(await beginTurn(conversations, turn(), 2_000)).toBe("begun");
    });

    it("refuses a rewind while a turn is running, and releases the lease even when the rewind throws", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);

        expect(await conversations.withRewindLease("c1", async () => "restored")).toBeUndefined();
        // Mutex is per conversation; a different one is unaffected.
        expect(await conversations.withRewindLease("c2", async () => "restored")).toBe("restored");

        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await expect(
            conversations.withRewindLease("c1", () => {
                throw new Error("restore blew up");
            }),
        ).rejects.toThrow("restore blew up");
        expect(await beginTurn(conversations, turn(), 3_000)).toBe("begun");
    });

    it("writes the session id through to the store as the frame arrives, not at the finish that flushes it", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-1" } });

        // Awaits `setTitle` to flush the fire-and-forget session write, like a persisting caller would.
        await registry.setTitle("c1", "Fix the login bug", "user");
        expect(store.saved().find((entry) => entry.id === "c1")?.sessionId).toBe("sess-1");

        // A session switch mid-turn (a handoff) moves the pointer with it.
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-2" } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(store.saved().find((entry) => entry.id === "c1")?.sessionId).toBe("sess-2");
    });

    // Stores the frame's account, not the request's: an account-less request is served by whichever connected account
    // has headroom.
    it("records the account that actually served the turn, whatever the request asked for", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();

        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-1", account: "acct-work" } });
        await registry.setTitle("c1", "Fix the login bug", "user");
        expect(store.saved().find((entry) => entry.id === "c1")).toMatchObject({ sessionId: "sess-1", profile: { account: "acct-work" } });

        // A frame naming no account does not clear a previously recorded one.
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-2" } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(store.saved().find((entry) => entry.id === "c1")).toMatchObject({ sessionId: "sess-2", profile: { account: "acct-work" } });
    });

    it("moves the recorded account when a later turn runs on a different one", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ profile: { agent: "claude", harness: "native", account: "acct-work" } }), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-1", account: "acct-work" } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;

        await beginTurn(conversations, turn({ profile: { agent: "claude", harness: "native", account: "acct-personal" } }), 3_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-2", account: "acct-personal" } });
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;

        expect(store.saved().find((entry) => entry.id === "c1")).toMatchObject({ sessionId: "sess-2", profile: { account: "acct-personal" } });
    });

    // An account belongs to the provider that minted it. Carried onto another provider's profile it would be latched into
    // that provider's next turn naming none, which then fell to whichever of its own accounts came first.
    it("carries no account across a provider change the turn named none for, and keeps it on the same provider", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ profile: { agent: "claude", harness: "native", account: "acct-work" } }), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;

        await beginTurn(conversations, turn({ profile: { agent: "claude", harness: "native" } }), 3_000);
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        await registry.setTitle("c1", "Port the parser", "user");
        expect(store.saved().find((entry) => entry.id === "c1")?.profile).toMatchObject({ provider: "claude", account: "acct-work" });

        await beginTurn(conversations, turn({ profile: { agent: "codex", harness: "native" } }), 5_000);
        await conversations.send("c1", { kind: "settle" }, 6_000).settled;
        await registry.setTitle("c1", "Port the parser, on Codex", "user");
        const moved = store.saved().find((entry) => entry.id === "c1")?.profile;
        expect(moved?.provider).toBe("codex");
        expect(moved?.account).toBeUndefined();
    });

    it("clearSession drops the pointer so the next turn opens a fresh provider thread", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "sess-1" } });
        expect(conversations.sessionIdOf("c1")).toBe("sess-1");

        await conversations.send("c1", { kind: "session-cleared" }).settled;
        // `sessionIdOf` checks the live pending id and the persisted one.
        expect(conversations.sessionIdOf("c1")).toBeUndefined();
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(conversations.sessionIdOf("c1")).toBeUndefined();
    });

    it("registers a workspace conversation without inventing a branch and projects its clean completion as idle", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ isolated: false }), 1_000);

        expect(registry.get("c1")).toMatchObject({ id: "c1", status: "running", title: "Fix the login bug" });
        expect(registry.get("c1")).not.toHaveProperty("branch");

        conversations.send("c1", { kind: "frame", frame: { kind: "question", requestId: "q1", questions: [] } });
        expect(registry.get("c1")?.status).toBe("awaiting");
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");
    });

    it("latches placement to the conversation instead of accepting a later request's stale posture", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();

        await beginTurn(conversations, turn({ conversationId: "workspace", isolated: false }), 1_000);
        await conversations.send("workspace", { kind: "settle" }, 1_100).settled;
        await beginTurn(conversations, turn({ conversationId: "workspace", isolated: true }), 1_200);
        expect(registry.get("workspace")).not.toHaveProperty("branch");

        await beginTurn(conversations, turn({ conversationId: "isolated", isolated: true }), 2_000);
        await conversations.send("isolated", { kind: "settle" }, 2_100).settled;
        await beginTurn(conversations, turn({ conversationId: "isolated", isolated: false }), 2_200);
        expect(registry.get("isolated")?.branch).toBe("agent/isolated");
    });

    it("records where an outside message came from and keeps it across the user's own follow-up turns", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        const origin = { automationId: "support", provider: "discord", channelId: "c-general", author: "alice" };
        await beginTurn(conversations, turn({ origin, title: "alice: the build is red" }), 1_000);
        expect(registry.get("c1")?.origin).toEqual(origin);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ prompt: "try the other fix" }), 3_000);
        expect(registry.get("c1")?.origin).toEqual(origin);
    });

    it("records the settings a turn ran under and keeps them for a turn that states none", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(
            conversations,
            turn({ profile: { agent: "claude", harness: "native", model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false } }),
            1_000,
        );
        expect(registry.get("c1")).toMatchObject({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")).toMatchObject({ model: "claude-sonnet-4-5-20250929", effort: "medium", thinking: false });
    });

    it("holds the autoLand override across turns and clears it on null", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        // Set mid-turn; read at the turn's completion.
        expect((await registry.setAutoLand("c1", false))?.autoLand).toBe(false);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")?.autoLand).toBe(false);
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        // null clears to absent ('inherit the sandbox setting'), not to a stored `false`.
        expect((await registry.setAutoLand("c1", null))?.autoLand).toBeUndefined();
        expect(registry.entry("c1")?.postures.autoLand).toBeUndefined();
        expect(await registry.setAutoLand("nope", true)).toBeUndefined();
    });

    it("holds an ending's own answer across turns and clears it on null", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        // Set mid-turn: the offer is typically pressed while the dead turn is still unwinding.
        expect((await registry.setBreakPolicy("c1", "outage", "retry"))?.outagePolicy).toBe("retry");
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ prompt: "keep going" }), 3_000);
        expect(registry.get("c1")?.outagePolicy).toBe("retry");
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        // `wait` is a real answer ('stop resuming'), distinct from the default, which may itself be `retry`.
        expect((await registry.setBreakPolicy("c1", "outage", "wait"))?.outagePolicy).toBe("wait");
        // Only the named ending moves; the other two keep whatever this conversation already said.
        await registry.setBreakPolicy("c1", "limit", "move");
        expect((await registry.setBreakPolicy("c1", "outage", "retry"))?.limitPolicy).toBe("move");
        // null is what hands that one ending back to the default.
        expect((await registry.setBreakPolicy("c1", "outage", null))?.outagePolicy).toBeUndefined();
        expect(registry.entry("c1")?.postures.outage).toBeUndefined();
        expect(await registry.setBreakPolicy("nope", "outage", "retry")).toBeUndefined();
        // An answer the ending cannot take is refused rather than stored: no pass would ever read it.
        expect(await registry.setBreakPolicy("c1", "outage", "move")).toBeUndefined();
        expect(registry.entry("c1")?.postures.outage).toBeUndefined();
    });

    it("begin is a mutex: a second concurrent turn is refused until finish", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        expect(await beginTurn(conversations, turn(), 2_000)).toBe("busy");
        await conversations.send("c1", { kind: "settle" }, 3_000).settled;
        expect(await beginTurn(conversations, turn(), 4_000)).toBe("begun");
    });

    it("keeps the first title and accumulates usage across turns", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "usage", costUsd: 0.5, inputTokens: 100, outputTokens: 50 } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ prompt: "another prompt" }), 3_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "usage", costUsd: 0.25, inputTokens: 10, outputTokens: 5 } });
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        const summary = registry.get("c1");
        expect(summary?.title).toBe("Fix the login bug");
        expect(summary?.costUsd).toBeCloseTo(0.75);
        expect(summary?.inputTokens).toBe(110);
        expect(summary?.outputTokens).toBe(55);
        expect(store.saved().find((entry) => entry.id === "c1")?.totals.costUsd).toBeCloseTo(0.75);
    });

    it("begin prefers the turn's title over the prompt; a whitespace title falls back to the prompt", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ title: "My renamed draft" }), 1_000);
        expect(registry.get("c1")?.title).toBe("My renamed draft");
        await beginTurn(conversations, turn({ conversationId: "c2", title: "   " }), 2_000);
        expect(registry.get("c2")?.title).toBe("Fix the login bug");
    });

    it("setTitle persists, broadcasts, keeps updatedAt, and survives a running turn's finish", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.title));
        const before = registry.get("c1")?.updatedAt;
        const summary = await registry.setTitle("c1", "  Login fix  ", "user");
        expect(summary?.title).toBe("Login fix");
        expect(frames.at(-1)).toBe("Login fix");
        expect(registry.get("c1")?.updatedAt).toBe(before);
        expect(store.saved().find((entry) => entry.id === "c1")?.social.title?.text).toBe("Login fix");
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.title).toBe("Login fix");
        expect(await registry.setTitle("nope", "x", "user")).toBeUndefined();
        expect(await registry.setTitle("c1", " \u0000 ", "user")).toBeUndefined();
        unsubscribe();
    });

    // Counts come from the roster the fleet's own actors hold, via `summaryOf`; this only pins the publish. Runs against
    // the real registry, not a stub, since the projection is what's under test, so the roster's doors are lent it.
    it("publishes the fleet when a child is born and when it settles, but not for its progress", async () => {
        // No window, so every send is read the moment it happens; the window itself is pinned on its own below.
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences(), { rosterWindowMs: 0 });
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        // The turn's handle on the fleet whose actors hold its children, which is what the card counts.
        const child = (held: SubagentTurn["conversations"]): SubagentTurn => ({
            conversationId: "c1",
            conversations: held,
            cwd: WORKSPACE_ROOT,
            sessionId: "sess-1",
            subagentsDir: undefined,
        });
        const frame = (message: SubagentTaskMessage, held: SubagentTurn["conversations"] = conversations): AgentEvent => {
            const born = noteSubagentTask(child(held), message);
            if (born === undefined) {
                throw new Error(`the subagent registry ignored a ${message.subtype}`);
            }
            return born;
        };
        const frames: (AgentSummary["subagents"] | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.subagents));
        expect(frames).toEqual([undefined]);

        conversations.send("c1", {
            kind: "frame",
            frame: frame({
                subtype: "task_started",
                task_id: "task-a",
                tool_use_id: "call-1",
                description: "Locate the handler",
                subagent_type: "Explore",
            }),
        });
        expect(frames).toEqual([undefined, { running: 1, total: 1 }]);

        conversations.send("c1", {
            kind: "frame",
            frame: frame({ subtype: "task_progress", task_id: "task-a", tool_use_id: "call-1", usage: { total_tokens: 9_000 } }),
        });
        expect(frames).toEqual([undefined, { running: 1, total: 1 }]);

        conversations.send("c1", { kind: "frame", frame: frame({ subtype: "task_updated", task_id: "task-a", patch: { status: "completed" } }) });
        expect(frames).toEqual([undefined, { running: 1, total: 1 }, { running: 0, total: 1 }]);
        unsubscribe();

        // `resetSubagents` simulates a restart; `total`, persisted on the entry, survives it.
        const store = memoryStore();
        const { agents: persisted, conversations: persistedConversations } = createFleet(store, standings(), presences());
        await persisted.init();
        await beginTurn(persistedConversations, turn(), 1_000);
        persistedConversations.send("c1", {
            kind: "frame",
            frame: frame(
                { subtype: "task_started", task_id: "task-b", tool_use_id: "call-2", description: "Audit the deps", subagent_type: "Explore" },
                persistedConversations,
            ),
        });
        await persistedConversations.send("c1", { kind: "settle" }, 2_000).settled;
        resetSubagents(persistedConversations);
        expect(persisted.get("c1")?.subagents).toEqual({ running: 0, total: 1 });
        expect(store.saved().find((entry) => entry.id === "c1")?.totals.subagents).toBe(1);
        // Subagent totals accumulate across turns rather than resetting.
        await beginTurn(persistedConversations, turn(), 3_000);
        persistedConversations.send("c1", {
            kind: "frame",
            frame: frame(
                { subtype: "task_started", task_id: "task-c", tool_use_id: "call-3", description: "Draft the fix", subagent_type: "claude" },
                persistedConversations,
            ),
        });
        expect(persisted.get("c1")?.subagents).toEqual({ running: 1, total: 2 });
    });

    it("leaves updatedAt on a settled card alone: observe must not steal recency from a fresher finish", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        conversations.send("c1", { kind: "frame", frame: { kind: "delta", text: "a subagent frame on a parent that already settled" } });
        expect(registry.get("c1")?.updatedAt).toBe(2_000);
    });

    it("markSeen persists the read marker, broadcasts it, and leaves updatedAt alone", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const frames: (number | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.seenAt));
        expect(registry.get("c1")?.seenAt).toBeUndefined();
        await registry.markSeen("c1", 3_000);
        expect(registry.get("c1")?.seenAt).toBe(3_000);
        expect(registry.get("c1")?.updatedAt).toBe(2_000);
        expect(frames.at(-1)).toBe(3_000);
        expect(store.saved().find((entry) => entry.id === "c1")?.social.seenAt).toBe(3_000);
        // The read marker survives the next turn's entry rebuild.
        await beginTurn(conversations, turn(), 4_000);
        await conversations.send("c1", { kind: "settle" }, 5_000).settled;
        expect(registry.get("c1")?.seenAt).toBe(3_000);
        expect(await registry.markSeen("nope", 6_000)).toBeUndefined();
        unsubscribe();
    });

    it("markAllSeen stamps the whole fleet: the board's one escape hatch", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await beginTurn(conversations, turn({ conversationId: "c2" }), 2_000);
        await registry.markAllSeen(9_000);
        expect(registry.list().map((agent) => agent.seenAt)).toEqual([9_000, 9_000]);
        expect(store.saved().every((entry) => entry.social.seenAt === 9_000)).toBe(true);
    });

    it("promotes the title to a plan's heading, which names the job the opening prompt only hinted at", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ prompt: "the login page throws on submit" }), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.title));

        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "plan", requestId: "r1", text: "## Fix the login submit handler\n\nFirst, read the form." },
        });

        // Rides the plan frame's own broadcast; no extra one is sent.
        expect(registry.get("c1")?.title).toBe("Fix the login submit handler");
        expect(frames.at(-1)).toBe("Fix the login submit handler");
        // Persisted out of band; the `setTimeout(0)` lets that write land before checking the store.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(store.saved().find((entry) => entry.id === "c1")?.social.title?.text).toBe("Fix the login submit handler");
        unsubscribe();
    });

    it("leaves the title alone for a plan with no heading to take it from", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ prompt: "the login page throws on submit" }), 1_000);

        conversations.send("c1", { kind: "frame", frame: { kind: "plan", requestId: "r1", text: "Read the form, then fix the handler." } });

        expect(registry.get("c1")?.title).toBe("The login page throws on submit");
    });

    it("lets the first plan name the job and refuses to let a replan rename it", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);

        conversations.send("c1", { kind: "frame", frame: { kind: "plan", requestId: "r1", text: "# Fix the login submit handler" } });
        conversations.send("c1", { kind: "frame", frame: { kind: "plan", requestId: "r2", text: "# Rewrite the form validation instead" } });

        expect(registry.get("c1")?.title).toBe("Fix the login submit handler");
    });

    it("slots a model name above the derived guess and below a plan's own name", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ prompt: "we have recently added the fleet board" }), 1_000);

        expect((await registry.setTitle("c1", "Fleet board broadcast", "model", "wire"))?.title).toBe("Fleet board broadcast");
        // A repeated model-sourced title does not override the first.
        await registry.setTitle("c1", "A second reading", "model");
        expect(registry.get("c1")?.title).toBe("Fleet board broadcast");

        conversations.send("c1", { kind: "frame", frame: { kind: "plan", requestId: "r1", text: "# Fix the fleet broadcast fan-out" } });
        expect(registry.get("c1")?.title).toBe("Fix the fleet broadcast fan-out");
        // A plan's title is never replaced by a later model-sourced one.
        await registry.setTitle("c1", "A late reading", "model");
        expect(registry.get("c1")?.title).toBe("Fix the fleet broadcast fan-out");
    });

    it("keeps the naming pass's action word beside the title, and drops it when another source renames", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);

        // The word is never part of the name; it rides the summary so a board can read the kind of work.
        expect(await registry.setTitle("c1", "Fleet board broadcast", "model", "wire")).toMatchObject({
            title: "Fleet board broadcast",
            titleAction: "wire",
        });

        // A rename names no action, so the old one cannot outlive the title it described.
        const renamed = await registry.setTitle("c1", "Login fix", "user");
        expect(renamed?.title).toBe("Login fix");
        expect(renamed?.titleAction).toBeUndefined();
    });

    // The two failure sentences (agent/failure-sentences.ts); guarding only one is how the other got through.
    const FAILURE_SENTENCES = [
        "You've hit your session limit · resets 11:50pm (UTC)",
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
        "Claude Haiku",
        "I am Claude",
    ];

    it.each(FAILURE_SENTENCES)("refuses %s as any automatic title: it names the failure, not the work", async (sentence) => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);

        // The derived title must stay replaceable; a later honest model title still lands.
        await registry.setTitle("c1", sentence, "model");
        expect(registry.get("c1")?.title).toBe("Fix the login bug");
        expect((await registry.setTitle("c1", "Fleet board broadcast", "model"))?.title).toBe("Fleet board broadcast");
    });

    it.each(FAILURE_SENTENCES)("a stolen title reading %s forfeits its rank, so the next name heals it", async (sentence) => {
        // Fixture: an entry already titled with a failure sentence, at `model` rank, predating this guard.
        const poisoned = isolatedAgent([], {
            social: { title: { text: sentence, source: "model" }, reactions: [] },
            createdAt: 1_000,
            updatedAt: 1_000,
        });
        const { agents: registry } = createFleet(memoryStore([poisoned]), standings(), presences());
        await registry.init();
        expect((await registry.setTitle("c1", "Fleet board broadcast", "model"))?.title).toBe("Fleet board broadcast");
    });

    it("never lets a plan rename what the user named, and still allows a second rename", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await registry.setTitle("c1", "Login bug", "user");

        conversations.send("c1", { kind: "frame", frame: { kind: "plan", requestId: "r1", text: "# Fix the login submit handler" } });
        expect(registry.get("c1")?.title).toBe("Login bug");

        // A user rename is not ranked; a second one is not a rejected sideways move.
        expect((await registry.setTitle("c1", "Login bug (round two)", "user"))?.title).toBe("Login bug (round two)");
    });

    it("a card parks the agent until its own release: the frames trailing it do not", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        // The `ask` tool's question can arrive before its own `tool_call` frame (dispatch vs queued stream); a `delta`
        // afterward must not read as an answer.
        conversations.send("c1", { kind: "frame", frame: { kind: "question", requestId: "q1", questions: [] } });
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "tool_call", id: "t1", name: "AskUserQuestion", category: "other", status: "in_progress" },
        });
        conversations.send("c1", { kind: "frame", frame: { kind: "delta", text: "still waiting" } });
        expect(registry.get("c1")?.status).toBe("awaiting");
        expect(registry.get("c1")?.attention.question).toBe(true);
        conversations.send("c1", { kind: "frame", frame: { kind: "resolved", requestId: "q1" } });
        expect(registry.get("c1")?.status).toBe("running");
        expect(registry.get("c1")?.attention.question).toBe(false);
    });

    it("cards are released one at a time; a release for one nobody raised changes nothing", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "plan", requestId: "p1", text: "the plan" } });
        conversations.send("c1", { kind: "frame", frame: { kind: "permission", requestId: "perm1", toolName: "Bash" } });
        conversations.send("c1", { kind: "frame", frame: { kind: "resolved", requestId: "p1" } });
        expect(registry.get("c1")?.status).toBe("awaiting");
        expect(registry.get("c1")?.attention).toMatchObject({ plan: false, permission: true });
        conversations.send("c1", { kind: "frame", frame: { kind: "resolved", requestId: "unknown" } });
        expect(registry.get("c1")?.status).toBe("awaiting");
        conversations.send("c1", { kind: "frame", frame: { kind: "resolved", requestId: "perm1" } });
        expect(registry.get("c1")?.status).toBe("running");
        expect(registry.get("c1")?.attention.permission).toBe(false);
    });

    it("stopping a parked turn takes its card off the board: the release may never arrive", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "question", requestId: "q1", questions: [] } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");
        expect(registry.get("c1")?.attention.question).toBe(false);
    });

    it("publishes the stop the instant it lands, ahead of the unwind", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        conversations.send("c1", { kind: "stop", ending: "stopped" });
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(frames.at(-1)).toBe("stopping");
        // Mutex is still held during `stopping`; a new turn would still collide with it.
        expect(conversations.running("c1")).toBe(true);
        unsubscribe();
    });

    // Not `error` (an abort's own unwind is not a failure) and not `interrupted` (that means the daemon died): a chosen
    // stop must never come back on its own.
    it("settles a stopped turn as stopped, on the entry the next boot reads", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "stop", ending: "stopped" });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("stopped");
        expect(store.saved().find((entry) => entry.id === "c1")?.ending).toEqual({ kind: "stopped" });
        // Does not leak into the next turn on the same conversation.
        await beginTurn(conversations, turn(), 3_000);
        expect(registry.get("c1")?.status).toBe("running");
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");
    });

    // The queue is the one piece of a conversation's live state its entry carries: a restart must not lose a word of it.
    it("keeps what waits in the conversation's queue across a restart, held as it was, and shows it before any turn runs", async () => {
        const store = memoryStore();
        const first = createFleet(store, standings(), presences());
        await first.agents.init();
        await beginTurn(first.conversations, turn(), 1_000);
        const item = {
            id: "m-1",
            voice: "person",
            queuedAt: 1_500,
            turn: { conversationId: "c1", prompt: "and the docs", messageId: "m-1" },
        } as const;
        await first.conversations.send("c1", { kind: "queue-joined", item }).settled;
        await first.conversations.send("c1", { kind: "stop", ending: "stopped" }).settled;

        const after = createFleet(store, standings(), presences());
        await after.agents.init();
        expect(after.agents.get("c1")?.queue).toEqual({
            items: [{ id: "m-1", text: "and the docs", voice: "person", queuedAt: 1_500, revision: 1 }],
            revision: 2,
            paused: "stopped",
        });
        expect(after.conversations.queued("c1")).toEqual({ items: [{ ...item, revision: 1 }], revision: 2, paused: "stopped" });
    });

    // Dismissal settles immediately, unlike a stop. The card must never read `running` in between, even though the
    // transitional `dismissing` publish is skipped and finish's own broadcast covers the gap.
    it("publishes a dismissal at the press, under the ending it is heading for", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "question", requestId: "q1", questions: [] } });
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        conversations.send("c1", { kind: "stop", ending: "dismissed" });
        expect(frames.at(-1)).toBe("dismissing");
        // The turn is still live; only the card's question is gone.
        expect(registry.get("c1")?.attention.question).toBe(false);
        expect(conversations.running("c1")).toBe(true);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");
        expect(store.saved().find((entry) => entry.id === "c1")?.ending).toEqual({ kind: "idle" });
        // `dismissing` and `idle` are both filed under the Finished lane (`laneOf`), so the card never moves lanes.
        expect(frames.at(-1)).toBe("idle");
        expect(frames).not.toContain("running");
        unsubscribe();
    });

    it("drops the cards a stopping turn was parked on, and refuses to raise new ones", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "question", requestId: "q1", questions: [] } });
        expect(registry.get("c1")?.status).toBe("awaiting");
        conversations.send("c1", { kind: "stop", ending: "stopped" });
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(registry.get("c1")?.attention.question).toBe(false);
        conversations.send("c1", { kind: "frame", frame: { kind: "permission", requestId: "perm1", toolName: "Bash" } });
        expect(registry.get("c1")?.status).toBe("stopping");
        expect(registry.get("c1")?.attention.permission).toBe(false);
    });

    // Would otherwise leak a stale flag into the conversation's next turn.
    it("says nothing for a stop with no live turn under it", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const frames: number[] = [];
        const unsubscribe = registry.subscribe(() => frames.push(1));
        conversations.send("c1", { kind: "stop", ending: "stopped" });
        conversations.send("never-heard-of-it", { kind: "stop", ending: "stopped" });
        expect(registry.get("c1")?.status).toBe("idle");
        expect(frames.length).toBe(1);
        unsubscribe();
    });

    it("keeps an error that preceded the stop", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "boom" } });
        conversations.send("c1", { kind: "stop", ending: "stopped" });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("error");
    });

    // Runtime state (running flag, parked question, attention) dies with the process; only the persisted status
    // survives a crash, which is why a crashed turn must read back as `interrupted`, not `idle`.
    it("a turn the daemon died under comes back interrupted, not idle", async () => {
        const store = memoryStore();
        const { agents: first, conversations: firstConversations } = createFleet(store, standings(), presences());
        await first.init();
        await beginTurn(firstConversations, turn(), 1_000);
        firstConversations.send("c1", { kind: "frame", frame: { kind: "question", requestId: "q1", questions: [] } });
        expect(first.get("c1")?.status).toBe("awaiting");

        // No `finish()`: simulates the process dying with the write already on disk.
        const { agents: rebooted, conversations: rebootedConversations } = createFleet(store, standings(), presences());
        await rebooted.init();
        expect(rebooted.get("c1")?.status).toBe("interrupted");
        expect(rebootedConversations.running("c1")).toBe(false);
    });

    // `interrupted` is a placeholder; any ordinary ending overwrites it, so a later boot reads the real status instead.
    it("finishing overwrites the interrupted placeholder, and it does not survive the next boot", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const landed = standings();
        landed.set("c1", "landed");
        const { agents: rebooted } = createFleet(store, landed, presences());
        await rebooted.init();
        expect(rebooted.get("c1")?.status).toBe("landed");
        expect(store.saved().find((entry) => entry.id === "c1")?.ending).toEqual({ kind: "idle" });
    });

    // Guards the whole roster refresh in one `finally`; a repo throwing here must not silence any other conversation's
    // probe.
    it("a probe that throws cannot fail a turn, and does not silence the other one", async () => {
        const failing: LandStandings = {
            of: () => "idle",
            causesOf: () => [],
            refresh: async () => {
                throw new Error(`fatal: cannot change to '${WORKSPACE_ROOT}/deleted': No such file or directory`);
            },
            forget: () => {},
        };
        const moving = presences();
        // Presence refresh still succeeds; only standings is made to throw.
        const { agents: registry, conversations } = createFleet(memoryStore(), failing, { ...moving, refresh: async () => true });
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        const frames: (string | undefined)[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents[0]?.status));
        await expect(conversations.send("c1", { kind: "settle" }, 2_000).settled).resolves.toBeUndefined();
        await expect(registry.refreshStandings()).resolves.toBeUndefined();
        unsubscribe();
        expect(registry.get("c1")?.status).toBe("idle");
        expect(frames).toContain("idle");
    });

    it("error during the turn persists as error status at finish", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "boom" } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("error");
    });

    // A failure with a resume already scheduled must read neither `error` (not done failing) nor `idle` (not done):
    // only `resuming` says work is still coming back.
    it("a failure with a scheduled resume publishes the card as still coming back", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" },
        });
        // Status stays `running` until finish; the error frame lands mid-stream.
        expect(registry.get("c1")?.status).toBe("running");
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("resuming");
        // Persisted status stays `idle`; `resuming` is a live-only projection, never written.
        expect(registry.entry("c1")?.ending).toEqual({ kind: "idle" });
    });

    it("the resumed turn takes the card straight back to running", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" },
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(await beginTurn(conversations, turn({ prompt: "…resumed automatically. Fix the login bug" }), 3_000)).toBe("begun");
        expect(registry.get("c1")?.status).toBe("running");
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");
    });

    // A restored card's placeholder turn finishes seconds before the real resumed turn begins; `markResuming` holds the
    // card through that gap.
    it("markResuming holds the card through the settle that precedes its resumed turn", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "resume-promised" });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("resuming");
        // The resumed turn's own `begin` ends the wait, same as the error-frame path.
        expect(await beginTurn(conversations, turn({ prompt: "…their response follows below. Approved." }), 3_000)).toBe("begun");
        expect(registry.get("c1")?.status).toBe("running");
    });

    // Settles into `error`/Attention, never back into the clean `idle` the dead turn left behind.
    it("an abandoned resume settles the card into the failure it was holding open", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" },
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const failure = "The Claude sign-in this turn ran on could not be renewed.";
        expect(await conversations.send("c1", { kind: "resume-abandoned", reason: failure }, 3_000).settled).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
        // `failure` names the reason; `error` alone does not say why the wait ended.
        expect(registry.get("c1")?.failure).toBe(failure);
        // Idempotent: a second `abandonResume` still answers true, since the wait is already over.
        expect(await conversations.send("c1", { kind: "resume-abandoned", reason: failure }, 4_000).settled).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // A write in this window is overwritten by the finish that follows; the caller must retry.
    it("an abandon that lands while the turn is still unwinding reports that it did not take", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" },
        });
        // No `finish()` yet: the generator is still unwinding.
        expect(
            await conversations.send("c1", { kind: "resume-abandoned", reason: "The Claude sign-in this turn ran on could not be renewed." }, 2_000)
                .settled,
        ).toBe(false);
        expect(registry.get("c1")?.status).toBe("running");
        await conversations.send("c1", { kind: "settle" }, 3_000).settled;
        expect(
            await conversations.send("c1", { kind: "resume-abandoned", reason: "The Claude sign-in this turn ran on could not be renewed." }, 4_000)
                .settled,
        ).toBe(true);
        expect(registry.get("c1")?.status).toBe("error");
    });

    // The only record of a session that failed before producing any other output, such as a report or screenshot.
    it("keeps the sentence a failed turn died on, so the card can say why", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        const message = "Your organization has disabled Claude subscription access for Claude Code";
        conversations.send("c1", {
            kind: "frame",
            frame: {
                kind: "error",
                code: "claude-not-entitled",
                message,
            },
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("error");
        expect(registry.get("c1")?.failure).toBe(message);
    });

    // `failure` describes only the last turn; a clean rerun must drop it.
    it("drops the explanation the moment the conversation runs again", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "API Error: 403 organization not allowed" } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.failure).not.toBeUndefined();
        await beginTurn(conversations, turn({ prompt: "try again" }), 3_000);
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");
        expect(registry.get("c1")?.failure).toBeUndefined();
        expect(registry.entry("c1")?.ending).toEqual({ kind: "idle" });
    });

    // The user's own restart can beat the scheduler; abandon must not overwrite a turn that is now running.
    it("an abandoned resume leaves a turn the user already restarted alone", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "claude-token-refused", message: "API Error: 401", autoResume: "scheduled" },
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ prompt: "try again" }), 3_000);
        expect(
            await conversations.send("c1", { kind: "resume-abandoned", reason: "The Claude sign-in this turn ran on could not be renewed." }, 4_000)
                .settled,
        ).toBe(false);
        expect(registry.get("c1")?.status).toBe("running");
    });

    // `available` means nothing is armed yet; unlike `scheduled`, the failure stands as error.
    it("a failure whose resume is merely on offer still ends the turn in error", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "provider-outage", message: "API Error: 529", autoResume: "available" },
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("error");
    });

    it("session and worktree composition persist across a turn's finish", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "s9" } });
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.sessionId).toBe("s9");
        expect(registry.get("c1")?.base).toBe("aaaaaaa");
    });

    // Precedence: live turn, then the last ending, then land standing; only `idle` yields. An error or interruption
    // outranks branch work, and a clean turn keeps no land verdict of its own.
    it("projects the land standing under a clean ending, and never over an error or an interruption", async () => {
        const store = memoryStore();
        const land = standings();
        const { agents: registry, conversations } = createFleet(store, land, presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("idle");

        land.set("c1", "conflict", ["workspace"]);
        expect(registry.get("c1")?.status).toBe("conflict");
        // `attention.conflict` reads the same derived verdict, not a stored status.
        expect(registry.get("c1")?.attention.conflict).toBe(true);
        // ...and the causes ride the same verdict, so a card can tell whose press clears it.
        expect(registry.get("c1")?.conflictCauses).toEqual(["workspace"]);
        // The land verdict is never persisted; the stored status stays `idle`.
        expect(store.saved().find((entry) => entry.id === "c1")?.ending).toEqual({ kind: "idle" });

        land.set("c1", "ready");
        expect(registry.get("c1")?.status).toBe("ready");
        expect(registry.get("c1")?.attention.conflict).toBe(false);
        // Nothing is refusing, so nothing names a cause: a list left here would offer a press about nothing.
        expect(registry.get("c1")?.conflictCauses).toBeUndefined();

        // An error outranks the branch's land standing.
        await beginTurn(conversations, turn(), 3_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "boom" } });
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
        expect(registry.get("c1")?.status).toBe("error");
    });

    // The lease is what keeps a second press from rebasing the worktree the first land is reading; the status is what
    // the card wears meanwhile, above the ending the last turn wrote, below a live turn.
    it("a land lease reads as `landing` from the claim to the last release, and queues a second land behind the first", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "boom" } });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.status).toBe("error");

        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = conversations.withLandLease("c1", async () => {
            await gate;
            return "first";
        });
        // Claimed synchronously: a request asking right after the claim already sees it.
        expect(conversations.landing("c1")).toBe(true);
        expect(registry.get("c1")?.status).toBe("landing");

        let secondRan = false;
        const second = conversations.withLandLease("c1", async () => {
            secondRan = true;
            return "second";
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(secondRan).toBe(false);

        release();
        expect(await first).toBe("first");
        expect(await second).toBe("second");
        expect(conversations.landing("c1")).toBe(false);
        expect(registry.get("c1")?.status).toBe("error");
    });

    it("a land lease is released when its work throws, and a running turn keeps its own status over it", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await expect(
            conversations.withLandLease("c1", async () => {
                throw new Error("git refused");
            }),
        ).rejects.toThrow("git refused");
        expect(conversations.landing("c1")).toBe(false);
        expect(registry.get("c1")?.status).toBe("idle");

        // A running turn's own end-of-turn land is still that turn running, not a card that stopped to land.
        await beginTurn(conversations, turn(), 3_000);
        let release: () => void = () => undefined;
        const lease = conversations.withLandLease(
            "c1",
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        expect(conversations.landing("c1")).toBe(true);
        expect(registry.get("c1")?.status).toBe("running");
        // The lease's work starts on the next tick; `release` is bound only once it has.
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await lease;
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;
    });

    it("recordLanded persists advanced landedTips and the cumulative diffstat", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 12, insertions: 412, deletions: 96 },
            adjudicated: true,
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(worktreeOf(store.saved().find((entry) => entry.id === "c1"))?.repos).toEqual([
            { repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) },
        ]);
        expect(registry.get("c1")?.diff).toEqual({ files: 12, insertions: 412, deletions: 96 });
    });

    // The sentence describes the claim at its landedTips: a later land that moves one puts different work in the tree,
    // and the old sentence would head its commit; a measure that moves none changes nothing it described.
    it("recordLanded retires the drafted message once a landedTip moves, and keeps it across a land that moves none", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        const landedAt = (tip: string, landed: boolean) =>
            registry.recordLanded("c1", {
                landed,
                changed: landed,
                repos: [{ repo: "root", base: "a".repeat(40), landedTip: tip }],
                diff: { files: 1, insertions: 1, deletions: 0 },
                adjudicated: landed,
            });
        await landedAt("b".repeat(40), true);
        await registry.setLandedSubject("c1", { subject: "fix: cascading markers", note: "Markers stop cascading." });
        registry.setLandedMessageDraft("c1", { startedAt: 1_500, steps: [], outcome: "written", finishedAt: 1_600 });

        await landedAt("b".repeat(40), false);
        expect(registry.get("c1")?.landedMessage).toEqual({ subject: "fix: cascading markers", note: "Markers stop cascading." });
        expect(registry.get("c1")?.landedMessageDraft?.outcome).toBe("written");

        await landedAt("c".repeat(40), true);
        expect(registry.get("c1")?.landedMessage).toBeUndefined();
        expect(registry.get("c1")?.landedMessageDraft).toBeUndefined();
        const saved = store.saved().find((entry) => entry.id === "c1");
        expect(saved?.landing.message).toBeUndefined();
    });

    it("setLandedSubject keeps the release note and the breaking warning whole, and bounds the subject by git's header limit rather than a card's width", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        const note = "You can now create, edit, and manage custom skills for your agent directly in the sandbox, without editing a file by hand.";
        const breaking =
            "The old skills folder is no longer read — move anything you keep there into the skills panel before updating, or it stops loading.";
        await registry.setLandedSubject("c1", { subject: "f".repeat(120), note, breaking });
        const saved = () => store.saved().find((entry) => entry.id === "c1");
        expect(saved()?.landing.message?.note).toBe(note);
        expect(saved()?.landing.message?.breaking).toBe(breaking);
        expect(saved()?.landing.message?.subject).toHaveLength(MAX_SUBJECT_LENGTH);
        expect(MAX_SUBJECT_LENGTH).toBeGreaterThan(80);

        // Same cap enforced even if the model ignores the 'one sentence' guidance in the prompt.
        await registry.setLandedSubject("c1", { subject: "skills panel", note: "n".repeat(500) });
        expect(saved()?.landing.message?.note).toHaveLength(MAX_NOTE_LENGTH);
    });

    it("setLandedSubject puts the message on the card and broadcasts it", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
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
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
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
        expect(store.saved().find((entry) => entry.id === "c1")?.landing.conflicts).toEqual(conflicts);

        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 3, insertions: 10, deletions: 1 },
            adjudicated: true,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.landing.conflicts).toBeUndefined();
    });

    // Every surface that explains a conflict (standing, review, the resolve action) reads off the stored report; a
    // measure land touches none of that and must not clear it.
    it("a measure land settles the books without retiring the last refusal", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
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
        expect(settled?.landing.conflicts).toEqual(conflicts);
        // The diffstat still refreshes; only the conflict report and land outcome are held.
        expect(settled?.landing.diff?.files).toBe(4);

        // A real land still has the final say, clearing the conflict report.
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) }],
            diff: { files: 4, insertions: 12, deletions: 1 },
            adjudicated: true,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.landing.conflicts).toBeUndefined();
    });

    // `begin` rebuilds the entry from an explicit field list; anything left off is dropped on the next turn.
    // `conflicts` and `landRequested` must survive it, since one more turn resolves neither.
    it("a follow-up turn keeps the land refusal and the ask still waiting on one", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
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
        await conversations.send("c1", { kind: "settle" }, 1_800).settled;

        expect(await beginTurn(conversations, turn({ prompt: "rebase onto main" }), 2_000)).toBe("begun");

        // Checked on the persisted entry; the live summary carries only the derived standing, not `conflicts`.
        expect(store.saved().find((entry) => entry.id === "c1")?.landing.conflicts).toEqual(conflicts);
        expect(registry.get("c1")?.landRequested).toMatchObject({ email: "m@x.com", name: "Mo" });

        await registry.recordLanded("c1", {
            landed: false,
            held: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40) }],
            diff: { files: 4, insertions: 12, deletions: 1 },
            adjudicated: false,
        });
        expect(store.saved().find((entry) => entry.id === "c1")?.landing.conflicts).toEqual(conflicts);
    });

    it("counts turns and tool uses: live during the turn, folded at finish, never inflated by manual lands", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "tool_call", id: "t1", name: "Edit", category: "edit", status: "in_progress" } });
        conversations.send("c1", { kind: "frame", frame: { kind: "tool_call", id: "t2", name: "Bash", category: "execute", status: "in_progress" } });
        expect(registry.get("c1")?.toolUses).toBe(2);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.get("c1")?.turns).toBe(1);
        expect(registry.get("c1")?.toolUses).toBe(2);
        await conversations.send("c1", { kind: "settle" }, 3_000).settled;
        expect(registry.get("c1")?.turns).toBe(1);
        await beginTurn(conversations, turn({ prompt: "again" }), 4_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "tool_call", id: "t3", name: "Read", category: "read", status: "in_progress" } });
        await conversations.send("c1", { kind: "settle" }, 5_000).settled;
        expect(registry.get("c1")?.turns).toBe(2);
        expect(registry.get("c1")?.toolUses).toBe(3);
    });

    // Needed so the next turn's plan re-states preamble notes a compaction summarized away (turn-plan.ts).
    it("files a compaction under the turn it happened in, once per turn, and persists it", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "compact", trigger: "auto" } });
        // Filed against the pre-increment count: the first turn is 0, turn 1 is the one retold.
        expect(registry.entry("c1")?.compactedTurn).toBe(0);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.entry("c1")?.totals.turns).toBe(1);

        await beginTurn(conversations, turn({ prompt: "again" }), 3_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "compact", trigger: "auto" } });
        conversations.send("c1", { kind: "frame", frame: { kind: "compact", trigger: "manual" } });
        expect(registry.entry("c1")?.compactedTurn).toBe(1);
        await conversations.send("c1", { kind: "settle" }, 4_000).settled;

        expect(store.saved().find((entry) => entry.id === "c1")?.compactedTurn).toBe(1);
    });

    it("liveSessionIds reports the in-flight turns' sdk sessions, the terminals list's 'still working' signal", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        expect(conversations.liveSessionIds()).toEqual([]);
        await beginTurn(conversations, turn(), 1_000);
        // The session id lands on the turn's first frame, before any Bash runs.
        conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "3f2a9b1c-0000-4000-8000-000000000000" } });
        expect(conversations.liveSessionIds()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000"]);
        // A second conversation's session joins the set; each id drops once its own turn ends.
        await beginTurn(conversations, turn({ conversationId: "c2" }), 1_100);
        conversations.send("c2", { kind: "frame", frame: { kind: "session", sessionId: "7c0e1ad7-0000-4000-8000-000000000000" } });
        expect(conversations.liveSessionIds().toSorted()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000", "7c0e1ad7-0000-4000-8000-000000000000"]);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(conversations.liveSessionIds()).toEqual(["7c0e1ad7-0000-4000-8000-000000000000"]);
        await conversations.send("c2", { kind: "settle" }, 2_100).settled;
        expect(conversations.liveSessionIds()).toEqual([]);
        // Before its first frame, a resumed turn falls back to the session the last turn flushed.
        await beginTurn(conversations, turn({ prompt: "again" }), 3_000);
        expect(conversations.liveSessionIds()).toEqual(["3f2a9b1c-0000-4000-8000-000000000000"]);
    });

    it("activity tracks the last tool and current todo", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "tool_call", id: "t1", name: "Edit", category: "edit", status: "in_progress", target: "src/app.ts" },
        });
        conversations.send("c1", {
            kind: "frame",
            frame: {
                kind: "todos",
                items: [
                    { content: "done thing", status: "completed", activeForm: "doing" },
                    { content: "current thing", status: "in_progress", activeForm: "doing" },
                ],
            },
        });
        expect(registry.get("c1")?.activity).toEqual({ tool: "Edit", target: "src/app.ts", todo: "current thing" });
    });

    // What a turn showed of its own work, read off its tool calls by the settle (turn-settlement.ts) and filed on the
    // card: the record the board badges instead of sending the turn back to prove anything.
    describe("the proof a turn showed", () => {
        const RED = { at: 1_500, verification: "failing", check: "pnpm test" } as const;
        const GREEN = { at: 3_500, verification: "verified", check: "pnpm test" } as const;

        it("files what the settling turn noted, and reports it on the card", async () => {
            const store = memoryStore();
            const { agents: registry, conversations } = createFleet(store, standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "proof-noted", proof: RED });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.entry("c1")?.proof).toEqual(RED);
            expect(registry.get("c1")?.proof).toEqual(RED);
            expect(store.saved().find((entry) => entry.id === "c1")?.proof).toEqual(RED);
        });

        // The work on the branch has not moved, so what was last shown of it still stands.
        it("leaves the last proof standing through a turn that touched no code", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "proof-noted", proof: RED });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await beginTurn(conversations, turn({ prompt: "what did you change?" }), 3_000);
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.proof).toEqual(RED);
        });

        it("takes the next proof a turn shows over the last one", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "proof-noted", proof: RED });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await beginTurn(conversations, turn({ prompt: "fix the test" }), 3_000);
            conversations.send("c1", { kind: "proof-noted", proof: GREEN });
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.proof).toEqual(GREEN);
        });

        // Unlike the turn's own books, the record is the card's: a restart reads it back off the entry.
        it("reads back after a restart", async () => {
            const store = memoryStore();
            const first = createFleet(store, standings(), presences());
            await first.agents.init();
            await beginTurn(first.conversations, turn(), 1_000);
            first.conversations.send("c1", { kind: "proof-noted", proof: RED });
            await first.conversations.send("c1", { kind: "settle" }, 2_000).settled;

            const restarted = createFleet(store, standings(), presences());
            await restarted.agents.init();
            expect(restarted.agents.get("c1")?.proof).toEqual(RED);
        });

        it("is absent on a card no turn has proved anything on", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.get("c1")?.proof).toBeUndefined();
            expect(registry.entry("c1")).not.toHaveProperty("proof");
        });
    });

    // What a turn left open, from only what it itself measured: the todo checklist. No model is asked, and no agent
    // declares anything.
    describe("unfinished work", () => {
        const list = (...items: [string, "pending" | "in_progress" | "completed"][]): AgentEvent => ({
            kind: "todos",
            items: items.map(([content, status]) => ({ content, status })),
        });

        it("counts what the last turn left on its own list, and names what it would have done next", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", {
                kind: "frame",
                frame: list(["Read the registry", "completed"], ["Draw the mark", "in_progress"], ["Cover it with tests", "pending"]),
            });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 2, total: 3, next: "Draw the mark" } });
        });

        it("says nothing about a turn that finished its own list", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Read the registry", "completed"], ["Draw the mark", "completed"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        // Re-measured every turn rather than stamped once, so finishing the work later actually clears it.
        it("clears once a later turn completes the list", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "in_progress"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.get("c1")?.unfinished?.steps).toEqual({ open: 1, total: 1, next: "Draw the mark" });

            await beginTurn(conversations, turn({ prompt: "carry on" }), 3_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "completed"]) });
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        it("re-stamps when a turn moves the list and still leaves something on it", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "pending"], ["Cover it with tests", "pending"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await beginTurn(conversations, turn({ prompt: "carry on" }), 3_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "completed"], ["Cover it with tests", "in_progress"]) });
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.unfinished).toEqual({ at: 4_000, steps: { open: 1, total: 2, next: "Cover it with tests" } });
        });

        /* A turn that reaches its own end without a list clears the prior unfinished state. */
        it("clears through a turn that ran to its own end without a list in view", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "pending"], ["Cover it with tests", "pending"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await beginTurn(conversations, turn({ prompt: "Continue" }), 3_000);
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.unfinished).toBeUndefined();
        });

        it("keeps what it knew through a turn the allowance refused", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "pending"], ["Cover it with tests", "pending"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await beginTurn(conversations, turn({ prompt: "carry on" }), 3_000);
            conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "Individual quota reached." } });
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            // `at` stays the turn that measured the list; a refusal must not reset that clock.
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 2, total: 2, next: "Draw the mark" } });
        });

        it("keeps what it knew through a turn the user stopped before it looked", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "pending"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await beginTurn(conversations, turn({ prompt: "carry on" }), 3_000);
            conversations.send("c1", { kind: "stop", ending: "stopped" });
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 1, total: 1, next: "Draw the mark" } });
        });

        // A cut-short turn that did see the list reports what it saw: the measurement is the turn's, whatever ended it.
        it("measures a list a refused turn had already moved", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "completed"], ["Cover it with tests", "in_progress"]) });
            conversations.send("c1", { kind: "frame", frame: { kind: "error", message: "Individual quota reached." } });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 1, total: 2, next: "Cover it with tests" } });
        });

        // A manual land finishes the card without a turn; the runtime state it reads is the last turn's, checklist
        // included, and re-measuring that would stamp an old abandonment with the land's date.
        it("leaves the mark exactly as it was through a land, which is no turn", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "pending"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;

            await conversations.send("c1", { kind: "settle" }, 9_000).settled;
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: { open: 1, total: 1, next: "Draw the mark" } });
        });

        // Nothing checks a turn's work when it ends any more (checks run after it lands), so no failing check is ever
        // left open on the card: a red one the turn ran is its proof, below.
        it("never marks a turn unfinished for the check it ran red", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "proof-noted", proof: { at: 1_500, verification: "failing", check: "pnpm verify" } });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            expect(registry.get("c1")?.unfinished).toBeUndefined();
            expect(registry.entry("c1")?.unfinished).toBeUndefined();
        });
        // The entry keeps the fact throughout; only what the card shows is held back while a turn works through that
        // very list.
        it("holds the mark back while a turn is in flight and reports it again once the turn settles", async () => {
            const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
            await registry.init();
            await beginTurn(conversations, turn(), 1_000);
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "pending"]) });
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            const left = { open: 1, total: 1, next: "Draw the mark" };
            expect(registry.get("c1")?.unfinished).toEqual({ at: 2_000, steps: left });

            await beginTurn(conversations, turn({ prompt: "carry on" }), 3_000);
            expect(registry.get("c1")?.unfinished).toBeUndefined();
            expect(registry.entry("c1")?.unfinished).toEqual({ at: 2_000, steps: left });

            // The resumed session re-publishes its list on the provider's first answer; still open, it is reported
            // again the moment the turn settles, dated to the turn that last saw it.
            conversations.send("c1", { kind: "frame", frame: list(["Draw the mark", "in_progress"]) });
            await conversations.send("c1", { kind: "settle" }, 4_000).settled;
            expect(registry.get("c1")?.unfinished).toEqual({ at: 4_000, steps: left });
        });

        // The card's rim, unlike the mark above, is NOT held back mid-turn: watching it fill is the whole point.
        describe("checklist progress", () => {
            it("counts the live list the moment a turn publishes one", async () => {
                const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
                await registry.init();
                await beginTurn(conversations, turn(), 1_000);
                conversations.send("c1", {
                    kind: "frame",
                    frame: list(["Read the registry", "completed"], ["Draw the mark", "in_progress"], ["Cover it with tests", "pending"]),
                });
                expect(registry.get("c1")?.checklist).toEqual({ done: 1, total: 3 });
            });

            it("reads a settled turn's completed list as whole", async () => {
                const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
                await registry.init();
                await beginTurn(conversations, turn(), 1_000);
                conversations.send("c1", { kind: "frame", frame: list(["Read the registry", "completed"], ["Draw the mark", "completed"]) });
                await conversations.send("c1", { kind: "settle" }, 2_000).settled;
                // `unfinished` is cleared by the same turn: nothing was left open, and the rim still says 2 of 2.
                expect(registry.get("c1")?.unfinished).toBeUndefined();
                expect(registry.get("c1")?.checklist).toEqual({ done: 2, total: 2 });
            });

            // `begin` installs a blank runtime state, so between it and the turn's first `todos` frame the only
            // surviving reading is what the last turn recorded as left open.
            it("carries the last turn's standing across the start of the next one", async () => {
                const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
                await registry.init();
                await beginTurn(conversations, turn(), 1_000);
                conversations.send("c1", {
                    kind: "frame",
                    frame: list(["Draw the mark", "completed"], ["Cover it with tests", "pending"], ["Update the pages", "pending"]),
                });
                await conversations.send("c1", { kind: "settle" }, 2_000).settled;
                expect(registry.get("c1")?.checklist).toEqual({ done: 1, total: 3 });

                await beginTurn(conversations, turn({ prompt: "carry on" }), 3_000);
                expect(registry.get("c1")?.checklist).toEqual({ done: 1, total: 3 });

                conversations.send("c1", {
                    kind: "frame",
                    frame: list(["Draw the mark", "completed"], ["Cover it with tests", "completed"], ["Update the pages", "pending"]),
                });
                expect(registry.get("c1")?.checklist).toEqual({ done: 2, total: 3 });
            });

            it("carries nothing for a conversation that kept no list", async () => {
                const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
                await registry.init();
                await beginTurn(conversations, turn(), 1_000);
                await conversations.send("c1", { kind: "settle" }, 2_000).settled;
                expect(Object.keys(registry.get("c1") ?? {})).not.toContain("checklist");
            });

            // An empty list is no list: a zero-segment rim would be a ring saying nothing, not a ring saying none done.
            it("carries nothing for an empty list", async () => {
                const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
                await registry.init();
                await beginTurn(conversations, turn(), 1_000);
                conversations.send("c1", { kind: "frame", frame: list() });
                expect(Object.keys(registry.get("c1") ?? {})).not.toContain("checklist");
            });
        });
    });

    // Each send is the whole live roster, so a burst of tool calls from running turns must not send it once per call.
    it("sends a burst of turn progress once, at the window's end, and a change someone made at once", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences(), { rosterWindowMs: 60 });
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        const sends: { readonly rev: number; readonly tool: string | undefined }[] = [];
        const unsubscribe = registry.subscribe((agents, rev) => sends.push({ rev, tool: agents[0]?.activity?.tool }));
        const opened = sends.length;
        for (const name of ["Read", "Grep", "Edit"]) {
            conversations.send("c1", { kind: "frame", frame: { kind: "tool_call", id: name, name, category: "edit", status: "in_progress" } });
        }
        // Bumped at every change, so a route reads its own; the roster carrying them waits for the window.
        expect(registry.revision()).toBe(sends[opened - 1]!.rev + 3);
        expect(sends).toHaveLength(opened);
        await waitFor(() => expect(sends).toHaveLength(opened + 1));
        expect(sends.at(-1)).toEqual({ rev: registry.revision(), tool: "Edit" });

        // Progress waiting behind a window rides the next change anyone makes, at once, and is not sent twice.
        conversations.send("c1", { kind: "frame", frame: { kind: "tool_call", id: "Bash", name: "Bash", category: "execute", status: "in_progress" } });
        await registry.markSeen("c1", 2_000);
        expect(sends.at(-1)).toEqual({ rev: registry.revision(), tool: "Bash" });
        const settled = sends.length;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(sends).toHaveLength(settled);
        unsubscribe();
    });

    it("subscribe delivers an immediate snapshot and change broadcasts", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        const frames: number[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents.length));
        expect(frames).toEqual([0]);
        await beginTurn(conversations, turn(), 1_000);
        expect(frames.at(-1)).toBe(1);
        // Delta frames are not card-visible; they never broadcast.
        const count = frames.length;
        conversations.send("c1", { kind: "frame", frame: { kind: "delta", text: "..." } });
        expect(frames.length).toBe(count);
        unsubscribe();
    });

    it("archiving takes an agent off the roster without touching the entry", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;

        await registry.setArchived(["c1"], 5_000);
        expect(registry.list()).toEqual([]);
        expect(registry.listArchived().map((agent) => agent.id)).toEqual(["c1"]);
        expect(registry.get("c1")?.archivedAt).toBe(5_000);
        expect(registry.entry("c1")?.social.title?.text).toBe("Fix the login bug");
        expect(registry.ids()).toEqual(["c1"]);

        await registry.clearArchived(["c1"]);
        expect(registry.list().map((agent) => agent.id)).toEqual(["c1"]);
        expect(registry.get("c1")?.archivedAt).toBeUndefined();
        expect(store.saved()[0]?.archivedAt).toBeUndefined();
    });

    // A person's door reopens it first (clearArchived, at the route that carries their words); the engine refuses every
    // archived conversation, whoever sent the turn.
    it("a person's door un-archives the agent, and then their turn runs on it", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await registry.setArchived(["c1"], 5_000);

        expect(await beginTurn(conversations, turn(), 5_500)).toBe("archived");
        await registry.clearArchived(["c1"]);
        expect(await beginTurn(conversations, turn(), 6_000)).toBe("begun");
        expect(registry.get("c1")?.archivedAt).toBeUndefined();
        expect(registry.list().map((agent) => agent.id)).toEqual(["c1"]);
        expect(registry.listArchived()).toEqual([]);
    });

    // A resume, a nudge, a wake: only a person un-archives, so the card stays filed away and nothing on it moves.
    it("a turn nobody sent leaves an archived agent archived and opens nothing on it", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await registry.setArchived(["c1"], 5_000);
        const filed = store.saved()[0];

        expect(await beginTurn(conversations, turn({ prompt: "Picking this back up." }), 6_000)).toBe("archived");
        expect(conversations.running("c1")).toBe(false);
        expect(registry.list()).toEqual([]);
        expect(registry.listArchived().map((agent) => [agent.id, agent.archivedAt])).toEqual([["c1", 5_000]]);
        expect(store.saved()[0]).toStrictEqual(filed);
    });

    // Each write path replaces `entries` wholesale; a write that carried the whole roster would let one overlapping change
    // land on top of another's and silently drop it.
    it("concurrent writes all survive the round-trip to disk", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        for (const id of ["c1", "c2", "c3"]) {
            await beginTurn(conversations, turn({ conversationId: id }), 1_000);
            await conversations.send(id, { kind: "settle" }, 2_000).settled;
        }

        await Promise.all([registry.setArchived(["c1"], 5_000), registry.setArchived(["c2"], 5_001), registry.markSeen("c3", 5_002)]);

        expect(store.saved().find((entry) => entry.id === "c1")?.archivedAt).toBe(5_000);
        expect(store.saved().find((entry) => entry.id === "c2")?.archivedAt).toBe(5_001);
        expect(store.saved().find((entry) => entry.id === "c3")?.social.seenAt).toBe(5_002);
    });

    it("the archived list survives a restart, newest first", async () => {
        const store = memoryStore();
        const { agents: first, conversations: firstConversations } = createFleet(store, standings(), presences());
        await first.init();
        await beginTurn(firstConversations, turn(), 1_000);
        await firstConversations.send("c1", { kind: "settle" }, 1_500).settled;
        await beginTurn(firstConversations, turn({ conversationId: "c2" }), 2_000);
        await firstConversations.send("c2", { kind: "settle" }, 2_500).settled;
        await first.setArchived(["c1"], 5_000);
        await first.setArchived(["c2"], 6_000);

        const { agents: second } = createFleet(store, standings(), presences());
        await second.init();
        expect(second.list()).toEqual([]);
        expect(second.listArchived().map((agent) => agent.id)).toEqual(["c2", "c1"]);
    });

    it("remove drops the entry and rehydration restores persisted entries", async () => {
        const store = memoryStore();
        const { agents: first, conversations: firstConversations } = createFleet(store, standings(), presences());
        await first.init();
        await beginTurn(firstConversations, turn(), 1_000);
        await firstConversations.send("c1", { kind: "settle" }, 2_000).settled;
        const { agents: second, conversations: secondConversations } = createFleet(store, standings(), presences());
        await second.init();
        expect(second.get("c1")?.status).toBe("idle");
        await secondConversations.dispose(["c1"]);
        expect(second.get("c1")).toBeUndefined();
        expect(store.saved()).toEqual([]);
    });

    // Only the exact (landedHead, landedTip) pair the scan measured may take the mark; anything else is stale.
    it("markLandingAbsorbed stamps the measured landing, persists it, and refuses every other row", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "b1", landedTip: "t1", landedHead: "h1", landedAt: 3_000 }],
            diff: { files: 1, insertions: 1, deletions: 0 },
            adjudicated: true,
        });

        // A mismatched hash (a stale scan racing a newer land) is a no-op.
        await registry.markLandingAbsorbed("c1", "root", "h0", "t1", 4);
        expect(worktreeOf(registry.entry("c1"))?.repos[0]?.absorbed).toBeUndefined();

        await registry.markLandingAbsorbed("c1", "root", "h1", "t1", 4);
        expect(worktreeOf(registry.entry("c1"))?.repos[0]?.absorbed).toBe(4);
        // Idempotent: a second mark, even with a different size, changes nothing.
        await registry.markLandingAbsorbed("c1", "root", "h1", "t1", 9);
        expect(worktreeOf(registry.entry("c1"))?.repos[0]?.absorbed).toBe(4);
        // Unknown agent or repo ids are silently ignored.
        await registry.markLandingAbsorbed("gone", "root", "h1", "t1", 1);
        await registry.markLandingAbsorbed("c1", "nested", "h1", "t1", 1);

        // Persists across a restart; the store round-trip is what this proves.
        const { agents: restarted } = createFleet(store, standings(), presences());
        await restarted.init();
        expect(worktreeOf(restarted.entry("c1"))?.repos[0]?.absorbed).toBe(4);

        // A fresh `recordLanded` row has no `absorbed` mark: a landing just landed cannot already be absorbed.
        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "b1", landedTip: "t2", landedHead: "h2", landedAt: 5_000 }],
            diff: { files: 1, insertions: 1, deletions: 0 },
            adjudicated: true,
        });
        expect(worktreeOf(registry.entry("c1"))?.repos[0]?.absorbed).toBeUndefined();
    });

    // The whole point of carrying the deadline: it has to outlive the turn that set it, since the entry it names goes
    // on expiring whether or not this conversation is running, and the card is read long after the turn ends.
    it("keeps the prompt-cache deadline past the end of the turn that measured it", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "context_usage", tokens: 142_000, contextWindow: 200_000, cachedAt: 1_500, cacheTtlMs: 3_600_000 },
        });
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        expect(registry.list()[0]?.promptCache).toEqual({ at: 1_500, ttlMs: 3_600_000, rollsAt: nextPromptDayAt(1_500) });
    });

    // Half a pair names no deadline, and a frame that carries neither is a turn that used no cache this time, not one
    // that killed the entry: neither may quietly replace a deadline already standing.
    it("takes a prompt-cache deadline only whole, and never unsets one", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        conversations.send("c1", { kind: "frame", frame: { kind: "context_usage", tokens: 10, contextWindow: 200_000, cachedAt: 1_500 } });
        expect(registry.list()[0]?.promptCache).toBeUndefined();

        conversations.send("c1", {
            kind: "frame",
            frame: { kind: "context_usage", tokens: 20, contextWindow: 200_000, cachedAt: 1_500, cacheTtlMs: 300_000 },
        });
        conversations.send("c1", { kind: "frame", frame: { kind: "context_usage", tokens: 30, contextWindow: 200_000 } });
        expect(registry.list()[0]?.promptCache).toEqual({ at: 1_500, ttlMs: 300_000, rollsAt: nextPromptDayAt(1_500) });
    });

    // A chip is worth nothing without the names behind it, which is the whole reason the wire carries people rather
    // than a count.
    it("groups reactions per emoji, naming everyone who left one, in the order they were left", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await registry.react("c1", "👍", { email: "ada@example.com", name: "Ada" }, true, 2_000);
        await registry.react("c1", "🎉", { email: "ada@example.com", name: "Ada" }, true, 2_100);
        await registry.react("c1", "👍", { email: "bob@example.com" }, true, 2_200);
        expect(registry.get("c1")?.reactions).toEqual([
            {
                emoji: "👍",
                by: [
                    { email: "ada@example.com", name: "Ada", at: 2_000 },
                    // No name: the sign-in carried none, and the address stands for them.
                    { email: "bob@example.com", at: 2_200 },
                ],
            },
            { emoji: "🎉", by: [{ email: "ada@example.com", name: "Ada", at: 2_100 }] },
        ]);
    });

    // `on` is the intent, not a flip: a retried request, a double press and two windows racing must all settle where
    // one press did, and none of them may restamp the instant the first press recorded.
    it("a second press of the same mark changes nothing at all", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        await registry.react("c1", "👍", { email: "ada@example.com", name: "Ada" }, true, 2_000);
        const frames: number[] = [];
        const unsubscribe = registry.subscribe((agents) => frames.push(agents.length));

        await registry.react("c1", "👍", { email: "ada@example.com", name: "Ada" }, true, 9_000);
        expect(registry.get("c1")?.reactions).toEqual([{ emoji: "👍", by: [{ email: "ada@example.com", name: "Ada", at: 2_000 }] }]);
        // Only the subscribe's own opening frame; nothing was published, because nothing changed.
        expect(frames).toHaveLength(1);
        unsubscribe();
    });

    // Reacting is not the conversation doing something, so the card must not move to the top of a board sorted by
    // when work last happened.
    it("leaves updatedAt where the last turn left it", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        const before = registry.get("c1")?.updatedAt;
        await registry.react("c1", "👀", { email: "ada@example.com" }, true, 8_000);
        expect(registry.get("c1")?.updatedAt).toBe(before);
    });

    // Taking a mark back has to survive a restart the same way leaving one does, and the last person to leave takes
    // the chip with them rather than leaving an empty one behind.
    it("takes a mark back, and the last one takes the chip with it", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await registry.react("c1", "👍", { email: "ada@example.com", name: "Ada" }, true, 2_000);
        await registry.react("c1", "👍", { email: "bob@example.com" }, true, 2_100);

        await registry.react("c1", "👍", { email: "ada@example.com", name: "Ada" }, false, 3_000);
        expect(registry.get("c1")?.reactions).toEqual([{ emoji: "👍", by: [{ email: "bob@example.com", at: 2_100 }] }]);

        await registry.react("c1", "👍", { email: "bob@example.com" }, false, 3_100);
        expect(registry.get("c1")?.reactions).toBeUndefined();
        // Absent rather than an empty list on disk too: a card nobody marks must read like one nobody ever did.
        expect(store.saved()[0]?.social.reactions).toEqual([]);

        const { agents: restarted } = createFleet(store, standings(), presences());
        await restarted.init();
        expect(restarted.get("c1")?.reactions).toBeUndefined();
    });

    it("takes back a mark nobody left without touching the card", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await registry.react("c1", "👍", { email: "ada@example.com" }, false, 2_000);
        expect(registry.get("c1")?.reactions).toBeUndefined();
    });

    it("answers an unknown conversation with nothing rather than minting one", async () => {
        const { agents: registry } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        expect(await registry.react("nope", "👍", { email: "ada@example.com" }, true, 2_000)).toBeUndefined();
    });
});

// Whose a conversation is: derived once from the opening turn, inherited by a child from its parent, and moved only by
// an explicit assignment. Ownership never follows a later turn's caller.
describe("session ownership", () => {
    it("latches the opening member as owner and keeps them through another member's turns", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ startedBy: "ania@example.com", owner: { email: "ania@example.com", name: "Ania" } }), 1_000);
        expect(registry.get("c1")?.owner).toEqual({ email: "ania@example.com", name: "Ania", since: 1_000 });
        expect(registry.get("c1")?.startedBy).toBe("ania@example.com");
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        await beginTurn(conversations, turn({ startedBy: "bob@example.com", owner: { email: "bob@example.com" } }), 2_000);
        expect(registry.get("c1")?.owner).toEqual({ email: "ania@example.com", name: "Ania", since: 1_000 });
        expect(registry.get("c1")?.startedBy).toBe("ania@example.com");
    });

    it("leaves a program's conversation unowned, and a child inherits its parent's owner as of its own birth", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ conversationId: "bot", startedBy: "token:nightly" }), 1_000);
        expect(registry.get("bot")?.owner).toBeUndefined();
        await beginTurn(
            conversations,
            turn({ conversationId: "parent", startedBy: "ania@example.com", owner: { email: "ania@example.com" } }),
            1_000,
        );
        await beginTurn(conversations, turn({ conversationId: "sub-1", startedBy: "agent:parent" }), 3_000);
        expect(registry.get("sub-1")?.owner).toEqual({ email: "ania@example.com", since: 3_000 });
        expect(registry.get("sub-1")?.startedBy).toBe("agent:parent");
        // A child of an unowned parent, or of a parent the registry has never seen, is unowned too.
        await beginTurn(conversations, turn({ conversationId: "sub-2", startedBy: "agent:bot" }), 4_000);
        expect(registry.get("sub-2")?.owner).toBeUndefined();
    });

    it("assign moves it without counting as activity, and the moved owner survives the next turn", async () => {
        const store = memoryStore();
        const { agents: registry, conversations } = createFleet(store, standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn({ owner: { email: "ania@example.com" } }), 1_000);
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        const before = registry.get("c1")?.updatedAt;
        const moved = await registry.assign("c1", { email: "bob@example.com", name: "Bob" }, 5_000);
        expect(moved?.owner).toEqual({ email: "bob@example.com", name: "Bob", since: 5_000 });
        expect(moved?.updatedAt).toBe(before);
        expect(store.saved().find((entry) => entry.id === "c1")?.social.owner?.email).toBe("bob@example.com");
        await beginTurn(conversations, turn({ owner: { email: "ania@example.com" } }), 6_000);
        expect(registry.get("c1")?.owner?.email).toBe("bob@example.com");
        expect(await registry.assign("missing", { email: "bob@example.com" }, 7_000)).toBeUndefined();
    });
});

// The facts that must agree are written as one: each of these injects a failure partway through the write and finds the
// database exactly as it was before the fact.
describe("one write per fact", () => {
    const IN_FLIGHT: JournalledTurn = { kind: "turn", turn: { conversationId: "c1", prompt: "Fix the login bug" }, startedAt: 1_000, attempts: 0 };

    it("a turn's opening entry and its journal row go down together", async () => {
        const db = openConversationsDb(IN_MEMORY);
        const { agents: registry, conversations } = createFleet(fleetStoreOver(db), standings(), presences());
        await registry.init();
        // Filed by the run before its turn begins, and written by nothing until the begin.
        conversations.send("c1", { kind: "journalled", entry: IN_FLIGHT });
        expect(db.rowsOf("c1")).toEqual({});

        expect(await beginTurn(conversations, turn(), 1_000)).toBe("begun");

        expect(Object.keys(db.rowsOf("c1")).toSorted()).toEqual(["conversation", "turn_journal"]);
        expect(await sqliteTurnJournal(db).list()).toEqual([IN_FLIGHT]);
    });

    it("a turn whose journal row cannot be written leaves no opening entry either", async () => {
        const db = openConversationsDb(IN_MEMORY);
        const store = fleetStoreOver(db);
        const failing: FleetStore = {
            ...store,
            journal: {
                ...store.journal,
                putTurn: () => {
                    throw new Error("disk full");
                },
            },
        };
        const { agents: registry, conversations } = createFleet(failing, standings(), presences());
        await registry.init();
        conversations.send("c1", { kind: "journalled", entry: IN_FLIGHT });

        await expect(beginTurn(conversations, turn(), 1_000)).rejects.toThrow("disk full");

        expect(db.rowsOf("c1")).toEqual({});
    });

    it("a land's outcome and its per-repo provenance go down together, or the record stays as it was", async () => {
        const db = openConversationsDb(IN_MEMORY);
        const { agents: registry, conversations } = createFleet(fleetStoreOver(db), standings(), presences());
        await registry.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;
        await registry.recordWorktree("c1", [{ repo: "root", base: "a".repeat(40) }]);
        const before = db.rowsOf("c1");

        // The same repo twice: the second provenance row collides after the record and the first row are written.
        await expect(
            registry.recordLanded("c1", {
                landed: true,
                changed: true,
                repos: [
                    { repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) },
                    { repo: "root", base: "a".repeat(40), landedTip: "c".repeat(40) },
                ],
                diff: { files: 1, insertions: 1, deletions: 0 },
                adjudicated: true,
            }),
        ).rejects.toThrow("UNIQUE constraint failed");
        expect(db.rowsOf("c1")).toEqual(before);

        await registry.recordLanded("c1", {
            landed: true,
            changed: true,
            repos: [{ repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40), landedHead: "h".repeat(40), landedAt: 2_000 }],
            diff: { files: 1, insertions: 1, deletions: 0 },
            adjudicated: true,
        });
        const landed = sqliteAgentsStore(db).load()[0];
        expect(worktreeOf(landed)?.repos).toEqual([
            { repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40), landedHead: "h".repeat(40), landedAt: 2_000 },
        ]);
        expect(landed?.landing.diff).toEqual({ files: 1, insertions: 1, deletions: 0 });
    });

    it("a removed conversation leaves no row in any table, and its directory goes with it", async () => {
        const db = openConversationsDb(IN_MEMORY);
        const removed: string[][] = [];
        const { agents: registry, conversations } = createFleet(
            fleetStoreOver(db, { remove: async (ids) => void removed.push([...ids]) }),
            standings(),
            presences(),
        );
        await registry.init();
        conversations.send("c1", { kind: "journalled", entry: IN_FLIGHT });
        await beginTurn(conversations, turn(), 1_000);
        await sqliteTurnCheckpoints(db).record("c1", 0, { kind: "tree", snapshot: "s-0" });
        await conversations.send("c1", { kind: "settle" }, 1_500).settled;

        await conversations.dispose(["c1"]);

        expect(db.rowsOf("c1")).toEqual({});
        expect(removed).toEqual([["c1"]]);
        expect(registry.entry("c1")).toBeUndefined();
    });
});

// An arrival lands rows under a running daemon: what it brought replaces what was here for those ids, and nothing else
// is read again, so a hold this process made for another conversation survives it.
it("an arrival takes in only the conversations it brought, replacing those whole", async () => {
    const db = openConversationsDb(IN_MEMORY);
    const { agents: registry, conversations } = createFleet(fleetStoreOver(db), standings(), presences());
    await registry.init();
    await beginTurn(conversations, turn(), 1_000);
    conversations.send("c1", {
        kind: "frame",
        frame: { kind: "error", code: "rate_limit", message: "spent", autoResume: "scheduled", resetsAt: 9_000, held: { ran: true } },
    });
    await conversations.send("c1", { kind: "settle" }, 2_000).settled;
    await beginTurn(conversations, turn({ conversationId: "c2" }), 1_000);
    await conversations.send("c2", { kind: "settle" }, 2_000).settled;
    const here = registry.entry("c2");
    if (here === undefined) {
        throw new Error("c2 never registered");
    }
    // What the arrival wrote: a conversation this fleet never had, and another copy of one it has.
    const brought = conversationEntry({ id: "new-1", createdAt: 3_000, updatedAt: 3_000 });
    sqliteAgentsStore(db).save([brought, { ...here, social: { title: { text: "Arrived title", source: "user" }, reactions: [] } }]);

    registry.adopted(["new-1", "c2"]);

    expect(registry.entry("new-1")).toEqual(brought);
    expect(registry.entry("c2")?.social.title).toEqual({ text: "Arrived title", source: "user" });
    expect(registry.get("c1")).toMatchObject({ limitHeld: true, limitScheduled: true });
});

// A spent allowance's hold, booking and move are memory of the process that made them; the refusal itself persists.
it("a restarted fleet reads a spent allowance back without the hold, the booking or the move", async () => {
    const store = memoryStore();
    const { agents: registry, conversations } = createFleet(store, standings(), presences());
    await registry.init();
    await beginTurn(conversations, turn(), 1_000);
    conversations.send("c1", {
        kind: "frame",
        frame: {
            kind: "error",
            code: "rate_limit",
            message: "spent",
            autoResume: "scheduled",
            resetsAt: 9_000,
            held: { ran: true, moving: "acct-2" },
        },
    });
    await conversations.send("c1", { kind: "settle" }, 2_000).settled;
    expect(registry.get("c1")).toMatchObject({
        failureCode: "rate_limit",
        limitResetsAt: 9_000,
        limitHeld: true,
        limitScheduled: true,
        limitMoving: "acct-2",
    });

    const { agents: restarted } = createFleet(store, standings(), presences());
    await restarted.init();
    expect(restarted.entry("c1")?.ending).toEqual({ kind: "limited", failure: "spent", resetsAt: 9_000, held: false, scheduled: false });
    const summary = restarted.get("c1");
    expect([
        summary?.status,
        summary?.failureCode,
        summary?.limitResetsAt,
        summary?.limitHeld,
        summary?.limitScheduled,
        summary?.limitMoving,
    ]).toEqual(["error", "rate_limit", 9_000, undefined, undefined, undefined]);
});

// Each turn runs as the persona it names (turn-premise.ts), so the conversation speaks as its last turn's: one daemon
// field every view groups by. The first turn's stays on `actsAs`, which never moves.
describe("the persona a conversation speaks as", () => {
    it("is the last turn's own, never carried to a turn naming none", async () => {
        const { agents: registry, conversations } = createFleet(memoryStore(), standings(), presences());
        await registry.init();
        const ran = async (actsAs: string | undefined, at: number): Promise<void> => {
            await beginTurn(conversations, turn({ profile: { agent: "claude", harness: "native", ...opt("actsAs", actsAs) } }), at);
            await conversations.send("c1", { kind: "settle" }, at + 1).settled;
        };
        await ran("support", 1_000);
        await ran("sales", 2_000);
        expect([registry.get("c1")?.actsAs, registry.get("c1")?.lastActsAs]).toEqual(["support", "sales"]);
        await ran(undefined, 3_000);
        expect([registry.get("c1")?.actsAs, registry.get("c1")?.lastActsAs]).toEqual(["support", undefined]);
    });
});
