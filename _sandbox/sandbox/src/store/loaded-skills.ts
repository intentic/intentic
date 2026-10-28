import { cp, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import type { Services } from "../composition.js";
import { scanSkillFolders, SKILL_FILE } from "../skill-file.js";
import { convergeClaudeSkills } from "./skills/claude-skills.js";
import { syncSkillLinkExcludes } from "./git/skill-link-excludes.js";
import { LEGACY_ACCOUNT_SKILL_MARKER, SKILL_STAMP_LINE, skillStampOf } from "./skills/skill-stamp.js";

// `.agents/skills/` is canonical; Codex reads it directly, other runtimes get a generated catalogue. `.claude/skills`
// is one derived link to it for Claude Code (skills/claude-skills.ts), never the source of truth. AGENTS.md is
// user-owned and untouched; skill content goes through the files seam, the link and scan touch disk directly.

// The two writes this store needs; a structural subset of `Services["files"]`, so no caller can pass something that
// writes elsewhere.
export type SkillFiles = Pick<Services["files"], "write" | "remove">;

export const loadedSkillsRoot = (root: string): string => join(root, ".agents", "skills");
// Where the image bakes the product's own skills (Dockerfile: seed-skills), beside each workspace's own: a runtime that
// does not look in the daemon's HOME by itself is pointed at both (OpenCode, whose project config is switched off).
export const BUILTIN_SKILLS_ROOT = "/root/.claude/skills";
export const loadedSkillDir = (root: string, name: string): string => join(loadedSkillsRoot(root), name);
export const loadedSkillFile = (root: string, name: string): string => join(loadedSkillDir(root, name), SKILL_FILE);

export const SKILL_CATALOG_NOTE_HEADER = "## Skills available in this workspace";
export const SKILL_CATALOG_NOTE_TITLE = "Skills available in this workspace";

// One entry of the catalogue: what a runtime without a skill loader is told a skill is, and where its file is, as the
// agent sees the path.
export interface CatalogSkill {
    readonly name: string;
    readonly description: string;
    readonly path: string;
}

// The workspace's loaded skills, name-ordered. Paths use the root the agent sees, so an isolated turn never gets a
// daemon-only worktree path.
export const loadedSkillCatalog = async (localRoot: string, agentRoot: string): Promise<CatalogSkill[]> =>
    (await scanSkillFolders(loadedSkillsRoot(localRoot), (path) => readFile(path, "utf8").catch(() => undefined), "throw")).map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: join(agentRoot, ".agents", "skills", skill.name, SKILL_FILE),
    }));

// Catalogue for a runtime without a skill loader: names and descriptions now, full SKILL.md only when a task matches.
// `omit` is the skills this turn may not use (its persona's withheld accounts, a gate, what its people were not given):
// listed, a withheld skill reads as an invitation. 2026-10-25: an X-only persona's runs were offered `chrome` ("when
// they name a site they are signed into") and two of them asked the owner's Brave for x.com. Empty means no note.
export const skillCatalogNoteOf = (skills: readonly CatalogSkill[], omit: ReadonlySet<string> = new Set()): string | undefined => {
    const listed = skills.filter((skill) => !omit.has(skill.name));
    if (listed.length === 0) {
        return undefined;
    }
    return [
        SKILL_CATALOG_NOTE_HEADER,
        "",
        "One folder per connected tool, account, or workflow is available below. When a task matches a",
        "description, read that skill's SKILL.md before improvising: it carries the exact commands, endpoints,",
        "and rules. Read it at the path shown, with your file tool: a skill tool of your runtime's own may not",
        "list these, and that does not mean the skill is missing.",
        "",
        ...listed.map((skill) => `- **${skill.name}**${skill.description === "" ? "" : `, ${skill.description}`} → \`${skill.path}\``),
    ].join("\n");
};

export const loadedSkillCatalogNote = async (localRoot: string, agentRoot: string): Promise<string | undefined> =>
    skillCatalogNoteOf(await loadedSkillCatalog(localRoot, agentRoot));

// One pass: Claude's view of the canonical tree converged (the main tree's own, so the owner's entries move in), then
// the excludes that keep what the daemon generates out of git.
const converge = async (root: string): Promise<void> => {
    await convergeClaudeSkills(root, { adopt: true });
    await syncSkillLinkExcludes(root);
};

// One pass per root at a time; a failed pass fails only its own caller and never blocks later writes.
const converging = keyedLock<string>();

const queueConverge = (root: string): Promise<void> => converging(root, async () => await converge(root));

// WHO WROTE A LOADED SKILL (2026-10-12). Every daemon writer names itself, and its id is stamped into the file, so a
// later release can tell its own leftovers from the owner's files: a skill no current writer claims is removed at boot
// (settings/skill-retirement.ts), one without a stamp never is. The owner's own skill copy is the owner's text and stays
// unstamped. Adding a writer means adding its id here, and the claim table in skill-retirement.ts is keyed by this
// union, so the typecheck refuses a writer that has not said which names it keeps. Retiring a writer moves its id to
// RETIRED_SKILL_WRITERS there.
export const DAEMON_SKILL_WRITERS = ["approvals", "baked-tool", "account", "cli", "peer", "ssh", "tunnel"] as const;
export type DaemonSkillWriter = (typeof DAEMON_SKILL_WRITERS)[number];
export type SkillWriter = DaemonSkillWriter | "owner";

// The stamp and its reader live in skills/skill-stamp.ts, where the git side reads them too; re-exported for the store's callers.
export { LEGACY_ACCOUNT_SKILL_MARKER, skillWriterOf } from "./skills/skill-stamp.js";
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

// The text with any writer stamp taken out, exactly undoing `stampSkill`: the stamp's line, and the blank line it was
// put under.
const isStampLine = (line: string): boolean => SKILL_STAMP_LINE.test(line) || line === LEGACY_ACCOUNT_SKILL_MARKER;
const unstamped = (text: string): string => {
    const lines = text.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
        if (!isStampLine(line)) {
            kept.push(line);
            continue;
        }
        if (kept.length > 0 && kept.at(-1) === "") {
            kept.pop();
        }
    }
    return kept.join("\n");
};

// The text as `writer` lands it: the stamp on its own line under the frontmatter (above everything without one).
// Idempotent, and a re-stamp replaces the writer rather than adding a second line; the owner's text passes unchanged.
export const stampSkill = (text: string, writer: SkillWriter): string => {
    if (writer === "owner") {
        return text;
    }
    const bare = unstamped(text);
    const marker = skillStampOf(writer);
    return FRONTMATTER.test(bare) ? bare.replace(FRONTMATTER, (frontmatter) => `${frontmatter}\n${marker}\n`) : `${marker}\n${bare}`;
};

// Writes one loaded skill stamped with its writer, then converges its loader projection; a runtime without a loader
// reads the canonical set via `loadedSkillCatalogNote` on its next conversation.
export const writeLoadedSkill = async (files: SkillFiles, root: string, name: string, text: string, writer: SkillWriter): Promise<void> => {
    await files.write(loadedSkillFile(root, name), stampSkill(text, writer));
    await queueConverge(root);
};

// Removes one loaded skill everywhere it's projected: Claude reads the canonical tree through its link, so "no runtime
// offers this skill" holds as soon as the folder goes, and the converge only sweeps a fallback per-skill link.
export const removeLoadedSkill = async (files: SkillFiles, root: string, name: string): Promise<void> => {
    await files.remove(loadedSkillDir(root, name));
    await queueConverge(root);
};

// A rename, or a copy and erase when the workspace and the history volume are different filesystems.
const relocate = async (from: string, to: string): Promise<void> => {
    try {
        await rename(from, to);
    } catch (failure) {
        if (errnoCode(failure) !== "EXDEV") {
            throw failure;
        }
        await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        await rm(from, { recursive: true, force: true });
    }
};

// Sets one loaded skill aside in the history volume's trash instead of erasing it (convergence rule 5), named
// `skill-<name>-<ms>` like every entry set aside there, so the trash sweep empties it after its while; answers where
// it went, or undefined when nothing was there. Claude stops offering it with the folder, as with `removeLoadedSkill`.
export const trashLoadedSkill = async (root: string, historyRoot: string, name: string, now: number = Date.now()): Promise<string | undefined> => {
    const dir = loadedSkillDir(root, name);
    if ((await lstat(dir).catch(undefinedIfMissing)) === undefined) {
        return undefined;
    }
    const target = join(historyRoot, "trash", `skill-${name}-${String(now)}`);
    await mkdir(dirname(target), { recursive: true });
    await relocate(dir, target);
    await queueConverge(root);
    return target;
};
