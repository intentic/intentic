import { describe, expect, it, vi } from "vitest";

// `of()` and `ofSandbox()` must produce the same key shape, since sandboxQueryPredicate finds a box's entries by
// reading the id off the last position. The scoping rule is mocked to a fixed id so keys can be spelled out in full.
vi.mock("../features/sandbox/overview/activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-here`] }));

const { AGENT_DIFF, AGENTS, GIT_CHANGES } = await import("./queryKeys");
const { sandboxQueryPredicate } = await import("../features/sandbox/live/systemEventRouting");

describe("ofSandbox", () => {
    it("puts the named box where sandboxKey puts the active one: last", () => {
        expect(AGENTS.of()).toEqual([`agents`, `sbx-here`]);
        expect(AGENTS.ofSandbox(`sbx-laptop`)).toEqual([`agents`, `sbx-laptop`]);
    });

    // A variant lands before the id in both, so a diff in one box is its own entry, not a prefix-match collision.
    it("keeps a variant ahead of the id, exactly as of() does", () => {
        expect(AGENTS.of(`a1`, `diff`)).toEqual([`agents`, `a1`, `diff`, `sbx-here`]);
        expect(AGENTS.ofSandbox(`sbx-laptop`, `a1`, `diff`)).toEqual([`agents`, `a1`, `diff`, `sbx-laptop`]);
    });

    // A wiped/recreated sandbox drops everything this browser remembered about it, by predicate; a cross-sandbox entry
    // must be swept the same way, or the ledger keeps painting a workspace that's gone.
    it("is found by the sweep that drops one sandbox's cached state", () => {
        const laptop = sandboxQueryPredicate(`sbx-laptop`);
        expect(laptop({ queryKey: GIT_CHANGES.ofSandbox(`sbx-laptop`) })).toBe(true);
        expect(laptop({ queryKey: GIT_CHANGES.ofSandbox(`sbx-desk`) })).toBe(false);
        expect(laptop({ queryKey: GIT_CHANGES.of() })).toBe(false);
    });

    // Naming the active box produces the identical key, not a second cache entry for the same data.
    it("collapses onto of() when it names the active sandbox", () => {
        expect(AGENTS.ofSandbox(`sbx-here`, `a1`, `diff`)).toEqual(AGENTS.of(`a1`, `diff`));
    });

    // The agent id sits mid-key, so a family prefix would also catch the (expensive) transcripts; `matches` is what the
    // workspace's own writes invalidate a diff through.
    it("recognises any agent's diff in any box, and nothing else under the family", () => {
        expect(AGENT_DIFF.of(`a1`)).toEqual(AGENTS.of(`a1`, `diff`));
        expect(AGENT_DIFF.ofSandbox(`sbx-laptop`, `a1`)).toEqual(AGENTS.ofSandbox(`sbx-laptop`, `a1`, `diff`));
        expect(AGENT_DIFF.matches(AGENT_DIFF.of(`a1`))).toBe(true);
        expect(AGENT_DIFF.matches(AGENT_DIFF.ofSandbox(`sbx-laptop`, `a2`))).toBe(true);
        // A per-file diff is filed under the list, so the same predicate reaches it: one invalidation, both.
        expect(AGENT_DIFF.matches([...AGENT_DIFF.of(`a1`), `file`, `root`, `src/app.ts`])).toBe(true);
        // ...and the rest of the family is left alone.
        expect(AGENT_DIFF.matches(AGENTS.of(`a1`, `transcript`))).toBe(false);
        expect(AGENT_DIFF.matches(AGENTS.of())).toBe(false);
        expect(AGENT_DIFF.matches(GIT_CHANGES.of())).toBe(false);
    });

    // `every` still reaches every box's entries, so a land in one sandbox invalidates that sandbox's changes.
    it("leaves the family-wide prefix reaching across every box", () => {
        expect(GIT_CHANGES.every).toEqual([`git`, `changes`]);
        for (const key of [GIT_CHANGES.of(), GIT_CHANGES.ofSandbox(`sbx-laptop`)]) {
            expect(key.slice(0, GIT_CHANGES.every.length)).toEqual([...GIT_CHANGES.every]);
        }
    });
});
