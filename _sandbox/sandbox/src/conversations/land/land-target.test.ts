import { childActor } from "../../auth/principal.js";
import { childLandingWords } from "../../agent/subagents/child-lands.js";
import { conversationEntry, isolatedAgent } from "../../testing.js";
import type { IsolatedAgent, PersistedAgent } from "../registry/agents-store.js";
import { type LandTarget, landTargetOf, recordedTargetOf, upstreamOf } from "./land-target.js";

// Pins where a conversation's finished work goes: the main tree under the rules for one of its own, and for a spawned
// child its parent's own checkout, as the parent's in-process subagents' edits go there, while the parent can take it;
// and what the parent is told of it.

const ROOT = [{ repo: "root", base: "b0" }];

// A parent working in a checkout of its own, here, carrying root.
const parent = (over: Partial<IsolatedAgent> = {}): IsolatedAgent => isolatedAgent(ROOT, { id: "p1", ...over });
const child = (over: Partial<IsolatedAgent> = {}): IsolatedAgent => isolatedAgent(ROOT, { id: "c1", identity: { startedBy: childActor("p1") }, ...over });
const registry = (...entries: PersistedAgent[]) => ({ entry: (id: string) => entries.find((entry) => entry.id === id) });
const attachedAll = { attached: async () => true };

describe("where a conversation's work goes", () => {
    it("lands one of its own in the main tree, under the rules", async () => {
        expect(await landTargetOf({ agents: registry(), agentWorktrees: attachedAll }, isolatedAgent(ROOT))).toEqual({ kind: "main", ruled: true });
    });

    it("sends a spawned child's into its parent's checkout", async () => {
        expect(await landTargetOf({ agents: registry(parent()), agentWorktrees: attachedAll }, child())).toEqual({ kind: "parent", parent: "p1" });
    });

    it("sends a child of a parent working in the main tree there, with no rule to ask", async () => {
        const inMain = conversationEntry({ id: "p1" });
        expect(await landTargetOf({ agents: registry(inMain), agentWorktrees: attachedAll }, child())).toEqual({ kind: "main", ruled: false });
    });

    it("leaves a child to land as any conversation does where its parent cannot take it", async () => {
        const own: LandTarget = { kind: "main", ruled: true };
        const deps = (...entries: PersistedAgent[]) => ({ agents: registry(...entries), agentWorktrees: attachedAll });
        expect(await landTargetOf(deps(), child())).toEqual(own);
        expect(await landTargetOf(deps(parent({ archivedAt: 5 })), child())).toEqual(own);
        expect(await landTargetOf(deps(parent({ placement: { kind: "worktree", branch: "agent/p1", runner: "rog", repos: ROOT } })), child())).toEqual(own);
        const nested = child({ placement: { kind: "worktree", branch: "agent/c1", repos: [...ROOT, { repo: "api", base: "b1" }] } });
        expect(await landTargetOf(deps(parent()), nested)).toEqual(own);
        // The registry alone still counts a checkout git no longer has attached.
        const detached = { agents: registry(parent()), agentWorktrees: { attached: async () => false } };
        expect([recordedTargetOf(detached.agents, child()), await landTargetOf(detached, child())]).toEqual([{ kind: "parent", parent: "p1" }, own]);
    });
});

describe("what a child's branch follows", () => {
    const cut = child({ placement: { kind: "worktree", branch: "agent/c1", repos: ROOT, parent: "p1" } });

    it("follows the parent it was cut from while that parent takes its work, and stays put once it cannot", () => {
        expect(upstreamOf(cut, { kind: "parent", parent: "p1" })).toEqual({ kind: "parent", parent: "p1" });
        expect(upstreamOf(cut, { kind: "main", ruled: true })).toEqual({ kind: "none" });
    });

    it("follows the main line for a branch cut from it, whoever takes its work", () => {
        expect(upstreamOf(child(), { kind: "parent", parent: "p1" })).toEqual({ kind: "main" });
        expect(upstreamOf(isolatedAgent(ROOT), { kind: "main", ruled: true })).toEqual({ kind: "main" });
    });
});

describe("what a parent is told of its child's work", () => {
    const landedInto = (over: Partial<IsolatedAgent> = {}): IsolatedAgent =>
        child({ placement: { kind: "worktree", branch: "agent/c1", repos: ROOT, parent: "p1", landedInto: "p1" }, landing: { diff: { files: 2, insertions: 5, deletions: 1 } }, ...over });

    it("says its changes are in the parent's checkout now", () => {
        expect(childLandingWords(registry(parent(), landedInto()), "c1")).toBe(
            "Its changes (2 files) are in your checkout now, uncommitted, as an in-process subagent's edits would be: read them there before you build on them.",
        );
    });

    it("names the clash and the door that brings the work in", () => {
        const held = landedInto({
            placement: { kind: "worktree", branch: "agent/c1", repos: ROOT, parent: "p1" },
            landing: { conflicts: [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 1 }, { repo: "api", paths: [{ path: "src/a.ts", reason: "diverged" }], clean: 0 }] },
        });
        expect(childLandingWords(registry(parent(), held), "c1")).toBe(
            "Its changes clash with the edits in your checkout on `app.ts`, `api/src/a.ts`, so nothing of them was written there: they wait on its branch. Bring them in with conflict markers to resolve yourself (the merge tool, or `agents merge c1` from a shell), or leave them.",
        );
    });

    it("says nothing for a child whose work lands as any conversation's does, or that left none", () => {
        expect(childLandingWords(registry(landedInto()), "c1")).toBeUndefined();
        expect(childLandingWords(registry(parent(), landedInto({ landing: { diff: { files: 0, insertions: 0, deletions: 0 } } })), "c1")).toBeUndefined();
        expect(childLandingWords(registry(parent()), "nobody")).toBeUndefined();
    });
});
