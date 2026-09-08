import type { LandConflict } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { ERRANDS, errandOf } from "../../chat/run/errands";
import { agentBlockers, blockerLabel, blockersOf, resolvePrompt, userBlockers } from "./conflictResolution";

// The prompt is what the panel's primary button sends; only the parts a turn fails without are pinned here: the
// commit-first step, main-branch self-discovery, keeping both sides, and the fence around paths the agent cannot
// touch.

const conflicts: readonly LandConflict[] = [
    {
        repo: `root`,
        clean: 11,
        paths: [
            { path: `src/auth/session.ts`, reason: `diverged` },
            { path: `assets/logo.png`, reason: `binary` },
            { path: `src/config.ts`, reason: `workspace` },
        ],
    },
    { repo: `docs`, clean: 2, paths: [{ path: `README.md`, reason: `diverged` }] },
];

describe(`blockers`, () => {
    it(`flattens the per-repo report, because who can act is decided by the reason and not by the repo`, () => {
        expect(blockersOf(conflicts)).toEqual([
            { repo: `root`, path: `src/auth/session.ts`, reason: `diverged` },
            { repo: `root`, path: `assets/logo.png`, reason: `binary` },
            { repo: `root`, path: `src/config.ts`, reason: `workspace` },
            { repo: `docs`, path: `README.md`, reason: `diverged` },
        ]);
    });

    it(`reads an absent report as no blockers: a repo-unavailable conflict carries no paths at all`, () => {
        expect(blockersOf(undefined)).toEqual([]);
        expect(blockersOf([{ repo: `root`, clean: 0, paths: [] }])).toEqual([]);
    });

    // The split mirrors the action ladder: a rebase can reach the first two causes, never the third.
    it(`gives the agent the causes a rebase can reach, and the user the one it cannot`, () => {
        const blockers = blockersOf(conflicts);
        expect(agentBlockers(blockers).map(blockerLabel)).toEqual([`src/auth/session.ts`, `assets/logo.png`, `docs/README.md`]);
        expect(userBlockers(blockers).map(blockerLabel)).toEqual([`src/config.ts`]);
    });

    it(`qualifies a nested repo's path and leaves the root repo's alone, like a review row's label`, () => {
        expect(blockerLabel({ repo: `root`, path: `src/a.ts`, reason: `diverged` })).toBe(`src/a.ts`);
        expect(blockerLabel({ repo: `docs`, path: `README.md`, reason: `diverged` })).toBe(`docs/README.md`);
    });
});

describe(`resolvePrompt`, () => {
    const prompt = resolvePrompt(conflicts);

    it(`tells the agent to commit first: a rebase refuses to start on the dirty worktree it always has`, () => {
        expect(prompt).toContain(`git add -A && git commit`);
        expect(prompt).toContain(`dirty`);
    });

    it(`falls back to self-discovery when the report carries no branch: a detached main checkout has no name`, () => {
        expect(prompt).toContain(`git worktree list`);
        expect(prompt).toContain(`git rebase <branch>`);
        // Escape hatch for a rebase that goes wrong, rather than leaving the agent to improvise.
        expect(prompt).toContain(`git rebase --abort`);
    });

    // When the daemon can read the branch name, the prompt states it directly instead of pointing at `git worktree
    // list`.
    it(`names the main line when the report carries it, and drops the listing the agent would have to read`, () => {
        const named = resolvePrompt([
            { repo: `root`, clean: 1, paths: [{ path: `a.ts`, reason: `diverged` }], mainBranch: `main` },
            { repo: `docs`, clean: 0, paths: [{ path: `b.md`, reason: `diverged` }], mainBranch: `main` },
        ]);
        expect(named).toContain(`git rebase main`);
        expect(named).toContain(`git merge main`);
        expect(named).not.toContain(`git worktree list`);
    });

    it(`goes back to self-discovery when the repos disagree: one instruction is the point`, () => {
        const mixed = resolvePrompt([
            { repo: `root`, clean: 1, paths: [{ path: `a.ts`, reason: `diverged` }], mainBranch: `main` },
            { repo: `docs`, clean: 0, paths: [{ path: `b.md`, reason: `diverged` }], mainBranch: `trunk` },
        ]);
        expect(mixed).toContain(`git rebase <branch>`);
    });

    it(`refuses the cheap resolution: taking one side is how a change silently disappears`, () => {
        expect(prompt).toContain(`BOTH`);
        expect(prompt).not.toContain(`git checkout --ours`);
        expect(prompt).not.toContain(`git checkout --theirs`);
    });

    it(`names every blocked path under its repo, with the cause in the agent's terms`, () => {
        for (const blocker of agentBlockers(blockersOf(conflicts))) {
            expect(prompt).toContain(blocker.path);
        }
        expect(prompt).toContain(`docs`);
        expect(prompt).toContain(`README.md`);
    });

    it(`fences off the user's own uncommitted paths rather than hiding them`, () => {
        for (const blocker of userBlockers(blockersOf(conflicts))) {
            expect(prompt).toContain(blockerLabel(blocker));
        }
        expect(prompt.indexOf(`src/config.ts`)).toBeGreaterThan(prompt.indexOf(`Leave these alone`));
    });

    it(`says nothing about the user's paths when there are none: no empty section, no dangling heading`, () => {
        expect(resolvePrompt([{ repo: `root`, clean: 3, paths: [{ path: `a.ts`, reason: `diverged` }] }])).not.toContain(`Leave these alone`);
    });

    it(`keeps the agent out of the user's checkout and tells it the land is automatic`, () => {
        expect(prompt).toContain(`user's checkout`);
        expect(prompt).toContain(`turn ends`);
    });

    // The transcript recognizes this prompt as an ERRAND by its opening paragraph, the only marker that survives a
    // hydrate (errands.ts). Asserted here so rewording the opening fails the test instead of silently breaking
    // recognition.
    it(`reads back as the land-conflict errand, which is what keeps it from stealing the sticky prompt`, () => {
        expect(errandOf({ id: 1, role: `user`, text: prompt })).toBe(ERRANDS.landConflict);
    });
});
