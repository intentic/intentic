import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { ConversationWorktree } from "../../../agents/worktrees/worktrees.js";
import { gitOut, realCheckout, recordingLogger } from "../../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../testing.js";
import { type LandBooks, landTurn } from "./turn-landing.js";
import { placedTurn, runnerPlacement } from "./turn-placement.js";
import { type WorktreeRun, worktreePlacement, type WorktreeSteps } from "./worktree-placement.js";

// The placements over real git, for the paths a whole turn through the routes does not reach: a runner's mirror, a
// pinned workflow step, a fork that starts from its source's files, and a land whose last rebase fails.

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A real checkout, removed after the test that made it, with a conversation already begun on it.
const begun = async (id: string, change: { readonly runner?: string } = {}, extra: Parameters<typeof services>[0] = {}) => {
    const made = await realCheckout(id);
    tempDirs.push(made.root);
    const recorded = recordingTurnStores();
    const { lines, logger } = recordingLogger();
    const deps = services({ ...recorded.overrides, logger, agentWorktrees: made.worktrees, ...extra });
    await beginTurn(
        deps.conversations,
        { conversationId: id, isolated: true, prompt: "ship it", profile: { agent: "claude", harness: "native" }, byPerson: true, ...change },
        1,
    );
    const base = await gitOut(made.work, "rev-parse", "HEAD");
    // What composing the worktree records, which is what a land reads its repos from.
    await deps.agents.recordWorktree(id, [{ repo: "root", base }]);
    const composed: ConversationWorktree = {
        cwd: made.worktree,
        branch: `agent/${id}`,
        repos: [{ repo: "root", base }],
        fenced: false,
        elsewhere: [],
    };
    return { ...made, deps, writes: recorded.writes, lines, base, composed };
};

const drain = async (frames: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for await (const frame of frames) {
        out.push(frame);
    }
    return out;
};

const body = (frames: readonly AgentEvent[]) =>
    async function* (): AsyncGenerator<AgentEvent> {
        yield* frames;
    };

// The worktree's steps with the land's hand-offs recorded; `run` is what receives the worktree the turn runs in.
const stepsOf = (composed: ConversationWorktree, runs: WorktreeRun[], bases: unknown[] = []): WorktreeSteps => ({
    compose: async (base) => {
        bases.push(base);
        return composed;
    },
    versionMain: async () => [],
    run: (worktree) => {
        runs.push(worktree);
        return body([{ kind: "done" }])();
    },
    settleLanding: () => {},
    routeBreakage: async () => undefined,
});

test("a runner's mirror is announced under its runner, anchored for a rewind, and settled in `measure` after the remote turn", async () => {
    const { deps, writes, worktree, work, composed, base } = await begun("mirror", { runner: "r-1" });
    // What the runner delivered, still sitting in the mirror.
    await writeFile(join(worktree, "app.ts"), "line one\nthe runner's work\n");
    const dispatched: ConversationWorktree[] = [];
    const placement = runnerPlacement(
        deps,
        { conversationId: "mirror", snapshot: { conversationId: "mirror", index: 2 }, runner: "r-1" },
        {
            compose: async () => composed,
            dispatch: (mirror) => {
                dispatched.push(mirror);
                return body([{ kind: "delta", text: "remote" }, { kind: "done" }])();
            },
        },
    );

    const frames = await drain(placedTurn(deps.conversations, "mirror", placement));

    expect(frames).toStrictEqual([
        { kind: "worktree", branch: "agent/mirror", base: base.slice(0, 7), remote: "r-1" },
        { kind: "checkpoint", id: "worktree:2", index: 2 },
        { kind: "delta", text: "remote" },
        { kind: "done" },
    ]);
    expect(dispatched).toStrictEqual([composed]);
    const anchor = await gitOut(worktree, "rev-parse", "HEAD");
    expect(writes.checkpoints).toStrictEqual([
        { conversationId: "mirror", index: 2, checkpoint: { kind: "worktree", repos: [{ repo: "root", base: anchor }] } },
    ]);
    expect(await gitOut(worktree, "log", "-1", "--format=%s")).toBe("Agent: before this turn");
    expect(writes.spans.filter(({ name }) => name === "agent.land")).toStrictEqual([
        { name: "agent.land", attrs: { id: "mirror", mode: "measure", span: "outstanding" } },
    ]);
    expect(await gitOut(work, "status", "--porcelain")).toBe("");
});

test("a pinned workflow step runs on its run's snapshot, and is never rebased onto the main line", async () => {
    const { deps, writes, work, composed, base } = await begun("pinned");
    // The main line moves; the step must not follow it.
    await writeFile(join(work, "other.ts"), "someone else's work\n");
    await gitOut(work, "add", "-A");
    await gitOut(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "meanwhile");
    const runs: WorktreeRun[] = [];
    const bases: unknown[] = [];
    const emitted: WorkspaceEvent[] = [];
    deps.events.subscribe("workspace", (event) => void emitted.push(event));
    const snapshot = [{ repo: "root", base }];
    const placement = worktreePlacement(
        deps,
        {
            input: { prompt: "step", conversationId: "pinned", worktreeBase: snapshot, autoLand: false },
            conversationId: "pinned",
            snapshot: { conversationId: "pinned", index: 0 },
            signal: undefined,
        },
        stepsOf(composed, runs, bases),
    );

    const frames = await drain(placedTurn(deps.conversations, "pinned", placement));

    expect(bases).toStrictEqual([snapshot]);
    expect(frames[0]).toStrictEqual({ kind: "worktree", branch: "agent/pinned", base: base.slice(0, 7), unenforced: true });
    expect(runs.map(({ id, cwd, fenced, synced }) => ({ id, cwd, fenced, synced }))).toStrictEqual([
        { id: "pinned", cwd: composed.cwd, fenced: false, synced: [] },
    ]);
    expect(await runs[0]?.resync()).toBeUndefined();
    expect(writes.spans.filter(({ name }) => name === "agent.sync")).toStrictEqual([]);
    expect(emitted).toStrictEqual([
        {
            event: "turn.settled",
            agentId: "pinned",
            title: "Ship it",
            branch: "agent/pinned",
            outcome: "idle",
            repos: [{ repo: "root", from: base, dir: composed.cwd }],
        },
    ]);
});

test("a fork wanting its source's files composes from the source's own anchored commits", async () => {
    const source = [{ repo: "root", base: "d".repeat(40) }];
    const { turnCheckpoints } = services(recordingTurnStores().overrides);
    const { deps, composed } = await begun(
        "forked",
        {},
        {
            turnCheckpoints: {
                ...turnCheckpoints,
                of: async (id: string, index: number) => (id === "source" && index === 3 ? { kind: "worktree" as const, repos: source } : undefined),
            },
        },
    );
    const bases: unknown[] = [];
    const placement = worktreePlacement(
        deps,
        {
            input: { prompt: "again", conversationId: "forked", forkOf: { conversationId: "source", keep: 3, files: "then" }, autoLand: false },
            conversationId: "forked",
            snapshot: { conversationId: "forked", index: 0 },
            signal: undefined,
        },
        stepsOf(composed, [], bases),
    );

    await drain(placedTurn(deps.conversations, "forked", placement));

    expect(bases).toStrictEqual([source]);
});

test("a worktree that never came up settles nothing and says nothing, and the failure is the turn's", async () => {
    const { deps, composed } = await begun("never");
    const emitted: WorkspaceEvent[] = [];
    deps.events.subscribe("workspace", (event) => void emitted.push(event));
    const placement = worktreePlacement(
        deps,
        {
            input: { prompt: "p", conversationId: "never" },
            conversationId: "never",
            snapshot: { conversationId: "never", index: 0 },
            signal: undefined,
        },
        {
            ...stepsOf(composed, []),
            compose: async () => {
                throw new Error("no such repo");
            },
        },
    );

    await expect(drain(placedTurn(deps.conversations, "never", placement))).rejects.toThrow("no such repo");
    expect(emitted).toStrictEqual([]);
    expect(deps.agents.entry("never")).toMatchObject({ ending: { kind: "failed", failure: "no such repo" } });
});

test("a land whose last rebase fails still lands, on the old base, and says why", async () => {
    const { deps, lines, worktree, writes } = await begun("stale");
    await writeFile(join(worktree, "app.ts"), "line one\nthe agent's work\n");
    const books: LandBooks = { span: [{ repo: "root", from: "a", dir: worktree }], branch: "agent/stale", outcome: undefined, reconciled: false };
    const turn = {
        conversationId: "stale",
        prompt: "ship it",
        autoLand: false,
        failed: false,
        aborted: false,
        sync: async () => {
            throw new Error("rebase refused");
        },
    };

    const frames = await drain(landTurn(deps, { settleLanding: () => {}, routeBreakage: async () => undefined }, turn, books));

    expect(frames).toStrictEqual([{ kind: "landed", landed: false, held: true }]);
    expect(books).toMatchObject({ reconciled: true, outcome: "ready" });
    expect(
        lines.filter(({ message }) => message === "agents: pre-land sync failed, landing on the old base").map(({ level, id }) => ({ level, id })),
    ).toStrictEqual([{ level: "warn", id: "stale" }]);
    expect(writes.spans.filter(({ name }) => name === "agent.land")).toStrictEqual([
        { name: "agent.land", attrs: { id: "stale", mode: "measure", span: "outstanding" } },
    ]);
});
