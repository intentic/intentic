import type { GitChange } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { capRepoChanges, MAX_REPO_CHANGES } from "./git.routes.js";

const changes = (count: number, prefix: string): GitChange[] =>
    Array.from({ length: count }, (_, index) => ({ path: `${prefix}/${index}.ts`, status: "modified" as const }));

test("a repo under the budget ships whole, lists untouched", () => {
    const conflicted = changes(3, "c");
    const staged = changes(10, "s");
    const unstaged = changes(20, "u");
    const capped = capRepoChanges(conflicted, staged, unstaged);
    expect(capped.conflicted).toBe(conflicted);
    expect(capped.staged).toBe(staged);
    expect(capped.unstaged).toBe(unstaged);
    expect(capped.truncated).toBe(0);
});

test("past the budget, staged fills before unstaged and truncated carries the remainder", () => {
    const staged = changes(MAX_REPO_CHANGES - 100, "s");
    const unstaged = changes(5000, "u");
    const capped = capRepoChanges([], staged, unstaged);
    expect(capped.staged).toHaveLength(MAX_REPO_CHANGES - 100);
    expect(capped.unstaged).toHaveLength(100);
    expect(capped.truncated).toBe(4900);
});

test("a mass delete ships the first budget-worth of rows and counts the rest", () => {
    const unstaged = changes(30_000, "u");
    const capped = capRepoChanges([], [], unstaged);
    expect(capped.unstaged).toHaveLength(MAX_REPO_CHANGES);
    expect(capped.truncated).toBe(30_000 - MAX_REPO_CHANGES);
});

test("conflicts are never cut, even past the budget on their own", () => {
    const conflicted = changes(MAX_REPO_CHANGES + 50, "c");
    const capped = capRepoChanges(conflicted, changes(10, "s"), changes(10, "u"));
    expect(capped.conflicted).toHaveLength(MAX_REPO_CHANGES + 50);
    expect(capped.staged).toHaveLength(0);
    expect(capped.unstaged).toHaveLength(0);
    expect(capped.truncated).toBe(20);
});
