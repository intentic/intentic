import { type GitChange, UNATTRIBUTED_ORIGIN } from "./git.js";
import { changeIsFrom, DISCARDABLE_SIDES, discardOutcome, isWholeRepo, scopedPaths, STAGEABLE_SIDES, UNSTAGEABLE_SIDES } from "./git-scope.js";

const change = (path: string, extra: Partial<GitChange> = {}): GitChange => ({ path, status: "modified", ...extra });

// Shape a scan produces: small enough to read, with something on every side.
const sides = {
    conflicted: [change("merge.ts", { status: "conflicted" })],
    staged: [change("staged.ts"), change("moved.ts", { status: "renamed", from: "old.ts" })],
    unstaged: [change("edited.ts"), change("new.ts", { status: "added" })],
};

test("a scope with no side reads every side the verb can move, and no others", () => {
    // Staged is deliberately absent from stageable: re-adding it would sweep in worktree edits made after the freeze.
    expect(scopedPaths(sides, STAGEABLE_SIDES, {})).toEqual(["edited.ts", "new.ts", "merge.ts"]);
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, {})).toEqual(["staged.ts", "moved.ts", "old.ts"]);
    expect(scopedPaths(sides, DISCARDABLE_SIDES, {})).toEqual(["merge.ts", "staged.ts", "moved.ts", "old.ts", "edited.ts", "new.ts"]);
});

test("a scope narrows the verb's sides and can never widen them", () => {
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "unstaged" })).toEqual(["edited.ts", "new.ts"]);
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "conflicted" })).toEqual(["merge.ts"]);
    // Staging the one side it can't move answers empty, not everything: the honest answer to an impossible request.
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "staged" })).toEqual([]);
});

test("both legs of a rename resolve together, so no verb acts on half a move", () => {
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, { side: "staged" })).toContain("old.ts");
});

test("an origin scope keeps only what that conversation landed, either leg of a rename counting", () => {
    const origins = { "edited.ts": ["agent-a"], "new.ts": ["agent-b"], "old.ts": ["agent-a"] };
    expect(scopedPaths(sides, STAGEABLE_SIDES, { origin: "agent-a" }, origins)).toEqual(["edited.ts"]);
    // `moved.ts` attributes through the path it came from, the leg the land recorded.
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, { origin: "agent-a" }, origins)).toEqual(["moved.ts", "old.ts"]);
    // A side and an origin compose as an intersection, not either alone.
    expect(scopedPaths(sides, DISCARDABLE_SIDES, { side: "unstaged", origin: "agent-b" }, origins)).toEqual(["new.ts"]);
    // No matching attribution resolves to nothing, not a fallback to everyone's work.
    expect(scopedPaths(sides, STAGEABLE_SIDES, { origin: "agent-a" })).toEqual([]);
});

// The Changes panel's "You" chip sends this; it used to resolve to nothing, so its Stage all, Discard and commit
// each moved no file at all.
test("the unattributed origin keeps exactly what no conversation landed, a rename counting only when neither leg was", () => {
    const origins = { "edited.ts": ["agent-a"], "old.ts": ["agent-a"] };
    expect(scopedPaths(sides, STAGEABLE_SIDES, { origin: UNATTRIBUTED_ORIGIN }, origins)).toEqual(["new.ts", "merge.ts"]);
    // `moved.ts` came from a landed path, so it is the agent's work, not the owner's.
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, { origin: UNATTRIBUTED_ORIGIN }, origins)).toEqual(["staged.ts"]);
    // With nothing attributed, every row is the owner's.
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "unstaged", origin: UNATTRIBUTED_ORIGIN })).toEqual(["edited.ts", "new.ts"]);
});

test("a path listed on two sides at once resolves to one entry", () => {
    const both = { conflicted: [], staged: [change("a.ts")], unstaged: [change("a.ts")] };
    expect(scopedPaths(both, DISCARDABLE_SIDES, {})).toEqual(["a.ts"]);
});

test("a scope that narrows nothing is the whole repository", () => {
    expect(isWholeRepo({})).toBe(true);
    expect(isWholeRepo({ side: "unstaged" })).toBe(false);
    expect(isWholeRepo({ origin: "agent-a" })).toBe(false);
});

// The panel's count, its discard question and the daemon's scope all read this one predicate, so a rename out of an
// agent's file cannot be "yours" in the question and the agent's in the action.
test("a row is an origin's when either leg was landed by it, and the owner's only when neither was", () => {
    const origins = { "util.ts": ["agent-a"] };
    const renamed = change("helpers.ts", { status: "renamed", from: "util.ts" });
    expect(changeIsFrom(renamed, "agent-a", origins)).toBe(true);
    expect(changeIsFrom(renamed, UNATTRIBUTED_ORIGIN, origins)).toBe(false);
    expect(changeIsFrom(change("mine.ts"), UNATTRIBUTED_ORIGIN, origins)).toBe(true);
    expect(changeIsFrom(change("mine.ts"), "agent-a", origins)).toBe(false);
});

test("a discard names what leaves the disk apart from what returns to its last commit", () => {
    const changed = {
        conflicted: [],
        staged: [
            change("helpers.ts", { status: "renamed", from: "util.ts" }),
            change("fresh.ts", { status: "added" }),
            change("gone.ts", { status: "deleted" }),
        ],
        // `gone.ts` deleted in the index and recreated on disk reads untracked, yet the last commit still holds it.
        unstaged: [change("edited.ts"), change("scratch.ts", { status: "added" }), change("gone.ts", { status: "added" })],
    };
    const paths = scopedPaths(changed, DISCARDABLE_SIDES, {});
    expect(discardOutcome(changed, paths)).toEqual({
        deletes: ["helpers.ts", "fresh.ts", "scratch.ts"],
        restores: ["util.ts", "gone.ts", "edited.ts"],
    });
});
