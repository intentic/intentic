import { describe, expect, it, vi } from "vitest";

/* THE KEY A CROSS-SANDBOX READ REGISTERS UNDER.
 *
 * `of()` is the family scoped to whichever sandbox the app is pointed at, and `ofSandbox()` is the same family
 * aimed at a NAMED one, which is what the fleet board's All-sandboxes scope and the changes ledger read
 * through. The two have to produce the same SHAPE, because a shape is not a detail here: `sandboxQueryPredicate`
 * finds every entry belonging to one box by reading the id out of the last position, and an entry that put it
 * anywhere else would survive the sweep that drops a replaced workspace's cache.
 *
 * The scoping rule is mocked to a fixed id so the whole key can be spelled out, the same thing useAgents.test
 * does and for the same reason: activeSandbox is a leaf module, and what is under test is the path, not where
 * the id came from. */
vi.mock("./sandbox/activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-here`] }));

const { AGENT_DIFF, AGENTS, GIT_CHANGES } = await import("./queryKeys");
const { sandboxQueryPredicate } = await import("./sandbox/systemEventRouting");

describe("ofSandbox", () => {
    it("puts the named box where sandboxKey puts the active one: last", () => {
        expect(AGENTS.of()).toEqual([`agents`, `sbx-here`]);
        expect(AGENTS.ofSandbox(`sbx-laptop`)).toEqual([`agents`, `sbx-laptop`]);
    });

    // A variant lands BEFORE the id in both, so one agent's diff in another box is its own entry rather than
    // something a prefix match on the family would collide with.
    it("keeps a variant ahead of the id, exactly as of() does", () => {
        expect(AGENTS.of(`a1`, `diff`)).toEqual([`agents`, `a1`, `diff`, `sbx-here`]);
        expect(AGENTS.ofSandbox(`sbx-laptop`, `a1`, `diff`)).toEqual([`agents`, `a1`, `diff`, `sbx-laptop`]);
    });

    /* THE PROPERTY THE SHAPE EXISTS FOR. A workspace wiped and recreated under one sandbox drops everything
     * this browser remembered about that box, by predicate, and a cross-sandbox entry has to be swept by it
     * like any other, or the ledger would be the one surface still painting a workspace that no longer exists. */
    it("is found by the sweep that drops one sandbox's cached state", () => {
        const laptop = sandboxQueryPredicate(`sbx-laptop`);
        expect(laptop({ queryKey: GIT_CHANGES.ofSandbox(`sbx-laptop`) })).toBe(true);
        expect(laptop({ queryKey: GIT_CHANGES.ofSandbox(`sbx-desk`) })).toBe(false);
        expect(laptop({ queryKey: GIT_CHANGES.of() })).toBe(false);
    });

    // Aimed at the box that happens to be active, it produces the identical key rather than a second copy of
    // the same read: the same data, one cache entry, whichever way a caller asked for it.
    it("collapses onto of() when it names the active sandbox", () => {
        expect(AGENTS.ofSandbox(`sbx-here`, `a1`, `diff`)).toEqual(AGENTS.of(`a1`, `diff`));
    });

    /* THE ONE READING NO PREFIX CAN EXPRESS: every agent's diff, and only the diffs. The agent id sits in the
     * middle of the key, so the family prefix would take the transcripts with it, and those are the most
     * expensive read this app has. `matches` is what the workspace's own writes invalidate through, since a
     * commit or a discard in the Changes panel changes what every open review says about its files. */
    it("recognises any agent's diff in any box, and nothing else under the family", () => {
        expect(AGENT_DIFF.of(`a1`)).toEqual(AGENTS.of(`a1`, `diff`));
        expect(AGENT_DIFF.ofSandbox(`sbx-laptop`, `a1`)).toEqual(AGENTS.ofSandbox(`sbx-laptop`, `a1`, `diff`));
        expect(AGENT_DIFF.matches(AGENT_DIFF.of(`a1`))).toBe(true);
        expect(AGENT_DIFF.matches(AGENT_DIFF.ofSandbox(`sbx-laptop`, `a2`))).toBe(true);
        // A per-file diff is filed UNDER the list, so the same predicate reaches it: one invalidation, both.
        expect(AGENT_DIFF.matches([...AGENT_DIFF.of(`a1`), `file`, `root`, `src/app.ts`])).toBe(true);
        // ...and the rest of the family is left alone.
        expect(AGENT_DIFF.matches(AGENTS.of(`a1`, `transcript`))).toBe(false);
        expect(AGENT_DIFF.matches(AGENTS.of())).toBe(false);
        expect(AGENT_DIFF.matches(GIT_CHANGES.of())).toBe(false);
    });

    // `every` is unchanged by any of this: it is the bare path, and it still reaches every box's entries, which
    // is what makes a land in one sandbox invalidate that sandbox's changes.
    it("leaves the family-wide prefix reaching across every box", () => {
        expect(GIT_CHANGES.every).toEqual([`git`, `changes`]);
        for (const key of [GIT_CHANGES.of(), GIT_CHANGES.ofSandbox(`sbx-laptop`)]) {
            expect(key.slice(0, GIT_CHANGES.every.length)).toEqual([...GIT_CHANGES.every]);
        }
    });
});
