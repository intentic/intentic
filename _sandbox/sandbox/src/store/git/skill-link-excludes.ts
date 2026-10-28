import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { commonDirOf, gitDirOf } from "./git-dir.js";
import { textFile } from "../plain-files/text-file.js";
import { generatedSkillNames } from "../skills/skill-stamp.js";

// What the daemon generates in a skills tree, which is not another copy to commit: Claude's view of .agents/skills
// (store/skills/claude-skills.ts) and every skill a daemon writer stamped (skill-stamp.ts). Keep their exact paths in a
// local exclude block: ignoring all of .claude/skills or .agents/skills would also hide the owner's real skill
// directories. The markers keep their first wording: a block written before generated skills joined it is still this
// block.
const START = "# intentic: generated Claude skill links";
const END = "# intentic: end generated Claude skill links";
const BLOCK = new RegExp(`^${START}\\n[\\s\\S]*?^${END}\\n?`, "m");

// Root excludes are rewritten when repositories change. Carry this separately converged block through that write,
// including onto the history root scope, which reads the same workspace through its own git directory.
export const skillLinkExcludeBlock = (content: string): string => BLOCK.exec(content)?.[0] ?? "";

const escaped = (name: string): string => name.replace(/[\\*?[\] ]/g, "\\$&");

// Git sees a symbolic link as a file, so each pair hides a link and leaves a real directory at that path seen: first
// `.claude/skills` itself, the single link; then the per-skill links a directory-shaped `.claude/skills` is given (a
// branch cut before the single link, claude-skills.ts), which the common exclude file hides in every worktree. A
// plain file directly under such a directory is hidden with them; real skill folders there stay work.
const CLAUDE_VIEW_PATTERNS = ["/.claude/skills", "!/.claude/skills/", "/.claude/skills/*", "!/.claude/skills/*/"] as const;

// Only once there is a skills tree to give Claude a view of: a workspace with neither keeps its excludes untouched.
const claudeViewPatternsOf = async (root: string): Promise<readonly string[]> => {
    for (const tree of [join(root, ".agents", "skills"), join(root, ".claude", "skills")]) {
        if ((await lstat(tree).catch(undefinedIfMissing)) !== undefined) {
            return CLAUDE_VIEW_PATTERNS;
        }
    }
    return [];
};

// Directory-only, so a plain file the owner puts at a generated skill's name is still seen.
const generatedPatternsOf = async (root: string): Promise<string[]> =>
    (await generatedSkillNames(join(root, ".agents", "skills"))).map((name) => `/.agents/skills/${escaped(name)}/`);

// Converged with the generated skills, not just at boot, so switching on one more skill cannot create a phantom
// addition. Only our marked block changes; the owner's excludes and staging stay as they were. A folder with no
// git is valid during provisioning and in a skill-only fixture, and its first later convergence installs the block.
// Untracked paths only, as any exclude is: a generated skill already committed is root-repo.ts's to untrack.
export const syncSkillLinkExcludes = async (root: string): Promise<void> => {
    const gitDir = await gitDirOf(root);
    if (gitDir === undefined) {
        return;
    }
    const patterns = [...(await claudeViewPatternsOf(root)), ...(await generatedPatternsOf(root))];
    const block = patterns.length === 0 ? "" : `${START}\n${patterns.join("\n")}\n${END}\n`;
    await textFile(join(await commonDirOf(gitDir), "info", "exclude")).update((current) => {
        const bare = current.replace(BLOCK, "");
        const next = `${bare}${bare === "" || bare.endsWith("\n") || block === "" ? "" : "\n"}${block}`;
        return next === current ? undefined : next;
    });
};
