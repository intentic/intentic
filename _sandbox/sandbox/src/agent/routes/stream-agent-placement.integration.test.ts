import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentEvent, type Rule, SandboxSettingsSchema, type WorkspaceEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import * as verifyLanded from "../../agents/land/verify-landed.js";
import * as versionLanded from "../../agents/land/version-landed.js";
import type { Services } from "../../composition.js";
import { collect } from "../../harness/route-client.testing.js";
import { gitOut, OPENING_CHECKS_PREAMBLE, realCheckout, recordingLogger } from "../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../harness/route-services.testing.js";
import { beginTurn } from "../../testing.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { AgentRequest } from "../providers/agent-request.js";
import type { SentTurn } from "../../seams/turn-starter.js";
import { streamAgent } from "./agent.routes.js";

// Pins where a conversation's turn runs and what happens after it: the runner, the main tree and the worktree, each
// with its own frames around the body, its land or its books, and the events a settled turn raises.

// The land's three hand-offs leave this process (a chore, the whole-repo check, the drafted message), so each is
// recorded at the door instead: the chore's announcement off the bus (placedServices), the other two by their modules.
const landed = { ...verifyLanded };
const versioned = { ...versionLanded };
const emitted = [] as WorkspaceEvent[];
const verified = [] as DependencyLandOrigin[];
const drafted = [] as string[];
jest.mock("../../agents/land/verify-landed.js", () => ({
    ...landed,
    verifyLandedTree: async (_services: unknown, origin: DependencyLandOrigin) => {
        verified.push(origin);
        return { missing: 1, started: ["root"], deferred: false };
    },
}));
jest.mock("../../agents/land/version-landed.js", () => ({
    ...versioned,
    settleLandingInBackground: (_services: unknown, id: string) => void drafted.push(id),
}));

const tempDirs: string[] = [];
afterEach(async () => {
    emitted.length = 0;
    verified.length = 0;
    drafted.length = 0;
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A real checkout, removed after the test that made it.
const checkout = async (id: string): ReturnType<typeof realCheckout> => {
    const made = await realCheckout(id);
    tempDirs.push(made.root);
    return made;
};

// A placed turn's services with every write, log line and timed span recorded.
const placedServices = (
    agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>,
    extra: Parameters<typeof services>[0] = {},
    snapshot?: string,
): { readonly services: Services; readonly writes: ReturnType<typeof recordingTurnStores>["writes"]; readonly lines: Record<string, unknown>[] } => {
    const recorded = recordingTurnStores(snapshot === undefined ? {} : { snapshot });
    const { lines, logger } = recordingLogger();
    const placed = services({ ...recorded.overrides, logger, git: { sync: async () => ({ status: "current" }) }, agent, ...extra });
    // Heard beside composition's own reactions, whose chores match no automation here.
    placed.events.subscribe("workspace", (event) => void emitted.push(event));
    return { services: placed, writes: recorded.writes, lines };
};

const scripted = (frames: readonly AgentEvent[]) =>
    async function* (): AsyncGenerator<AgentEvent> {
        yield* frames;
    };

// The agent's own edit, written where it works before it says anything.
const editing = (worktree: string, frames: readonly AgentEvent[]) =>
    async function* (): AsyncGenerator<AgentEvent> {
        await writeFile(join(worktree, "app.ts"), "line one\nthe agent's work\n");
        yield* frames;
    };

const lands = (writes: ReturnType<typeof recordingTurnStores>["writes"]): unknown[] => writes.spans.filter(({ name }) => name === "agent.land");

test("a runner turn without a conversation is refused before anything starts", async () => {
    const { services: s } = placedServices(scripted([{ kind: "done" }]));

    expect(await collect(streamAgent(s, { prompt: "go", placement: { kind: "runner", id: "r-1" }, byPerson: true }, undefined))).toStrictEqual([
        { kind: "error", message: "Running on a runner needs a conversation id — the conversation's branch is what travels." },
        { kind: "done" },
    ]);
});

test("a runner nobody paired is refused before the conversation exists", async () => {
    const { services: s } = placedServices(scripted([{ kind: "done" }]), {
        runners: unstubbed<Services["runners"]>("runners", { enrolled: async () => false }),
    });

    const frames = await collect(
        streamAgent(s, { prompt: "go", conversationId: "placed-unpaired", placement: { kind: "runner", id: "r-1" }, byPerson: true }, undefined),
    );

    expect(frames).toStrictEqual([
        { kind: "error", message: 'No runner named "r-1" is paired with this sandbox — pair one first, or leave placement out to run here.' },
        { kind: "done" },
    ]);
    expect(s.agents.entry("placed-unpaired")).toBeUndefined();
});

test("a conversation already running a turn refuses a second one as busy", async () => {
    const { services: s } = placedServices(scripted([{ kind: "done" }]));
    expect(
        await beginTurn(
            s.conversations,
            { conversationId: "placed-busy", isolated: false, prompt: "first", profile: { agent: "claude", harness: "native" }, byPerson: true },
            Date.now(),
        ),
    ).toBe("begun");

    expect(await collect(streamAgent(s, { prompt: "second", conversationId: "placed-busy", byPerson: true }, undefined))).toStrictEqual([
        { kind: "error", code: "agent-busy", message: "This agent is already running a turn, wait for it to finish." },
        { kind: "done" },
    ]);
});

// Only a person reopens an archived conversation: any other turn is turned away at its begin, runs nothing, and says why.
test("an archived conversation refuses a turn nobody sent, and stays archived", async () => {
    let ran = false;
    const { services: s } = placedServices(async function* (): AsyncGenerator<AgentEvent> {
        ran = true;
        yield { kind: "done" };
    });
    const turn = { conversationId: "placed-filed", isolated: false, prompt: "first", profile: { agent: "claude", harness: "native" }, byPerson: true } as const;
    await beginTurn(s.conversations, turn, 1_000);
    await s.conversations.send("placed-filed", { kind: "settle" }, 2_000).settled;
    await s.agents.setArchived(["placed-filed"], 3_000);

    expect(await collect(streamAgent(s, { prompt: "picking this back up", conversationId: "placed-filed", byPerson: false }, undefined))).toStrictEqual([
        { kind: "error", message: "This conversation is archived: only a person's message reopens it." },
        { kind: "done" },
    ]);
    expect(ran).toBe(false);
    expect(s.agents.entry("placed-filed")?.archivedAt).toBe(3_000);
});

test("a runner turn mirrors the branch, runs remotely, and settles its books even when the runner is gone", async () => {
    const { work, worktree, worktrees } = await checkout("placed-runner");
    const base = await gitOut(work, "rev-parse", "HEAD");
    // What the runner delivered last time, still in the mirror.
    await writeFile(join(worktree, "app.ts"), "line one\nthe runner's work\n");
    const { services: s, writes } = placedServices(scripted([{ kind: "done" }]), {
        agentWorktrees: worktrees,
        runners: unstubbed<Services["runners"]>("runners", { enrolled: async () => true }),
        runnerHub: unstubbed<Services["runnerHub"]>("runnerHub", { client: () => undefined }),
    });

    const frames = await collect(
        streamAgent(s, { prompt: "go", conversationId: "placed-runner", placement: { kind: "runner", id: "r-1" }, byPerson: true }, undefined),
    );

    expect(frames).toStrictEqual([
        { kind: "worktree", branch: "agent/placed-runner", base: base.slice(0, 7), remote: "r-1" },
        { kind: "checkpoint", id: "worktree:0", index: 0 },
        {
            kind: "error",
            message:
                'The runner "r-1" is offline — its machine is asleep, or the runner container is down. This conversation runs there; wake it, or start a new conversation to work here.',
        },
        { kind: "done" },
    ]);
    // Settled in `measure` though the turn failed: the mirror is what the runner delivered, whatever it said.
    expect(lands(writes)).toStrictEqual([{ name: "agent.land", attrs: { id: "placed-runner", mode: "measure", span: "outstanding" } }]);
    expect(s.agents.entry("placed-runner")).toMatchObject({
        placement: { kind: "worktree", branch: "agent/placed-runner", runner: "r-1" },
        ending: {
            kind: "failed",
            failure:
                'The runner "r-1" is offline — its machine is asleep, or the runner container is down. This conversation runs there; wake it, or start a new conversation to work here.',
        },
    });
    expect(await gitOut(work, "status", "--porcelain")).toBe("");
    // No chore hears about a runner's turn.
    expect(emitted).toStrictEqual([]);
});

test("a main-tree turn checkpoints before it runs, snapshots after, and raises no land or settled event", async () => {
    const { services: s, writes } = placedServices(scripted([{ kind: "delta", text: "done" }, { kind: "done" }]), {}, "snap-1");

    const frames = await collect(streamAgent(s, { prompt: "tidy the readme", conversationId: "placed-main", byPerson: true }, undefined));

    expect(frames).toStrictEqual([
        OPENING_CHECKS_PREAMBLE,
        { kind: "checkpoint", id: "snap-1", index: 0 },
        { kind: "delta", text: "done" },
        { kind: "done" },
    ]);
    expect(writes.checkpoints).toStrictEqual([{ conversationId: "placed-main", index: 0, checkpoint: { kind: "tree", snapshot: "snap-1" } }]);
    expect(writes.snapshots).toStrictEqual([{ trigger: "user" }, { trigger: "turn", label: "tidy the readme" }]);
    expect(s.agents.entry("placed-main")).toMatchObject({ ending: { kind: "idle" } });
    expect(s.agents.entry("placed-main")?.placement).toEqual({ kind: "main" });
    expect(emitted).toStrictEqual([]);
});

test("a main-tree turn with no conversation keeps its checkpoint unindexed and files it nowhere", async () => {
    const { services: s, writes } = placedServices(scripted([{ kind: "delta", text: "done" }, { kind: "done" }]), {}, "snap-2");

    const frames = await collect(streamAgent(s, { prompt: "tidy the readme", byPerson: true }, undefined));

    expect(frames).toStrictEqual([OPENING_CHECKS_PREAMBLE, { kind: "checkpoint", id: "snap-2" }, { kind: "delta", text: "done" }, { kind: "done" }]);
    expect(writes.checkpoints).toStrictEqual([]);
});

test("a runtime that throws is observed as the turn's failure, and the throw reaches the caller", async () => {
    const { services: s } = placedServices(async function* () {
        yield { kind: "delta", text: "starting" };
        throw new Error("the harness crashed");
    });

    const frames: AgentEvent[] = [];
    const run = (async () => {
        for await (const frame of streamAgent(s, { prompt: "go", conversationId: "placed-throws", byPerson: true }, undefined)) {
            frames.push(frame);
        }
    })();

    await expect(run).rejects.toThrow("the harness crashed");
    expect(frames).toStrictEqual([OPENING_CHECKS_PREAMBLE, { kind: "delta", text: "starting" }]);
    expect(s.agents.entry("placed-throws")).toMatchObject({ ending: { kind: "failed" } });
});

test("a clean isolated turn rebases onto the main line, lands into the main tree, checks it, and says so to every reader", async () => {
    const { work, worktree, worktrees } = await checkout("placed-lands");
    // The main line moved on after the branch was cut, so the turn starts by rebasing onto it.
    await writeFile(join(work, "other.ts"), "someone else's work\n");
    await gitOut(work, "add", "-A");
    await gitOut(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "meanwhile");
    const base = await gitOut(work, "rev-parse", "HEAD");
    const { services: s, writes } = placedServices(editing(worktree, [{ kind: "delta", text: "shipped" }, { kind: "done" }]), {
        agentWorktrees: worktrees,
    });

    const input: SentTurn = { prompt: "ship the parser", conversationId: "placed-lands", isolated: true, autoLand: true, byPerson: true };
    const frames = await collect(streamAgent(s, input, undefined));

    expect(frames).toStrictEqual([
        { kind: "worktree", branch: "agent/placed-lands", base: base.slice(0, 7), unenforced: true, sync: { commits: 1, blocked: [] } },
        { kind: "checkpoint", id: "worktree:0", index: 0 },
        OPENING_CHECKS_PREAMBLE,
        { kind: "delta", text: "shipped" },
        { kind: "done" },
        { kind: "landed", landed: true, deps: { missing: 1, started: ["root"], deferred: false } },
    ]);
    expect(await gitOut(work, "show", "HEAD:app.ts")).toBe("line one");
    expect(await gitOut(work, "diff")).toContain("+the agent's work");
    expect(lands(writes)).toStrictEqual([{ name: "agent.land", attrs: { id: "placed-lands", mode: "check", span: "outstanding" } }]);
    const repos = [{ repo: "root", from: base, dir: worktree }];
    expect(verified).toStrictEqual([{ kind: "land", agentId: "placed-lands", title: "Ship the parser", branch: "agent/placed-lands", repos }]);
    expect(drafted).toStrictEqual(["placed-lands"]);
    // The main tree moved: History gets a turn checkpoint; the worktree turn itself never snapshots.
    expect(writes.snapshots).toStrictEqual([{ trigger: "turn", label: "ship the parser" }]);
    expect(emitted).toStrictEqual([
        { event: "agent.landed", agentId: "placed-lands", title: "Ship the parser", branch: "agent/placed-lands", outcome: "landed", repos },
        { event: "turn.settled", agentId: "placed-lands", title: "Ship the parser", branch: "agent/placed-lands", outcome: "landed", repos },
    ]);
    expect(writes.activity.filter(({ type }) => type === "rule.held_work")).toStrictEqual([]);
});

test("a clean isolated turn with auto-land off is measured and held on its branch", async () => {
    const { work, worktree, worktrees } = await checkout("placed-held");
    const base = await gitOut(work, "rev-parse", "HEAD");
    const { services: s, writes } = placedServices(editing(worktree, [{ kind: "delta", text: "shipped" }, { kind: "done" }]), {
        agentWorktrees: worktrees,
    });

    const frames = await collect(streamAgent(s, { prompt: "ship it", conversationId: "placed-held", isolated: true, autoLand: false, byPerson: true }, undefined));

    expect(frames.at(-1)).toStrictEqual({ kind: "landed", landed: false, held: true });
    expect(lands(writes)).toStrictEqual([{ name: "agent.land", attrs: { id: "placed-held", mode: "measure", span: "outstanding" } }]);
    expect(await gitOut(work, "status", "--porcelain")).toBe("");
    expect(verified).toStrictEqual([]);
    expect(drafted).toStrictEqual([]);
    expect(emitted).toStrictEqual([
        {
            event: "turn.settled",
            agentId: "placed-held",
            title: "Ship it",
            branch: "agent/placed-held",
            outcome: "ready",
            repos: [{ repo: "root", from: base, dir: worktree }],
        },
    ]);
});

test("a rule that holds work narrowed by path is read against the turn's own changes, stamped, and reported", async () => {
    const { worktree, worktrees } = await checkout("placed-rule");
    const hold: Rule = {
        id: "hold-app",
        label: "Hold the app",
        moment: "agent.finished",
        when: { paths: ["app.ts"] },
        action: { kind: "verdict", verdict: "hold" },
        enabled: true,
    };
    const { services: s, writes } = placedServices(editing(worktree, [{ kind: "delta", text: "shipped" }, { kind: "done" }]), {
        agentWorktrees: worktrees,
        sandboxSettings: { get: async () => SandboxSettingsSchema.parse({ rules: [hold] }) },
    });

    const frames = await collect(streamAgent(s, { prompt: "ship it", conversationId: "placed-rule", isolated: true, byPerson: true }, undefined));

    expect(frames.at(-1)).toStrictEqual({ kind: "landed", landed: false, held: true });
    expect(writes.ruleFirings).toStrictEqual([{ rule: "hold-app", at: expect.any(Number) }]);
    expect(writes.activity.filter(({ type }) => type === "rule.held_work")).toStrictEqual([
        {
            direction: "system",
            type: "rule.held_work",
            content: '"Hold the app" held this work on its branch instead of landing it.',
            conversationId: "placed-rule",
        },
    ]);
    expect(emitted.map(({ event, outcome }) => ({ event, outcome }))).toStrictEqual([{ event: "turn.settled", outcome: "ready" }]);
});

// Nothing a turn checks can hold its work: the whole-tree check runs after it lands (verify-deps.ts), and what the turn
// showed of its own work is only recorded on its card.
test("a turn whose own check failed still lands, and its card records the check that failed", async () => {
    const { work, worktree, worktrees } = await checkout("placed-checks");
    const { services: s, writes } = placedServices(
        editing(worktree, [
            {
                kind: "tool_call",
                id: "call-edit",
                name: "Edit",
                category: "edit",
                status: "completed",
                locations: [{ path: join(worktree, "app.ts") }],
            },
            { kind: "tool_call", id: "call-test", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
            { kind: "tool_call_update", id: "call-test", status: "completed", content: [{ type: "text", text: "1 failed\n--- [exit 1, 4s]" }] },
            { kind: "delta", text: "shipped" },
            { kind: "done" },
        ]),
        { agentWorktrees: worktrees },
    );

    const frames = await collect(
        streamAgent(s, { prompt: "ship it", conversationId: "placed-checks", isolated: true, autoLand: true, byPerson: true }, undefined),
    );

    expect(frames.at(-1)).toMatchObject({ kind: "landed", landed: true });
    expect(await gitOut(work, "diff")).toContain("+the agent's work");
    expect(lands(writes)).toStrictEqual([{ name: "agent.land", attrs: { id: "placed-checks", mode: "check", span: "outstanding" } }]);
    expect(writes.activity.filter(({ type }) => type === "rule.held_work")).toStrictEqual([]);
    expect(writes.ruleFirings).toStrictEqual([]);
    expect(s.agents.entry("placed-checks")?.proof).toStrictEqual({ at: expect.any(Number), verification: "failing", check: "pnpm test" });
});

test("a failed isolated turn lands nothing, leaves its books alone, and settles as an error", async () => {
    const { work, worktree, worktrees } = await checkout("placed-fails");
    const { services: s, writes } = placedServices(
        editing(worktree, [{ kind: "error", code: "context-window-too-small", message: "this model cannot hold the turn" }, { kind: "done" }]),
        { agentWorktrees: worktrees },
    );

    const frames = await collect(streamAgent(s, { prompt: "ship it", conversationId: "placed-fails", isolated: true, autoLand: true, byPerson: true }, undefined));

    expect(frames.slice(2)).toStrictEqual([
        OPENING_CHECKS_PREAMBLE,
        { kind: "error", code: "context-window-too-small", message: "this model cannot hold the turn", account: "default" },
        { kind: "done" },
    ]);
    expect(lands(writes)).toStrictEqual([]);
    expect(await gitOut(work, "status", "--porcelain")).toBe("");
    expect(await gitOut(worktree, "status", "--porcelain")).toBe("M app.ts");
    expect(emitted.map(({ event, outcome }) => ({ event, outcome }))).toStrictEqual([{ event: "turn.settled", outcome: "error" }]);
    expect(s.agents.entry("placed-fails")).toMatchObject({ ending: { kind: "failed" } });
});

test("a stopped isolated turn lands nothing but settles its books on the branch", async () => {
    const { work, worktree, worktrees } = await checkout("placed-stopped");
    const controller = new AbortController();
    const { services: s, writes } = placedServices(
        async function* () {
            await writeFile(join(worktree, "app.ts"), "line one\nthe agent's work\n");
            yield { kind: "delta", text: "working" };
            controller.abort();
            yield { kind: "error", message: "aborted by the user" };
            yield { kind: "done" };
        },
        { agentWorktrees: worktrees },
    );

    const frames = await collect(
        streamAgent(s, { prompt: "ship it", conversationId: "placed-stopped", isolated: true, autoLand: true, byPerson: true }, controller.signal),
    );

    expect(frames.slice(2)).toStrictEqual([OPENING_CHECKS_PREAMBLE, { kind: "delta", text: "working" }, { kind: "done" }]);
    expect(lands(writes)).toStrictEqual([{ name: "agent.land", attrs: { id: "placed-stopped", mode: "measure", span: "outstanding" } }]);
    expect(await gitOut(work, "status", "--porcelain")).toBe("");
    expect(await gitOut(work, "show", "--name-only", "--format=%s", "agent/placed-stopped")).toContain("app.ts");
    expect(emitted.map(({ event, outcome }) => ({ event, outcome }))).toStrictEqual([{ event: "turn.settled", outcome: "idle" }]);
});

test("a card settling mid-turn rebases the branch again, restates where it stands, and moves the span with it", async () => {
    const { work, worktree, worktrees } = await checkout("placed-resync");
    const base = await gitOut(work, "rev-parse", "HEAD");
    let moved = "";
    const { services: s } = placedServices(
        async function* (request) {
            yield { kind: "delta", text: "asked" };
            // The main line moves while the card is parked; the answer is what resyncs.
            await writeFile(join(work, "other.ts"), "someone else's work\n");
            await gitOut(work, "add", "-A");
            await gitOut(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "meanwhile");
            moved = await gitOut(work, "rev-parse", "HEAD");
            const restated = await request.hooks.resync?.();
            if (restated !== undefined) {
                yield restated;
            }
            // Nothing moved since: no frame at all.
            expect(await request.hooks.resync?.()).toBeUndefined();
            yield { kind: "done" };
        },
        { agentWorktrees: worktrees },
    );

    const frames = await collect(streamAgent(s, { prompt: "ship it", conversationId: "placed-resync", isolated: true, autoLand: false, byPerson: true }, undefined));

    expect(frames).toStrictEqual([
        { kind: "worktree", branch: "agent/placed-resync", base: base.slice(0, 7), unenforced: true },
        { kind: "checkpoint", id: "worktree:0", index: 0 },
        OPENING_CHECKS_PREAMBLE,
        { kind: "delta", text: "asked" },
        { kind: "worktree", branch: "agent/placed-resync", base: moved.slice(0, 7), unenforced: true, sync: { commits: 1, blocked: [] } },
        { kind: "done" },
    ]);
    expect(emitted).toStrictEqual([
        {
            event: "turn.settled",
            agentId: "placed-resync",
            title: "Ship it",
            branch: "agent/placed-resync",
            outcome: "idle",
            repos: [{ repo: "root", from: moved, dir: worktree }],
        },
    ]);
});
