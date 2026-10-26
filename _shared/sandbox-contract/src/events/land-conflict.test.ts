import { isLandConflict, keepDeletedPrompt } from "./land-conflict.js";

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
    expect(prompt).toContain("`git rm` it");
    expect(prompt).toContain(`Keep them deleted: do not re-create them`);
    expect(prompt).toContain(`root\n  - docs/reports/a.md`);
    expect(prompt).toContain(`intentic\n  - x.ts`);
});

it(`falls back to the worktree list when no main line was named`, () => {
    expect(keepDeletedPrompt([{ repo: `root`, path: `a.md`, reason: `workspace` }], undefined)).toContain("FIRST line of `git worktree list`");
});
