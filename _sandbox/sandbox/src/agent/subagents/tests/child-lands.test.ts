import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { childActor } from "../../../auth/principal.js";
import type { PersistedAgent } from "../../../conversations/registry/agents-store.js";
import { conversationEntry, fakeTurns, type FakeTurns } from "../../../testing.js";
import { type ChildNewsDeps, reportChildConflict, reportChildLanded } from "../child-lands.js";

// A child's land or conflict is its parent's news while the parent supervises, and nobody else's.

interface World extends FakeTurns {
    readonly deps: ChildNewsDeps;
}

// `running` names the conversations with a live turn; every entry is the parent's or one of its children's.
const worldOf = (running: readonly string[], over: { readonly orchestrator?: Partial<PersistedAgent> } = {}): World => {
    const entries = new Map<string, PersistedAgent>([
        ["orchestrator", conversationEntry({ id: "orchestrator", ...over.orchestrator })],
        [
            "sub-a",
            conversationEntry({
                id: "sub-a",
                identity: { startedBy: childActor("orchestrator") },
                social: { title: { text: "Land-check queue", source: "derived" }, reactions: [] },
            }),
        ],
        [
            "sub-b",
            conversationEntry({
                id: "sub-b",
                identity: { startedBy: childActor("orchestrator") },
                social: { title: { text: "OOM kill priority", source: "derived" }, reactions: [] },
            }),
        ],
        ["by-hand", conversationEntry({ id: "by-hand", identity: { startedBy: "owner@example.com" } })],
    ]);
    const turns = fakeTurns({ live: true });
    return Object.assign(turns, {
        deps: {
            agents: { entry: (id: string) => entries.get(id) },
            conversations: { running: (id: string) => running.includes(id), sessionIdOf: () => "orchestrator-session" },
            turns: turns.turns,
            logger: unstubbed<ChildNewsDeps["logger"]>("logger", { info: () => {}, warn: () => {} }),
        },
    });
};

const landed = (agentId: string, outcome: WorkspaceEvent["outcome"] = "landed"): WorkspaceEvent => ({
    event: "agent.landed",
    agentId,
    branch: `agent/${agentId}`,
    outcome,
    repos: [{ repo: "intentic", from: "abc", dir: `/history/worktrees/${agentId}/intentic` }],
});

describe("a child's land, told to its parent", () => {
    it("says into a supervising parent's turn which child landed where", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildLanded(world.deps, landed("sub-a"));
        expect(world.steers).toEqual([{ voice: "sandbox", text: 'Your subagent `sub-a` ("Land-check queue") landed in the main tree (`intentic`).' }]);
    });

    it("wakes nobody whose supervising is over, nor for a conversation a person started", async () => {
        const idle = worldOf([]);
        await reportChildLanded(idle.deps, landed("sub-a"));
        const byHand = worldOf(["orchestrator"]);
        await reportChildLanded(byHand.deps, landed("by-hand"));
        expect([...idle.steers, ...idle.started, ...byHand.steers, ...byHand.started]).toEqual([]);
    });

    it("reads only a land that reached the tree", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildLanded(world.deps, landed("sub-a", "conflict"));
        await reportChildLanded(world.deps, { ...landed("sub-a"), event: "turn.settled" });
        expect(world.steers).toEqual([]);
    });

    it("tells a parent filed away nothing", async () => {
        const world = worldOf(["orchestrator"], { orchestrator: { archivedAt: 1 } });
        await reportChildLanded(world.deps, landed("sub-a"));
        expect(world.steers).toEqual([]);
    });
});

describe("a conflicted press of Land, told to the child's parent", () => {
    it("names the files, says nothing reached the tree, and how it lands", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildConflict(world.deps, "sub-a", ["intentic/a.ts", "intentic/b.ts", "intentic/c.ts", "intentic/d.ts", "intentic/e.ts", "intentic/f.ts"]);
        expect(world.steers.map(({ text }) => text)).toEqual([
            'The owner pressed Land on your subagent `sub-a` ("Land-check queue"), and it hit a merge conflict on `intentic/a.ts`, `intentic/b.ts`, ' +
                "`intentic/c.ts`, `intentic/d.ts`, `intentic/e.ts` and 1 more: nothing of it reached the main tree. It lands once its branch is rebased onto the " +
                "main line and the conflicts are resolved. The owner can have it do that from its card, or you can tell it to; a message you send while another " +
                "turn runs on it waits for that turn to end.",
        ]);
    });
});
