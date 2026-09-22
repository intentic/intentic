import type { RepoChanges } from "@intentic/api-contract";
import { describe, it, expect } from "bun:test";
import { sideTotal, truncatedOn, truncatedTotal } from "./truncation";

const repo = (truncated?: RepoChanges["truncated"]): RepoChanges => ({
    repo: `root`,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...(truncated !== undefined ? { truncated } : {}),
});

describe("what the review is not drawing", () => {
    it("reads zero for a repo that shipped whole", () => {
        expect(truncatedTotal(repo())).toBe(0);
        expect(truncatedOn(repo(), `staged`)).toBe(0);
        expect(sideTotal(repo(), `unstaged`, 12)).toBe(12);
    });

    /* THE READING THE COMMIT BOX DEPENDS ON. */
    it("adds the cut rows back to the side that lost them, and only that side", () => {
        const big = repo({ staged: 4500, unstaged: 300 });
        expect(sideTotal(big, `staged`, 500)).toBe(5000);
        expect(sideTotal(big, `unstaged`, 0)).toBe(300);
        expect(truncatedTotal(big)).toBe(4800);
    });

    // Conflicts are never cut: they block every commit in the repo, so all of them reach the user, and there is
    // no hidden remainder for the side to add back.
    it("has nothing to add back for conflicts", () => {
        expect(truncatedOn(repo({ staged: 4500, unstaged: 300 }), `conflicted`)).toBe(0);
        expect(sideTotal(repo({ staged: 4500, unstaged: 300 }), `conflicted`, 7)).toBe(7);
    });
});
