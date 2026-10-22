import type { WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import { unstubbed } from "@intentic/testing";
import { childActor } from "../../../auth/principal.js";
import type { IsolatedAgent, PersistedAgent } from "../../registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../../registry/agents-store.testing.js";
import { fakeTurns, type FakeTurns } from "../../../seams/turn-starter.testing.js";
import { type ChildNewsDeps, childLandingWords, reportChildConflict, reportChildLanded } from "../child-lands.js";

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
            conversations: { running: (id: string) => running.includes(id) },
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

describe("where a child's work went, as its parent reads it beside the report", () => {
    const ROOT = [{ repo: "root", base: "cut" }];
    const familyOf = (parent: Partial<IsolatedAgent>, child: Partial<IsolatedAgent>) => {
        const entries = new Map<string, PersistedAgent>([
            ["home-1", isolatedAgent(ROOT, { id: "home-1", ...parent })],
            ["sub-a", isolatedAgent(ROOT, { id: "sub-a", identity: { startedBy: childActor("home-1") }, landing: { diff: { files: 2, insertions: 3, deletions: 1 } }, ...child })],
        ]);
        return { entry: (id: string) => entries.get(id) };
    };

    it("tells a parent that judges its children first that the work waits for it, and how to judge and take it", () => {
        const words = childLandingWords(familyOf({ identity: { home: true } }, {}), "sub-a");
        expect(words).toContain("Its changes (2 files) wait on its branch for you");
        expect(words).toContain('freshOf: { conversationId: "sub-a", kind: "review" }');
        expect(words).toContain("agents merge sub-a");
    });

    it("says it waits again once a later turn left more on the branch after a merge", () => {
        const agents = { ...familyOf({ identity: { home: true } }, {}), standingOf: () => "ready" as const };
        const merged = agents.entry("sub-a");
        if (merged === undefined || merged.placement.kind !== "worktree") {
            throw new Error("fixture");
        }
        const again = { entry: (id: string) => (id === "sub-a" ? { ...merged, placement: { ...merged.placement, landedInto: "home-1" } } : agents.entry(id)), standingOf: agents.standingOf };
        expect(childLandingWords(again, "sub-a")).toContain("wait on its branch for you");
    });

    it("tells any other parent the work is already in its checkout", () => {
        const agents = familyOf({}, {});
        const child = agents.entry("sub-a");
        if (child === undefined || child.placement.kind !== "worktree") {
            throw new Error("fixture");
        }
        const inParent = { entry: (id: string) => (id === "sub-a" ? { ...child, placement: { ...child.placement, landedInto: "home-1" } } : agents.entry(id)) };
        expect(childLandingWords(inParent, "sub-a")).toContain("are in your checkout now");
    });
});
