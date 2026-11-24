import { RUNNER_CAPABILITIES, type RunnerHeldTurn, type RunnerSync, type RunnerSyncLine } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { unstubbed } from "@intentic/testing";
import pino from "pino";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { moveConversationHere, type MoveHereDeps } from "./move-here.js";

// zipper-a6t4 (2026-11-24) was a new conversation told to "pick up the work of" ginger-v2nz, whose runner had stopped
// taking its turns: it found the work on the runner's disk by hand. The conversation itself now comes home, its work
// first, and nothing moves while any of that work would stay behind.

const placement = { kind: "worktree" as const, branch: "agent/c1", runner: "omen", repos: [{ repo: "intentic", base: "abc" }] };

const fakeServices = (options: { online?: boolean; held?: RunnerHeldTurn; push?: readonly RunnerSyncLine[]; capabilities?: readonly string[] } = {}) => {
    const pushes: RunnerSync[] = [];
    const placed: string[] = [];
    const sent: unknown[] = [];
    const rows: TranscriptRow[] = [];
    const client = {
        heldTurn: async () => options.held ?? { state: "none" as const, events: 0, acked: 0 },
        syncWorkspace: async (sync: RunnerSync) => {
            pushes.push(sync);
            return (async function* () {
                yield* options.push ?? [{ kind: "done" as const, ok: true }];
            })();
        },
    };
    const services: MoveHereDeps = {
        entry: () => unstubbed<PersistedAgent>("entry", { id: "c1", placement }),
        placeHere: async (id) => void placed.push(id),
        runnerHub: {
            client: () => (options.online === false ? undefined : client),
            state: () => ({ online: true, announced: { version: "1.431.0", image: "dev", capabilities: [...(options.capabilities ?? RUNNER_CAPABILITIES)] } }),
        },
        logger: pino({ level: "silent" }),
        // Git on a path that is not a repository fails, which the mirror's advance reads as nothing to move.
        agentWorktrees: { mainDir: () => "/nowhere", worktreeDir: () => "/nowhere" },
        withRewindLease: async (_id, work) => await work(),
        clearSession: async () => void sent.push({ kind: "session-cleared" }),
        note: async (_id, appended) => void rows.push(...appended),
    };
    return { services, pushes, placed, sent, rows };
};

test("a runner conversation comes here with its work: pushed, taken off the runner, its session let go, said in its record", async () => {
    const rescue: RunnerSyncLine = {
        kind: "line",
        text: "intentic: sent home",
        work: { kind: "rescue", repo: "intentic", sha: "b".repeat(40), base: "c".repeat(40), files: 194, at: 1795555026774 },
    };
    const { services, pushes, placed, sent, rows } = fakeServices({ push: [rescue, { kind: "done", ok: true }] });

    await expect(moveConversationHere(services, "c1")).resolves.toEqual({ from: "omen" });

    expect(pushes).toEqual([{ op: "push", conversationId: "c1", branch: "agent/c1", repos: [{ repo: "intentic", dir: "intentic", mainBranch: "main" }] }]);
    expect(placed).toEqual(["c1"]);
    expect(sent).toEqual([{ kind: "session-cleared" }]);
    expect(rows.map((row) => row.text)).toEqual([expect.stringContaining('Moved here from the runner "omen"'), expect.stringContaining(`commit ${"b".repeat(12)}`)]);
});

test("a runner out of reach keeps its conversation: nothing moves", async () => {
    const { services, placed } = fakeServices({ online: false });
    await expect(moveConversationHere(services, "c1")).rejects.toThrow(/offline/);
    expect(placed).toEqual([]);
});

test("a turn still running there, or one not shown here yet, keeps the conversation where it is and pushes nothing", async () => {
    for (const held of [
        { state: "live", events: 3, acked: 3 },
        { state: "finished", events: 5, acked: 2 },
    ] as const) {
        const { services, pushes, placed } = fakeServices({ held });
        await expect(moveConversationHere(services, "c1")).rejects.toThrow(/runner "omen"/);
        expect(pushes).toEqual([]);
        expect(placed).toEqual([]);
    }
});

test("a push that fails keeps the conversation on its runner, saying why", async () => {
    const { services, placed } = fakeServices({ push: [{ kind: "done", ok: false, detail: "the parent refused the push" }] });
    await expect(moveConversationHere(services, "c1")).rejects.toThrow(/the parent refused the push/);
    expect(placed).toEqual([]);
});

test("from a runner on an older build it still moves, and says what such a build leaves on the runner", async () => {
    const { services, placed, rows } = fakeServices({ capabilities: [] });
    await moveConversationHere(services, "c1");
    expect(placed).toEqual(["c1"]);
    expect(rows[0]?.text).toContain("left uncommitted there is still on it");
    expect(rows[0]?.agentNotice?.level).toBe("warning");
});
