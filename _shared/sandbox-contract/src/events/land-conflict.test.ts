import { isLandConflict, keepDeletedPrompt, landConflictPrompt } from "./land-conflict.js";

// The turn a "Keep deleted" press sends: the same errand as a Resolve (the chat folds it as one), but with the answer
// to the modify/delete conflict already decided, since "keep both sides" would bring the owner's deleted file back.
it(`asks for the deleted files to stay gone, named per repo, on the named main line`, () => {
    const prompt = keepDeletedPrompt(
        [
            { repo: `root`, path: `docs/reports/a.md`, reason: `workspace` },
            { repo: `intentic`, path: `x.ts`, reason: `workspace` },
        ],
        `main`,
    );
    expect(isLandConflict(prompt)).toBe(true);
    expect(prompt).toContain("`git rebase main`");
    // Commits only what is left: the land usually committed the worktree, and `git commit` with nothing staged exits 1.
    expect(prompt).toContain("1. `git add -A; git diff --cached --quiet || git commit -qm wip`");
    expect(prompt).not.toContain("&& git commit");
    expect(prompt).toContain("`git rm` it");
    expect(prompt).toContain(`Keep them deleted: do not re-create them`);
    expect(prompt).toContain(`root\n  - docs/reports/a.md`);
    expect(prompt).toContain(`intentic\n  - x.ts`);
});

it(`falls back to the worktree list when no main line was named`, () => {
    expect(keepDeletedPrompt([{ repo: `root`, path: `a.md`, reason: `workspace` }], undefined)).toContain("FIRST line of `git worktree list`");
});

// The prompt said "The app re-lands automatically" while 83 of 90 resolve turns on one sandbox ended held on their
// branch again: it lands by itself only where the conversation's work does, and it says so.
it(`tells the resolve turn what becomes of its work, held or landed, and to commit only what is left`, () => {
    const prompt = landConflictPrompt([{ repo: `root`, clean: 0, mainBranch: `main`, paths: [{ path: `a.ts`, reason: `diverged` }] }]);
    expect(prompt).toContain("1. `git add -A; git diff --cached --quiet || git commit -qm wip`");
    expect(prompt).not.toContain(`re-lands automatically`);
    expect(prompt).toContain(`lands it where this conversation's work lands by itself, or keeps it on its branch, ready for the user to land from its review`);
});
