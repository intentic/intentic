import { lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { skillFolderNames } from "../../skill-file.js";

// ONE LINK, NOT ONE PER SKILL (2026-10-28). Claude Code reads a project's skills from `.claude/skills/` alone: it reads
// AGENTS.md, but not `.agents/skills/`, the folder every other runtime here reads (checked against 2.1.312). So
// `.claude/skills` is a single relative link to `../.agents/skills`, and Claude sees the canonical set as it stands. It
// replaced a directory holding a link per skill, which needed an exclude line per link, a link carried into every
// worktree, and a sweep, and still went wrong: a committed link outlived its skill on main (komodo-192), and an owner's
// skill, whose link git ignored, was linked in no agent's worktree, so no Claude turn ever saw it. The link is
// generated, not source: git ignores it (store/git/skill-link-excludes.ts), and every checkout converges it, the main
// tree when a skill is written (loaded-skills.ts) and an agent's checkout as each turn opens on it
// (conversations/worktrees/generated-skills.ts).

const CLAUDE_SKILLS = join(".claude", "skills");
const CANONICAL = join(".agents", "skills");
// Relative on purpose: an isolated turn's worktree is bind-mounted over the workspace root, and an absolute link would
// reach across the mount.
const CLAUDE_SKILLS_TARGET = join("..", CANONICAL);
const perSkillTarget = (name: string): string => join("..", "..", CANONICAL, name);

export interface ClaudeSkillsScope {
    // The main tree's pass: the owner's own entries in a directory-shaped `.claude/skills` move into `.agents/skills`,
    // and the old per-skill links go even where git tracks them. An agent's checkout passes false: what its branch
    // tracks is the branch's, so nothing tracked is moved or removed there.
    readonly adopt: boolean;
    // The names directly under `.claude/skills` the checkout's index tracks; read only when `adopt` is false.
    readonly tracked?: ReadonlySet<string>;
}

// A link into `.agents`, matched on its target rather than its name, so a renamed one is still recognized.
const isCanonicalLink = async (path: string): Promise<boolean> =>
    ((await readlink(path).catch(undefinedIfMissing)) ?? "").split(/[\\/]/).includes(".agents");

// EEXIST is a concurrent pass getting there first.
const link = async (target: string, path: string): Promise<void> => {
    try {
        await symlink(target, path);
    } catch (failure) {
        if (errnoCode(failure) !== "EEXIST") {
            throw failure;
        }
    }
};

// Converges `root`'s `.claude/skills` onto the single link. Absent: the link, once there is a canonical tree to point
// at. A link or a file already there (ours, or the owner's own pointing elsewhere) stays as it stands. A directory is
// the layout from before the single link: emptied of the old links (and, in the main tree, of the owner's entries,
// moved where every runtime reads them) it becomes the link; when something there cannot go (a branch's tracked
// entries, or an owner's folder whose name `.agents/skills` already holds) it stays a directory, given a link for
// every canonical skill it lacks and cleared of untracked links to skills that are gone.
export const convergeClaudeSkills = async (root: string, scope: ClaudeSkillsScope): Promise<void> => {
    const dir = join(root, CLAUDE_SKILLS);
    const canonical = join(root, CANONICAL);
    const found = await lstat(dir).catch(undefinedIfMissing);
    if (found === undefined) {
        if ((await lstat(canonical).catch(undefinedIfMissing))?.isDirectory() === true) {
            await mkdir(dirname(dir), { recursive: true });
            await link(CLAUDE_SKILLS_TARGET, dir);
        }
        return;
    }
    if (!found.isDirectory()) {
        return;
    }
    const removable = (name: string): boolean => scope.adopt || scope.tracked?.has(name) !== true;
    const ours: string[] = [];
    const kept: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink() && (await isCanonicalLink(path))) {
            ours.push(entry.name);
        } else if (scope.adopt && (await lstat(join(canonical, entry.name)).catch(undefinedIfMissing)) === undefined) {
            // Same depth under the root, so a relative link the owner kept here still resolves after the move.
            await mkdir(canonical, { recursive: true });
            await rename(path, join(canonical, entry.name));
        } else {
            kept.push(entry.name);
        }
    }
    if (kept.length === 0 && ours.every(removable)) {
        await Promise.all(ours.map((name) => rm(join(dir, name), { force: true })));
        try {
            await rmdir(dir);
        } catch (failure) {
            // Something arrived meanwhile: the next pass finds it.
            if (errnoCode(failure) === "ENOTEMPTY" || errnoCode(failure) === "ENOENT") {
                return;
            }
            throw failure;
        }
        await link(CLAUDE_SKILLS_TARGET, dir);
        return;
    }
    // Listed after the moves, so a folder just moved is linked too. Only a missing tree lists empty: the sweep below
    // removes every link the listing does not name.
    const names = await skillFolderNames(canonical, "throw");
    const present = new Set([...ours, ...kept]);
    for (const name of names.filter((candidate) => !present.has(candidate))) {
        await link(perSkillTarget(name), join(dir, name));
    }
    const live = new Set(names);
    const stale = ours.filter((name) => !live.has(name) && removable(name));
    await Promise.all(stale.map((name) => rm(join(dir, name), { force: true })));
};
