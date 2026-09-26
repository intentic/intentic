import type { MainlineRouting, WorkspaceEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { childActor } from "../../auth/principal.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { conversationEntry, fakeTurns, type FakeTurns } from "../../testing.js";
import { type ChildNewsDeps, reportChildConflict, reportChildLanded, reportChildrenRed, resetChildNews, routedWords } from "./child-lands.js";

// A child's land, conflict or red is its parent's news while the parent supervises, and nobody else's.

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

beforeEach(() => resetChildNews());

describe("a child's land, told to its parent", () => {
    it("says into a supervising parent's turn which child landed where, and that a red on it is routed without it", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildLanded(world.deps, landed("sub-a"));
        expect(world.steers).toEqual([
            {
                voice: "sandbox",
                text:
                    'Your child agent `sub-a` ("Land-check queue") landed in the main tree (`intentic`). The main tree\'s own check runs on it next. ' +
                    "If that goes red on this land you are told where its failures were sent, so leave them to that instead of relaying them yourself.",
            },
        ]);
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
            'The owner pressed Land on your child agent `sub-a` ("Land-check queue"), and it hit a merge conflict on `intentic/a.ts`, `intentic/b.ts`, ' +
                "`intentic/c.ts`, `intentic/d.ts`, `intentic/e.ts` and 1 more: nothing of it reached the main tree. It lands once its branch is rebased onto the " +
                "main line and the conflicts are resolved. The owner can have it do that from its card, or you can tell it to; a message you send while another " +
                "turn runs on it waits for that turn to end.",
        ]);
    });
});

describe("a red land check on a child's work, told to its parent", () => {
    const red = { project: "intentic", redSince: 1_000, fresh: ["daemon-boundaries", "tidy silent-catch: auth/grants.ts", "lint prefer-template", "test x"] };
    const sentBack: MainlineRouting = { kind: "original", conversationId: "sub-a", at: 2_000, detail: "Sent back to the conversation that landed it (1 of 2)." };

    it("says once per parent which children, a few failures, and where they went", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildrenRed(world.deps, red, ["sub-a", "sub-b", "by-hand"], { kind: "fix-up", conversationId: "land-fix-intentic-x", at: 2_000 });
        expect(world.steers.map(({ text }) => text)).toEqual([
            'The main tree\'s own check in `intentic` went red after work from your child agents `sub-a` ("Land-check queue"), `sub-b` ("OOM kill priority") ' +
                "landed: 4 new failures, such as `daemon-boundaries`, `tidy silent-catch: auth/grants.ts`, `lint prefer-template` and 1 more. They were handed to " +
                "a fresh conversation, `land-fix-intentic-x`, which fixes them in a worktree of its own. Leave them to that instead of relaying them yourself.",
        ]);
    });

    it("tells a decision once, however many runs of the streak route it again", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildrenRed(world.deps, red, ["sub-a"], sentBack);
        await reportChildrenRed(world.deps, red, ["sub-a"], { ...sentBack, at: 3_000 });
        expect(world.steers).toHaveLength(1);
    });

    it("says nothing for a red that waits on the next check, and nothing to a parent no longer supervising", async () => {
        const world = worldOf(["orchestrator"]);
        await reportChildrenRed(world.deps, red, ["sub-a"], { kind: "waiting", at: 2_000 });
        const idle = worldOf([]);
        await reportChildrenRed(idle.deps, red, ["sub-a"], sentBack);
        expect([...world.steers, ...idle.steers, ...idle.started]).toEqual([]);
    });
});

describe("where a red went, in the parent's words", () => {
    it("hands off what somebody else now owns, and hands back what nobody does", () => {
        expect(routedWords({ kind: "held", at: 1, detail: "A conversation still working touches what failed; nothing else starts until it stops." })).toBe(
            "Nobody is sent yet: a conversation still working touches what failed; nothing else starts until it stops. Leave them to that instead of relaying them yourself.",
        );
        expect(routedWords({ kind: "reported", at: 1, detail: "Repairs after landing are switched off." })).toBe(
            "Nobody was sent: repairs after landing are switched off. Fixing it is for you or the owner to arrange.",
        );
        expect(routedWords({ kind: "spent", at: 1, detail: "Still red after 2 fresh attempt(s); it waits for you." })).toBe(
            "Nobody more is sent: still red after 2 fresh attempt(s); it waits for you. Fixing it is for you or the owner to arrange.",
        );
        expect(routedWords({ kind: "resolved", at: 1 })).toBeUndefined();
    });
});
