import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Services } from "../composition.js";
import { parseSkillFile } from "./skill-file.js";

/* THE LOADED-SKILLS FOLDER, in the one place every writer and reader spells it.
 *
 * Skills are written in the Agent Skills format (`<name>/SKILL.md`), which every runtime this daemon serves can
 * read, but each runtime LOOKS in its own place. The folder that converges them is therefore the vendor-neutral
 * `.agents/skills/`: Codex scans it natively (upward from its cwd), and runtimes without a loader receive the
 * catalogue on their opening prompt (turn-plan.ts). `.claude/skills/` is no longer where a skill LIVES, it is
 * where Claude Code LOOKS, so this module keeps a per-skill symlink there (the SDK loader follows them; the same
 * never-clobber rule as session-store.ts's links protects anything real a user dropped in).
 *
 * The loader projection is DERIVED, scan-to-converge, and serialized per workspace (a capability apply and the
 * boot reconcile may write concurrently). Writers await the queue, so "write returned" means every runtime's
 * filesystem view is current. AGENTS.md is entirely user-owned; this module neither reads nor writes it.
 *
 * CONTENT GOES THROUGH THE FILES SEAM, the tree is walked directly, and the split is not stylistic. A skill file
 * is workspace CONTENT, the seam is what a test replaces to keep a fake workspace off the real disk, and a store
 * that wrote around it put a stray skill into the developer's own /work the first time a route suite exercised a
 * real handler. The links and the scan have no seam to go through and need none: they only ever DESCRIBE what is
 * on disk, so a suite whose content writes went to memory converges the real tree against itself and writes
 * nothing. */

const SKILL_FILE = "SKILL.md";

/* The two writes this store owes the workspace. A structural subset of `Services["files"]` (`ctx.files` on a
 * capability handler is the same object), so every caller already holds one and no caller can pass something
 * that writes somewhere else. */
export type SkillFiles = Pick<Services["files"], "write" | "remove">;

export const loadedSkillsRoot = (root: string): string => join(root, ".agents", "skills");
export const loadedSkillDir = (root: string, name: string): string => join(loadedSkillsRoot(root), name);
export const loadedSkillFile = (root: string, name: string): string => join(loadedSkillDir(root, name), SKILL_FILE);

export const SKILL_CATALOG_NOTE_HEADER = "## Skills available in this workspace";
export const SKILL_CATALOG_NOTE_TITLE = "Skills available in this workspace";

// Claude Code's own tree, a projection now, holding one symlink per canonical skill.
const claudeSkillsRoot = (root: string): string => join(root, ".claude", "skills");
const claudeSkillLink = (root: string, name: string): string => join(claudeSkillsRoot(root), name);

// Relative on purpose: an isolated turn sees its worktree bind-mounted over the workspace root, and a relative
// link resolves inside whichever tree it was checked out into, an absolute one would reach across the mount.
const linkTarget = (root: string, name: string): string => relative(claudeSkillsRoot(root), loadedSkillDir(root, name));

/* One skill's Claude link, converged. A REAL entry under `.claude/skills/<name>` is left alone, it is something
 * a person put there for Claude specifically, and clobbering it would turn "drop a folder in" into a fight with
 * the daemon. EEXIST on the create is the concurrent writer having just won the same race to the same answer. */
const ensureClaudeLink = async (root: string, name: string): Promise<void> => {
    const link = claudeSkillLink(root, name);
    const target = linkTarget(root, name);
    const existing = await lstat(link).catch(() => undefined);
    if (existing !== undefined) {
        if (!existing.isSymbolicLink()) {
            return;
        }
        if ((await readlink(link).catch(() => undefined)) === target) {
            return;
        }
        await rm(link, { force: true });
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    });
};

// Is this `.claude/skills` entry one of OUR links? Anything pointing into the canonical folder is managed
// namespace, matched on the target rather than on the name, so a link somebody hand-renamed still sweeps.
const isManagedLink = (target: string | undefined): boolean => target !== undefined && target.split(/[\\/]/).includes(".agents");

const skillDirNames = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));
};

/* THE CATALOGUE FOR A RUNTIME WITHOUT A SKILL LOADER, the same progressive-disclosure surface a native loader
 * injects: names and descriptions now, the full SKILL.md only when a task matches. It is generated from the
 * turn's own tree rather than from the shared checkout, and every path is written against the root as the AGENT
 * sees it (turn-plan.ts supplies that address), so an isolated turn never receives a daemon-only worktree path.
 * Empty means no note at all. */
export const loadedSkillCatalogNote = async (localRoot: string, agentRoot: string): Promise<string | undefined> => {
    const skills: { name: string; description: string }[] = [];
    for (const name of await skillDirNames(loadedSkillsRoot(localRoot))) {
        const text = await readFile(loadedSkillFile(localRoot, name), "utf8").catch(() => undefined);
        if (text !== undefined) {
            skills.push({ name, description: parseSkillFile(text).description ?? "" });
        }
    }
    if (skills.length === 0) {
        return undefined;
    }
    return [
        SKILL_CATALOG_NOTE_HEADER,
        "",
        "One folder per connected tool, account, or workflow is available below. When a task matches a",
        "description, read that skill's SKILL.md before improvising: it carries the exact commands, endpoints,",
        "and rules.",
        "",
        ...skills.map(
            (skill) =>
                `- **${skill.name}**${skill.description === "" ? "" : `, ${skill.description}`} → \`${join(agentRoot, ".agents", "skills", skill.name, SKILL_FILE)}\``,
        ),
    ].join("\n");
};

/* One converge pass: a Claude link per canonical skill, and no Claude link without one. The
 * sweep only ever deletes SYMLINKS THAT POINT AT THE CANONICAL FOLDER, a real directory (a drop-in meant for
 * Claude alone) and a link somebody made to somewhere else are both outside this pass's ownership. */
const converge = async (root: string): Promise<void> => {
    const names = await skillDirNames(loadedSkillsRoot(root));
    for (const name of names) {
        await ensureClaudeLink(root, name);
    }
    const canonical = new Set(names);
    const entries = await readdir(claudeSkillsRoot(root), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((candidate) => candidate.isSymbolicLink() && !canonical.has(candidate.name))) {
        const link = join(claudeSkillsRoot(root), entry.name);
        if (isManagedLink(await readlink(link).catch(() => undefined))) {
            await rm(link, { force: true });
        }
    }
};

/* The serialization, per workspace root. The stored chain swallows its own failure so one bad pass cannot wedge
 * every later write; the RETURNED promise does not, so the caller that triggered the pass still hears about it. */
const chains = new Map<string, Promise<void>>();

const queueConverge = (root: string): Promise<void> => {
    const next = (chains.get(root) ?? Promise.resolve()).then(() => converge(root));
    chains.set(
        root,
        next.catch(() => undefined),
    );
    return next;
};

// Write one loaded skill, then converge its loader projection. Runtimes without a loader read the canonical
// set through loadedSkillCatalogNote at the start of their next conversation.
export const writeLoadedSkill = async (files: SkillFiles, root: string, name: string, text: string): Promise<void> => {
    await files.write(loadedSkillFile(root, name), text);
    await queueConverge(root);
};

// Remove one loaded skill everywhere it is projected. The link is taken out here rather than left to the sweep
// so the caller's postcondition, "no runtime offers this skill anymore", holds when the promise resolves.
export const removeLoadedSkill = async (files: SkillFiles, root: string, name: string): Promise<void> => {
    await files.remove(loadedSkillDir(root, name));
    const link = claudeSkillLink(root, name);
    if ((await lstat(link).catch(() => undefined))?.isSymbolicLink() === true && isManagedLink(await readlink(link).catch(() => undefined))) {
        await rm(link, { force: true });
    }
    await queueConverge(root);
};
