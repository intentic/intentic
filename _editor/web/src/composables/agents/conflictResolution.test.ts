import type { LandConflict } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { ERRANDS, errandOf } from "../chat/errands";
import { agentBlockers, blockerLabel, blockersOf, resolvePrompt, userBlockers } from "./conflictResolution";

/* The prompt is a UI artifact — it is what the panel's primary button DOES — so the parts of it that decide
 * whether the turn works are pinned here rather than left to review. Everything asserted below is something a
 * turn fails without: the commit that lets a rebase start, the self-discovery of the user's checkout, the
 * instruction not to resolve by dropping a side, and the fence around paths the agent cannot touch. */

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

    it(`reads an absent report as no blockers — a repo-unavailable conflict carries no paths at all`, () => {
        expect(blockersOf(undefined)).toEqual([]);
        expect(blockersOf([{ repo: `root`, clean: 0, paths: [] }])).toEqual([]);
    });

    // The split IS the action ladder: a rebase in the agent's worktree can reach the first two causes and can
    // never reach the third, so offering one button for all of them would promise something git refuses.
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

    it(`tells the agent to commit first — a rebase refuses to start on the dirty worktree it always has`, () => {
        expect(prompt).toContain(`git add -A && git commit`);
        expect(prompt).toContain(`refuses to start on a dirty tree`);
    });

    it(`falls back to self-discovery when the report carries no branch — a detached main checkout has no name`, () => {
        expect(prompt).toContain(`git worktree list`);
        expect(prompt).toContain(`git rebase <branch>`);
        // The escape hatch, so a rebase that goes badly has somewhere to go other than improvisation.
        expect(prompt).toContain(`git rebase --abort`);
    });

    // `git worktree list` is one line per live agent — 65 of them in this workspace — and every conflicted
    // session spent its opening calls on it. When the daemon read the name, the prompt says it.
    it(`names the main line when the report carries it, and drops the listing the agent would have to read`, () => {
        const named = resolvePrompt([
            { repo: `root`, clean: 1, paths: [{ path: `a.ts`, reason: `diverged` }], mainBranch: `main` },
            { repo: `docs`, clean: 0, paths: [{ path: `b.md`, reason: `diverged` }], mainBranch: `main` },
        ]);
        expect(named).toContain(`git rebase main`);
        expect(named).toContain(`git merge main`);
        expect(named).not.toContain(`git worktree list`);
    });

    it(`goes back to self-discovery when the repos disagree — one instruction is the point`, () => {
        const mixed = resolvePrompt([
            { repo: `root`, clean: 1, paths: [{ path: `a.ts`, reason: `diverged` }], mainBranch: `main` },
            { repo: `docs`, clean: 0, paths: [{ path: `b.md`, reason: `diverged` }], mainBranch: `trunk` },
        ]);
        expect(mixed).toContain(`git rebase <branch>`);
    });

    it(`refuses the cheap resolution — taking one side is how a change silently disappears`, () => {
        expect(prompt).toContain(`the intent of BOTH sides`);
        expect(prompt).toContain(`Do not take one side wholesale`);
    });

    it(`names every blocked path under its repo, with the cause in the agent's terms`, () => {
        expect(prompt).toContain(`  - src/auth/session.ts — the main line's committed content moved under you since you branched`);
        expect(prompt).toContain(`  - assets/logo.png — git has no automatic merge for a binary file`);
        // Grouped by repo rather than repo-qualified per line: the agent works one checkout at a time.
        expect(prompt).toContain(`docs\n  - README.md`);
    });

    it(`fences off the user's own uncommitted paths rather than hiding them`, () => {
        expect(prompt).toContain(`Leave these alone`);
        expect(prompt).toContain(`rebasing will not unblock them`);
        // Named under the fence, not in the work list.
        expect(prompt.indexOf(`src/config.ts`)).toBeGreaterThan(prompt.indexOf(`Leave these alone`));
    });

    it(`says nothing about the user's paths when there are none — no empty section, no dangling heading`, () => {
        expect(resolvePrompt([{ repo: `root`, clean: 3, paths: [{ path: `a.ts`, reason: `diverged` }] }])).not.toContain(`Leave these alone`);
    });

    it(`keeps the agent out of the user's checkout and tells it the land is automatic`, () => {
        expect(prompt).toContain(`never edit, stage or commit in the user's checkout`);
        expect(prompt).toContain(`re-lands automatically when your turn ends`);
    });

    /* The transcript recognises this prompt as an ERRAND — the app's words, not the user's — by its opening
     * paragraph, which is the only marker that survives a hydrate (errands.ts). Asserted on the composed
     * prompt, so rewording the opening fails here rather than silently restoring the behaviour this replaced:
     * a paragraph of machine prose pinned over the question the agent was actually asked. */
    it(`reads back as the land-conflict errand, which is what keeps it from stealing the sticky prompt`, () => {
        expect(errandOf({ id: 1, role: `user`, text: prompt })).toBe(ERRANDS.landConflict);
    });
});
