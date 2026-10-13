import { cp, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TurnContext } from "../../../agent/providers/adapter.js";
import { runRootFor } from "../../../agent/tools/agent-terminals.js";
import type { TurnPlacement } from "../../../conversations/worktrees/isolation.js";
import { personaSkillsRoot } from "../../../personas/persona-kit.js";
import { skillFolderNames } from "../../../skill-file.js";
import { loadedSkillsRoot } from "../../../store/loaded-skills.js";

// The skills a Cursor turn loads, through Cursor's own loader (agent-runtimes.ts `skillDiscovery: "native"`). The SDK
// reads every `SKILL.md` under `.agents/skills/` (and `.cursor/`, `.claude/`, `.codex/`, `.grok/`) of each workspace
// root it is given: the turn's cwd, which holds the workspace's loaded skills, and `local.dirs` (options.d.ts). So:
// - the workspace's loaded skills are found where they already are, in the conversation's own tree;
// - the worn persona's own kit, which lives where no loader looks (.intentic/config/personas/<id>/skills), is copied into
//   a folder of the turn's own laid out as Cursor reads one, and handed over as a second root;
// - a skill the persona or a credential gate withholds (TurnPolicy.disallowedTools names it `Skill(<name>)`, as the
//   Claude Code loop is told) is refused at Cursor's read tool (cursor-hooks.ts), the seam the Claude loop's
//   `Skill(<name>)` denial is. Like that denial it stops the loader's path, not a shell that cats the file, and Cursor
//   still lists the skill's name and description: its loader reads the whole folder and takes no filter.

export interface CursorSkills {
    // The persona kit's skill folders, as the daemon reads them.
    readonly kit: readonly string[];
    // The loaded skills this turn may not open.
    readonly denied: readonly string[];
}

export const NO_SKILLS: CursorSkills = { kit: [], denied: [] };

/** What a turn's skills are, listed off the conversation's tree as the daemon sees it. */
export const cursorSkillsOf = async (context: Pick<TurnContext, "localCwd" | "base" | "persona">): Promise<CursorSkills> => {
    const withheld = new Set(context.base.policy.disallowedTools ?? []);
    const denied = (await skillFolderNames(loadedSkillsRoot(context.localCwd))).filter((name) => withheld.has(`Skill(${name})`));
    const persona = context.persona?.persona?.id;
    const root = persona === undefined ? undefined : personaSkillsRoot(context.localCwd, persona);
    const kit = root === undefined ? [] : (await skillFolderNames(root)).map((name) => join(root, name));
    return { kit, denied };
};

/**
 * The roots to hand Cursor as `local.dirs` for the kit, made where the turn's agent can read them (an anchored turn's
 * temp dir as its namespace sees it), and the release that removes them once the turn ends.
 */
export const projectKit = async (skills: CursorSkills, isolation: TurnPlacement | undefined): Promise<{ readonly dirs: string[]; readonly release: () => Promise<void> }> => {
    if (skills.kit.length === 0) {
        return { dirs: [], release: async () => {} };
    }
    const root = await mkdtemp(join(runRootFor(isolation), "intentic-cursor-skills-"));
    // Copied, not linked: Cursor's skill walk can hold what it finds to the folder it was pointed at (its containment
    // root), and a link's target is outside it; a copy is inside whatever it holds to.
    await Promise.all(skills.kit.map((dir) => cp(dir, join(root, ".agents", "skills", basename(dir)), { recursive: true })));
    return { dirs: [root], release: () => rm(root, { recursive: true, force: true }) };
};
