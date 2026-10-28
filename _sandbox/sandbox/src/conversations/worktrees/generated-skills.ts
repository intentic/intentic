import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { undefinedIfMissing } from "@intentic/base/errors";
import { SKILL_FILE } from "../../skill-file.js";
import { convergeClaudeSkills } from "../../store/skills/claude-skills.js";
import { generatedSkillNames } from "../../store/skills/skill-stamp.js";

// The skills the daemon generates are not in git (store/skills/skill-stamp.ts), so a worktree cut from a commit has
// none of them: this hands an agent's root checkout the main tree's live copies, and Claude's link to the skills tree,
// every time a turn opens on it. Git ignores both there as it does in the main tree (the common exclude file serves
// every worktree), so nothing here reaches the branch, a land or a review. Converged, not appended: a copy whose skill
// the main tree no longer has goes, and one already current is not rewritten. Whatever the branch itself tracks at one
// of these paths (a branch cut before the skills left git, or before `.claude/skills` became one link) is the branch's,
// and is left exactly as it stands.

const SKILLS = join(".agents", "skills");

// The folder's files by name, read whole; a skill is a few small files, so comparing them costs less than a rewrite.
const filesOf = async (dir: string): Promise<Map<string, string> | undefined> => {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(undefinedIfMissing);
    if (entries === undefined) {
        return undefined;
    }
    const files = new Map<string, string>();
    for (const entry of entries.filter((candidate) => candidate.isFile())) {
        const path = join(entry.parentPath, entry.name);
        files.set(path.slice(dir.length + 1), await readFile(path, "utf8"));
    }
    return files;
};

const sameFiles = (a: Map<string, string>, b: Map<string, string> | undefined): boolean =>
    b !== undefined && a.size === b.size && [...a].every(([path, text]) => b.get(path) === text);

// Every path the checkout's index holds under the two skills trees.
const trackedIn = async (worktree: string, git: GitRunner): Promise<readonly string[]> =>
    (await git(worktree, ["ls-files", "-z", "--", ".agents/skills", ".claude/skills"])).stdout.split("\0").filter((path) => path !== "");

// One skill's folder made the main tree's, rewritten only when a file differs. Nothing when the main tree's copy went
// between the listing and the read: the next turn sweeps any copy of it.
const carryOne = async (main: string, worktree: string, name: string): Promise<void> => {
    const source = join(main, SKILLS, name);
    const target = join(worktree, SKILLS, name);
    const files = await filesOf(source);
    if (files === undefined || !files.has(SKILL_FILE)) {
        return;
    }
    if (!sameFiles(files, await filesOf(target))) {
        await rm(target, { recursive: true, force: true });
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { recursive: true });
    }
};

export const carryGeneratedSkills = async (main: string, worktree: string, git: GitRunner = defaultGit): Promise<void> => {
    const live = await generatedSkillNames(join(main, SKILLS));
    const carried = await generatedSkillNames(join(worktree, SKILLS));
    const tracked = await trackedIn(worktree, git);
    const skillTracked = (name: string): boolean => tracked.some((path) => path.startsWith(`.agents/skills/${name}/`));
    for (const name of live.filter((candidate) => !skillTracked(candidate))) {
        await carryOne(main, worktree, name);
    }
    const wanted = new Set(live);
    for (const name of carried.filter((candidate) => !wanted.has(candidate) && !skillTracked(candidate))) {
        await rm(join(worktree, SKILLS, name), { recursive: true, force: true });
    }
    const claudeTracked = tracked.filter((path) => path.startsWith(".claude/skills/")).map((path) => path.split("/")[2] ?? "");
    await convergeClaudeSkills(worktree, { adopt: false, tracked: new Set(claudeTracked) });
};
