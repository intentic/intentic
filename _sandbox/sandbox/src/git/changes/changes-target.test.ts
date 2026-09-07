import type { GitChange } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { chunkPaths } from "./changes-index.js";
import { DISCARDABLE_SIDES, isWholeRepo, scopedPaths, STAGEABLE_SIDES, UNSTAGEABLE_SIDES } from "./changes-target.js";

const change = (path: string, extra: Partial<GitChange> = {}): GitChange => ({ path, status: "modified", ...extra });

// The shape a scan produces, small enough to read and wide enough to have something on every side.
const sides = {
    conflicted: [change("merge.ts", { status: "conflicted" })],
    staged: [change("staged.ts"), change("moved.ts", { status: "renamed", from: "old.ts" })],
    unstaged: [change("edited.ts"), change("new.ts", { status: "added" })],
};

test("a scope with no side reads every side the verb can move, and no others", () => {
    // Staging moves a path INTO the index, so it reads the two sides that are not in it yet. The staged side is
    // deliberately absent: re-adding it would sweep in worktree edits made after the user froze that content.
    expect(scopedPaths(sides, STAGEABLE_SIDES, {})).toEqual(["edited.ts", "new.ts", "merge.ts"]);
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, {})).toEqual(["staged.ts", "moved.ts", "old.ts"]);
    expect(scopedPaths(sides, DISCARDABLE_SIDES, {})).toEqual(["merge.ts", "staged.ts", "moved.ts", "old.ts", "edited.ts", "new.ts"]);
});

test("a scope narrows the verb's sides and can never widen them", () => {
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "unstaged" })).toEqual(["edited.ts", "new.ts"]);
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "conflicted" })).toEqual(["merge.ts"]);
    // Asking to stage the staged side is empty rather than everything: the honest answer to a request for the
    // one side this verb cannot move.
    expect(scopedPaths(sides, STAGEABLE_SIDES, { side: "staged" })).toEqual([]);
});

test("both legs of a rename resolve together, so no verb acts on half a move", () => {
    // Unstage only the new name and the index still records the old one as deleted: a move that never happened.
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, { side: "staged" })).toContain("old.ts");
});

test("an origin scope keeps only what that conversation landed, either leg of a rename counting", () => {
    const origins = { "edited.ts": ["agent-a"], "new.ts": ["agent-b"], "old.ts": ["agent-a"] };
    expect(scopedPaths(sides, STAGEABLE_SIDES, { origin: "agent-a" }, origins)).toEqual(["edited.ts"]);
    // `moved.ts` is attributed through the path it came FROM, which is the leg the land recorded.
    expect(scopedPaths(sides, UNSTAGEABLE_SIDES, { origin: "agent-a" }, origins)).toEqual(["moved.ts", "old.ts"]);
    // A side and an origin compose: the intersection, not either one on its own.
    expect(scopedPaths(sides, DISCARDABLE_SIDES, { side: "unstaged", origin: "agent-b" }, origins)).toEqual(["new.ts"]);
    // No attribution at all resolves to nothing, rather than falling back to everyone's work.
    expect(scopedPaths(sides, STAGEABLE_SIDES, { origin: "agent-a" })).toEqual([]);
});

test("a path listed on two sides at once resolves to one entry", () => {
    const both = { conflicted: [], staged: [change("a.ts")], unstaged: [change("a.ts")] };
    expect(scopedPaths(both, DISCARDABLE_SIDES, {})).toEqual(["a.ts"]);
});

// The two verbs with a single-command spelling for the whole repo (`git add -A`, `reset --hard` + `clean`) ask
// this before they build any list at all, which is what keeps the panel's biggest buttons flat in cost.
test("a scope that narrows nothing is the whole repository", () => {
    expect(isWholeRepo({})).toBe(true);
    expect(isWholeRepo({ side: "unstaged" })).toBe(false);
    expect(isWholeRepo({ origin: "agent-a" })).toBe(false);
});

test("paths are split into runs that each fit one command line, in order and losing nothing", () => {
    // 40 KiB per path, so three of them exceed the ~96 KiB slice this splits on.
    const long = Array.from({ length: 5 }, (_, index) => `${index}/${"p".repeat(40 * 1024)}`);
    const chunks = chunkPaths(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(long);
    // Every chunk is small enough to hand to one spawn, which is the property the split exists for: without it
    // a repository with tens of thousands of pending paths fails the verb outright with E2BIG.
    for (const chunk of chunks) {
        expect(chunk.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 1, 0)).toBeLessThanOrEqual(96 * 1024);
    }
    // An ordinary list is one call: the split must not cost a process per path.
    expect(chunkPaths(["a.ts", "b.ts"])).toEqual([["a.ts", "b.ts"]]);
    expect(chunkPaths([])).toEqual([]);
});

test("a single path past the budget still gets a call of its own rather than being dropped", () => {
    // The per-argument limit is separate and far higher than the whole-argv one, so this works; silently
    // skipping the file would be the one outcome worse than a failed spawn.
    const huge = "x".repeat(200 * 1024);
    expect(chunkPaths([huge, "a.ts"])).toEqual([[huge], ["a.ts"]]);
});
