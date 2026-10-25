import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillDiscovery } from "@intentic/sandbox-contract/models/agent-runtimes";
import { personaSkillsRoot } from "../../../personas/persona-kit.js";
import { scanSkillFolders, SKILL_FILE } from "../../../skill-file.js";
import { type CatalogSkill, loadedSkillCatalog } from "../../../store/loaded-skills.js";

/* ONE SKILL SET PER TURN, WHATEVER LOADER THE RUNTIME HAS.

   A turn may use three origins of skills: the workspace's loaded skills (.agents/skills), the product's own the image
   bakes (/root/.claude/skills), and the worn persona's kit, less every skill a persona, a gate or the reach filter
   withholds (`Skill(<name>)`). Each runtime's loader reads some of them by itself (AgentCapabilities.skillDiscovery);
   what it does not read is named here, with its path as the agent sees it, in the note a fresh session opens with.
   2026-10-25: before this the note listed only the workspace's skills, and only for a runtime with no loader at all, so
   an ACP, Muse, Codex or Cursor turn never heard of the built-ins (the `capabilities` and `environment` CLIs among
   them), OpenCode was told the workspace's twice, and no persona's kit reached Codex, OpenCode, ACP or Muse. */

export interface TurnSkillCatalog {
    // The workspace's loaded skills, where the loader does not read them.
    readonly workspace: readonly CatalogSkill[];
    // The image's own, where the loader does not read them.
    readonly builtIn: readonly CatalogSkill[];
    // Each persona's kit by persona id, where the loader is not handed it: which persona the turn wears is decided after
    // this is read.
    readonly kits: Readonly<Record<string, readonly CatalogSkill[]>>;
}

/** Whether the loader leaves any origin for the note to name. */
export const skillsUnseen = (reach: SkillDiscovery): boolean => !reach.workspace || !reach.builtIn || !reach.kit;

// One folder of skills: `dir` as the daemon reads it, `agentDir` as the agent's file tool reaches it.
const scanned = async (dir: string, agentDir: string): Promise<CatalogSkill[]> =>
    (
        await scanSkillFolders(dir, (path) =>
            readFile(path, "utf8").catch(
                // allow(silent-catch): an unreadable SKILL.md is a skill nobody can be pointed at; the scan skips it.
                () => undefined,
            ),
        )
    ).map((skill) => ({ name: skill.name, description: skill.description, path: join(agentDir, skill.name, SKILL_FILE) }));

/** The skills of every origin `reach` leaves unread, each persona's kit among them. */
export const turnSkillCatalog = async (
    reach: SkillDiscovery,
    roots: { readonly localCwd: string; readonly effectiveCwd: string; readonly builtIn: string },
    personas: readonly { readonly id: string }[],
): Promise<TurnSkillCatalog> => {
    const [workspace, builtIn, kits] = await Promise.all([
        reach.workspace ? [] : loadedSkillCatalog(roots.localCwd, roots.effectiveCwd),
        // The image's own sit outside every worktree, at one path the daemon and every agent read alike.
        reach.builtIn || roots.builtIn === "" ? [] : scanned(roots.builtIn, roots.builtIn),
        reach.kit
            ? []
            : Promise.all(
                  personas.map(async ({ id }) => [id, await scanned(personaSkillsRoot(roots.localCwd, id), personaSkillsRoot(roots.effectiveCwd, id))] as const),
              ),
    ]);
    return { workspace, builtIn, kits: Object.fromEntries(kits.filter(([, skills]) => skills.length > 0)) };
};

/** The skills a turn wearing `persona` is told of, a workspace skill first where a built-in shares its name. */
export const catalogFor = (catalog: TurnSkillCatalog, persona: string | undefined): CatalogSkill[] => {
    const kit = persona === undefined ? [] : (catalog.kits[persona] ?? []);
    const named = new Set([...catalog.workspace, ...kit].map((skill) => skill.name));
    return [...catalog.workspace, ...kit, ...catalog.builtIn.filter((skill) => !named.has(skill.name))];
};
