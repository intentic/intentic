import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_FILE, skillFolderNames } from "../skill-file.js";

// The stamp a daemon writer puts into every skill it writes (store/loaded-skills.ts stampSkill), and what reads it back.
// Apart from the store so the git side (store/git/skill-link-excludes.ts, conversations/worktrees/generated-skills.ts)
// can ask which skills are generated without importing the store that converges them.

export const skillStampOf = (writer: string): string => `<!-- intentic:skill-writer=${writer} · written by the sandbox; edits here are overwritten -->`;
export const SKILL_STAMP_LINE = /^<!-- intentic:skill-writer=([a-z0-9-]+) [^\n]*-->$/m;
// Account skills were stamped with this before every writer was (until 2026-10-12); still read as the account writer's.
export const LEGACY_ACCOUNT_SKILL_MARKER = "<!-- managed by the sandbox: derived from the connected accounts; edits are overwritten -->";

// The daemon writer a loaded skill's text names, or undefined for an unstamped (owner-authored) file.
export const skillWriterOf = (text: string): string | undefined => {
    const stamped = SKILL_STAMP_LINE.exec(text)?.[1];
    if (stamped !== undefined) {
        return stamped;
    }
    return text.includes(LEGACY_ACCOUNT_SKILL_MARKER) ? "account" : undefined;
};

// GENERATED SKILLS ARE NOT SOURCE (2026-10-27). A stamped skill is rewritten by the daemon whenever its writer runs (a
// boot, a connection, a release), so tracking it in git turned every rebuild into a diff the owner had to commit, and
// an agent's worktree, cut from that commit, read whatever copy was last committed rather than the one the daemon
// wrote. Git leaves them alone instead (skill-link-excludes.ts, root-repo.ts untrackGeneratedSkills) and each worktree
// is handed the live copies (conversations/worktrees/generated-skills.ts). The owner's own skills, unstamped, stay
// tracked: they are the owner's text.
// The stamped folders directly under `skillsRoot`, name-ordered; an unreadable or absent SKILL.md is not generated.
export const generatedSkillNames = async (skillsRoot: string): Promise<string[]> => {
    const names: string[] = [];
    for (const name of await skillFolderNames(skillsRoot)) {
        // allow(silent-catch): a folder without a readable SKILL.md names no writer, so it is nobody's generated skill.
        const text = await readFile(join(skillsRoot, name, SKILL_FILE), "utf8").catch(() => undefined);
        if (text !== undefined && skillWriterOf(text) !== undefined) {
            names.push(name);
        }
    }
    return names;
};
