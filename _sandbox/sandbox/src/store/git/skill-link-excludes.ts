import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { commonDirOf, gitDirOf } from "./git-dir.js";
import { textFile } from "../plain-files/text-file.js";
import { generatedSkillNames } from "../skill-stamp.js";

// What the daemon generates in a skills tree, which is not another copy to commit: Claude's skill links (derived from
// .agents/skills) and every skill a daemon writer stamped (skill-stamp.ts). Keep their exact paths in a local exclude
// block: ignoring all of .claude/skills or .agents/skills would also hide the owner's real skill directories.
// The markers keep their first wording: a block written before generated skills joined it is still this block.
const START = "# intentic: generated Claude skill links";
const END = "# intentic: end generated Claude skill links";
const BLOCK = new RegExp(`^${START}\\n[\\s\\S]*?^${END}\\n?`, "m");

// Root excludes are rewritten when repositories change. Carry this separately converged block through that write,
// including onto the history root scope, which reads the same workspace through its own git directory.
export const skillLinkExcludeBlock = (content: string): string => BLOCK.exec(content)?.[0] ?? "";

const escaped = (name: string): string => name.replace(/[\\*?[\] ]/g, "\\$&");

const linkPatternsOf = async (root: string): Promise<string[]> => {
    const dir = join(root, ".claude", "skills");
    const entries = (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    const patterns: string[] = [];
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!entry.isSymbolicLink() || (await readlink(join(dir, entry.name)).catch(undefinedIfMissing)) !== `../../.agents/skills/${entry.name}`) {
            continue;
        }
        const name = escaped(entry.name);
        // The common exclude file serves every worktree: a real directory at this name in another one is still work.
        patterns.push(`/.claude/skills/${name}`, `!/.claude/skills/${name}/`);
    }
    return patterns;
};

// Directory-only, so a plain file the owner puts at a generated skill's name is still seen.
const generatedPatternsOf = async (root: string): Promise<string[]> =>
    (await generatedSkillNames(join(root, ".agents", "skills"))).map((name) => `/.agents/skills/${escaped(name)}/`);

// Converged with the links and the generated skills, not just at boot, so switching on one more skill cannot create a
// phantom addition. Only our marked block changes; the owner's excludes and staging stay as they were. A folder with no
// git is valid during provisioning and in a skill-only fixture, and its first later convergence installs the block.
// Untracked paths only, as any exclude is: a generated skill already committed is root-repo.ts's to untrack.
export const syncSkillLinkExcludes = async (root: string): Promise<void> => {
    const gitDir = await gitDirOf(root);
    if (gitDir === undefined) {
        return;
    }
    const patterns = [...(await linkPatternsOf(root)), ...(await generatedPatternsOf(root))];
    const block = patterns.length === 0 ? "" : `${START}\n${patterns.join("\n")}\n${END}\n`;
    await textFile(join(await commonDirOf(gitDir), "info", "exclude")).update((current) => {
        const bare = current.replace(BLOCK, "");
        const next = `${bare}${bare === "" || bare.endsWith("\n") || block === "" ? "" : "\n"}${block}`;
        return next === current ? undefined : next;
    });
};
