import type { GitChange } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { chunkPaths } from "./changes-index.js";
import { DISCARDABLE_SIDES, isWholeRepo, scopedPaths, STAGEABLE_SIDES, UNSTAGEABLE_SIDES } from "./changes-target.js";

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

test("a path listed on two sides at once resolves to one entry", () => {
    const both = { conflicted: [], staged: [change("a.ts")], unstaged: [change("a.ts")] };
    expect(scopedPaths(both, DISCARDABLE_SIDES, {})).toEqual(["a.ts"]);
});

test("a scope that narrows nothing is the whole repository", () => {
    expect(isWholeRepo({})).toBe(true);
    expect(isWholeRepo({ side: "unstaged" })).toBe(false);
    expect(isWholeRepo({ origin: "agent-a" })).toBe(false);
});

test("paths are split into runs that each fit one command line, in order and losing nothing", () => {
    // 40 KiB per path; three of five exceed the ~96 KiB budget this splits on.
    const long = Array.from({ length: 5 }, (_, index) => `${index}/${"p".repeat(40 * 1024)}`);
    const chunks = chunkPaths(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(long);
    for (const chunk of chunks) {
        expect(chunk.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 1, 0)).toBeLessThanOrEqual(96 * 1024);
    }
    // An ordinary short list must stay one call, not one process per path.
    expect(chunkPaths(["a.ts", "b.ts"])).toEqual([["a.ts", "b.ts"]]);
    expect(chunkPaths([])).toEqual([]);
});

test("a single path past the budget still gets a call of its own rather than being dropped", () => {
    const huge = "x".repeat(200 * 1024);
    expect(chunkPaths([huge, "a.ts"])).toEqual([[huge], ["a.ts"]]);
});
